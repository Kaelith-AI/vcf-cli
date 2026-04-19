// review_submit — project scope.
//
// Close out a pending review_runs row by writing the final report to
// plans/reviews/<type>/<stage>-<ts>.md and persisting a new carry-forward
// into the DB. On PASS with config.review.auto_advance_on_pass=true, we
// leave project.state in 'reviewing' until the user explicitly advances
// (via a future ship trigger) — "auto-advance" in the plan refers to
// unlocking the *next stage's* review_prepare, not to transitioning out
// of reviewing entirely.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import {
  CARRY_FORWARD_SECTIONS,
  type CarryForward,
  type CarryForwardSection,
  emptyCarryForward,
  mergeCarryForward,
  renderYaml,
} from "../review/carryForward.js";

const VERDICTS = ["PASS", "NEEDS_WORK", "BLOCK"] as const;

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
      return runTool(async () => {
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
          .get(parsed.run_id) as
          | { id: string; type: string; stage: number; status: string; carry_forward_json: string }
          | undefined;
        if (!run) {
          throw new McpError("E_NOT_FOUND", `review run "${parsed.run_id}" does not exist`);
        }
        if (run.status !== "pending" && run.status !== "running") {
          throw new McpError(
            "E_STATE_INVALID",
            `review run "${parsed.run_id}" is ${run.status}; cannot submit`,
          );
        }

        // Parse the inherited carry-forward; merge in the new entries.
        const prior = parseCarryForward(run.carry_forward_json);
        const next = groupCarryForward(parsed.carry_forward, run.stage);
        const merged = mergeCarryForward(prior, next);

        // Write the report.
        const reportsDir = join(root, "plans", "reviews", run.type);
        await assertInsideAllowedRoot(reportsDir, deps.config.workspace.allowed_roots);
        await mkdir(reportsDir, { recursive: true });
        const now = Date.now();
        const ts = new Date(now)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+/, "")
          .replace(/Z$/, "Z");
        const reportPath = join(reportsDir, `stage-${run.stage}-${ts}.md`);
        await writeFile(reportPath, renderReport(run, parsed, merged), "utf8");

        // Persist the merged carry-forward to the run dir (alongside the
        // run workspace) so `.review-runs/<id>/carry-forward.yaml` reflects
        // the post-submit state.
        const runWorkspace = join(root, ".review-runs", run.id);
        if (existsSync(runWorkspace)) {
          await writeFile(join(runWorkspace, "carry-forward.yaml"), renderYaml(merged), "utf8");
        }

        // Update DB row.
        deps.projectDb
          .prepare(
            `UPDATE review_runs
             SET status = 'submitted',
                 verdict = ?,
                 finished_at = ?,
                 report_path = ?,
                 carry_forward_json = ?
             WHERE id = ?`,
          )
          .run(parsed.verdict, now, reportPath, JSON.stringify(merged), run.id);

        // Project state stays 'reviewing' on PASS; only a future ship call
        // transitions out. On NEEDS_WORK / BLOCK we also stay reviewing.
        deps.projectDb.prepare("UPDATE project SET updated_at = ? WHERE id = 1").run(now);

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
            : { expand_hint: "Call review_submit with expand=true for the full content payload." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "review_submit",
            scope: "project",
            project_root: root,
            inputs: { ...parsed, summary: `<${parsed.summary.length} chars>` },
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

function parseCarryForward(raw: string): CarryForward {
  try {
    const parsed = JSON.parse(raw) as Partial<CarryForward>;
    return {
      architecture: parsed.architecture ?? [],
      verification: parsed.verification ?? [],
      security: parsed.security ?? [],
      compliance: parsed.compliance ?? [],
      supportability: parsed.supportability ?? [],
      release_confidence: parsed.release_confidence ?? [],
    };
  } catch {
    return emptyCarryForward();
  }
}

function groupCarryForward(
  entries: Array<{
    section: CarryForwardSection;
    severity: "info" | "warning" | "blocker";
    text: string;
  }>,
  stage: number,
): Partial<CarryForward> {
  const out: Partial<CarryForward> = {};
  for (const e of entries) {
    if (!out[e.section]) out[e.section] = [];
    out[e.section]!.push({ stage, severity: e.severity, text: e.text });
  }
  return out;
}

function renderReport(
  run: { id: string; type: string; stage: number },
  submit: z.infer<typeof ReviewSubmitInput>,
  cf: CarryForward,
): string {
  const parts: string[] = [];
  parts.push("---");
  parts.push(`type: review-report`);
  parts.push(`review_type: ${run.type}`);
  parts.push(`stage: ${run.stage}`);
  parts.push(`verdict: ${submit.verdict}`);
  parts.push(`run_id: ${run.id}`);
  parts.push(`created_at: ${new Date().toISOString()}`);
  parts.push("---");
  parts.push("");
  parts.push(`# ${run.type} — Stage ${run.stage} — ${submit.verdict}`);
  parts.push("");
  parts.push("## Summary");
  parts.push("");
  parts.push(submit.summary.trim());
  parts.push("");
  if (submit.findings.length > 0) {
    parts.push("## Findings");
    parts.push("");
    for (const f of submit.findings) {
      const loc = f.file
        ? `${f.file}${f.line !== undefined ? ":" + f.line : ""}`
        : "_location unspecified_";
      parts.push(`- **${f.severity}** — \`${loc}\` — ${f.description.trim()}`);
      if (f.required_change) parts.push(`  - required: ${f.required_change.trim()}`);
    }
    parts.push("");
  }
  parts.push("## Carry-forward");
  parts.push("");
  for (const section of CARRY_FORWARD_SECTIONS) {
    parts.push(`### ${section}`);
    parts.push("");
    if (cf[section].length === 0) {
      parts.push("_none_");
    } else {
      for (const e of cf[section]) {
        parts.push(`- (stage ${e.stage}, ${e.severity}) ${e.text.trim()}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n") + "\n";
}

// Silence unused-var if readFile import is ever dropped (it's used in other
// tools but not here). Re-export removed; the import is kept for future
// extensions that read prior reports from disk for additional context.
export /* readFile */ {};
void readFile; // lint appeasement — intentionally reference to avoid "unused"
