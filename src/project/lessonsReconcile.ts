// Followup #42 — drift-repair for the per-project → global lessons mirror.
//
// Every project-level lesson carries a `mirror_status` ('pending' |
// 'mirrored' | 'failed'). `lesson_log_add` flips it to 'mirrored' on
// success or 'failed' on a DB error. Rows stuck in pending/failed never
// reach cross-project search until an operator runs `vcf lessons
// reconcile`, which calls into this module.
//
// Writes are idempotent thanks to `uniq_global_lessons_identity` on
// (project_root, title, created_at) in global-lessons migration v2 —
// `INSERT OR IGNORE` quietly succeeds when the row is already present,
// so the reconcile can be re-run safely.

import type { DatabaseSync } from "node:sqlite";

export interface ReconcileInput {
  projectDb: DatabaseSync;
  projectRoot: string;
  globalDb: DatabaseSync;
  /** Maximum pending/failed rows to drain in one call. Defaults to all. */
  limit?: number;
}

export interface ReconcileResult {
  attempted: number;
  mirrored: number;
  already_present: number;
  failed: number;
  failures: Array<{ lesson_id: number; error: string }>;
}

interface PendingRow {
  id: number;
  title: string;
  context: string | null;
  observation: string;
  actionable_takeaway: string | null;
  scope: string;
  stage: string | null;
  tags_json: string;
  created_at: number;
}

/**
 * Drain lessons whose mirror_status ≠ 'mirrored' from the project DB into
 * the global mirror. Uses INSERT OR IGNORE so an already-present row
 * short-circuits cleanly. Updates the project.db row's mirror_status
 * inside the same logical pass.
 */
export function reconcileLessons(input: ReconcileInput): ReconcileResult {
  const { projectDb, projectRoot, globalDb } = input;
  const limit = input.limit ?? 10_000;

  const pendingStmt = projectDb.prepare(
    `SELECT id, title, context, observation, actionable_takeaway, scope, stage,
            tags_json, created_at
       FROM lessons
      WHERE mirror_status != 'mirrored'
      ORDER BY created_at ASC
      LIMIT ?`,
  );
  const pending = pendingStmt.all(limit) as unknown as PendingRow[];

  const upsertGlobal = globalDb.prepare(
    `INSERT OR IGNORE INTO lessons
       (project_root, title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const existsGlobal = globalDb.prepare(
    `SELECT 1 FROM lessons WHERE project_root = ? AND title = ? AND created_at = ? LIMIT 1`,
  );
  const markMirrored = projectDb.prepare(
    `UPDATE lessons SET mirror_status = 'mirrored' WHERE id = ?`,
  );
  const markFailed = projectDb.prepare(
    `UPDATE lessons SET mirror_status = 'failed' WHERE id = ?`,
  );

  const result: ReconcileResult = {
    attempted: pending.length,
    mirrored: 0,
    already_present: 0,
    failed: 0,
    failures: [],
  };

  for (const row of pending) {
    try {
      const info = upsertGlobal.run(
        projectRoot,
        row.title,
        row.context,
        row.observation,
        row.actionable_takeaway,
        row.scope,
        row.stage,
        row.tags_json,
        row.created_at,
      );
      if (info.changes === 1) {
        result.mirrored += 1;
      } else {
        // INSERT OR IGNORE dropped it because the identity row already
        // existed. Confirm, then mark the project row mirrored so it
        // stops showing up in subsequent reconcile passes.
        const seen = existsGlobal.get(projectRoot, row.title, row.created_at);
        if (seen) result.already_present += 1;
      }
      markMirrored.run(row.id);
    } catch (err) {
      result.failed += 1;
      result.failures.push({
        lesson_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        markFailed.run(row.id);
      } catch {
        /* non-fatal — reconcile is best-effort */
      }
    }
  }

  return result;
}
