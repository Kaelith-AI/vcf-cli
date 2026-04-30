// Followup #50 — automate the 0.3 → 0.5 state-dir migration.
//
// 0.5.0 moved per-project runtime state out of `<project>/.vcf/` into
// `~/.vcf/projects/<slug>/`. The CHANGELOG documents a five-step manual
// recipe; this module encapsulates it behind `vcf migrate 0.3` so a
// future operator pulling the 0.5.0 tag cold doesn't have to hand-roll
// the SQL.
//
// Steps:
//   1. Locate `<sourcePath>/.vcf/project.db`.
//   2. Pick a slug — operator override → project.name row value → basename(sourcePath).
//   3. Copy DB → `~/.vcf/projects/<slug>/project.db` (idempotent — skip if
//      the state-dir DB already exists AND its `project.root_path` matches
//      `sourcePath`; otherwise surface a conflict).
//   4. Update the copied DB's `project.root_path` + `project.name` so the
//      new state-dir is canonical.
//   5. Upsert the global registry.
//   6. If there's an in-tree `<sourcePath>/.review-runs/`, move it to
//      `~/.vcf/projects/<slug>/review-runs/`.
//   7. With `--delete-source`, rm the in-tree `.vcf/` (review-runs already
//      moved above).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as OpenDb } from "node:sqlite";
import { projectDbPath, projectRunsDir, projectStateDir } from "./stateDir.js";
import { upsertProject } from "../util/projectRegistry.js";
import { runMigrations } from "../db/migrate.js";
import { PROJECT_MIGRATIONS } from "../db/schema.js";

export interface Migrate03Input {
  /** In-tree project root (holds `.vcf/project.db`). */
  sourcePath: string;
  /** Override slug. Defaults to project.name row value → basename(sourcePath). */
  name?: string;
  /** Global DB handle (writable). */
  globalDb: DatabaseSync;
  /** Home override for tests (VCF_HOME). */
  homeDir?: string;
  /** Remove `<sourcePath>/.vcf/` after a successful migration. */
  deleteSource?: boolean;
  /** Walk through every step without writing. */
  dryRun?: boolean;
}

export type Migrate03Outcome =
  | "migrated"
  | "already-migrated"
  | "no-source-db"
  | "conflict-existing-state-dir";

export interface Migrate03Result {
  outcome: Migrate03Outcome;
  slug: string;
  sourcePath: string;
  stateDbPath: string;
  reviewRunsMoved: number;
  deletedSource: boolean;
  /** Human-readable note (e.g. "state-dir already present with matching root_path"). */
  note?: string;
}

export class Migrate03Error extends Error {
  constructor(
    public readonly code:
      | "E_NOT_FOUND"
      | "E_ALREADY_EXISTS"
      | "E_STATE_INVALID"
      | "E_FILESYSTEM"
      | "E_VALIDATION",
    message: string,
  ) {
    super(message);
    this.name = "Migrate03Error";
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function migrateProject03to05(input: Migrate03Input): Migrate03Result {
  const { sourcePath, globalDb, homeDir } = input;
  const sourceDbPath = join(sourcePath, ".vcf", "project.db");
  if (!existsSync(sourceDbPath)) {
    throw new Migrate03Error(
      "E_NOT_FOUND",
      `no in-tree project.db at ${sourceDbPath} — nothing to migrate`,
    );
  }

  // Read the source project row to discover its stored name + state. Open
  // with the full migration chain so any pre-0.5 project.db (schemas v1-v2)
  // catches up to the latest — operators may have skipped updates.
  const src = new OpenDb(sourceDbPath, { enableForeignKeyConstraints: true });
  src.exec("PRAGMA journal_mode = WAL");
  src.exec("PRAGMA synchronous = NORMAL");
  try {
    runMigrations(src, PROJECT_MIGRATIONS);
  } catch (e) {
    src.close();
    throw new Migrate03Error(
      "E_STATE_INVALID",
      `source project.db failed migration replay: ${(e as Error).message}`,
    );
  }
  const row = src.prepare("SELECT name, root_path, state FROM project WHERE id=1").get() as
    | { name: string; root_path: string; state: string }
    | undefined;
  src.close();
  if (!row) {
    throw new Migrate03Error("E_STATE_INVALID", `source project.db has no project row`);
  }

  const slugRaw = input.name ?? row.name ?? basename(sourcePath);
  const slug = slugify(slugRaw);
  if (!slug) {
    throw new Migrate03Error("E_VALIDATION", `could not derive a slug from "${slugRaw}"`);
  }

  const stateDbPath = projectDbPath(slug, homeDir);
  if (existsSync(stateDbPath)) {
    // Idempotent path: if the state-dir DB's project.root_path already
    // matches sourcePath, treat this as already migrated. Otherwise a
    // different project is parked at the same slug — caller must resolve.
    const existing = new OpenDb(stateDbPath, { enableForeignKeyConstraints: true });
    let existingRoot: string | null = null;
    try {
      const existingRow = existing.prepare("SELECT root_path FROM project WHERE id=1").get() as
        | { root_path: string }
        | undefined;
      existingRoot = existingRow?.root_path ?? null;
    } finally {
      existing.close();
    }
    if (existingRoot === sourcePath) {
      return {
        outcome: "already-migrated",
        slug,
        sourcePath,
        stateDbPath,
        reviewRunsMoved: 0,
        deletedSource: false,
        note: `state-dir already present at ${stateDbPath} with matching root_path`,
      };
    }
    return {
      outcome: "conflict-existing-state-dir",
      slug,
      sourcePath,
      stateDbPath,
      reviewRunsMoved: 0,
      deletedSource: false,
      note:
        `state-dir ${stateDbPath} already holds a project rooted at ` +
        `${existingRoot ?? "(unknown)"} — pick a different --name or resolve the conflict first`,
    };
  }

  if (input.dryRun) {
    return {
      outcome: "migrated",
      slug,
      sourcePath,
      stateDbPath,
      reviewRunsMoved: 0,
      deletedSource: false,
      note: "dry-run: no writes performed",
    };
  }

  // Step 3 — copy the DB into the state-dir (create parent).
  const stateDir = projectStateDir(slug, homeDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    copyFileSync(sourceDbPath, stateDbPath);
  } catch (e) {
    throw new Migrate03Error(
      "E_FILESYSTEM",
      `failed to copy ${sourceDbPath} → ${stateDbPath}: ${(e as Error).message}`,
    );
  }

  // Step 4 — rewrite root_path + name on the copied DB.
  const dest = new OpenDb(stateDbPath, { enableForeignKeyConstraints: true });
  dest.exec("PRAGMA journal_mode = WAL");
  try {
    dest
      .prepare("UPDATE project SET name = ?, root_path = ?, updated_at = ? WHERE id = 1")
      .run(slug, sourcePath, Date.now());
  } catch (e) {
    dest.close();
    throw new Migrate03Error(
      "E_STATE_INVALID",
      `failed to update project row in ${stateDbPath}: ${(e as Error).message}`,
    );
  } finally {
    dest.close();
  }

  // Step 5 — upsert the global registry.
  try {
    upsertProject(globalDb, { name: slug, root_path: sourcePath, state: row.state });
  } catch (e) {
    throw new Migrate03Error(
      "E_STATE_INVALID",
      `global registry upsert failed for slug="${slug}" root="${sourcePath}": ${(e as Error).message}`,
    );
  }

  // Step 6 — move any in-tree review runs.
  const sourceReviewRuns = join(sourcePath, ".review-runs");
  let runsMoved = 0;
  if (existsSync(sourceReviewRuns)) {
    const destReviewRuns = projectRunsDir(slug, homeDir);
    try {
      mkdirSync(destReviewRuns, { recursive: true });
      // Move each subdir of .review-runs; preserve existing dest entries.
      for (const name of readdirSync(sourceReviewRuns)) {
        const from = join(sourceReviewRuns, name);
        const to = join(destReviewRuns, name);
        if (existsSync(to)) continue; // skip conflicts; don't clobber
        renameSync(from, to);
        runsMoved += 1;
      }
      // Drop the now-empty source dir (failure non-fatal).
      try {
        rmSync(sourceReviewRuns, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      throw new Migrate03Error("E_FILESYSTEM", `review-runs move failed: ${(e as Error).message}`);
    }
  }

  // Step 7 — optional source deletion.
  let deletedSource = false;
  if (input.deleteSource) {
    const sourceVcfDir = join(sourcePath, ".vcf");
    try {
      rmSync(sourceVcfDir, { recursive: true, force: true });
      deletedSource = true;
    } catch (e) {
      throw new Migrate03Error(
        "E_FILESYSTEM",
        `failed to remove in-tree ${sourceVcfDir}: ${(e as Error).message}`,
      );
    }
  }

  return {
    outcome: "migrated",
    slug,
    sourcePath,
    stateDbPath,
    reviewRunsMoved: runsMoved,
    deletedSource,
  };
}

/**
 * Walk an array of search roots looking for `<root>/.vcf/project.db` files.
 * Used by `vcf migrate 0.3 --all` when the operator wants to sweep every
 * registered allowed_root in one pass.
 */
export function discoverLegacyProjects(searchRoots: string[]): string[] {
  const out: string[] = [];
  for (const root of searchRoots) {
    try {
      const st = statSync(root);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root, 3, out);
  }
  return out;

  function walk(dir: string, depthLeft: number, acc: string[]): void {
    // depth-limited: operators tend to have projects at depth 1-2 under
    // allowed_roots. Going deeper walks node_modules and other big trees.
    const candidate = join(dir, ".vcf", "project.db");
    if (existsSync(candidate)) acc.push(dir);
    if (depthLeft <= 0) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const sub = join(dir, name);
      try {
        const st = statSync(sub);
        if (st.isDirectory()) walk(sub, depthLeft - 1, acc);
      } catch {
        /* ignore */
      }
    }
  }
}
