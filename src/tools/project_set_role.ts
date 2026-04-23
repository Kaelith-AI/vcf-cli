// project_set_role — global-scope MCP tool. Meta-operation that designates
// a project as PM (admin) or reverts to standard. PM-elevation unlocks the
// cross-project admin tools (project_move / project_rename / project_relocate)
// inside that project's MCP sessions.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { setProjectRole } from "../util/projectRegistry.js";

const ProjectSetRoleInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(128)
      .describe("registered project slug"),
    role: z
      .enum(["standard", "pm"])
      .describe("'pm' unlocks cross-project admin tools in that project's sessions; 'standard' is the default"),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectSetRoleArgs = z.infer<typeof ProjectSetRoleInput>;

export function registerProjectSetRole(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_set_role",
    {
      title: "Set Project Admin Role",
      description:
        "Designate a project as PM (admin) or revert to standard. A PM project sees project_move / project_rename / project_relocate tools in its MCP sessions; a standard project does not. Multiple PM projects are allowed.",
      inputSchema: ProjectSetRoleInput,
    },
    async (args: ProjectSetRoleArgs) => {
      return runTool(
        async () => {
          const parsed = ProjectSetRoleInput.parse(args);
          const changed = setProjectRole(deps.globalDb, parsed.slug, parsed.role);
          if (!changed) {
            throw new McpError(
              "E_NOT_FOUND",
              `no registered project with slug '${parsed.slug}'`,
            );
          }
          const summary = `Set project '${parsed.slug}' role to '${parsed.role}'.`;
          return success([], summary, {
            ...(parsed.expand
              ? { content: { slug: parsed.slug, role: parsed.role } }
              : {}),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "project_set_role",
            scope: "global",
            project_root: null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}
