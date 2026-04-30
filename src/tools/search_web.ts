// search_web — global scope. Workstream B8.
//
// Wraps a configured SearXNG instance as an MCP tool. Lets local models
// (or any flow that wants reproducible search) run a query and get back
// ranked results without depending on a provider's built-in web-search
// tool. Frontier providers should use their native tool when available;
// this tool is the equalizer for local routes.
//
// SearXNG response shape (https://docs.searxng.org/dev/search_api.html):
//   { query, number_of_results, results: [{title, url, content, ...}] }
//
// We map to a stable, narrower shape — title, url, snippet, source, score
// — so future engine swaps don't break callers.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const SearchWebInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1024)
      .describe("the search query — keep it specific; SearXNG ranks against the literal terms"),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("max results; defaults to config.searxng.default_limit (10)"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .optional()
      .describe("override per-call timeout; defaults to config.searxng.timeout_ms"),
    /**
     * SearXNG search categories — comma-separated. Common values:
     *   "general" (default), "news", "it", "science", "files", "videos"
     */
    categories: z
      .string()
      .max(256)
      .optional()
      .describe("comma-separated SearXNG categories (e.g. 'general,news')"),
    /**
     * Restrict to specific search engines (SearXNG `engines` param).
     * Comma-separated. Use when you want a targeted source — e.g.
     * "duckduckgo,wikipedia" for general, "github" for code.
     */
    engines: z.string().max(256).optional(),
    /** Time range filter — SearXNG supports day | week | month | year. */
    time_range: z.enum(["day", "week", "month", "year"]).optional(),
    expand: z.boolean().default(true),
  })
  .strict();

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
  publishedDate?: string;
}

interface SearxngResponse {
  query?: string;
  number_of_results?: number;
  results?: SearxngResult[];
}

interface NormalizedResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score: number | null;
  published?: string;
}

export function registerSearchWeb(server: McpServer, deps: ServerDeps): void {
  // search_web is only registered when config.searxng is set. No-op when
  // unconfigured — keeps the tool surface honest.
  if (!deps.config.searxng) return;

  server.registerTool(
    "search_web",
    {
      title: "Search the Web (via SearXNG)",
      description:
        "Run a web search via the configured SearXNG instance. Returns ranked {title, url, snippet, engine, score} results. Use for local models lacking native web search, or when you want reproducible/configurable search instead of a provider's built-in tool. Tool is only registered when config.searxng is configured.",
      inputSchema: SearchWebInput.shape,
    },
    async (args: z.infer<typeof SearchWebInput>, extra: { signal?: AbortSignal } | undefined) => {
      return runTool(
        async () => {
          const parsed = SearchWebInput.parse(args);
          const cfg = deps.config.searxng;
          if (!cfg) {
            // Defensive — registerSearchWeb early-returns above, but keep
            // the explicit check in case the tool is ever wired by hand.
            throw new McpError("E_STATE_INVALID", "search_web requires config.searxng to be set");
          }

          const url = new URL(cfg.url);
          url.searchParams.set("q", parsed.query);
          url.searchParams.set("format", "json");
          if (parsed.categories) url.searchParams.set("categories", parsed.categories);
          if (parsed.engines) url.searchParams.set("engines", parsed.engines);
          if (parsed.time_range) url.searchParams.set("time_range", parsed.time_range);

          const headers: Record<string, string> = { accept: "application/json" };
          if (cfg.auth_env_var) {
            const v = process.env[cfg.auth_env_var];
            if (!v) {
              throw new McpError(
                "E_CONFIG_MISSING_ENV",
                `env var ${cfg.auth_env_var} is unset (referenced via config.searxng.auth_env_var)`,
              );
            }
            headers["authorization"] =
              v.startsWith("Bearer ") || v.startsWith("Basic ") ? v : `Bearer ${v}`;
          }

          const ctrl = new AbortController();
          const onAbort = (): void => ctrl.abort();
          extra?.signal?.addEventListener("abort", onAbort);
          const timeout = parsed.timeout_ms ?? cfg.timeout_ms;
          const timer = setTimeout(() => ctrl.abort(), timeout);

          let body: SearxngResponse;
          try {
            const res = await fetch(url.toString(), {
              method: "GET",
              headers,
              signal: ctrl.signal,
            });
            if (!res.ok) {
              throw new McpError(
                "E_ENDPOINT_UNREACHABLE",
                `SearXNG returned HTTP ${res.status} ${res.statusText}`,
              );
            }
            body = (await res.json()) as SearxngResponse;
          } catch (e) {
            if (e instanceof McpError) throw e;
            const err = e as Error;
            if (err.name === "AbortError") {
              throw new McpError("E_CANCELED", `search_web aborted after ${timeout}ms`);
            }
            throw new McpError("E_ENDPOINT_UNREACHABLE", `SearXNG fetch failed: ${err.message}`);
          } finally {
            clearTimeout(timer);
            extra?.signal?.removeEventListener("abort", onAbort);
          }

          const limit = parsed.limit ?? cfg.default_limit;
          const raw = Array.isArray(body.results) ? body.results : [];
          const normalized: NormalizedResult[] = [];
          for (const [i, r] of raw.entries()) {
            if (!r.url || !r.title) continue;
            const entry: NormalizedResult = {
              rank: i + 1,
              title: String(r.title).slice(0, 512),
              url: String(r.url).slice(0, 2048),
              snippet: String(r.content ?? "").slice(0, 1024),
              engine: String(r.engine ?? "unknown").slice(0, 64),
              score: typeof r.score === "number" ? r.score : null,
            };
            if (typeof r.publishedDate === "string") {
              entry.published = r.publishedDate.slice(0, 64);
            }
            normalized.push(entry);
            if (normalized.length >= limit) break;
          }

          return success<Record<string, unknown>>(
            [],
            `search_web: '${parsed.query}' → ${normalized.length} result(s)${
              parsed.engines ? ` (engines=${parsed.engines})` : ""
            }${parsed.time_range ? ` (time=${parsed.time_range})` : ""}`,
            parsed.expand
              ? {
                  content: {
                    query: parsed.query,
                    total_available: body.number_of_results ?? null,
                    returned: normalized.length,
                    results: normalized,
                  },
                }
              : {},
          );
        },
        (payload) => {
          // Audit logs the query but not the result bodies — those can be
          // noisy and may include whatever the engine returned, including
          // arbitrary user content.
          writeAudit(deps.globalDb, {
            tool: "search_web",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: {
              query: args.query,
              ...(args.categories ? { categories: args.categories } : {}),
              ...(args.engines ? { engines: args.engines } : {}),
              ...(args.time_range ? { time_range: args.time_range } : {}),
            },
            outputs: payload.ok
              ? {
                  ok: true,
                  count: (payload.content as { returned?: number } | undefined)?.returned,
                }
              : payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}
