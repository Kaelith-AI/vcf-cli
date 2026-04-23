import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScope } from "../src/scope.js";
import { openGlobalDb, closeTrackedDbs } from "./helpers/db-cleanup.js";
import { upsertProject } from "../src/util/projectRegistry.js";

// Scope is auto-detected from the global registry — not from in-tree
// files. These tests pin the three decision paths: explicit override,
// auto-detect walk-up to a registered root_path, and auto-detect with no
// registration → global.

describe("resolveScope", () => {
  let root: string;
  let home: string;
  let globalDb: ReturnType<typeof openGlobalDb>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-scope-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-scope-home-")));
    globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("auto-detect: cwd matches a registered root_path → project scope", () => {
    upsertProject(globalDb, { name: "proj", root_path: root, state: "reviewing" });
    const resolved = resolveScope({ cwd: root, globalDb, homeDir: home });
    expect(resolved.scope).toBe("project");
    expect(resolved.projectRoot).toBe(root);
    expect(resolved.projectSlug).toBe("proj");
    expect(resolved.projectDbPath).toBe(join(home, ".vcf", "projects", "proj", "project.db"));
  });

  it("auto-detect: walks up from subdir to find registered root", async () => {
    upsertProject(globalDb, { name: "proj", root_path: root, state: "reviewing" });
    const subdir = join(root, "src", "deeply", "nested");
    await mkdir(subdir, { recursive: true });
    const resolved = resolveScope({ cwd: subdir, globalDb, homeDir: home });
    expect(resolved.scope).toBe("project");
    expect(resolved.projectRoot).toBe(root);
  });

  it("auto-detect: no matching registration → global scope", () => {
    const resolved = resolveScope({ cwd: root, globalDb, homeDir: home });
    expect(resolved.scope).toBe("global");
    expect(resolved.projectRoot).toBeUndefined();
  });

  it("explicit requested='global' returns global even when a registration matches", () => {
    upsertProject(globalDb, { name: "proj", root_path: root, state: "reviewing" });
    const resolved = resolveScope({ cwd: root, globalDb, homeDir: home, requested: "global" });
    expect(resolved.scope).toBe("global");
    expect(resolved.projectRoot).toBeUndefined();
  });

  it("explicit requested='project' at an unregistered path throws E_STATE_INVALID", () => {
    expect(() =>
      resolveScope({ cwd: root, globalDb, homeDir: home, requested: "project" }),
    ).toThrowError(/project scope requested/);
  });

  it("explicit requested='project' does NOT walk up — parent registration is ignored", async () => {
    upsertProject(globalDb, { name: "proj", root_path: root, state: "reviewing" });
    const subdir = join(root, "child");
    await mkdir(subdir, { recursive: true });
    expect(() =>
      resolveScope({ cwd: subdir, globalDb, homeDir: home, requested: "project" }),
    ).toThrowError(/project scope requested/);
  });
});
