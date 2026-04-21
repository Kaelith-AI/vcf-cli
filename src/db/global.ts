// Global SQLite database (~/.vcf/vcf.db).
//
// Holds cross-project state: ideas, specs, primer catalog, endpoint list,
// model aliases, and the audit trail. Per-project state lives in
// <project>/.vcf/project.db (see ./project.ts).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
 * concurrent readers and foreign keys ON because the default OFF is a
 * footgun even though node:sqlite flips the default.
 */
export function openGlobalDb(opts: OpenGlobalDbOptions): DatabaseSync {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db = new DatabaseSync(opts.path, {
    readOnly: opts.readonly === true,
    enableForeignKeyConstraints: true,
  });
  if (opts.readonly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    runMigrations(db, GLOBAL_MIGRATIONS);
  } else {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}
