// Drain legacy per-project lessons + feedback rows to the global store.
//
// Context: before v8 of the project schema, lessons lived in both
// project.db (authoritative) and ~/.vcf/lessons.db (mirror), and feedback
// lived only in project.db. Followup #41 concluded that improvement-cycle
// data should be global-only. v8 drops the per-project tables; this helper
// runs BEFORE the v8 migration to preserve rows that would otherwise be
// lost.
//
// Idempotent: re-running against an already-drained DB is a no-op because
// the global schema has UNIQUE indexes on (project_root, title, created_at)
// for lessons and (project_root, note, created_at) for feedback. Repeated
// INSERT OR IGNORE calls silently skip duplicates.

import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as DBCtor } from "node:sqlite";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_GLOBAL_LESSONS_PATH = join(homedir(), ".vcf", "lessons.db");

interface LegacyLessonRow {
  title: string;
  context: string | null;
  observation: string;
  actionable_takeaway: string | null;
  scope: string;
  stage: string | null;
  tags_json: string;
  created_at: number;
}

interface LegacyFeedbackRow {
  note: string;
  stage: string | null;
  urgency: string | null;
  created_at: number;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function resolveGlobalPath(): string {
  const home = process.env.VCF_HOME;
  if (home && home.trim() !== "") return join(home, "lessons.db");
  return DEFAULT_GLOBAL_LESSONS_PATH;
}

function openGlobalForDrain(path: string): DatabaseSync {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  const db = new DBCtor(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Ensure the schema is current enough. The global migrations run when the
  // proper handle is opened later; for drain we only need `lessons` (v1) and
  // `feedback` (v3) tables present. Bootstrap them directly — idempotent and
  // matches the canonical migrations exactly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      project_root         TEXT NOT NULL,
      title                TEXT NOT NULL,
      context              TEXT,
      observation          TEXT NOT NULL,
      actionable_takeaway  TEXT,
      scope                TEXT NOT NULL CHECK (scope IN ('project','universal')),
      stage                TEXT CHECK (stage IS NULL OR stage IN (
                             'draft','planning','building','testing','reviewing','shipping','shipped'
                           )),
      tags_json            TEXT NOT NULL DEFAULT '[]',
      created_at           INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_global_lessons_identity
      ON lessons(project_root, title, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_root TEXT NOT NULL,
      note         TEXT NOT NULL,
      stage        TEXT CHECK (stage IS NULL OR stage IN (
                     'draft','planning','building','testing','reviewing','shipping','shipped'
                   )),
      urgency      TEXT CHECK (urgency IS NULL OR urgency IN ('low','normal','high')),
      created_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_global_feedback_identity
      ON feedback(project_root, note, created_at);
  `);
  return db;
}

/**
 * Drain any legacy per-project lessons + feedback rows to the global store.
 * Called from openProjectDb BEFORE migrations run so v8's DROP doesn't lose
 * rows. No-op when the legacy tables don't exist (already migrated past v8
 * or freshly-scaffolded DB).
 */
export function drainLegacyLessonsFeedback(projectDb: DatabaseSync): void {
  const hasLessons = tableExists(projectDb, "lessons");
  const hasFeedback = tableExists(projectDb, "feedback");
  if (!hasLessons && !hasFeedback) return;

  const projectRow = projectDb
    .prepare("SELECT root_path FROM project WHERE id=1")
    .get() as { root_path?: string } | undefined;
  const projectRoot = projectRow?.root_path;
  if (!projectRoot) return; // malformed project DB; nothing safe to drain

  const globalPath = resolveGlobalPath();
  // Only open global if there's drain work to do — avoids touching the
  // global DB during tests that never used lessons/feedback. We already
  // know at least one table exists; check for rows before committing.
  let hasRows = false;
  if (hasLessons) {
    const c = projectDb.prepare("SELECT COUNT(*) AS c FROM lessons").get() as { c: number };
    if (c.c > 0) hasRows = true;
  }
  if (!hasRows && hasFeedback) {
    const c = projectDb.prepare("SELECT COUNT(*) AS c FROM feedback").get() as { c: number };
    if (c.c > 0) hasRows = true;
  }
  if (!hasRows) return;

  if (!existsSync(dirname(globalPath))) mkdirSync(dirname(globalPath), { recursive: true });
  const globalDb = openGlobalForDrain(globalPath);
  try {
    if (hasLessons) {
      const lessons = projectDb
        .prepare(
          `SELECT title, context, observation, actionable_takeaway,
                  scope, stage, tags_json, created_at
           FROM lessons`,
        )
        .all() as unknown as LegacyLessonRow[];
      const insertLesson = globalDb.prepare(
        `INSERT OR IGNORE INTO lessons
           (project_root, title, context, observation, actionable_takeaway,
            scope, stage, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      globalDb.exec("BEGIN");
      try {
        for (const row of lessons) {
          insertLesson.run(
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
        }
        globalDb.exec("COMMIT");
      } catch (err) {
        globalDb.exec("ROLLBACK");
        throw err;
      }
    }
    if (hasFeedback) {
      const feedback = projectDb
        .prepare(`SELECT note, stage, urgency, created_at FROM feedback`)
        .all() as unknown as LegacyFeedbackRow[];
      const insertFeedback = globalDb.prepare(
        `INSERT OR IGNORE INTO feedback
           (project_root, note, stage, urgency, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      globalDb.exec("BEGIN");
      try {
        for (const row of feedback) {
          insertFeedback.run(projectRoot, row.note, row.stage, row.urgency, row.created_at);
        }
        globalDb.exec("COMMIT");
      } catch (err) {
        globalDb.exec("ROLLBACK");
        throw err;
      }
    }
  } finally {
    globalDb.close();
  }
}
