// Global lessons SQLite database (default ~/.vcf/lessons.db).
//
// Separate file from ~/.vcf/vcf.db so the cross-project lesson log can grow
// without bloating the general audit DB, and so users can point it at
// external storage (sync folder, encrypted volume) without moving the rest
// of their VCF state. Schema mirrors the per-project `lessons` table plus a
// `project_root` column so queries can scope to a source project.
//
// lesson_log_add writes to both DBs in one handler; lesson_search reads
// from whichever scope the caller asks for. See
// primers/node-sqlite-embedded.md for the migration + WAL pattern.

import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Migration } from "./schema.js";
import { runMigrations } from "./migrate.js";
import { McpError } from "../errors.js";

export const DEFAULT_GLOBAL_LESSONS_PATH = join(homedir(), ".vcf", "lessons.db");

export const GLOBAL_LESSONS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_lessons",
    up: `
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
      CREATE INDEX IF NOT EXISTS idx_global_lessons_project ON lessons(project_root);
      CREATE INDEX IF NOT EXISTS idx_global_lessons_scope ON lessons(scope);
      CREATE INDEX IF NOT EXISTS idx_global_lessons_stage ON lessons(stage);
      CREATE INDEX IF NOT EXISTS idx_global_lessons_created ON lessons(created_at);
    `,
  },
  {
    version: 2,
    name: "mirror_idempotency_index",
    up: `
      -- (Obsolete in 0.7+; kept for back-compat with DBs that already have
      -- this index. The UNIQUE index is reused by followup #41's drain path
      -- for idempotent INSERT OR IGNORE.) Collision odds are negligible in
      -- a single-operator corpus at ms granularity.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_global_lessons_identity
        ON lessons(project_root, title, created_at);
    `,
  },
  {
    version: 3,
    name: "global_feedback",
    up: `
      -- Followup #41: feedback moves to the global store alongside lessons
      -- because it's improvement-cycle data, not project-lifecycle data.
      -- project_root tags each row with the origin project so retrospectives
      -- can filter or aggregate across projects.
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
      CREATE INDEX IF NOT EXISTS idx_global_feedback_project ON feedback(project_root);
      CREATE INDEX IF NOT EXISTS idx_global_feedback_created ON feedback(created_at);
      CREATE INDEX IF NOT EXISTS idx_global_feedback_stage ON feedback(stage);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_global_feedback_identity
        ON feedback(project_root, note, created_at);
    `,
  },
];

/**
 * Resolve the configured path against ~ and absoluteness rules.
 *
 * Returns:
 *   - `null` when the operator has explicitly disabled the mirror
 *     (`config.lessons.global_db_path: null`). Callers MUST treat this as
 *     "the cross-project mirror is off for this project" — lesson writes
 *     skip the mirror, cross-scope reads are refused.
 *   - The expanded absolute path otherwise (default `~/.vcf/lessons.db`).
 *
 * Throws E_VALIDATION when the caller's YAML is malformed.
 */
export function resolveGlobalLessonsPath(configured?: string | null): string | null {
  if (configured === null) return null;
  if (!configured || configured.trim() === "") return DEFAULT_GLOBAL_LESSONS_PATH;
  const expanded = configured.startsWith("~")
    ? join(homedir(), configured.slice(1).replace(/^[/\\]/, ""))
    : configured;
  if (!isAbsolute(expanded)) {
    throw new McpError(
      "E_VALIDATION",
      `config.lessons.global_db_path must resolve to an absolute path; got "${configured}"`,
    );
  }
  return expanded;
}

export interface OpenGlobalLessonsDbOptions {
  /** Absolute path to the lessons DB. Use resolveGlobalLessonsPath(config.lessons.global_db_path). */
  path: string;
  readonly?: boolean;
}

/**
 * Open (and migrate, if writable) the global lessons DB. Fails loud with
 * E_UNWRITABLE when the parent directory can't be created or lacks write
 * permission — the plan calls this out explicitly.
 */
export function openGlobalLessonsDb(opts: OpenGlobalLessonsDbOptions): DatabaseSync {
  const dir = dirname(opts.path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new McpError(
      "E_UNWRITABLE",
      `lessons DB parent directory cannot be created: ${dir} (${(err as Error).message})`,
    );
  }
  if (opts.readonly !== true) {
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new McpError(
        "E_UNWRITABLE",
        `lessons DB parent directory lacks write permission: ${dir}`,
      );
    }
  }
  const db = new DatabaseSync(opts.path, {
    readOnly: opts.readonly === true,
    enableForeignKeyConstraints: true,
  });
  if (opts.readonly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    runMigrations(db, GLOBAL_LESSONS_MIGRATIONS);
  } else {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

// Module-cached handle, keyed by resolved path. Tests that create isolated
// paths get isolated handles; the handle survives across tool calls in a
// long-running server.
const HANDLE_CACHE = new Map<string, DatabaseSync>();

/**
 * Lazily open the global lessons DB for the resolved path. Re-uses the cached
 * handle across tool calls in the same process. Tests that open a second
 * path will get a second handle automatically.
 *
 * Returns `null` when the operator has disabled the mirror
 * (`config.lessons.global_db_path: null`). Callers MUST branch on null
 * rather than treating it as an error.
 */
export function getGlobalLessonsDb(
  configuredPath: string | null | undefined,
): DatabaseSync | null {
  const path = resolveGlobalLessonsPath(configuredPath);
  if (path === null) return null;
  let db = HANDLE_CACHE.get(path);
  if (!db) {
    db = openGlobalLessonsDb({ path });
    HANDLE_CACHE.set(path, db);
  }
  return db;
}

/** Test-only: drop all cached handles so a new DatabaseSync opens next call. */
export function resetGlobalLessonsCache(): void {
  for (const db of HANDLE_CACHE.values()) {
    try {
      db.close();
    } catch {
      /* test cleanup; ignore */
    }
  }
  HANDLE_CACHE.clear();
}
