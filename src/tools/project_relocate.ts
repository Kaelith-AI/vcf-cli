// project_relocate — PM-only MCP tool. See src/project/relocate.ts.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { relocateProject, RelocateProjectError } from "../project/relocate.js";

const ProjectRelocateInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(128)
      .describe("registered project slug"),
    new_path: z
      .string()
      .min(1)
      .describe("absolute path to re-point root_path at; the directory must already exist and live inside workspace.allowed_roots"),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectRelocateArgs = z.infer<typeof ProjectRelocateInput>;

export function registerProjectRelocate(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_relocate",
    {
      title: "Relocate Project Pointer (PM)",
      description:
        "Update the registered root_path for a project WITHOUT moving files. Use when the project directory has been moved externally (e.g., cloned into a new folder). For an actual directory copy/move, use project_move instead. PM-only.",
      inputSchema: ProjectRelocateInput,
    },
    async (args: ProjectRelocateArgs) => {
      return runTool(
        async () => {
          const parsed = ProjectRelocateInput.parse(args);
          try {
            const r = await relocateProject({
              slug: parsed.slug,
              newPath: parsed.new_path,
              allowedRoots: deps.config.workspace.allowed_roots,
              globalDb: deps.globalDb,
              ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
            });
            const summary =
              r.oldPath === r.newPath
                ? `Project '${r.slug}' was already at ${r.newPath}; no change.`
                : `Relocated project '${r.slug}' pointer: ${r.oldPath} → ${r.newPath}.`;
            return success([], summary, {
              ...(parsed.expand
                ? {
                    content: {
                      slug: r.slug,
                      old_path: r.oldPath,
                      new_path: r.newPath,
                    },
                  }
                : {}),
            });
          } catch (e) {
            if (e instanceof RelocateProjectError) {
              throw new McpError(e.code, e.message);
            }
            throw e;
          }
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "project_relocate",
            scope: "project",
            project_root: deps.resolved.projectRoot ?? null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}
