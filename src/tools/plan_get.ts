// plan_get — project scope.
//
// Fetch the three saved plan artifacts by plan name. Returns `paths` always;
// content only on expand=true.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { resolveOutputs } from "../util/outputs.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const PlanGetInput = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerPlanGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "plan_get",
    {
      title: "Get Plan",
      description:
        "Return the three plan artifact paths (plans/<name>-{plan,todo,manifest}.md). Pass expand=true to include the bodies.",
      inputSchema: PlanGetInput.shape,
    },
    async (args: z.infer<typeof PlanGetInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "plan_get requires project scope");
          }
          const parsed = PlanGetInput.parse(args);
          const row = deps.projectDb.prepare("SELECT root_path FROM project WHERE id=1").get() as
            | { root_path: string }
            | undefined;
          if (!row) throw new McpError("E_STATE_INVALID", "project row missing");

          const plansDir = resolveOutputs(row.root_path, deps.config).plansDir;
          const paths = {
            plan_md: join(plansDir, `${parsed.name}-plan.md`),
            todo_md: join(plansDir, `${parsed.name}-todo.md`),
            manifest_md: join(plansDir, `${parsed.name}-manifest.md`),
          };

          const found: string[] = [];
          const bodies: Record<string, string> = {};
          for (const [k, p] of Object.entries(paths)) {
            const canonical = await assertInsideAllowedRoot(p, deps.config.workspace.allowed_roots);
            if (!existsSync(canonical)) continue;
            found.push(canonical);
            if (parsed.expand) bodies[k] = await readFile(canonical, "utf8");
          }
          if (found.length === 0) {
            throw new McpError("E_NOT_FOUND", `no plan files for name "${parsed.name}"`);
          }

          const payload = success(
            found,
            `Found ${found.length}/3 plan file(s) for "${parsed.name}".`,
            {
              ...(parsed.expand
                ? { content: bodies }
                : { expand_hint: "Call plan_get with expand=true to include the bodies." }),
            },
          );
          return payload;
        },
        (payload) => {
          const pr = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
            | { root_path: string }
            | undefined;
          writeAudit(deps.globalDb, {
            tool: "plan_get",
            scope: "project",
            project_root: pr?.root_path ?? null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}
