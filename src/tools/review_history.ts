// review_history — project scope.
//
// Query review_runs across all stages + types. Used by portfolio_status
// (indirectly) and by the client to answer "where did we last pass Stage 3?".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const ReviewHistoryInput = z
  .object({
    type: z.enum(["code", "security", "production"]).optional(),
    stage: z.number().int().min(1).max(9).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerReviewHistory(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_history",
    {
      title: "Review History",
      description:
        "Return review_runs rows (run_id, type, stage, status, verdict, started_at, finished_at, report_path), newest first. Optional type + stage filters.",
      inputSchema: ReviewHistoryInput.shape,
    },
    async (args: z.infer<typeof ReviewHistoryInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "review_history requires project scope");
        }
        const parsed = ReviewHistoryInput.parse(args);
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (parsed.type !== undefined) {
          clauses.push("type = ?");
          params.push(parsed.type);
        }
        if (parsed.stage !== undefined) {
          clauses.push("stage = ?");
          params.push(parsed.stage);
        }
        const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
        const rows = deps.projectDb
          .prepare(
            `SELECT id, type, stage, status, verdict, started_at, finished_at, report_path
             FROM review_runs ${where}
             ORDER BY started_at DESC LIMIT ?`,
          )
          .all(...params, parsed.limit) as Array<{
          id: string;
          type: string;
          stage: number;
          status: string;
          verdict: string | null;
          started_at: number;
          finished_at: number | null;
          report_path: string | null;
        }>;

        const payload = success(
          rows.map((r) => r.report_path).filter((x): x is string => typeof x === "string"),
          `review_history: ${rows.length} row(s)${parsed.type ? " type=" + parsed.type : ""}${
            parsed.stage !== undefined ? " stage=" + parsed.stage : ""
          }.`,
          parsed.expand
            ? { content: { runs: rows } }
            : { expand_hint: "Call review_history with expand=true for the full list." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "review_history",
            scope: "project",
            project_root: readProjectRoot(deps),
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

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
