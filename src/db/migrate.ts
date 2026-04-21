// Minimal migration runner.
//
// We don't need Knex or drizzle-migrate for six tables; instead we keep a
// `schema_migrations(version, name, applied_at)` ledger and apply any
// unapplied migration in order inside a transaction. Running open() N times
// is idempotent.
//
// Uses node:sqlite (built into Node >= 22.5) — no native addon, no
// prebuild fetch, works identically on every platform Node runs on. See
// 2026-04-21 dep migration: better-sqlite3's install tooling is deprecated
// and stalled; we use the Node-builtin instead.

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./schema.js";

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);
  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    // node:sqlite has no `db.transaction(fn)` helper; use explicit
    // BEGIN/COMMIT with a ROLLBACK on throw. Migrations must be
    // atomic — partial application leaves schema_migrations out of
    // sync with the actual tables.
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      insertMigration.run(m.version, m.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
