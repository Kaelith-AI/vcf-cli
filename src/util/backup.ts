// Followup #49 — vcf backup / vcf restore core.
//
// Shells out to `tar` for archive create/extract — GNU tar (Linux), BSD
// tar (macOS), and Windows built-in `tar.exe` (since Windows 10 1803)
// agree on the subset we need (`-czf`, `-xzf`, `-tzf`, `-C`). No new npm
// dep; no native-module complications.
//
// Subsets:
//   projects  → ~/.vcf/projects/            (per-project state-dirs)
//   global    → ~/.vcf/vcf.db + lessons.db + config.yaml + audit.log*
//   kb        → ~/.vcf/kb/ + kb-ancestors/
//   all       → every subset above
//
// Conflict handling on restore is explicit: entries already present in
// the target home are skipped by default; `--replace` overwrites. Slug
// collisions in the projects/ subset are surfaced per project so the
// operator can decide case-by-case.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type BackupSubset = "projects" | "global" | "kb" | "all";

const GLOBAL_FILES = ["vcf.db", "lessons.db", "config.yaml"] as const;
const KB_DIRS = ["kb", "kb-ancestors"] as const;

function vcfHome(home?: string): string {
  return home ?? process.env["VCF_HOME"] ?? homedir();
}

function vcfDir(home?: string): string {
  return join(vcfHome(home), ".vcf");
}

export interface BackupInput {
  /** Destination directory. Created if missing. Defaults to ~/backups/. */
  outDir?: string;
  /** Subsets to include. Defaults to ['all']. */
  include?: BackupSubset[];
  /** Home override for tests (VCF_HOME). */
  homeDir?: string;
  /** Optional filename override; default `vcf-backup-<iso>.tar.gz`. */
  filename?: string;
}

export interface BackupResult {
  archive: string;
  included_subsets: BackupSubset[];
  included_paths: string[];
  size_bytes: number;
}

function resolveSubsets(include: BackupSubset[] | undefined): Exclude<BackupSubset, "all">[] {
  const raw = include && include.length > 0 ? include : (["all"] as BackupSubset[]);
  const out = new Set<Exclude<BackupSubset, "all">>();
  for (const s of raw) {
    if (s === "all") {
      out.add("projects");
      out.add("global");
      out.add("kb");
    } else {
      out.add(s);
    }
  }
  return [...out];
}

function collectBackupPaths(subsets: Exclude<BackupSubset, "all">[], home?: string): string[] {
  const paths: string[] = [];
  const base = vcfDir(home);
  for (const subset of subsets) {
    if (subset === "projects") {
      const p = join(base, "projects");
      if (existsSync(p)) paths.push("projects");
    }
    if (subset === "global") {
      for (const f of GLOBAL_FILES) {
        if (existsSync(join(base, f))) paths.push(f);
      }
    }
    if (subset === "kb") {
      for (const d of KB_DIRS) {
        if (existsSync(join(base, d))) paths.push(d);
      }
    }
  }
  return paths;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createBackup(input: BackupInput = {}): BackupResult {
  const subsets = resolveSubsets(input.include);
  const base = vcfDir(input.homeDir);
  if (!existsSync(base)) {
    throw new Error(`VCF home ${base} does not exist; nothing to back up`);
  }
  const includedPaths = collectBackupPaths(subsets, input.homeDir);
  if (includedPaths.length === 0) {
    throw new Error(`no matching content for include=[${subsets.join(",")}] under ${base}`);
  }

  const outDir = input.outDir ?? join(vcfHome(input.homeDir), "backups");
  mkdirSync(outDir, { recursive: true });
  const filename = input.filename ?? `vcf-backup-${timestamp()}.tar.gz`;
  const archive = join(outDir, filename);

  const result = spawnSync("tar", ["-czf", archive, "-C", base, ...includedPaths], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `tar exited with status ${result.status}: ${result.stderr?.trim() || "(no stderr)"}`,
    );
  }
  const size = statSync(archive).size;
  return {
    archive,
    included_subsets: subsets,
    included_paths: includedPaths,
    size_bytes: size,
  };
}

export interface RestoreInput {
  archive: string;
  /** Dry-run: report the plan without writing. */
  dryRun?: boolean;
  /** Overwrite existing entries instead of skipping. */
  replace?: boolean;
  /** Home override for tests. */
  homeDir?: string;
}

export interface RestorePlanEntry {
  relative_path: string;
  action: "copy" | "skip-existing" | "replace";
  reason?: string;
}

export interface RestoreResult {
  plan: RestorePlanEntry[];
  applied: number;
  skipped: number;
  replaced: number;
  archive: string;
  home: string;
  dry_run: boolean;
}

function listArchive(archive: string): string[] {
  const res = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`tar -tzf failed: ${res.stderr?.trim() || "(no stderr)"} (archive=${archive})`);
  }
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractArchive(archive: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const res = spawnSync("tar", ["-xzf", archive, "-C", dest], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`tar -xzf failed: ${res.stderr?.trim() || "(no stderr)"}`);
  }
}

/**
 * Restore plan: top-level entries from the archive — each is either a
 * file (global subset: vcf.db, lessons.db, config.yaml) or a directory
 * (projects/, kb/, kb-ancestors/). Sub-entries inside projects/ are
 * per-slug state-dirs and get individual conflict handling.
 */
function buildPlan(stagingDir: string, targetDir: string, replace: boolean): RestorePlanEntry[] {
  const plan: RestorePlanEntry[] = [];
  const topEntries = readdirSync(stagingDir);
  for (const name of topEntries) {
    if (name === "projects") {
      const projectsStaging = join(stagingDir, "projects");
      const slugs = existsSync(projectsStaging) ? readdirSync(projectsStaging) : [];
      for (const slug of slugs) {
        const rel = join("projects", slug);
        const targetPath = join(targetDir, rel);
        if (existsSync(targetPath)) {
          plan.push({
            relative_path: rel,
            action: replace ? "replace" : "skip-existing",
            reason: replace
              ? "target state-dir exists — replacing"
              : "target state-dir exists — pass --replace to overwrite",
          });
        } else {
          plan.push({ relative_path: rel, action: "copy" });
        }
      }
    } else {
      const rel = name;
      const targetPath = join(targetDir, rel);
      if (existsSync(targetPath)) {
        plan.push({
          relative_path: rel,
          action: replace ? "replace" : "skip-existing",
          reason: replace
            ? "target exists — replacing"
            : "target exists — pass --replace to overwrite",
        });
      } else {
        plan.push({ relative_path: rel, action: "copy" });
      }
    }
  }
  return plan;
}

export function restoreBackup(input: RestoreInput): RestoreResult {
  if (!existsSync(input.archive)) {
    throw new Error(`archive not found: ${input.archive}`);
  }
  // Validate it's a readable tar.
  listArchive(input.archive);

  const home = vcfHome(input.homeDir);
  const targetDir = vcfDir(input.homeDir);

  const staging = join(tmpdir(), `vcf-restore-${Date.now()}`);
  extractArchive(input.archive, staging);

  try {
    const plan = buildPlan(staging, targetDir, input.replace === true);
    const result: RestoreResult = {
      plan,
      applied: 0,
      skipped: 0,
      replaced: 0,
      archive: input.archive,
      home,
      dry_run: input.dryRun === true,
    };

    if (input.dryRun) return result;

    // Only create the target dir when we're about to write to it — dry-run
    // must leave the target untouched.
    mkdirSync(targetDir, { recursive: true });

    for (const entry of plan) {
      const src = join(staging, entry.relative_path);
      const dst = join(targetDir, entry.relative_path);
      if (entry.action === "skip-existing") {
        result.skipped += 1;
        continue;
      }
      if (entry.action === "replace") {
        try {
          rmSync(dst, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        result.replaced += 1;
      } else {
        result.applied += 1;
      }
      mkdirSync(join(targetDir, entry.relative_path, ".."), { recursive: true });
      const st = statSync(src);
      if (st.isDirectory()) {
        cpSync(src, dst, { recursive: true });
      } else {
        copyFileSync(src, dst);
      }
    }
    return result;
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
