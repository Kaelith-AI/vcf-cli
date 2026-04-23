// Per-project SQLite database (<project>/.vcf/project.db).
//
// Exists only inside an initialized project. Holds the project's own
// metadata row plus artifacts, review runs, decisions, response log, and
// builds. The MCP server refuses --scope=project at launch if this file is
// missing; see server boot in M2.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { runMigrations } from "./migrate.js";
import { drainLegacyLessonsFeedback } from "./drain.js";

export interface OpenProjectDbOptions {
  /** Absolute path to <project>/.vcf/project.db. */
  path: string;
  readonly?: boolean;
}

export function openProjectDb(opts: OpenProjectDbOptions): DatabaseSync {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db = new DatabaseSync(opts.path, {
    readOnly: opts.readonly === true,
    enableForeignKeyConstraints: true,
  });
  if (opts.readonly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    // #41: drain legacy per-project lessons/feedback to the global store
    // BEFORE v8 drops the tables. Idempotent, no-op on fresh DBs.
    drainLegacyLessonsFeedback(db);
    runMigrations(db, PROJECT_MIGRATIONS);
  } else {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

export interface ProjectRow {
  id: 1;
  name: string;
  root_path: string;
  state: ProjectState;
  created_at: number;
  updated_at: number;
  spec_path: string | null;
}

export type ProjectState =
  | "draft"
  | "planning"
  | "building"
  | "testing"
  | "reviewing"
  | "shipping"
  | "shipped";
