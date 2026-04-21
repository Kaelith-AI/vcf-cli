// idea_get — global scope.
//
// Fetch a single idea by slug or exact path. Reads the file from disk (files
// are the source of truth) and returns frontmatter + body. Path is
// re-validated against allowed_roots before read.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { queryRow } from "../util/db.js";
import { McpError } from "../errors.js";

const IdeaPathRowSchema = z.object({ path: z.string() });

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

export function registerIdeaGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "idea_get",
    {
      title: "Get Idea",
      description:
        "Fetch one captured idea by slug or absolute path. Returns {paths:[file]} plus summary. Pass expand=true to include the file body.",
      inputSchema: IdeaGetInput.shape,
    },
    async (args: z.infer<typeof IdeaGetInput>) => {
      return runTool(
        async () => {
          const parsed = IdeaGetInput.parse(args);
          let path: string;
          if (parsed.path !== undefined) {
            path = parsed.path;
          } else {
            // Zod refine guarantees slug is defined when path is absent.
            const slug = parsed.slug!;
            const row = queryRow(
              deps.globalDb,
              "SELECT path FROM ideas WHERE slug = ? ORDER BY created_at DESC LIMIT 1",
              IdeaPathRowSchema,
              [slug],
            );
            if (!row) throw new McpError("E_NOT_FOUND", `no idea with slug "${parsed.slug}"`);
            path = row.path;
          }

          const canonical = await assertInsideAllowedRoot(
            path,
            deps.config.workspace.allowed_roots,
          );
          let body: string;
          try {
            body = await readFile(canonical, "utf8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              throw new McpError("E_NOT_FOUND", `idea file missing: ${canonical}`);
            }
            throw err;
          }

          return success(
            [canonical],
            `Fetched idea at ${canonical} (${body.length} bytes).`,
            parsed.expand
              ? { content: body }
              : { expand_hint: "Call idea_get with expand=true to include the file body." },
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
