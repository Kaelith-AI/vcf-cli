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
];

/**
 * Resolve the configured path against ~ and absoluteness rules. Returns the
 * expanded absolute path or throws E_VALIDATION with a precise message when
 * the caller's YAML is malformed.
 */
export function resolveGlobalLessonsPath(configured?: string): string {
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
 */
export function getGlobalLessonsDb(configuredPath: string | undefined): DatabaseSync {
  const path = resolveGlobalLessonsPath(configuredPath);
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
