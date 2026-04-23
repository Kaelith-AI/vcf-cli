// renameProject — shared core for `vcf project rename` CLI + `project_rename` MCP tool.
//
// Semantics: change a project's display name. The slug derived from the new
// name is what keys the state-dir under `~/.vcf/projects/`, so this
// operation also renames the state-dir. The project's on-disk `root_path`
// is NOT touched — only the state-dir + registry name + project.db name.
//
// Failure handling:
//   - New slug must not collide with an existing registered project.
//   - State-dir rename happens first (filesystem op). If it fails, no DB
//     changes are made.
//   - DB updates (registry + project.db) follow. If they fail, the state-dir
//     rename is rolled back so the operator isn't left with a state-dir
//     whose name doesn't match any registered row.

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../db/project.js";
import { getProjectByName, getProjectByRoot } from "../util/projectRegistry.js";
import { slugify } from "../util/slug.js";
import { projectDbPath, projectStateDir } from "./stateDir.js";

export interface RenameProjectInput {
  slug: string;
  newName: string;
  globalDb: DatabaseSync;
  homeDir?: string;
}

export interface RenameProjectResult {
  oldSlug: string;
  newSlug: string;
  oldName: string;
  newName: string;
  stateDirRenamed: boolean;
}

export class RenameProjectError extends Error {
  constructor(
    public code: "E_NOT_FOUND" | "E_ALREADY_EXISTS" | "E_VALIDATION" | "E_FILESYSTEM",
    message: string,
  ) {
    super(message);
    this.name = "RenameProjectError";
  }
}

export async function renameProject(input: RenameProjectInput): Promise<RenameProjectResult> {
  const { slug, newName, globalDb } = input;
  if (newName.trim().length === 0) {
    throw new RenameProjectError("E_VALIDATION", "new name is empty");
  }
  const newSlug = slugify(newName);
  if (newSlug === slug) {
    // No-op at the slug level, but the display name may have changed.
    return renameDisplayNameOnly({
      slug,
      newName,
      globalDb,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
    });
  }

  const row = getProjectByName(globalDb, slug);
  if (!row) {
    throw new RenameProjectError(
      "E_NOT_FOUND",
      `no registered project with slug '${slug}'`,
    );
  }
  const collision = getProjectByName(globalDb, newSlug);
  if (collision) {
    throw new RenameProjectError(
      "E_ALREADY_EXISTS",
      `slug '${newSlug}' is already registered (root=${collision.root_path})`,
    );
  }

  const oldStateDir = projectStateDir(slug, input.homeDir);
  const newStateDir = projectStateDir(newSlug, input.homeDir);
  const stateDirExists = existsSync(oldStateDir);
  const newStateDirCollides = existsSync(newStateDir);
  if (newStateDirCollides) {
    throw new RenameProjectError(
      "E_ALREADY_EXISTS",
      `target state-dir ${newStateDir} already exists — remove it or pick a different name`,
    );
  }

  // Rename state-dir first. Filesystem op is the only step that can't be
  // trivially undone by the DB — do it before the DB touches so rollback
  // is just a reverse rename.
  if (stateDirExists) {
    try {
      await rename(oldStateDir, newStateDir);
    } catch (e) {
      throw new RenameProjectError(
        "E_FILESYSTEM",
        `rename ${oldStateDir} -> ${newStateDir} failed: ${(e as Error).message}`,
      );
    }
  }

  // DB updates with rollback on failure.
  const oldName = row.name;
  try {
    globalDb
      .prepare("UPDATE projects SET name = ?, last_seen_at = ? WHERE name = ?")
      .run(newSlug, Date.now(), slug);

    const dbPath = projectDbPath(newSlug, input.homeDir);
    if (existsSync(dbPath)) {
      const pdb = openProjectDb({ path: dbPath });
      try {
        pdb
          .prepare("UPDATE project SET name = ?, updated_at = ? WHERE id = 1")
          .run(newName, Date.now());
      } finally {
        pdb.close();
      }
    }
  } catch (e) {
    // Roll back the state-dir rename.
    if (stateDirExists) {
      await rename(newStateDir, oldStateDir).catch(() => {});
    }
    throw new RenameProjectError(
      "E_FILESYSTEM",
      `DB update failed after state-dir rename (rolled back): ${(e as Error).message}`,
    );
  }

  return { oldSlug: slug, newSlug, oldName, newName, stateDirRenamed: stateDirExists };
}

/**
 * Display-name-only rename: the slug stays the same (new name slugifies to
 * the same value). Only the project.db's project.name column is updated
 * — the registry's `name` is the slug, unchanged.
 */
async function renameDisplayNameOnly(args: {
  slug: string;
  newName: string;
  globalDb: DatabaseSync;
  homeDir?: string;
}): Promise<RenameProjectResult> {
  const dbPath = projectDbPath(args.slug, args.homeDir);
  let oldName = args.slug;
  if (existsSync(dbPath)) {
    const pdb = openProjectDb({ path: dbPath });
    try {
      const row = pdb.prepare("SELECT name FROM project WHERE id = 1").get() as
        | { name: string }
        | undefined;
      if (row) oldName = row.name;
      pdb
        .prepare("UPDATE project SET name = ?, updated_at = ? WHERE id = 1")
        .run(args.newName, Date.now());
    } finally {
      pdb.close();
    }
  }
  // Touch last_seen so the registry timestamp reflects the rename.
  args.globalDb
    .prepare("UPDATE projects SET last_seen_at = ? WHERE name = ?")
    .run(Date.now(), args.slug);
  return {
    oldSlug: args.slug,
    newSlug: args.slug,
    oldName,
    newName: args.newName,
    stateDirRenamed: false,
  };
}

// unused import guard
void getProjectByRoot;
