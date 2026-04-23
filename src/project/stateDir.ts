// Per-project state directory under the user's global VCF dir.
//
// VCF never writes runtime state inside a project directory. The only
// things that live in-tree are user-authored or user-blessed artifacts
// (plans/, CLAUDE.md, skills/, spec docs, the final review reports under
// plans/reviews/). Everything the MCP server generates — the SQLite DB,
// review-run scratch, audit traces — lives under:
//
//     ~/.vcf/projects/<slug>/
//
// where <slug> is the kebab-case form of the project name as stored in
// the global registry. The registry row (projects.name UNIQUE) keeps
// slugs unique across projects on this host.
//
// The global registry (`~/.vcf/vcf.db`) is the source of truth for
// "this path is a VCF project." Scope auto-detect walks up from cwd
// matching registered root_paths; no in-tree marker is required.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the VCF home dir. Honors `VCF_HOME` (test hook; scoped to a
 * tmpdir during integration tests so state doesn't leak into the real
 * `~/.vcf/`). Falls back to the OS home.
 */
function vcfHome(): string {
  return process.env["VCF_HOME"] ?? homedir();
}

/** Absolute path to `~/.vcf/projects/<slug>/`. */
export function projectStateDir(slug: string, home?: string | undefined): string {
  return join(home ?? vcfHome(), ".vcf", "projects", slug);
}

/** Absolute path to `~/.vcf/projects/<slug>/project.db`. */
export function projectDbPath(slug: string, home?: string | undefined): string {
  return join(projectStateDir(slug, home), "project.db");
}

/** Absolute path to `~/.vcf/projects/<slug>/review-runs/` — review scratch root. */
export function projectRunsDir(slug: string, home?: string | undefined): string {
  return join(projectStateDir(slug, home), "review-runs");
}
