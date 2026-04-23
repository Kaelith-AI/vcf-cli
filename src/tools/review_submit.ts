// review_submit — project scope.
//
// Close out a pending review_runs row by writing the final report to
// plans/reviews/<type>/<stage>-<ts>.md and persisting a new carry-forward
// into the DB. On PASS with config.review.auto_advance_on_pass=true, we
// leave project.state in 'reviewing' until the user explicitly advances
// (via a future ship trigger) — "auto-advance" in the plan refers to
// unlocking the *next stage's* review_prepare, not to transitioning out
// of reviewing entirely.
//
// The actual persistence lives in `src/review/submitCore.ts` so
// `review_execute` (server-side LLM path) can share it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { CARRY_FORWARD_SECTIONS, type CarryForwardSection } from "../review/carryForward.js";
import { persistReviewSubmission, VERDICTS, type ReviewRunRow } from "../review/submitCore.js";
import { resolveOutputs } from "../util/outputs.js";
import { projectRunsDir } from "../project/stateDir.js";
import { join } from "node:path";

const FindingSchema = z
  .object({
    file: z.string().max(512).optional(),
    line: z.number().int().nonnegative().optional(),
    severity: z.enum(["info", "warning", "blocker"]),
    description: z.string().min(4).max(4_000),
    required_change: z.string().max(4_000).optional(),
  })
  .strict();

const CarryForwardEntryInput = z
  .object({
    section: z.enum(
      CARRY_FORWARD_SECTIONS as readonly [CarryForwardSection, ...CarryForwardSection[]],
    ),
    severity: z.enum(["info", "warning", "blocker"]),
    text: z.string().min(4).max(2_000),
  })
  .strict();

const ReviewSubmitInput = z
  .object({
    run_id: z.string().min(3).max(128),
    verdict: z.enum(VERDICTS),
    summary: z.string().min(4).max(4_000),
    findings: z.array(FindingSchema).max(200).default([]),
    carry_forward: z.array(CarryForwardEntryInput).max(120).default([]),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerReviewSubmit(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_submit",
    {
      title: "Submit Review Verdict",
      description:
        "Close a pending review_runs row: write report to plans/reviews/<type>/<stage>-<ts>.md, update DB with verdict + carry-forward. Verdict ∈ {PASS, NEEDS_WORK, BLOCK}.",
      inputSchema: ReviewSubmitInput.shape,
    },
    async (args: z.infer<typeof ReviewSubmitInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "review_submit requires project scope");
          }
          const parsed = ReviewSubmitInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const run = deps.projectDb
            .prepare(
              `SELECT id, type, stage, status, carry_forward_json FROM review_runs WHERE id = ?`,
            )
            .get(parsed.run_id) as ReviewRunRow | undefined;
          if (!run) {
            throw new McpError("E_NOT_FOUND", `review run "${parsed.run_id}" does not exist`);
          }

          const slug = deps.resolved.projectSlug;
          if (!slug) {
            throw new McpError(
              "E_STATE_INVALID",
              "review_submit requires a resolved project slug (project scope)",
            );
          }
          const runDir = join(projectRunsDir(slug, deps.homeDir), run.id);
          const outputs = resolveOutputs(root, deps.config);
          const { reportPath, merged } = await persistReviewSubmission({
            projectDb: deps.projectDb,
            allowedRoots: deps.config.workspace.allowed_roots,
            reviewsDir: outputs.reviewsDir,
            runDir,
            run,
            submission: {
              verdict: parsed.verdict,
              summary: parsed.summary,
              findings: parsed.findings,
              carry_forward: parsed.carry_forward,
            },
          });

          const payload = success(
            [reportPath],
            `Submitted ${run.type} stage ${run.stage} verdict=${parsed.verdict} for ${run.id}.`,
            parsed.expand
              ? {
                  content: {
                    run_id: run.id,
                    report_path: reportPath,
                    verdict: parsed.verdict,
                    carry_forward: merged,
                  },
                }
              : {
                  expand_hint: "Call review_submit with expand=true for the full content payload.",
                },
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "review_submit",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
