// Launch-scope detection for the MCP server.
//
// Scope is derived from the global project registry — never from in-tree
// files. A project is "this path is registered in `~/.vcf/vcf.db`"; scope
// auto-detect walks up from cwd looking for a registered root_path. No
// in-tree `.vcf/` marker exists (runtime state lives under
// `~/.vcf/projects/<slug>/` — see `./project/stateDir.ts`).
//
//   project — walk-up from cwd hit a registered root_path. The server
//             exposes the full lifecycle (plan/build/test/review/ship +
//             lesson/decision/response logs).
//
//   global  — no match found on the walk. The server exposes
//             idea/spec/project-init/catalog tools only.
//
// `requested` is retained as an explicit override for tests and power
// users. Auto-detect is the default.

import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { McpError } from "./errors.js";
import { projectDbPath as stateDbPath } from "./project/stateDir.js";

export type Scope = "global" | "project";

export interface ResolveScopeInput {
  /** Optional explicit override. Auto-detected when omitted. */
  requested?: Scope;
  cwd: string;
  /** Global registry — consulted during auto-detect and explicit-project. */
  globalDb: DatabaseSync;
  /** Test hook: override the home dir used to build the project-db path. */
  homeDir?: string;
}

export type ProjectRole = "standard" | "pm";

export interface ResolvedScope {
  scope: Scope;
  /** Registered project root (the path stored in the registry) when scope is project. */
  projectRoot?: string;
  /** Slug used as the state-dir name under ~/.vcf/projects/. */
  projectSlug?: string;
  /** Absolute path to the project's state-dir project.db. */
  projectDbPath?: string;
  /**
   * Role from the global registry (migration v4). 'pm' unlocks the
   * cross-project admin tool surface (project_move / project_rename /
   * project_relocate); 'standard' is the default.
   */
  projectRole?: ProjectRole;
}

/**
 * Resolve the launch scope by consulting the global registry.
 *
 * - No `requested`: walk up from cwd, match each path against registered
 *   root_paths. First hit → project scope. No hit → global scope.
 * - `requested === "global"`: return global even if a match exists.
 * - `requested === "project"`: require a registered project at cwd
 *   (no walk-up — explicit project scope means "this exact directory").
 */
export function resolveScope(input: ResolveScopeInput): ResolvedScope {
  const cwd = resolve(input.cwd);
  const home = input.homeDir ?? homedir();

  if (input.requested === "global") {
    return { scope: "global" };
  }
  if (input.requested === "project") {
    const hit = lookupRegistered(cwd, input.globalDb);
    if (!hit) {
      throw new McpError(
        "E_STATE_INVALID",
        `project scope requested but no VCF project is registered at ${cwd}. ` +
          `Run \"vcf adopt\" at the project root (the directory where Claude Code / your LLM is launched — typically the one holding CLAUDE.md) first.`,
        { cwd },
      );
    }
    return buildProjectScope(hit, home);
  }

  const hit = findProjectAtOrAbove(cwd, input.globalDb);
  if (hit) return buildProjectScope(hit, home);
  return { scope: "global" };
}

function buildProjectScope(
  hit: { root_path: string; slug: string; role: ProjectRole },
  home: string,
): ResolvedScope {
  return {
    scope: "project",
    projectRoot: hit.root_path,
    projectSlug: hit.slug,
    projectDbPath: stateDbPath(hit.slug, home),
    projectRole: hit.role,
  };
}

function toRole(raw: string | undefined): ProjectRole {
  return raw === "pm" ? "pm" : "standard";
}

/** Exact match of `cwd` against registered root_paths. */
function lookupRegistered(
  cwd: string,
  globalDb: DatabaseSync,
): { root_path: string; slug: string; role: ProjectRole } | null {
  const row = globalDb
    .prepare("SELECT name, root_path, role FROM projects WHERE root_path = ?")
    .get(cwd) as { name: string; root_path: string; role: string } | undefined;
  if (!row) return null;
  return { root_path: row.root_path, slug: row.name, role: toRole(row.role) };
}

/** Walk-up from cwd, match each level against registered root_paths. */
function findProjectAtOrAbove(
  startCwd: string,
  globalDb: DatabaseSync,
): { root_path: string; slug: string; role: ProjectRole } | null {
  const rows = globalDb.prepare("SELECT name, root_path, role FROM projects").all() as Array<{
    name: string;
    root_path: string;
    role: string;
  }>;
  if (rows.length === 0) return null;
  const byPath = new Map<string, { slug: string; role: ProjectRole }>();
  for (const r of rows) byPath.set(resolve(r.root_path), { slug: r.name, role: toRole(r.role) });

  let dir = startCwd;
  while (true) {
    const hit = byPath.get(dir);
    if (hit !== undefined) return { root_path: dir, slug: hit.slug, role: hit.role };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
