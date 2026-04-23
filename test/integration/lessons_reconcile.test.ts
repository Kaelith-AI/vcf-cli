import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { GLOBAL_LESSONS_MIGRATIONS } from "../../src/db/globalLessons.js";
import { runMigrations } from "../../src/db/migrate.js";
import { reconcileLessons } from "../../src/project/lessonsReconcile.js";

// Followup #42 — lessons_reconcile integration coverage. Covers:
//   - drain of 'pending' rows into the global mirror
//   - idempotency: second run on the same set is a no-op
//   - partial drain (limit honored)
//   - graceful handling when the identity row already exists in the mirror

describe("reconcileLessons", () => {
  let home: string;
  let projectDb: DatabaseSync;
  let globalLessonsDb: DatabaseSync;
  const projectRoot = "/tmp/demo-reconcile";

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-recon-")));
    projectDb = openProjectDb({ path: join(home, ".vcf", "projects", "demo", "project.db") });
    // Seed the project row required by the rest of the schema.
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'demo', ?, 'building', ?, ?)`,
      )
      .run(projectRoot, Date.now(), Date.now());

    globalLessonsDb = new DatabaseSync(join(home, ".vcf", "lessons.db"), {
      enableForeignKeyConstraints: true,
    });
    globalLessonsDb.exec("PRAGMA journal_mode = WAL");
    runMigrations(globalLessonsDb, GLOBAL_LESSONS_MIGRATIONS);
  });

  afterEach(async () => {
    closeTrackedDbs();
    try {
      globalLessonsDb.close();
    } catch {
      /* noop */
    }
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function seedPending(count: number): void {
    const stmt = projectDb.prepare(
      `INSERT INTO lessons (title, context, observation, actionable_takeaway,
                            scope, stage, tags_json, created_at, mirror_status)
       VALUES (?, ?, ?, ?, 'project', 'building', '["recon"]', ?, 'pending')`,
    );
    const base = Date.now() - count;
    for (let i = 0; i < count; i++) {
      stmt.run(`lesson ${i}`, null, `observation ${i}`, null, base + i);
    }
  }

  function countGlobal(): number {
    return (globalLessonsDb.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
  }

  function mirrorStatusHistogram(): Record<string, number> {
    const rows = projectDb
      .prepare("SELECT mirror_status, COUNT(*) AS n FROM lessons GROUP BY mirror_status")
      .all() as Array<{ mirror_status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.mirror_status] = r.n;
    return out;
  }

  it("drains all pending rows on first run, no-op on second run", () => {
    seedPending(5);
    const r1 = reconcileLessons({
      projectDb,
      projectRoot,
      globalDb: globalLessonsDb,
    });
    expect(r1.attempted).toBe(5);
    expect(r1.mirrored).toBe(5);
    expect(r1.already_present).toBe(0);
    expect(r1.failed).toBe(0);
    expect(countGlobal()).toBe(5);
    expect(mirrorStatusHistogram()).toEqual({ mirrored: 5 });

    // Second run finds nothing to do.
    const r2 = reconcileLessons({
      projectDb,
      projectRoot,
      globalDb: globalLessonsDb,
    });
    expect(r2.attempted).toBe(0);
    expect(r2.mirrored).toBe(0);
  });

  it("honors limit (partial drain leaves remainder pending)", () => {
    seedPending(10);
    const r = reconcileLessons({
      projectDb,
      projectRoot,
      globalDb: globalLessonsDb,
      limit: 3,
    });
    expect(r.attempted).toBe(3);
    expect(r.mirrored).toBe(3);
    expect(countGlobal()).toBe(3);
    const hist = mirrorStatusHistogram();
    expect(hist.mirrored).toBe(3);
    expect(hist.pending).toBe(7);
  });

  it("returns already_present when the identity row pre-exists in the mirror", () => {
    seedPending(2);
    // Pre-insert a row matching the first seeded lesson's identity.
    const row = projectDb
      .prepare(
        "SELECT title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at FROM lessons ORDER BY created_at ASC LIMIT 1",
      )
      .get() as {
      title: string;
      context: string | null;
      observation: string;
      actionable_takeaway: string | null;
      scope: string;
      stage: string | null;
      tags_json: string;
      created_at: number;
    };
    globalLessonsDb
      .prepare(
        `INSERT INTO lessons (project_root, title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

    const r = reconcileLessons({ projectDb, projectRoot, globalDb: globalLessonsDb });
    expect(r.attempted).toBe(2);
    expect(r.mirrored).toBe(1);
    expect(r.already_present).toBe(1);
    expect(r.failed).toBe(0);
    // Both project rows are now marked mirrored.
    expect(mirrorStatusHistogram()).toEqual({ mirrored: 2 });
    // Mirror holds exactly 2 rows (the pre-seeded one + the newly written one).
    expect(countGlobal()).toBe(2);
  });

  it("leaves non-pending rows alone (e.g., 'mirrored' default from migration)", () => {
    // Legacy row — created under the old code path which defaulted to
    // 'mirrored'. Reconcile should never touch it because the query is
    // WHERE mirror_status != 'mirrored'.
    projectDb
      .prepare(
        `INSERT INTO lessons (title, context, observation, actionable_takeaway,
                              scope, stage, tags_json, created_at, mirror_status)
         VALUES ('legacy', NULL, 'obs', NULL, 'project', 'building', '[]', ?, 'mirrored')`,
      )
      .run(Date.now() - 1000);
    seedPending(2);
    const r = reconcileLessons({ projectDb, projectRoot, globalDb: globalLessonsDb });
    expect(r.attempted).toBe(2);
    expect(r.mirrored).toBe(2);
    // Legacy row was never drained, so mirror only has the 2 reconciled rows.
    expect(countGlobal()).toBe(2);
  });
});
