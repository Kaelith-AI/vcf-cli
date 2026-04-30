// portfolio_status — project scope.
//
// Returns this project's current state (from project.state) plus last-updated
// timestamp and a next-action hint derived from the state. No LLM calls; a
// pure DB read.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import type { ProjectState } from "../db/project.js";

const PortfolioStatusInput = z
  .object({
    expand: z.boolean().default(false),
  })
  .strict();

const NEXT_ACTION: Record<ProjectState, string> = {
  draft: "Run plan_context then plan_save to produce the plan.",
  planning: "Plan is in progress — call plan_save when ready.",
  building: "Builder is active. Run test_generate / test_execute on completion.",
  testing: "Tests running; on green, kick off review_prepare for stage 1.",
  reviewing: "Review in progress. Check review_history for current verdict.",
  shipping: "Audit passed, build artifacts queued.",
  shipped: "Released. Mark done or spin up a new iteration.",
};

export function registerPortfolioStatus(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "portfolio_status",
    {
      title: "Portfolio Status",
      description:
        "Return this project's current lifecycle state, last-updated timestamp, and next-action hint. Pure DB read; no LLM.",
      inputSchema: PortfolioStatusInput.shape,
    },
    async (args: z.infer<typeof PortfolioStatusInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError(
              "E_STATE_INVALID",
              "portfolio_status requires project scope — server booted without a project DB",
            );
          }
          const parsed = PortfolioStatusInput.parse(args);
          const row = deps.projectDb
            .prepare(
              `SELECT name, root_path, state, updated_at, spec_path FROM project WHERE id = 1`,
            )
            .get() as
            | {
                name: string;
                root_path: string;
                state: ProjectState;
                updated_at: number;
                spec_path: string | null;
              }
            | undefined;
          if (!row) {
            throw new McpError("E_NOT_FOUND", "project row missing — run vcf init to re-scaffold");
          }
          const summary = `${row.name}: state=${row.state}; next → ${NEXT_ACTION[row.state]}`;
          const payload = success([row.root_path], summary, {
            ...(parsed.expand
              ? {
                  content: {
                    name: row.name,
                    root_path: row.root_path,
                    state: row.state,
                    updated_at_iso: new Date(row.updated_at).toISOString(),
                    spec_path: row.spec_path,
                    next_action: NEXT_ACTION[row.state],
                  },
                }
              : {}),
          });

          return payload;
        },
        (payload) => {
          const pr = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
            | { root_path: string }
            | undefined;
          writeAudit(deps.globalDb, {
            tool: "portfolio_status",
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
