// Global SQLite database (~/.vcf/vcf.db).
//
// Holds cross-project state: ideas, specs, primer catalog, endpoint list,
// model aliases, and the audit trail. Per-project state lives in
// <project>/.vcf/project.db (see ./project.ts).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { GLOBAL_MIGRATIONS } from "./schema.js";
import { runMigrations } from "./migrate.js";

export interface OpenGlobalDbOptions {
  /** Absolute path to ~/.vcf/vcf.db (or wherever the user's config points). */
  path: string;
  /** When true, db is opened read-only. Used by `vcf admin audit`. */
  readonly?: boolean;
}

/**
 * Open (and migrate, if writable) the global DB. Always enables WAL for safe
 * concurrent readers and `foreign_keys = ON` because SQLite's default OFF is
 * a footgun.
 */
export function openGlobalDb(opts: OpenGlobalDbOptions): DatabaseType {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db: DatabaseType = new Database(opts.path, {
    readonly: opts.readonly === true,
    fileMustExist: false,
  });
  if (opts.readonly !== true) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    runMigrations(db, GLOBAL_MIGRATIONS);
  } else {
    db.pragma("foreign_keys = ON");
  }
  return db;
}
