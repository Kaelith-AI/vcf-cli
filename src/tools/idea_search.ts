// idea_search — global scope.
//
// Query the global DB's `ideas` table. SQL-backed so searches are O(index),
// not O(filesystem). Returns path + slug + summary + matched tags per hit.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";

const IdeaSearchInput = z
  .object({
    query: z
      .string()
      .max(256)
      .optional()
      .describe("substring match against slug + frontmatter.title (case-insensitive)"),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(8)
      .default([])
      .describe("require all listed tags (AND). Empty = no tag filter."),
    limit: z.number().int().min(1).max(100).default(20),
    expand: z.boolean().default(false),
  })
  .strict();

interface IdeaRow {
  path: string;
  slug: string;
  tags: string; // JSON array
  created_at: number;
  frontmatter_json: string;
}

export function registerIdeaSearch(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "idea_search",
    {
      title: "Search Ideas",
      description:
        "Search captured ideas by substring (slug/title) and/or tag set. Returns up to `limit` matches as {path, slug, title, tags, created_at}. Pass expand=true to include the full frontmatter in content.",
      inputSchema: IdeaSearchInput.shape,
    },
    async (args: z.infer<typeof IdeaSearchInput>) => {
      return runTool(async () => {
        const parsed = IdeaSearchInput.parse(args);

        // Build WHERE clause. `tags` is stored as JSON; we use SQLite's
        // json_each view via LIKE-match on the stringified JSON for the
        // AND filter. This is O(rows) but the table is small.
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (parsed.query !== undefined && parsed.query.length > 0) {
          clauses.push("(slug LIKE ? OR lower(frontmatter_json) LIKE ?)");
          const like = `%${parsed.query.toLowerCase()}%`;
          params.push(like, like);
        }
        for (const tag of parsed.tags) {
          // Match '"tag"' inside the JSON array — cheap and works without JSON1 extension.
          clauses.push("tags LIKE ?");
          params.push(`%"${tag}"%`);
        }
        const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
        const rows = deps.globalDb
          .prepare(
            `SELECT path, slug, tags, created_at, frontmatter_json FROM ideas ${where}
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...params, parsed.limit) as unknown as IdeaRow[];

        const hits = rows.map((r) => {
          const fm = safeParseJson(r.frontmatter_json) as { title?: string } | null;
          return {
            path: r.path,
            slug: r.slug,
            title: fm?.title ?? r.slug,
            tags: safeParseJson(r.tags) ?? [],
            created_at: r.created_at,
          };
        });

        const payload = success(
          hits.map((h) => h.path),
          `Found ${hits.length} idea(s) matching ${summarizeQuery(parsed)}.`,
          parsed.expand
            ? { content: hits }
            : {
                expand_hint: "Call idea_search with expand=true to include the full hit list.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "idea_search",
            scope: "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

function summarizeQuery(p: z.infer<typeof IdeaSearchInput>): string {
  const parts: string[] = [];
  if (p.query) parts.push(`query="${p.query}"`);
  if (p.tags.length > 0) parts.push(`tags=${p.tags.join(",")}`);
  return parts.length > 0 ? parts.join(" ") : "(no filter)";
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
