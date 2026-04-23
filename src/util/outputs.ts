// Output-path helper.
//
// Every project-tree artifact the MCP server writes (plans, decisions,
// review reports, response-log, lifecycle reports, memory logs, docs,
// skills, backups) has a configurable location under
// `config.outputs.<kind>`. Defaults keep the pre-0.6.2 layout — each
// subdir rooted at the registered project_root — so no config changes
// are required for existing installs.
//
// Values may be:
//   - relative (default) — resolved against `projectRoot`
//   - absolute           — used as-is
//
// This lets operators keep outputs inside the project tree (the
// recommended default — reviews are evidence that belongs with the
// code) OR point a specific kind at a shared location (e.g. a
// company-wide decision log).

import { isAbsolute, resolve as resolvePath, join } from "node:path";
import type { Config } from "../config/schema.js";

/**
 * Resolve a single configured output value against `projectRoot`.
 * Absolute values pass through unchanged.
 */
export function resolveOutput(projectRoot: string, configured: string): string {
  return isAbsolute(configured) ? configured : resolvePath(projectRoot, configured);
}

/**
 * Resolved output locations for a given project root.
 *
 * Use this at the top of each tool handler rather than building paths
 * via `join(projectRoot, "plans", …)`. Centralizing the lookup means
 * `config.outputs.<kind>` is the single contact surface operators need
 * to change to relocate an artifact kind.
 */
export interface ResolvedOutputs {
  /** Base dir for plan/manifest/todo markdown pairs. */
  plansDir: string;
  /** Decision log (ADR-lite per file). */
  decisionsDir: string;
  /** Review reports root (type subdirs land under this). */
  reviewsDir: string;
  /** Absolute path to the response-log markdown file. */
  responseLogPath: string;
  /** Dir where lifecycle-report.{md,json} land. */
  lifecycleReportDir: string;
  /** Memory / daily-logs base. */
  memoryDir: string;
  /** Project-level docs root (scaffolded by project_init). */
  docsDir: string;
  /** Project-level skills root (scaffolded by project_init). */
  skillsDir: string;
  /** Default backup destination inside the project. */
  backupsDir: string;
}

export function resolveOutputs(projectRoot: string, config: Config): ResolvedOutputs {
  const out = config.outputs;
  return {
    plansDir: resolveOutput(projectRoot, out.plans_dir),
    decisionsDir: resolveOutput(projectRoot, out.decisions_dir),
    reviewsDir: resolveOutput(projectRoot, out.reviews_dir),
    responseLogPath: resolveOutput(projectRoot, out.response_log_path),
    lifecycleReportDir: resolveOutput(projectRoot, out.lifecycle_report_dir),
    memoryDir: resolveOutput(projectRoot, out.memory_dir),
    docsDir: resolveOutput(projectRoot, out.docs_dir),
    skillsDir: resolveOutput(projectRoot, out.skills_dir),
    backupsDir: resolveOutput(projectRoot, out.backups_dir),
  };
}

/**
 * Build a type-scoped reviews dir from the reviews-root.
 * `plans/reviews/code/` (etc.) under the default layout.
 */
export function reviewsDirForType(outputs: ResolvedOutputs, reviewType: string): string {
  return join(outputs.reviewsDir, reviewType);
}
