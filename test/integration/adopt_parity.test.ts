import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../../src/db/migrate.js";
import { GLOBAL_MIGRATIONS, PROJECT_MIGRATIONS } from "../../src/db/schema.js";
import { adoptProject } from "../../src/project/adopt.js";

// Parity test for the shared adoption core extracted at 0.5.0 (followup #39).
// Both the CLI (`vcf adopt`) and the MCP tool (`project_init_existing`) now
// call the same adoptProject() function. Before this refactor each path
// reimplemented the same sequence with slightly different edge-case
// behavior — a drift vector on a boundary-sensitive flow. Post-refactor, a
// second call against the same dir must:
//   1. mark adopted=1 in project.db
//   2. preserve the original name + state on re-adoption
//   3. upsert the global registry both times
//   4. surface registry failures via registryWarning (non-fatal)

describe("adoptProject shared core", () => {
  let workRoot: string;
  let globalDb: DatabaseSync;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-adoptcore-")));
    const gdbPath = join(workRoot, "global.db");
    globalDb = new DatabaseSync(gdbPath, { enableForeignKeyConstraints: true });
    globalDb.exec("PRAGMA journal_mode = WAL");
    runMigrations(globalDb, GLOBAL_MIGRATIONS);
  });

  afterEach(async () => {
    globalDb.close();
    await rm(workRoot, { recursive: true, force: true });
  });

  it("first adoption creates project.db, inserts row, upserts registry", async () => {
    const root = join(workRoot, "proj-a");
    await mkdir(root, { recursive: true });

    const r = await adoptProject({
      root,
      name: "Proj A",
      state: "reviewing",
      globalDb,
      homeDir: workRoot,
    });

    expect(r.freshDb).toBe(true);
    expect(r.existing).toBeNull();
    expect(r.registryWarning).toBeNull();
    // State lives out of tree under <home>/.vcf/projects/<slug>/project.db.
    expect(r.projectDbPath).toBe(join(workRoot, ".vcf", "projects", "proj-a", "project.db"));
    expect(r.slug).toBe("proj-a");

    // Open the produced project DB and verify the row.
    const pdb = new DatabaseSync(r.projectDbPath, { enableForeignKeyConstraints: true });
    runMigrations(pdb, PROJECT_MIGRATIONS);
    const row = pdb.prepare("SELECT name, state, adopted FROM project WHERE id = 1").get() as
      | { name: string; state: string; adopted: number }
      | undefined;
    pdb.close();
    expect(row?.name).toBe("Proj A");
    expect(row?.state).toBe("reviewing");
    expect(row?.adopted).toBe(1);

    // Global registry carries the slug + state.
    const reg = globalDb
      .prepare("SELECT name, state_cache FROM projects WHERE name = ?")
      .get("proj-a") as { name: string; state_cache: string } | undefined;
    expect(reg?.name).toBe("proj-a");
    expect(reg?.state_cache).toBe("reviewing");
  });

  it("re-adoption preserves name + state on an existing project row", async () => {
    const root = join(workRoot, "proj-b");
    await mkdir(root, { recursive: true });

    await adoptProject({
      root,
      name: "Original",
      state: "building",
      globalDb,
      homeDir: workRoot,
    });
    // A second call with different name/state must NOT clobber the row.
    const r2 = await adoptProject({
      root,
      name: "Original",
      state: "shipping",
      globalDb,
      homeDir: workRoot,
    });

    expect(r2.freshDb).toBe(false);
    expect(r2.existing).toEqual({ name: "Original", state: "building" });
    // Registry carries the PRESERVED state, not the new one.
    const reg = globalDb
      .prepare("SELECT state_cache FROM projects WHERE root_path = ?")
      .get(root) as { state_cache: string } | undefined;
    expect(reg?.state_cache).toBe("building");
  });

  it("global registry upsert failure is non-fatal and surfaced in registryWarning", async () => {
    const root = join(workRoot, "proj-c");
    await mkdir(root, { recursive: true });
    // Close the global DB so upsertProject throws — simulates an IO failure.
    globalDb.close();

    const r = await adoptProject({
      root,
      name: "Proj C",
      state: "draft",
      globalDb,
      homeDir: workRoot,
    });

    // The project-db write is authoritative and must succeed even with the
    // registry broken.
    expect(r.freshDb).toBe(true);
    expect(r.registryWarning).toBeTruthy();
    expect(r.registryWarning).toContain("registry");
    const pdb = new DatabaseSync(r.projectDbPath, { enableForeignKeyConstraints: true });
    runMigrations(pdb, PROJECT_MIGRATIONS);
    const row = pdb.prepare("SELECT name, adopted FROM project WHERE id = 1").get() as
      | { name: string; adopted: number }
      | undefined;
    pdb.close();
    expect(row?.adopted).toBe(1);

    // Re-open the global DB so afterEach cleanup doesn't blow up.
    globalDb = new DatabaseSync(join(workRoot, "global.db"), { enableForeignKeyConstraints: true });
  });
});
