// Minimal migration runner.
//
// We don't need Knex or drizzle-migrate for six tables; instead we keep a
// `schema_migrations(version, name, applied_at)` ledger and apply any
// unapplied migration in order inside a transaction. Running open() N times
// is idempotent.

import type BetterSqlite3 from "better-sqlite3";
import type { Migration } from "./schema.js";

export function runMigrations(db: BetterSqlite3.Database, migrations: readonly Migration[]): void {
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
    const tx = db.transaction(() => {
      db.exec(m.up);
      insertMigration.run(m.version, m.name, Date.now());
    });
    tx();
  }
}
