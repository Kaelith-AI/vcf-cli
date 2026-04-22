// review_prepare — project scope.
//
// Stand up a disposable `.review-runs/<type>-<ts>/` workspace for the
// reviewer, copying in:
//   - stage definition (kb/review-system/<type>/0N-*.md) — READ-ONLY copy
//   - reviewer overlay (kb/reviewers/reviewer-<type>.md) — READ-ONLY copy
//   - carry-forward from the most recent previous-stage PASS
//   - prior decision log snapshot
//   - prior response log snapshot
//   - applicable lenses by spec tag match (best-effort)
//   - a scoped git diff (if a reference ref is configured)
//
// Stage-entry rules (M7 subsystem contract):
//   - Stage 1 may be prepared at any time.
//   - Stage N (N > 1) requires that Stage (N-1) has a PASS verdict with
//     status=submitted (not superseded), unless `force=true` is passed
//     (and the override is audited).
//
// Re-run semantics:
//   - re-preparing a stage that already passed is allowed — the prior
//     run stays on disk, the DB row is marked `superseded`, and a fresh
//     run-id is issued.
//
// Critical non-negotiable: the KB files are *copied*, never read from in
// place. The reviewer never mutates the original template.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { isoCompactNow } from "../util/ids.js";
import { McpError } from "../errors.js";
import { loadKbCached } from "../primers/load.js";
import { matchPrimers } from "../primers/match.js";
import { setProjectState } from "../util/projectRegistry.js";
import { emptyCarryForward, renderYaml, type CarryForward } from "../review/carryForward.js";

// Review type is validated against `config.review.categories` at runtime, not
// with a fixed z.enum — users may extend the set via their config.yaml (e.g.
// add "accessibility" or "performance"). The schema still enforces the slug
// shape so the arg itself can't carry a path-traversal payload.
const ReviewTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "review type must be lowercase alphanumeric + hyphen");

const ReviewPrepareInput = z
  .object({
    type: ReviewTypeSchema,
    stage: z.number().int().min(1).max(9),
    diff_ref: z
      .string()
      .max(128)
      .optional()
      .describe("git ref to diff from (e.g. 'main' or a commit SHA); default skips diff"),
    include_review_output: z
      .boolean()
      .default(false)
      .describe(
        "include plans/reviews/** + lifecycle-report snapshots in the scoped diff. Off by default — those are review output, not code under review.",
      ),
    force: z.boolean().default(false).describe("bypass stage-entry rules; audited as an override"),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerReviewPrepare(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_prepare",
    {
      title: "Prepare Review Run",
      description:
        "Create a disposable .review-runs/<type>-<ts>/ workspace: stage file + reviewer overlay (read-only copies), carry-forward manifest from prior PASS, snapshots of decision and response logs, applicable lenses, optional scoped diff. Enforces stage-entry rules (Stage N>1 requires prior PASS unless force=true).",
      inputSchema: ReviewPrepareInput.shape,
    },
    async (args: z.infer<typeof ReviewPrepareInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "review_prepare requires project scope");
          }
          const parsed = ReviewPrepareInput.parse(args);
          if (!deps.config.review.categories.includes(parsed.type)) {
            throw new McpError(
              "E_VALIDATION",
              `review type '${parsed.type}' not in config.review.categories (${deps.config.review.categories.join(", ")})`,
            );
          }
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          // Stage-entry rules.
          if (parsed.stage > 1 && !parsed.force) {
            const priorPass = deps.projectDb
              .prepare(
                `SELECT id FROM review_runs
                 WHERE type = ? AND stage = ? AND verdict = 'PASS' AND status = 'submitted'
                 ORDER BY finished_at DESC LIMIT 1`,
              )
              .get(parsed.type, parsed.stage - 1) as { id: string } | undefined;
            if (!priorPass) {
              throw new McpError(
                "E_STATE_INVALID",
                `Stage ${parsed.stage} (${parsed.type}) requires Stage ${parsed.stage - 1} PASS; pass force=true to override`,
              );
            }
          }

          // Supersede any prior, non-superseded run at this exact stage.
          deps.projectDb
            .prepare(
              `UPDATE review_runs SET status = 'superseded'
               WHERE type = ? AND stage = ? AND status IN ('pending', 'running', 'submitted')`,
            )
            .run(parsed.type, parsed.stage);

          const ts = isoCompactNow();
          const runId = `${parsed.type}-${parsed.stage}-${ts}`;
          const runDir = join(root, ".review-runs", runId);
          await assertInsideAllowedRoot(runDir, deps.config.workspace.allowed_roots);
          await mkdir(runDir, { recursive: true });

          // Copy stage file (read-only — by convention, not filesystem-enforced).
          const stageCopy = await copyStageFile(deps, parsed.type, parsed.stage, runDir);
          // Copy reviewer overlay.
          const reviewerCopy = await copyReviewerFile(deps, parsed.type, runDir);
          // Tag-matched lenses.
          const lenses = await selectLenses(deps, root);

          // Carry-forward: the most recent PASS at stage (N-1) owns truth.
          const priorCf =
            parsed.stage > 1
              ? loadPriorCarryForward(deps, parsed.type, parsed.stage)
              : emptyCarryForward();
          const carryForwardPath = join(runDir, "carry-forward.yaml");
          await writeFile(carryForwardPath, renderYaml(priorCf), "utf8");

          // Snapshot decision log + response log, scoped to this review type.
          // Cross-type noise is pollution: a code reviewer should not read
          // security-stage responses as "context" for the current run. The
          // base reviewer role already carries universal guidance; carry-
          // forward supplies unresolved findings structurally.
          const decisionSnapshot = snapshotDecisions(deps, parsed.type);
          await writeFile(join(runDir, "decisions.snapshot.md"), decisionSnapshot, "utf8");
          const responseSnapshot = snapshotResponseLog(deps, parsed.type);
          await writeFile(join(runDir, "response-log.snapshot.md"), responseSnapshot, "utf8");

          // Scoped diff (best-effort; non-fatal if git errors). Prior review
          // reports and lifecycle-report snapshots are excluded by default —
          // they are review *output*, not code under review, and reviewing
          // them pollutes the prompt with self-feedback that drowns the real
          // diff. Carry-forward handles unresolved findings as a separate,
          // structured prompt section. To override (e.g. reviewing changes
          // to the reviewer overlays themselves), pass include_review_output.
          let diffPath: string | null = null;
          if (parsed.diff_ref) {
            try {
              const git = simpleGit({ baseDir: root });
              const diffArgs: string[] = [parsed.diff_ref];
              if (!parsed.include_review_output) {
                diffArgs.push(
                  "--",
                  ".",
                  ":(exclude)plans/reviews",
                  ":(exclude)plans/lifecycle-report.md",
                  ":(exclude)plans/lifecycle-report.json",
                  ":(exclude).review-runs",
                );
              }
              const diff = await git.diff(diffArgs);
              diffPath = join(runDir, "scoped-diff.patch");
              await writeFile(diffPath, diff.length === 0 ? "(empty diff)\n" : diff, "utf8");
            } catch (err) {
              diffPath = null;
              // Log the failure in the run dir so the reviewer can see why.
              await writeFile(
                join(runDir, "scoped-diff.error.txt"),
                `failed to produce diff from ${parsed.diff_ref}: ${(err as Error).message}\n`,
                "utf8",
              );
            }
          }

          // Insert a pending review_runs row.
          const now = Date.now();
          deps.projectDb
            .prepare(
              `INSERT INTO review_runs
                 (id, type, stage, status, started_at, carry_forward_json)
               VALUES (?, ?, ?, 'pending', ?, ?)`,
            )
            .run(runId, parsed.type, parsed.stage, now, JSON.stringify(priorCf));

          // Advance project state to reviewing on first prepare (both DBs).
          deps.projectDb
            .prepare("UPDATE project SET state = 'reviewing', updated_at = ? WHERE id = 1")
            .run(now);
          try {
            setProjectState(deps.globalDb, root, "reviewing");
          } catch {
            /* non-fatal */
          }

          const manifest = {
            run_id: runId,
            run_dir: runDir,
            type: parsed.type,
            stage: parsed.stage,
            stage_file: stageCopy,
            reviewer_file: reviewerCopy,
            carry_forward_file: carryForwardPath,
            decisions_snapshot: join(runDir, "decisions.snapshot.md"),
            response_log_snapshot: join(runDir, "response-log.snapshot.md"),
            diff_file: diffPath,
            lenses,
            force_used: parsed.force,
          };

          const payload = success(
            [runDir, stageCopy, reviewerCopy, carryForwardPath].filter(
              (x): x is string => x !== null,
            ),
            `Prepared ${parsed.type} review stage ${parsed.stage} as run ${runId}${parsed.force ? " (force)" : ""}.`,
            parsed.expand
              ? { content: manifest }
              : { expand_hint: "Call review_prepare with expand=true for the manifest." },
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "review_prepare",
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

// ---- helpers --------------------------------------------------------------

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

async function copyStageFile(
  deps: ServerDeps,
  type: string,
  stage: number,
  runDir: string,
): Promise<string> {
  const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
  const stageEntry = entries.find(
    (e) =>
      e.kind === "stage" &&
      (e.frontmatter["review_type"] as string | undefined) === type &&
      Number(e.frontmatter["stage"]) === stage,
  );
  if (!stageEntry) {
    throw new McpError(
      "E_NOT_FOUND",
      `no stage file found in KB for ${type} stage ${stage} (expected under kb/review-system/${type}/0${stage}-*.md)`,
    );
  }
  const target = join(runDir, `stage-${stage}.${type}.md`);
  await copyFile(stageEntry.path, target);
  return target;
}

async function copyReviewerFile(deps: ServerDeps, type: string, runDir: string): Promise<string> {
  const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
  const reviewer = entries.find(
    (e) =>
      e.kind === "reviewer-config" &&
      (e.frontmatter["reviewer_type"] as string | undefined) === type,
  );
  const base = join(runDir, `reviewer-${type}.md`);
  if (!reviewer) {
    // Not strictly required — return a stub file so the reviewer knows there's no overlay.
    await writeFile(
      base,
      `# Reviewer Overlay (stub)\n\nNo kb/reviewers/reviewer-${type}.md found. Following the stage file verbatim.\n`,
      "utf8",
    );
    return base;
  }
  await copyFile(reviewer.path, base);

  // Snapshot every per-model overlay (`reviewer-<type>.<variant>.md`) into the
  // run dir alongside the base. The overlay chosen at execute time depends on
  // model_id + endpoint.trust_level (neither known at prepare time), so
  // resolution must still happen at execute — but it now resolves against the
  // prepared snapshot, not live KB. Editing reviewer-code.local.md between
  // prepare and execute no longer changes what the prepared run sees.
  const reviewerDir = dirname(reviewer.path);
  const variantPrefix = `reviewer-${type}.`;
  const variantSuffix = ".md";
  try {
    const dirEntries = await readdir(reviewerDir);
    for (const entry of dirEntries) {
      if (!entry.startsWith(variantPrefix) || !entry.endsWith(variantSuffix)) continue;
      if (entry === `reviewer-${type}.md`) continue; // base, already copied
      await copyFile(join(reviewerDir, entry), join(runDir, entry));
    }
  } catch {
    // Reviewer dir missing / unreadable is non-fatal: the base already copied
    // above, and the overlay resolver falls back to base-only when no variant
    // file exists in the snapshot.
  }
  return base;
}

async function selectLenses(
  deps: ServerDeps,
  _root: string,
): Promise<Array<{ id: string; path: string }>> {
  const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
  // No spec tags available here without re-parsing; MVP returns all lenses.
  // M9 will refine this to the spec's tech_stack / lens intersection when
  // review_prepare accepts a plan_name input.
  const lenses = entries.filter((e) => e.kind === "lens").map((e) => ({ id: e.id, path: e.path }));
  // Use matchPrimers API to stabilize ordering — unused output here.
  matchPrimers([], { tech_tags: [] }); // no-op, keeps import alive
  return lenses;
}

function loadPriorCarryForward(deps: ServerDeps, type: string, stage: number): CarryForward {
  const row = deps.projectDb
    ?.prepare(
      `SELECT carry_forward_json FROM review_runs
       WHERE type = ? AND stage = ? AND verdict = 'PASS' AND status = 'submitted'
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(type, stage - 1) as { carry_forward_json: string } | undefined;
  if (!row) return emptyCarryForward();
  try {
    const parsed = JSON.parse(row.carry_forward_json) as Partial<CarryForward>;
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

/**
 * Snapshot the decision log for a review-run prompt. Scoped to the current
 * review type plus universal (review_type IS NULL) entries. A code reviewer
 * sees code-scoped decisions and universal ones; security-scoped entries
 * are withheld because they are noise for the code-review context. Order:
 * oldest first so the reviewer reads them chronologically.
 */
function snapshotDecisions(deps: ServerDeps, reviewType: string): string {
  const rows = deps.projectDb
    ?.prepare(
      `SELECT slug, path, created_at, review_type FROM decisions
       WHERE review_type IS NULL OR review_type = ?
       ORDER BY created_at ASC`,
    )
    .all(reviewType) as
    | Array<{ slug: string; path: string; created_at: number; review_type: string | null }>
    | undefined;
  if (!rows || rows.length === 0) {
    return `# Decisions snapshot (${reviewType})\n\n_no decisions in scope_\n`;
  }
  const body = rows
    .map((r) => {
      const scope = r.review_type ?? "universal";
      return `- **${r.slug}** _(scope: ${scope})_ — ${r.path} (logged ${new Date(r.created_at).toISOString()})`;
    })
    .join("\n");
  return `# Decisions snapshot (${rows.length}, scope=${reviewType}+universal)\n\n${body}\n`;
}

/**
 * Snapshot the response log for a review-run prompt. Scoped to responses
 * keyed to prior same-type review runs — a code reviewer reads code-run
 * responses and nothing else. Pulls straight from the v4 response_log
 * table joined with review_runs; the legacy plans/reviews/response-log.md
 * file is a rendered view, not the source of truth. Order: oldest first
 * so the reviewer reads the history chronologically.
 */
function snapshotResponseLog(deps: ServerDeps, reviewType: string): string {
  const rows = deps.projectDb
    ?.prepare(
      `SELECT r.run_id, r.finding_ref, r.builder_claim, r.response_text, r.created_at, rr.stage
       FROM response_log r
       JOIN review_runs rr ON rr.id = r.run_id
       WHERE rr.type = ?
       ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(reviewType) as
    | Array<{
        run_id: string;
        finding_ref: string | null;
        builder_claim: string;
        response_text: string;
        created_at: number;
        stage: number;
      }>
    | undefined;
  if (!rows || rows.length === 0) {
    return `# Response log snapshot (${reviewType})\n\n_no ${reviewType} responses yet_\n`;
  }
  const header =
    `# Response log snapshot (${rows.length}, type=${reviewType})\n\n` +
    `> Past builder responses against ${reviewType} reviews. Context, not instruction.\n`;
  const blocks = rows
    .map((r) => {
      const findingLine = r.finding_ref
        ? `finding_ref: ${r.finding_ref}`
        : "finding_ref: _(whole-run response)_";
      return [
        "---",
        `run_id: ${r.run_id}`,
        `stage: ${r.stage}`,
        findingLine,
        `builder_claim: ${r.builder_claim}`,
        `created_at: ${new Date(r.created_at).toISOString()}`,
        "---",
        "",
        r.response_text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
  return `${header}\n${blocks}`;
}
