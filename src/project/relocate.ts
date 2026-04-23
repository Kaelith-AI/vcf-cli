// relocateProject — shared core for `vcf project relocate` CLI + `project_relocate` MCP tool.
//
// Semantics: update the registered `root_path` for a project WITHOUT
// touching the filesystem. Use case: the operator cloned the repo into
// a different directory (e.g., `~/work/foo` → `~/src/foo`) and needs
// the registry's auto-detect to match the new layout. No file copy,
// no rename, no state-dir touch.
//
// For actual directory moves, use `moveProject` instead.

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../db/project.js";
import { getProjectByName, getProjectByRoot } from "../util/projectRegistry.js";
import { projectDbPath } from "./stateDir.js";

export interface RelocateProjectInput {
  slug: string;
  newPath: string;
  allowedRoots: readonly string[];
  globalDb: DatabaseSync;
  homeDir?: string;
}

export interface RelocateProjectResult {
  slug: string;
  oldPath: string;
  newPath: string;
}

export class RelocateProjectError extends Error {
  constructor(
    public code: "E_NOT_FOUND" | "E_ALREADY_EXISTS" | "E_SCOPE_DENIED" | "E_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "RelocateProjectError";
  }
}

export async function relocateProject(
  input: RelocateProjectInput,
): Promise<RelocateProjectResult> {
  const { slug, globalDb } = input;
  const row = getProjectByName(globalDb, slug);
  if (!row) {
    throw new RelocateProjectError(
      "E_NOT_FOUND",
      `no registered project with slug '${slug}'`,
    );
  }
  const oldPath = resolvePath(row.root_path);
  const newPath = resolvePath(input.newPath);
  if (oldPath === newPath) {
    return { slug, oldPath, newPath };
  }

  if (!existsSync(newPath) || !statSync(newPath).isDirectory()) {
    throw new RelocateProjectError(
      "E_NOT_FOUND",
      `new path ${newPath} does not exist or is not a directory`,
    );
  }
  if (!isInsideAllowedRoots(newPath, input.allowedRoots)) {
    throw new RelocateProjectError(
      "E_SCOPE_DENIED",
      `new path ${newPath} is outside workspace.allowed_roots`,
    );
  }
  const collision = getProjectByRoot(globalDb, newPath);
  if (collision && collision.name !== slug) {
    throw new RelocateProjectError(
      "E_ALREADY_EXISTS",
      `another registered project ('${collision.name}') already owns ${newPath}`,
    );
  }

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

  return { slug, oldPath, newPath };
}

function isInsideAllowedRoots(path: string, roots: readonly string[]): boolean {
  const abs = resolvePath(path);
  return roots.some((r) => {
    const absRoot = resolvePath(r);
    return abs === absRoot || abs.startsWith(absRoot + "/");
  });
}
