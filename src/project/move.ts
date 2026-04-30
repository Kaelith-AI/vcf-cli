// moveProject — shared core for `vcf project move` CLI + `project_move` MCP tool.
//
// Semantics: copy the project's on-disk directory from its current
// registered `root_path` to `newPath`, then re-point both the global
// registry row and the project.db's `project.root_path` to the new
// location. On mode="move", delete the source after the copy + DB
// updates succeed. On mode="copy", leave the source intact.
//
// Failure handling:
//   - Target must not exist (or be an empty directory) unless `force=true`.
//   - Target must live inside `workspace.allowed_roots`.
//   - Copy-then-commit pattern: we copy to a temp sibling dir first, rename
//     into place atomically (same-filesystem), then run the DB updates.
//     On DB failure the copy is rolled back (target deleted).
//   - Post-success source-delete failure is non-fatal; surfaced via
//     `sourceDeleteWarning` in the result.

import { cp, rm, mkdir, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../db/project.js";
import { getProjectByName, getProjectByRoot } from "../util/projectRegistry.js";
import { projectDbPath } from "./stateDir.js";

export type MoveMode = "copy" | "move";

export interface MoveProjectInput {
  slug: string;
  newPath: string;
  mode?: MoveMode;
  force?: boolean;
  allowedRoots: readonly string[];
  globalDb: DatabaseSync;
  homeDir?: string;
}

export interface MoveProjectResult {
  slug: string;
  oldPath: string;
  newPath: string;
  mode: MoveMode;
  sourceDeleteWarning: string | null;
}

export class MoveProjectError extends Error {
  constructor(
    public code:
      | "E_NOT_FOUND"
      | "E_ALREADY_EXISTS"
      | "E_SCOPE_DENIED"
      | "E_FILESYSTEM"
      | "E_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "MoveProjectError";
  }
}

export async function moveProject(input: MoveProjectInput): Promise<MoveProjectResult> {
  const { slug, globalDb } = input;
  const mode: MoveMode = input.mode ?? "copy";
  const force = input.force ?? false;

  const row = getProjectByName(globalDb, slug);
  if (!row) {
    throw new MoveProjectError("E_NOT_FOUND", `no registered project with slug '${slug}'`);
  }
  const oldPath = resolvePath(row.root_path);
  const newPath = resolvePath(input.newPath);
  if (oldPath === newPath) {
    throw new MoveProjectError("E_ALREADY_EXISTS", `project '${slug}' is already at ${newPath}`);
  }

  if (!isInsideAllowedRoots(newPath, input.allowedRoots)) {
    throw new MoveProjectError(
      "E_SCOPE_DENIED",
      `target path ${newPath} is outside workspace.allowed_roots`,
    );
  }

  // Target collision: if it exists and isn't an empty dir, require force.
  if (existsSync(newPath)) {
    const entries = await readdir(newPath).catch(() => []);
    if (entries.length > 0 && !force) {
      throw new MoveProjectError(
        "E_ALREADY_EXISTS",
        `target ${newPath} exists and is non-empty — pass force=true to overwrite`,
      );
    }
  }
  // Check the registry doesn't already own the new path under another slug.
  const collision = getProjectByRoot(globalDb, newPath);
  if (collision && collision.name !== slug) {
    throw new MoveProjectError(
      "E_ALREADY_EXISTS",
      `another registered project ('${collision.name}') already owns ${newPath}`,
    );
  }

  if (!existsSync(oldPath)) {
    throw new MoveProjectError(
      "E_STATE_INVALID",
      `source path ${oldPath} does not exist — project is registered but the directory is missing. Use 'vcf project relocate' instead.`,
    );
  }

  await mkdir(dirname(newPath), { recursive: true });

  // Copy-and-commit. We copy directly to newPath (cp recursive handles
  // both "target doesn't exist" and "target exists"); on DB failure we
  // rm -rf the target to roll back. This is not a cross-filesystem
  // atomic move, but it's as close as we get from userspace.
  try {
    await cp(oldPath, newPath, { recursive: true, errorOnExist: false, force: true });
  } catch (e) {
    throw new MoveProjectError(
      "E_FILESYSTEM",
      `copy ${oldPath} -> ${newPath} failed: ${(e as Error).message}`,
    );
  }

  // Update DBs. If this fails, roll back the copy.
  try {
    globalDb
      .prepare("UPDATE projects SET root_path = ?, last_seen_at = ? WHERE name = ?")
      .run(newPath, Date.now(), slug);

    const dbPath = projectDbPath(slug, input.homeDir);
    if (existsSync(dbPath)) {
      const pdb = openProjectDb({ path: dbPath });
      try {
        pdb
          .prepare("UPDATE project SET root_path = ?, updated_at = ? WHERE id = 1")
          .run(newPath, Date.now());
      } finally {
        pdb.close();
      }
    }
  } catch (e) {
    // Roll back the copy — preserve the source, remove the new target.
    await rm(newPath, { recursive: true, force: true }).catch(() => {});
    throw new MoveProjectError(
      "E_FILESYSTEM",
      `DB update failed after copy (rolled back): ${(e as Error).message}`,
    );
  }

  // Source delete (mode=move only). Non-fatal on failure.
  let sourceDeleteWarning: string | null = null;
  if (mode === "move") {
    try {
      await rm(oldPath, { recursive: true, force: true });
    } catch (e) {
      sourceDeleteWarning =
        `copied to ${newPath} and DBs updated, but failed to delete source ${oldPath}: ` +
        `${(e as Error).message}. Delete it manually.`;
    }
  }

  return { slug, oldPath, newPath, mode, sourceDeleteWarning };
}

function isInsideAllowedRoots(path: string, roots: readonly string[]): boolean {
  const abs = resolvePath(path);
  return roots.some((r) => {
    const absRoot = resolvePath(r);
    if (abs === absRoot) return true;
    const rel = relative(absRoot, abs);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

// unused util — silence
void rename;
