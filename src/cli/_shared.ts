// Followup #44 — shared helpers for the per-group CLI modules under src/cli/.
//
// Each command module (init.ts, reindex.ts, project.ts, …) imports from
// here rather than from cli.ts directly. Keeps the split clean: cli.ts is
// the commander bootstrap + top-level argv routing; per-group modules
// implement runXxx and re-share only what lives here.

import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../config/loader.js";

/**
 * Resolve the global VCF dir. Honors `VCF_HOME` (test hook; scoped to a
 * tmpdir during tests) so CLI operations don't touch the real `~/.vcf/`.
 */
export const vcfHomeDir = (): string => process.env["VCF_HOME"] ?? homedir();

export const DEFAULT_CONFIG_PATH = (): string =>
  resolvePath(homedir(), ".vcf", "config.yaml");
export const DEFAULT_KB_ROOT = (): string => resolvePath(homedir(), ".vcf", "kb");
export const DEFAULT_KB_ANCESTOR_ROOT = (): string =>
  resolvePath(homedir(), ".vcf", "kb-ancestors");

/**
 * Resolve the upstream `@kaelith-labs/kb` package's `kb/` directory.
 *
 * Order: VCF_KB_SOURCE env override → monorepo sibling checkout (dev) →
 * installed package via `require.resolve` (production — handles hoisted
 * node_modules, nested node_modules, and pnpm store symlinks uniformly).
 * Returns null if none of those paths resolve to an existing directory.
 */
export function resolveUpstreamKbRoot(): string | null {
  const envOverride = process.env["VCF_KB_SOURCE"];
  if (envOverride && existsSync(envOverride)) return envOverride;

  const devSibling = resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "vcf-kb",
    "kb",
  );
  if (existsSync(devSibling)) return devSibling;

  try {
    const require = createRequire(import.meta.url);
    const kbPkg = require.resolve("@kaelith-labs/kb/package.json");
    const installed = join(dirname(kbPkg), "kb");
    if (existsSync(installed)) return installed;
  } catch {
    // @kaelith-labs/kb is not installed in any resolvable location.
  }
  return null;
}

export function err(message: string, code = 1): never {
  process.stderr.write(`vcf: ${message}\n`);
  process.exit(code);
}

export function log(message: string): void {
  process.stderr.write(`vcf: ${message}\n`);
}

export async function loadConfigOrExit(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  try {
    return await loadConfig(path);
  } catch (e) {
    if (e instanceof ConfigError) err(`[${e.code}] ${e.message}`);
    throw e;
  }
}

/**
 * Minimal slug helper — strictly the registry name shape. Accepts the
 * special-case empty input and returns 'project' so adopt paths always
 * have a non-empty slug to work with.
 */
export function slugifyBasic(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 128) || "project"
  );
}

/** CSV-escape rule used by the admin audit --format=csv path. */
export function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
