// spec_suggest_primers — global scope.
//
// Given a spec slug or explicit tag list, run the tag-matching engine
// (src/primers/match.ts) over the user's KB and return an ordered list of
// primer + best-practice candidates for the planner to load.
//
// This is the one place in M4 that touches the KB. The planner doesn't read
// primer bodies through this tool — it gets a ranked list of ids and paths
// and uses primer_list / a KB-read tool later to pull bodies on demand.
// Keeps token economy tight.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { loadKbCached } from "../primers/load.js";
import { matchPrimers, type MatchResult } from "../primers/match.js";
import {
  blend,
  cosine,
  defaultCacheDir,
  loadEmbeddingCache,
  normalizeTagScore,
} from "../primers/embed.js";
import { callEmbeddings, LlmError } from "../util/llmClient.js";

const SuggestInput = z
  .object({
    spec_slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("slug of a saved spec whose tech_stack + lens tags drive the match"),
    tech_tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(32)
      .default([])
      .describe("explicit tech_stack tags (used when spec_slug is not given or to extend it)"),
    lens_tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(16)
      .default([]),
    kinds: z
      .array(z.enum(["primer", "best-practice", "lens", "stage", "reviewer-config", "standard"]))
      .max(6)
      .default(["primer", "best-practice"])
      .describe("restrict match to these KB kinds"),
    limit: z.number().int().min(1).max(50).default(10),
    expand: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.spec_slug !== undefined || v.tech_tags.length > 0, {
    message: "provide either spec_slug or at least one tech tag",
  });

export function registerSpecSuggestPrimers(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "spec_suggest_primers",
    {
      title: "Suggest Primers For Spec",
      description:
        "Rank primers/best-practices against a spec's tag set (weighted Jaccard, deterministic). Returns ordered [{id, kind, name, score, matched_tags, path}]. Planner loads these bodies via its own primer_list / a read step.",
      inputSchema: SuggestInput.shape,
    },
    async (args: z.infer<typeof SuggestInput>) => {
      return runTool(async () => {
        const parsed = SuggestInput.parse(args);

        // Resolve tech + lens tags.
        let tech = parsed.tech_tags.slice();
        let lens = parsed.lens_tags.slice();
        if (parsed.spec_slug !== undefined) {
          const row = deps.globalDb
            .prepare(
              "SELECT frontmatter_json FROM specs WHERE slug = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(parsed.spec_slug) as { frontmatter_json: string } | undefined;
          if (!row) {
            throw new McpError("E_NOT_FOUND", `no spec with slug "${parsed.spec_slug}"`);
          }
          const fm = safeJson(row.frontmatter_json) as {
            tech_stack?: string[];
            lens?: string[];
          } | null;
          if (fm?.tech_stack) tech = Array.from(new Set([...tech, ...fm.tech_stack]));
          if (fm?.lens) lens = Array.from(new Set([...lens, ...fm.lens]));
        }

        if (tech.length === 0 && lens.length === 0) {
          throw new McpError(
            "E_VALIDATION",
            "spec_suggest_primers: no tags available after merging spec + explicit args",
          );
        }

        const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
        const kindFilter = new Set(parsed.kinds);
        const filtered = entries.filter((e) => kindFilter.has(e.kind));

        // Tag-only baseline: we always compute this so blending can layer on
        // top and fallback is automatic when embeddings are unavailable.
        const tagResults = matchPrimers(filtered, {
          tech_tags: tech,
          lens_tags: lens,
          // Do not slice yet — blend may reorder.
        });

        let results = tagResults;
        let scoring: "tag" | "blended" = "tag";
        if (deps.config.embeddings) {
          const blended = await tryBlend(deps, tech, lens, tagResults);
          if (blended !== null) {
            results = blended;
            scoring = "blended";
          }
        }
        if (typeof parsed.limit === "number") results = results.slice(0, parsed.limit);

        const payload = success(
          results.map((r) => r.path),
          `Suggested ${results.length} KB entr(y|ies) for ${tech.length}+${lens.length} tag(s) [${scoring}].`,
          parsed.expand
            ? {
                content: {
                  tech_tags: tech,
                  lens_tags: lens,
                  scoring,
                  suggestions: results,
                },
              }
            : {
                expand_hint:
                  "Call spec_suggest_primers with expand=true to receive the ranked list.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "spec_suggest_primers",
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

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Try to blend cosine similarity into the tag-based ranking. Returns null
 * on any fallback condition (no cache, endpoint unreachable, live embed
 * failed, cache empty) so the caller falls through to pure tag scoring.
 */
async function tryBlend(
  deps: ServerDeps,
  tech: string[],
  lens: string[],
  tagResults: MatchResult[],
): Promise<MatchResult[] | null> {
  const cfg = deps.config.embeddings;
  if (!cfg) return null;
  const cacheDir = defaultCacheDir(homedir(), cfg.cache_dir);
  const cache = await loadEmbeddingCache(cacheDir, cfg.model);
  if (cache.byId.size === 0) return null; // nothing precomputed

  const endpoint = deps.config.endpoints.find((e) => e.name === cfg.endpoint);
  if (!endpoint) return null;
  let apiKey: string | undefined;
  if (endpoint.auth_env_var) {
    apiKey = process.env[endpoint.auth_env_var];
    if (!apiKey && endpoint.trust_level !== "local") return null;
  }

  const queryText = [...tech, ...lens].join(" ").trim();
  if (queryText.length === 0) return null;

  let queryVec: number[];
  try {
    const vectors = await callEmbeddings({
      baseUrl: endpoint.base_url,
      apiKey,
      model: cfg.model,
      inputs: [queryText],
    });
    const first = vectors[0];
    if (!first || first.length === 0) return null;
    queryVec = first;
  } catch (e) {
    // Any embedding-endpoint failure at query time falls back to tag-only.
    void (e instanceof LlmError);
    return null;
  }

  const maxTag = tagResults.reduce((m, r) => (r.score > m ? r.score : m), 0);

  const blended = tagResults.map((r) => {
    const vec = cache.byId.get(r.id);
    const cos = vec ? cosine(queryVec, vec) : 0;
    const tagNorm = normalizeTagScore(r.score, maxTag);
    const combined = blend(tagNorm, cos, cfg.blend_weight);
    return { ...r, score: Math.round(combined * 1000) / 1000 };
  });

  blended.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return blended;
}
