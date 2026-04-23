// project_move — PM-only MCP tool.
//
// Copies (or moves, with mode="move") a registered project's directory
// from its current root_path to `new_path`. Updates both the global
// registry and the project.db's project.root_path to the new location.
// See src/project/move.ts for the core semantics + rollback contract.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { moveProject, MoveProjectError } from "../project/move.js";

const ProjectMoveInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(128)
      .describe("registered project slug (kebab-case of name)"),
    new_path: z
      .string()
      .min(1)
      .describe("absolute path to move the project directory to; must live inside workspace.allowed_roots"),
    mode: z
      .enum(["copy", "move"])
      .default("copy")
      .describe("'copy' leaves the source directory intact; 'move' deletes it after copy+DB updates succeed"),
    force: z
      .boolean()
      .default(false)
      .describe("proceed even if new_path exists and is non-empty; files at the target that collide with the source are overwritten"),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectMoveArgs = z.infer<typeof ProjectMoveInput>;

export function registerProjectMove(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_move",
    {
      title: "Move Project Directory (PM)",
      description:
        "Copy or move a registered project's directory to new_path. Registry + project.db root_path are re-pointed atomically after the copy; on DB failure the copy is rolled back. PM-only: this tool is registered only when the current MCP session is rooted at a project with role='pm'.",
      inputSchema: ProjectMoveInput,
    },
    async (args: ProjectMoveArgs) => {
      return runTool(
        async () => {
          const parsed = ProjectMoveInput.parse(args);
          try {
            const r = await moveProject({
              slug: parsed.slug,
              newPath: parsed.new_path,
              mode: parsed.mode,
              force: parsed.force,
              allowedRoots: deps.config.workspace.allowed_roots,
              globalDb: deps.globalDb,
              ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
            });
            const summary =
              r.mode === "move"
                ? `Moved project '${r.slug}' from ${r.oldPath} to ${r.newPath}.`
                : `Copied project '${r.slug}' from ${r.oldPath} to ${r.newPath} (source retained).`;
            return success([r.newPath], summary, {
              ...(parsed.expand
                ? {
                    content: {
                      slug: r.slug,
                      old_path: r.oldPath,
                      new_path: r.newPath,
                      mode: r.mode,
                      source_delete_warning: r.sourceDeleteWarning,
                    },
                  }
                : {}),
            });
          } catch (e) {
            if (e instanceof MoveProjectError) {
              throw new McpError(e.code, e.message);
            }
            throw e;
          }
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "project_move",
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
