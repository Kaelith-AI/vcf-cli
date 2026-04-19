// Per-project SQLite database (<project>/.vcf/project.db).
//
// Exists only inside an initialized project. Holds the project's own
// metadata row plus artifacts, review runs, decisions, response log, and
// builds. The MCP server refuses --scope=project at launch if this file is
// missing; see server boot in M2.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { PROJECT_MIGRATIONS } from "./schema.js";
import { runMigrations } from "./migrate.js";

export interface OpenProjectDbOptions {
  /** Absolute path to <project>/.vcf/project.db. */
  path: string;
  readonly?: boolean;
}

export function openProjectDb(opts: OpenProjectDbOptions): DatabaseType {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db: DatabaseType = new Database(opts.path, {
    readonly: opts.readonly === true,
    fileMustExist: false,
  });
  if (opts.readonly !== true) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    runMigrations(db, PROJECT_MIGRATIONS);
  } else {
    db.pragma("foreign_keys = ON");
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
