// idea_search — global scope.
//
// Query the global DB's `ideas` table. SQL-backed so searches are O(index),
// not O(filesystem). Returns path + slug + summary + matched tags per hit.
//
// When the FTS5 index exists (post Phase G-D migration), the `query` field
// uses full-text search (ranked by relevance). On pre-migration DBs the FTS
// table won't exist; the tool falls back to a LIKE search on slug +
// frontmatter_json automatically via a try/catch.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { queryAll } from "../util/db.js";

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

const IdeaRowSchema = z.object({
  path: z.string(),
  slug: z.string(),
  tags: z.string(), // JSON array
  created_at: z.number(),
  frontmatter_json: z.string(),
});

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
      return runTool(
        async () => {
          const parsed = IdeaSearchInput.parse(args);

          let rows: z.infer<typeof IdeaRowSchema>[] = [];

          if (parsed.query !== undefined && parsed.query.length > 0) {
            // Try FTS5 path first (Phase G-D migration).
            let usedFts = false;
            try {
              // FTS5 standalone table — join back to ideas on slug.
              // Tag filter applied on the ideas side after the FTS match.
              const tagClauses: string[] = [];
              const tagParams: (string | number)[] = [];
              for (const tag of parsed.tags) {
                tagClauses.push("i.tags LIKE ?");
                tagParams.push(`%"${tag}"%`);
              }
              const tagWhere = tagClauses.length > 0 ? "AND " + tagClauses.join(" AND ") : "";

              const ftsRows = queryAll(
                deps.globalDb,
                `SELECT i.path, i.slug, i.tags, i.created_at, i.frontmatter_json
                 FROM ideas_fts
                 JOIN ideas i ON ideas_fts.slug = i.slug
                 WHERE ideas_fts MATCH ?
                 ${tagWhere}
                 ORDER BY ideas_fts.rank
                 LIMIT ?`,
                IdeaRowSchema,
                [parsed.query, ...tagParams, parsed.limit],
              );
              rows = ftsRows;
              usedFts = true;
            } catch {
              /* FTS table doesn't exist yet (pre-migration DB); fall through */
            }

            if (!usedFts) {
              // Fallback: LIKE-based search on slug + frontmatter_json.
              const likeClauses: string[] = [];
              const likeParams: (string | number)[] = [];
              const like = `%${parsed.query.toLowerCase()}%`;
              likeClauses.push("(slug LIKE ? OR lower(frontmatter_json) LIKE ?)");
              likeParams.push(like, like);
              for (const tag of parsed.tags) {
                likeClauses.push("tags LIKE ?");
                likeParams.push(`%"${tag}"%`);
              }
              const where = "WHERE " + likeClauses.join(" AND ");
              rows = queryAll(
                deps.globalDb,
                `SELECT path, slug, tags, created_at, frontmatter_json FROM ideas ${where}
                 ORDER BY created_at DESC LIMIT ?`,
                IdeaRowSchema,
                [...likeParams, parsed.limit],
              );
            }
          } else {
            // No query string — tag-only (or no) filter via the base table.
            const clauses: string[] = [];
            const params: (string | number)[] = [];
            for (const tag of parsed.tags) {
              clauses.push("tags LIKE ?");
              params.push(`%"${tag}"%`);
            }
            const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
            rows = queryAll(
              deps.globalDb,
              `SELECT path, slug, tags, created_at, frontmatter_json FROM ideas ${where}
               ORDER BY created_at DESC LIMIT ?`,
              IdeaRowSchema,
              [...params, parsed.limit],
            );
          }

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
            parsed.expand ? { content: hits } : {},
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "idea_search",
            scope: "global",
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
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
