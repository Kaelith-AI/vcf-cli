// idea_get — global scope.
//
// Fetch one or more ideas by slug or exact path. When a slug is provided,
// all ideas with that slug are returned (ordered newest-first) rather than
// only the most recent one — supports the case where the same slug was
// captured on different days. Path lookup still returns exactly one item.
// Files are the source of truth; path is re-validated against allowed_roots
// before read.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const IdeaGetInput = z
  .object({
    slug: z.string().min(1).max(128).optional(),
    path: z.string().min(1).optional(),
    expand: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.slug !== undefined || v.path !== undefined, {
    message: "idea_get requires either slug or path",
  });

interface IdeaItem {
  path: string;
  body?: string;
}

export function registerIdeaGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "idea_get",
    {
      title: "Get Idea",
      description:
        "Fetch captured ideas by slug (returns all matching, newest first) or exact path (returns one). Returns {paths:[...files], summary}. Pass expand=true to include file bodies in the content array.",
      inputSchema: IdeaGetInput.shape,
    },
    async (args: z.infer<typeof IdeaGetInput>) => {
      return runTool(
        async () => {
          const parsed = IdeaGetInput.parse(args);
          let paths: string[];

          if (parsed.path !== undefined) {
            // Single-path lookup — validate and return one item.
            const canonical = await assertInsideAllowedRoot(
              parsed.path,
              deps.config.workspace.allowed_roots,
            );
            paths = [canonical];
          } else {
            // Slug lookup — return ALL matching rows, newest first.
            const slug = parsed.slug!;
            const rows = deps.globalDb
              .prepare("SELECT path FROM ideas WHERE slug = ? ORDER BY created_at DESC")
              .all(slug) as Array<{ path: string }>;
            if (rows.length === 0) {
              throw new McpError("E_NOT_FOUND", `no idea with slug "${slug}"`);
            }
            // Validate each path inside allowed_roots.
            paths = await Promise.all(
              rows.map((r) => assertInsideAllowedRoot(r.path, deps.config.workspace.allowed_roots)),
            );
          }

          // Read each file (body only included when expand=true).
          const items: IdeaItem[] = [];
          for (const p of paths) {
            let body: string;
            try {
              body = await readFile(p, "utf8");
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new McpError("E_NOT_FOUND", `idea file missing: ${p}`);
              }
              throw err;
            }
            items.push(parsed.expand ? { path: p, body } : { path: p });
          }

          return success(
            paths,
            `Fetched ${items.length} idea(s) matching ${parsed.slug ? `slug="${parsed.slug}"` : `path="${parsed.path}"`}.`,
            parsed.expand ? { content: items } : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "idea_get",
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
