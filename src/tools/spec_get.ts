// spec_get — global scope.
//
// Fetch a saved spec by slug or absolute path; re-validated against
// allowed_roots before read. Mirrors idea_get.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const SpecGetInput = z
  .object({
    slug: z.string().min(1).max(128).optional(),
    path: z.string().min(1).optional(),
    expand: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.slug !== undefined || v.path !== undefined, {
    message: "spec_get requires either slug or path",
  });

export function registerSpecGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "spec_get",
    {
      title: "Get Spec",
      description:
        "Fetch one spec by slug or absolute path. Returns {paths:[file]}; expand=true to include the body.",
      inputSchema: SpecGetInput.shape,
    },
    async (args: z.infer<typeof SpecGetInput>) => {
      return runTool(async () => {
        const parsed = SpecGetInput.parse(args);
        let path: string;
        if (parsed.path !== undefined) {
          path = parsed.path;
        } else {
          // Zod refine guarantees slug is defined when path is absent.
          const slug = parsed.slug!;
          const row = deps.globalDb
            .prepare("SELECT path FROM specs WHERE slug = ? ORDER BY created_at DESC LIMIT 1")
            .get(slug) as unknown as { path: string } | undefined;
          if (!row) throw new McpError("E_NOT_FOUND", `no spec with slug "${slug}"`);
          path = row.path;
        }
        const canonical = await assertInsideAllowedRoot(path, deps.config.workspace.allowed_roots);
        let body: string;
        try {
          body = await readFile(canonical, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new McpError("E_NOT_FOUND", `spec file missing: ${canonical}`);
          }
          throw err;
        }
        const payload = success(
          [canonical],
          `Fetched spec at ${canonical} (${body.length} bytes).`,
          parsed.expand
            ? { content: body }
            : { expand_hint: "Call spec_get with expand=true to include the file body." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "spec_get",
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
