import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, restoreBackup } from "../../src/util/backup.js";

// Followup #49 — backup + restore integration coverage. Tarballs go through
// the OS `tar` binary (always present on Linux/macOS; bundled with Windows
// since 10 1803) so these tests double as a smoke check that the shell-out
// path actually works in the host environment.

describe("createBackup / restoreBackup", () => {
  let sourceHome: string;
  let targetHome: string;
  let outDir: string;

  beforeEach(async () => {
    sourceHome = await realpath(await mkdtemp(join(tmpdir(), "vcf-bup-src-")));
    targetHome = await realpath(await mkdtemp(join(tmpdir(), "vcf-bup-tgt-")));
    outDir = await realpath(await mkdtemp(join(tmpdir(), "vcf-bup-out-")));
    await mkdir(join(sourceHome, ".vcf", "projects", "alpha"), { recursive: true });
    await mkdir(join(sourceHome, ".vcf", "kb"), { recursive: true });
    await writeFile(join(sourceHome, ".vcf", "config.yaml"), "version: 1\n");
    await writeFile(join(sourceHome, ".vcf", "vcf.db"), "SQLite format 3\0stub");
    await writeFile(
      join(sourceHome, ".vcf", "projects", "alpha", "project.db"),
      "SQLite format 3\0alpha",
    );
    await writeFile(join(sourceHome, ".vcf", "kb", "sample.md"), "# kb entry\n");
  });

  afterEach(async () => {
    await rm(sourceHome, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(targetHome, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(outDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("backs up all subsets into a tar.gz archive", () => {
    const result = createBackup({
      include: ["all"],
      homeDir: sourceHome,
      outDir,
      filename: "test.tar.gz",
    });
    expect(result.archive).toBe(join(outDir, "test.tar.gz"));
    expect(existsSync(result.archive)).toBe(true);
    expect(result.size_bytes).toBeGreaterThan(0);
    expect(result.included_subsets.sort()).toEqual(["global", "kb", "projects"]);
    expect(result.included_paths.sort()).toEqual(
      ["config.yaml", "kb", "projects", "vcf.db"].sort(),
    );
  });

  it("backup --include projects only captures the projects subtree", () => {
    const result = createBackup({
      include: ["projects"],
      homeDir: sourceHome,
      outDir,
      filename: "proj-only.tar.gz",
    });
    expect(result.included_paths).toEqual(["projects"]);
  });

  it("restoreBackup dry-run produces a plan without writing", () => {
    const { archive } = createBackup({
      include: ["all"],
      homeDir: sourceHome,
      outDir,
      filename: "dry.tar.gz",
    });
    const result = restoreBackup({ archive, homeDir: targetHome, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.plan.length).toBeGreaterThan(0);
    // Target was untouched.
    expect(existsSync(join(targetHome, ".vcf"))).toBe(false);
  });

  it("restore into an empty target copies every entry", async () => {
    const { archive } = createBackup({
      include: ["all"],
      homeDir: sourceHome,
      outDir,
      filename: "full.tar.gz",
    });
    const result = restoreBackup({ archive, homeDir: targetHome });
    expect(result.applied).toBeGreaterThan(0);
    expect(result.replaced).toBe(0);
    expect(result.skipped).toBe(0);
    // Files actually present in the target home.
    expect(existsSync(join(targetHome, ".vcf", "config.yaml"))).toBe(true);
    expect(existsSync(join(targetHome, ".vcf", "projects", "alpha", "project.db"))).toBe(true);
    const kb = await readFile(join(targetHome, ".vcf", "kb", "sample.md"), "utf8");
    expect(kb).toBe("# kb entry\n");
  });

  it("restore skips entries that already exist in the target", async () => {
    const { archive } = createBackup({
      include: ["all"],
      homeDir: sourceHome,
      outDir,
      filename: "second.tar.gz",
    });
    // Seed the target with a config.yaml and an alpha project so restore
    // must choose skip vs overwrite.
    await mkdir(join(targetHome, ".vcf", "projects", "alpha"), { recursive: true });
    await writeFile(join(targetHome, ".vcf", "config.yaml"), "existing\n");
    await writeFile(
      join(targetHome, ".vcf", "projects", "alpha", "project.db"),
      "EXISTING",
    );
    const result = restoreBackup({ archive, homeDir: targetHome });
    expect(result.skipped).toBeGreaterThan(0);
    const cfg = await readFile(join(targetHome, ".vcf", "config.yaml"), "utf8");
    expect(cfg).toBe("existing\n");
  });

  it("restore --replace overwrites existing entries", async () => {
    const { archive } = createBackup({
      include: ["all"],
      homeDir: sourceHome,
      outDir,
      filename: "replace.tar.gz",
    });
    await mkdir(join(targetHome, ".vcf", "projects", "alpha"), { recursive: true });
    await writeFile(join(targetHome, ".vcf", "config.yaml"), "existing\n");
    const result = restoreBackup({ archive, homeDir: targetHome, replace: true });
    expect(result.replaced).toBeGreaterThan(0);
    const cfg = await readFile(join(targetHome, ".vcf", "config.yaml"), "utf8");
    expect(cfg).toBe("version: 1\n");
  });
});
