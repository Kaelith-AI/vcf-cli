// Followup #44 — `vcf adopt` + `vcf project (register / list / scan /
// unregister / refresh / move / rename / relocate / set-role)` CLI
// handlers.
//
// Cross-project registry maintenance. `project_init` (MCP tool) auto-
// registers new projects; these commands cover pre-existing projects
// and explicit deregistration. Operates against the global DB only —
// the authoritative per-project state lives in each project.db.

import { resolve as resolvePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import { openGlobalDb } from "../db/global.js";
import { openProjectDb } from "../db/project.js";
import { projectDbPath } from "../project/stateDir.js";
import {
  listProjects,
  setProjectRole,
  setProjectState,
  unregisterProject,
  upsertProject,
} from "../util/projectRegistry.js";
import { loadConfig } from "../config/loader.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { adoptProject } from "../project/adopt.js";
import { moveProject, MoveProjectError } from "../project/move.js";
import { renameProject, RenameProjectError } from "../project/rename.js";
import { relocateProject, RelocateProjectError } from "../project/relocate.js";
import {
  DEFAULT_CONFIG_PATH,
  err,
  log,
  loadConfigOrExit,
  slugifyBasic,
  vcfHomeDir,
} from "./_shared.js";

export async function runAdopt(opts: {
  path: string;
  name?: string;
  state?: string;
}): Promise<void> {
  const { basename } = await import("node:path");
  const absRoot = resolvePath(opts.path);
  if (!existsSync(absRoot)) {
    err(`path does not exist: ${absRoot}`, 2);
  }
  const st = statSync(absRoot);
  if (!st.isDirectory()) {
    err(`path is not a directory: ${absRoot}`, 2);
  }

  const configPath = DEFAULT_CONFIG_PATH();
  if (existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      await assertInsideAllowedRoot(absRoot, config.workspace.allowed_roots);
    } catch (e) {
      const kind = (e as { code?: string } | undefined)?.code;
      if (kind === "E_SCOPE_DENIED") {
        err(`path ${absRoot} is outside workspace.allowed_roots — edit ${configPath} to add it`, 2);
      }
      err(
        `config at ${configPath} exists but failed to load (${(e as Error).message}) — fix it and retry`,
        2,
      );
    }
  }

  const allowedStates = new Set([
    "draft",
    "planning",
    "building",
    "testing",
    "reviewing",
    "shipping",
    "shipped",
  ]);
  const state = opts.state ?? "reviewing";
  if (!allowedStates.has(state)) {
    err(`invalid --state ${state} (allowed: ${Array.from(allowedStates).join(",")})`, 2);
  }

  const name = opts.name ?? (basename(absRoot) || "project");

  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const result = await adoptProject({
      root: absRoot,
      name,
      state: state as import("../db/project.js").ProjectState,
      globalDb,
    });

    if (result.existing) {
      log(
        `re-adopted project '${result.existing.name}' at ${absRoot} (state=${result.existing.state} preserved)`,
      );
    } else {
      log(
        `adopted project '${name}' at ${absRoot} (state=${state}, fresh project.db=${result.freshDb})`,
      );
      log(`  registered in global registry as '${result.slug}'`);
      log(`  next: run reviews with 'vcf-mcp' in ${absRoot} or start a project-scope MCP session`);
    }
    if (result.registryWarning) log(`warning: ${result.registryWarning}`);
  } finally {
    globalDb.close();
  }
}

export async function runProjectRegister(opts: {
  path: string;
  name?: string;
}): Promise<void> {
  const absRoot = resolvePath(opts.path);
  const candidateName = opts.name ?? slugifyBasic(absRoot.split("/").pop() ?? "project");
  const statePath = projectDbPath(candidateName);
  let row: { name: string; state: string } | undefined;
  if (existsSync(statePath)) {
    const pdb = openProjectDb({ path: statePath });
    row = pdb.prepare("SELECT name, state FROM project WHERE id = 1").get() as
      | { name: string; state: string }
      | undefined;
    pdb.close();
  }
  const name = opts.name ?? (row ? slugifyBasic(row.name) : candidateName);
  const state = row?.state ?? null;

  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    upsertProject(globalDb, { name, root_path: absRoot, state });
    log(`registered project '${name}' → ${absRoot}`);
  } finally {
    globalDb.close();
  }
}

export async function runProjectList(): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const rows = listProjects(globalDb);
    if (rows.length === 0) {
      log(
        "no projects registered — use `vcf project register <path>` or `vcf project scan <root>`",
      );
      return;
    }
    for (const p of rows) {
      const age = p.last_seen_at
        ? `${Math.floor((Date.now() - p.last_seen_at) / 1000)}s ago`
        : "never";
      process.stderr.write(
        `  ${p.name.padEnd(24)} ${(p.state_cache ?? "—").padEnd(10)} ${p.root_path} (seen ${age})\n`,
      );
    }
    log(`${rows.length} project(s) registered`);
  } finally {
    globalDb.close();
  }
}

export async function runProjectScan(opts: { root: string }): Promise<void> {
  // Scan previously walked the filesystem looking for `.vcf/project.db`
  // markers inside project directories. With runtime state now living out
  // of tree under ~/.vcf/projects/<slug>/, there is no in-tree signal to
  // scan for — adoption is the only path to becoming a registered
  // project. Print a helpful error instead of silently doing nothing.
  void opts;
  err(
    "`vcf project scan` is obsolete — runtime state no longer lives in-tree. " +
      "Use `vcf adopt <path>` (or `vcf init`) for each project root you want registered.",
    2,
  );
}

export async function runProjectUnregister(name: string): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const dropped = unregisterProject(globalDb, name);
    if (dropped) log(`unregistered project '${name}' (files untouched)`);
    else err(`no project named '${name}' in registry`, 2);
  } finally {
    globalDb.close();
  }
}

export async function runProjectRefresh(): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const rows = listProjects(globalDb);
    let refreshed = 0;
    for (const p of rows) {
      const pdbPath = projectDbPath(p.name);
      if (!existsSync(pdbPath)) {
        process.stderr.write(
          `  [MISSING] ${p.name}: ${pdbPath} not found — consider unregistering\n`,
        );
        continue;
      }
      const pdb = openProjectDb({ path: pdbPath });
      const row = pdb.prepare("SELECT state FROM project WHERE id = 1").get() as
        | { state: string }
        | undefined;
      pdb.close();
      if (row) {
        setProjectState(globalDb, p.root_path, row.state);
        refreshed++;
      }
    }
    log(`refresh: ${refreshed}/${rows.length} project state(s) updated`);
  } finally {
    globalDb.close();
  }
}

export async function runProjectMove(
  slug: string,
  newPath: string,
  opts: { move: boolean; force: boolean },
): Promise<void> {
  const config = await loadConfigOrExit();
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const r = await moveProject({
      slug,
      newPath: resolvePath(newPath),
      mode: opts.move ? "move" : "copy",
      force: opts.force,
      allowedRoots: config.workspace.allowed_roots,
      globalDb,
    });
    if (r.mode === "move") {
      log(`moved project '${r.slug}' from ${r.oldPath} to ${r.newPath}`);
    } else {
      log(`copied project '${r.slug}' from ${r.oldPath} to ${r.newPath} (source retained; pass --move to delete it)`);
    }
    if (r.sourceDeleteWarning) log(`warning: ${r.sourceDeleteWarning}`);
  } catch (e) {
    if (e instanceof MoveProjectError) err(`${e.code}: ${e.message}`, 2);
    throw e;
  } finally {
    globalDb.close();
  }
}

export async function runProjectRename(slug: string, newName: string): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const r = await renameProject({ slug, newName, globalDb });
    if (r.oldSlug === r.newSlug) {
      log(`renamed display '${r.oldName}' → '${r.newName}' (slug unchanged: ${r.newSlug})`);
    } else {
      log(`renamed '${r.oldSlug}' → '${r.newSlug}' (display '${r.oldName}' → '${r.newName}')`);
      if (r.stateDirRenamed) log(`  state-dir renamed under ~/.vcf/projects/`);
    }
  } catch (e) {
    if (e instanceof RenameProjectError) err(`${e.code}: ${e.message}`, 2);
    throw e;
  } finally {
    globalDb.close();
  }
}

export async function runProjectRelocate(slug: string, newPath: string): Promise<void> {
  const config = await loadConfigOrExit();
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const r = await relocateProject({
      slug,
      newPath: resolvePath(newPath),
      allowedRoots: config.workspace.allowed_roots,
      globalDb,
    });
    if (r.oldPath === r.newPath) {
      log(`project '${r.slug}' already at ${r.newPath} — no change`);
    } else {
      log(`relocated '${r.slug}' pointer: ${r.oldPath} → ${r.newPath}`);
    }
  } catch (e) {
    if (e instanceof RelocateProjectError) err(`${e.code}: ${e.message}`, 2);
    throw e;
  } finally {
    globalDb.close();
  }
}

export async function runProjectSetRole(slug: string, role: string): Promise<void> {
  if (role !== "pm" && role !== "standard") {
    err(`invalid role '${role}' — must be 'pm' or 'standard'`, 2);
  }
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const changed = setProjectRole(globalDb, slug, role as "pm" | "standard");
    if (!changed) err(`no registered project with slug '${slug}'`, 2);
    log(`set project '${slug}' role to '${role}'`);
  } finally {
    globalDb.close();
  }
}
