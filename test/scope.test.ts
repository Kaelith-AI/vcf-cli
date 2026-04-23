import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath, symlink } from "node:fs/promises";
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

  // #46 — on macOS (HFS+/APFS) and Windows (NTFS default) the filesystem is
  // case-insensitive but our string compare is case-sensitive. Symlinks
  // exercise the same canonicalization path cross-platform: a cwd that is a
  // symlink to a registered root should still resolve to project scope.
  it("auto-detect: canonicalizes cwd via realpath (symlink to registered root → project)", async () => {
    upsertProject(globalDb, { name: "proj", root_path: root, state: "reviewing" });
    const linkParent = await realpath(await mkdtemp(join(tmpdir(), "vcf-scope-link-")));
    const link = join(linkParent, "via-link");
    try {
      await symlink(root, link, "dir");
      const resolved = resolveScope({ cwd: link, globalDb, homeDir: home });
      expect(resolved.scope).toBe("project");
      expect(resolved.projectRoot).toBe(root);
      expect(resolved.projectSlug).toBe("proj");
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it("auto-detect: canonicalizes the registered root_path (symlinked-registered root still matched)", async () => {
    const linkParent = await realpath(await mkdtemp(join(tmpdir(), "vcf-scope-regl-")));
    const link = join(linkParent, "root-link");
    try {
      await symlink(root, link, "dir");
      // Register via the symlink path — resolveScope should canonicalize
      // both sides and still match when cwd is the real root.
      upsertProject(globalDb, { name: "proj", root_path: link, state: "reviewing" });
      const resolved = resolveScope({ cwd: root, globalDb, homeDir: home });
      expect(resolved.scope).toBe("project");
      expect(resolved.projectRoot).toBe(link);
      expect(resolved.projectSlug).toBe("proj");
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  it("auto-detect: registered root whose on-disk path was deleted still matches the stored value", () => {
    // Canonicalize gracefully falls back to logical resolve() when the
    // path doesn't exist, so a registry row whose root_path was later
    // removed from disk is still reachable when cwd equals the stored path.
    const ghost = join(root, "ghost-dir-never-created");
    upsertProject(globalDb, { name: "ghost", root_path: ghost, state: "reviewing" });
    const resolved = resolveScope({ cwd: ghost, globalDb, homeDir: home });
    expect(resolved.scope).toBe("project");
    expect(resolved.projectSlug).toBe("ghost");
  });
});
