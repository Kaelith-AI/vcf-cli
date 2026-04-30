// project_rename — PM-only MCP tool. See src/project/rename.ts for core semantics.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { renameProject, RenameProjectError } from "../project/rename.js";

const ProjectRenameInput = z
  .object({
    slug: z.string().min(1).max(128).describe("current registered project slug"),
    new_name: z
      .string()
      .min(1)
      .max(128)
      .describe("new display name; slugs into the new state-dir under ~/.vcf/projects/"),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectRenameArgs = z.infer<typeof ProjectRenameInput>;

export function registerProjectRename(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_rename",
    {
      title: "Rename Project (PM)",
      description:
        "Change a project's display name. The slug derived from new_name keys the state-dir under ~/.vcf/projects/, so this also renames the state-dir (atomic, with rollback on DB failure). root_path is NOT touched. PM-only.",
      inputSchema: ProjectRenameInput,
    },
    async (args: ProjectRenameArgs) => {
      return runTool(
        async () => {
          const parsed = ProjectRenameInput.parse(args);
          try {
            const r = await renameProject({
              slug: parsed.slug,
              newName: parsed.new_name,
              globalDb: deps.globalDb,
              ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
            });
            const summary =
              r.oldSlug === r.newSlug
                ? `Renamed project display name '${r.oldName}' → '${r.newName}' (slug unchanged: ${r.newSlug}).`
                : `Renamed project '${r.oldSlug}' → '${r.newSlug}' (display '${r.oldName}' → '${r.newName}'); state-dir ${r.stateDirRenamed ? "renamed" : "absent"}.`;
            return success([], summary, {
              ...(parsed.expand
                ? {
                    content: {
                      old_slug: r.oldSlug,
                      new_slug: r.newSlug,
                      old_name: r.oldName,
                      new_name: r.newName,
                      state_dir_renamed: r.stateDirRenamed,
                    },
                  }
                : {}),
            });
          } catch (e) {
            if (e instanceof RenameProjectError) {
              throw new McpError(e.code, e.message);
            }
            throw e;
          }
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "project_rename",
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
