// Shared project-adoption core.
//
// The CLI (`vcf adopt`) and the MCP tool (`project_init_existing`) both need
// to bring a pre-existing directory under VCF tracking: open/create the
// per-project SQLite, mark `adopted=1`, insert or update the project row,
// and upsert into the global registry. Before this module they each
// reimplemented that sequence independently — a drift vector on a boundary-
// sensitive flow, flagged at the 0.5.0 release gate (followup #39).
//
// Callers own the wrapping concerns:
//   - path validation + existence checks
//   - allowed_roots enforcement (both surfaces call assertInsideAllowedRoot
//     before invoking adoptProject — the core does NOT re-check because
//     the CLI caller has the config-loading bootstrap edge to handle)
//   - name resolution (basename fallback)
//   - state/mode argument validation
//   - user-facing messaging
//
// The core owns: mkdir .vcf, project.db open/create, project row
// insert/update with adopted=1, global registry upsert with the registry-
// healing non-fatal contract.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openProjectDb, type ProjectState } from "../db/project.js";
import { upsertProject } from "../util/projectRegistry.js";
import { slugify } from "../util/slug.js";

export interface AdoptProjectInput {
  /** Absolute path to the project directory. Caller must validate beforehand. */
  root: string;
  /** Human-readable project name. Caller resolves the default (basename). */
  name: string;
  /** Initial state if this is a fresh adoption. Ignored when a project row already exists (state preserved). */
  state: ProjectState;
  /** Global registry DB handle. The core upserts; mirror failure is non-fatal. */
  globalDb: DatabaseSync;
}

export interface AdoptProjectResult {
  /** Absolute path to the project.db that now carries the adopted marker. */
  projectDbPath: string;
  /** Kebab-case slug derived from `name` — what the global registry indexes. */
  slug: string;
  /** True when project.db did not exist before this call. */
  freshDb: boolean;
  /**
   * If the id=1 project row already existed, this carries its pre-existing
   * name + state so the caller can log "re-adopted X at state Y (preserved)"
   * messaging. Null when the row was inserted fresh.
   */
  existing: { name: string; state: string } | null;
  /**
   * Non-null when the global-registry upsert failed. The per-project DB is
   * still authoritative and re-running adopt heals the registry, so the
   * caller surfaces this as a warning, never an error.
   */
  registryWarning: string | null;
}

/**
 * Adopt a pre-existing directory into VCF. Idempotent: re-adopting the same
 * path refreshes the `adopted` flag and `updated_at` stamp without clobbering
 * the project's existing state or name.
 *
 * Registry write is advisory (see AdoptProjectResult.registryWarning).
 */
export async function adoptProject(input: AdoptProjectInput): Promise<AdoptProjectResult> {
  const { root, name, state, globalDb } = input;
  const slug = slugify(name);

  await mkdir(join(root, ".vcf"), { recursive: true });
  const projectDbPath = join(root, ".vcf", "project.db");
  const freshDb = !existsSync(projectDbPath);
  const pdb = openProjectDb({ path: projectDbPath });
  const now = Date.now();
  const existing = pdb.prepare("SELECT id, name, state FROM project WHERE id = 1").get() as
    | { id: number; name: string; state: string }
    | undefined;

  if (existing) {
    pdb
      .prepare("UPDATE project SET adopted = 1, updated_at = ?, root_path = ? WHERE id = 1")
      .run(now, root);
  } else {
    pdb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at, spec_path, adopted)
         VALUES (1, ?, ?, ?, ?, ?, NULL, 1)`,
      )
      .run(name, root, state, now, now);
  }
  pdb.close();

  let registryWarning: string | null = null;
  try {
    upsertProject(globalDb, {
      name: slug,
      root_path: root,
      state: existing?.state ?? state,
    });
  } catch (e) {
    registryWarning =
      `global registry update failed (${(e as Error).message}) — ` +
      `local project.db is adopted; re-run adoption to heal the registry`;
  }

  return {
    projectDbPath,
    slug,
    freshDb,
    existing: existing ? { name: existing.name, state: existing.state } : null,
    registryWarning,
  };
}
