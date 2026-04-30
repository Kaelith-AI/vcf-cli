import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  migrateProject03to05,
  Migrate03Error,
  discoverLegacyProjects,
} from "../../src/project/migrate03.js";
import { openGlobalDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PROJECT_MIGRATIONS } from "../../src/db/schema.js";

// Followup #50 — integration coverage for the 0.3 → 0.5 migration path.

describe("migrateProject03to05", () => {
  let home: string;
  let workRoot: string;
  let projectDir: string;
  let globalDb: DatabaseSync;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m03-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m03h-")));
    projectDir = join(workRoot, "demo-project");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function seedLegacyProjectDb(name: string, state = "building"): string {
    const dbPath = join(projectDir, ".vcf", "project.db");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db, PROJECT_MIGRATIONS);
    const now = Date.now();
    db.prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(name, projectDir, state, now, now);
    db.close();
    return dbPath;
  }

  it("migrates an in-tree project.db into the state-dir and updates the registry", async () => {
    seedLegacyProjectDb("Demo Project");
    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
    });
    expect(result.outcome).toBe("migrated");
    expect(result.slug).toBe("demo-project");
    expect(result.stateDbPath).toBe(join(home, ".vcf", "projects", "demo-project", "project.db"));
    expect(existsSync(result.stateDbPath)).toBe(true);

    // Copied DB has updated root_path + slug-normalized name.
    const dest = new DatabaseSync(result.stateDbPath);
    try {
      const row = dest.prepare("SELECT name, root_path FROM project WHERE id=1").get() as {
        name: string;
        root_path: string;
      };
      expect(row.name).toBe("demo-project");
      expect(row.root_path).toBe(projectDir);
    } finally {
      dest.close();
    }

    // Registry upserted.
    const reg = globalDb
      .prepare("SELECT name, root_path, state_cache FROM projects WHERE name = ?")
      .get("demo-project") as
      | { name: string; root_path: string; state_cache: string | null }
      | undefined;
    expect(reg).toBeDefined();
    expect(reg?.root_path).toBe(projectDir);
  });

  it("is idempotent — running a second time reports 'already-migrated'", async () => {
    seedLegacyProjectDb("Demo");
    migrateProject03to05({ sourcePath: projectDir, globalDb, homeDir: home });
    const second = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
    });
    expect(second.outcome).toBe("already-migrated");
  });

  it("reports conflict when the state-dir slug is taken by another root", async () => {
    seedLegacyProjectDb("shared-name");

    // Seed a pre-existing state-dir under the same slug but a different root.
    const prior = join(home, ".vcf", "projects", "shared-name");
    await mkdir(prior, { recursive: true });
    const priorDbPath = join(prior, "project.db");
    const priorDb = new DatabaseSync(priorDbPath, { enableForeignKeyConstraints: true });
    priorDb.exec("PRAGMA journal_mode = WAL");
    runMigrations(priorDb, PROJECT_MIGRATIONS);
    const now = Date.now();
    priorDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'shared-name', '/tmp/different', 'building', ?, ?)`,
      )
      .run(now, now);
    priorDb.close();

    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
    });
    expect(result.outcome).toBe("conflict-existing-state-dir");
    expect(result.note).toMatch(/different/);
  });

  it("honors --name override for the slug", () => {
    seedLegacyProjectDb("whatever");
    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
      name: "renamed-demo",
    });
    expect(result.slug).toBe("renamed-demo");
    expect(existsSync(join(home, ".vcf", "projects", "renamed-demo", "project.db"))).toBe(true);
  });

  it("moves in-tree .review-runs/ into the state-dir review-runs/", async () => {
    seedLegacyProjectDb("demo");
    const runDir = join(projectDir, ".review-runs", "code-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "stage-1.code.md"), "# Stage 1\n");

    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
    });
    expect(result.outcome).toBe("migrated");
    expect(result.reviewRunsMoved).toBe(1);
    expect(existsSync(join(home, ".vcf", "projects", "demo", "review-runs", "code-1"))).toBe(true);
    expect(existsSync(join(projectDir, ".review-runs"))).toBe(false);
  });

  it("--delete-source removes the in-tree .vcf/ only after a successful migration", () => {
    seedLegacyProjectDb("demo");
    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
      deleteSource: true,
    });
    expect(result.deletedSource).toBe(true);
    expect(existsSync(join(projectDir, ".vcf"))).toBe(false);
  });

  it("--dry-run does not write; skips file copy + registry upsert", () => {
    seedLegacyProjectDb("demo");
    const result = migrateProject03to05({
      sourcePath: projectDir,
      globalDb,
      homeDir: home,
      dryRun: true,
    });
    expect(result.outcome).toBe("migrated");
    expect(result.note).toMatch(/dry-run/);
    expect(existsSync(join(home, ".vcf", "projects", "demo"))).toBe(false);
    // Registry untouched.
    const rows = globalDb.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("throws E_NOT_FOUND if there is no in-tree project.db", () => {
    expect(() =>
      migrateProject03to05({
        sourcePath: projectDir,
        globalDb,
        homeDir: home,
      }),
    ).toThrow(Migrate03Error);
  });
});

describe("discoverLegacyProjects", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-m03d-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("finds `.vcf/project.db` within depth 3 and skips node_modules + dotfiles", async () => {
    await mkdir(join(root, "A", ".vcf"), { recursive: true });
    await writeFile(join(root, "A", ".vcf", "project.db"), "");
    await mkdir(join(root, "B", "inner", ".vcf"), { recursive: true });
    await writeFile(join(root, "B", "inner", ".vcf", "project.db"), "");
    await mkdir(join(root, "node_modules", "skipped", ".vcf"), { recursive: true });
    await writeFile(join(root, "node_modules", "skipped", ".vcf", "project.db"), "");
    await mkdir(join(root, ".hidden", ".vcf"), { recursive: true });
    await writeFile(join(root, ".hidden", ".vcf", "project.db"), "");

    const found = discoverLegacyProjects([root]);
    expect(found.sort()).toEqual([join(root, "A"), join(root, "B", "inner")].sort());
  });
});
