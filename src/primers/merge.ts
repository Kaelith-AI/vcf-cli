// Three-way merge core for `vcf update-primers` + the first-run seed path.
//
// Extracted from src/cli.ts (followup #44 god-module decomposition). Lives
// under `src/primers/` because it's KB content movement, not CLI UX —
// keeps `cli/` focused on handlers that marshal args and print output.

import { resolve as resolvePath, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

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

  // From src/primers/merge.ts: ../../../vcf-kb/kb → project-root's parent → sibling vcf-kb
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

/**
 * First-run KB seed. If `kbRoot` does not exist, copy every upstream file
 * into place and seed the ancestor snapshot so future `vcf update-primers`
 * runs have a three-way merge base. Idempotent: no-op if `kbRoot` exists.
 * If the upstream package can't be resolved, warn but do not fail — the
 * rest of init is still useful, and `vcf update-primers` can recover later.
 */
export async function seedKbIfMissing(
  kbRoot: string,
  ancestorRoot: string,
  logFn: (message: string) => void = defaultLog,
): Promise<void> {
  if (existsSync(kbRoot)) {
    logFn(
      `${kbRoot} already exists — leaving in place. Run 'vcf update-primers' to refresh.`,
    );
    return;
  }
  const upstreamRoot = resolveUpstreamKbRoot();
  if (upstreamRoot === null) {
    logFn(
      "warning: @kaelith-labs/kb not found — KB-reading tools will return empty until it's installed or 'vcf update-primers' is run.",
    );
    return;
  }
  const report = await mergePrimerTree({ kbRoot, upstreamRoot, ancestorRoot });
  logFn(
    `seeded kb: ${report.counts.added} entr(y|ies) from ${upstreamRoot} (ancestor: ${ancestorRoot})`,
  );
}

function defaultLog(message: string): void {
  process.stderr.write(`vcf: ${message}\n`);
}

export interface MergeOutcome {
  rel: string;
  kind: "added" | "in-sync" | "local-only" | "fast-forward" | "auto-merged" | "conflict";
  note?: string;
}
export interface MergeReport {
  outcomes: MergeOutcome[];
  counts: Record<MergeOutcome["kind"], number>;
}

export async function mergePrimerTree(opts: {
  kbRoot: string;
  upstreamRoot: string;
  ancestorRoot: string;
  /** Optional override for tests; defaults to real git. */
  runGitMergeFile?: (
    local: string,
    ancestor: string,
    upstream: string,
  ) => { exitCode: number };
}): Promise<MergeReport> {
  const { kbRoot, upstreamRoot, ancestorRoot } = opts;
  const runMerge = opts.runGitMergeFile ?? defaultRunGitMergeFile;
  await mkdir(kbRoot, { recursive: true });
  await mkdir(ancestorRoot, { recursive: true });

  const outcomes: MergeOutcome[] = [];
  const counts: Record<MergeOutcome["kind"], number> = {
    added: 0,
    "in-sync": 0,
    "local-only": 0,
    "fast-forward": 0,
    "auto-merged": 0,
    conflict: 0,
  };

  const stack: string[] = [upstreamRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      const rel = full.slice(upstreamRoot.length + 1);
      const localPath = join(kbRoot, rel);
      const ancestorPath = join(ancestorRoot, rel);

      if (!existsSync(localPath)) {
        await mkdir(dirname(localPath), { recursive: true });
        await copyFile(full, localPath);
        await mkdir(dirname(ancestorPath), { recursive: true });
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "added" });
        counts.added++;
        continue;
      }

      const [upBuf, localBuf] = await Promise.all([readFile(full), readFile(localPath)]);
      const upHash = sha256(upBuf);
      const localHash = sha256(localBuf);

      if (upHash === localHash) {
        await mkdir(dirname(ancestorPath), { recursive: true });
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "in-sync" });
        counts["in-sync"]++;
        continue;
      }

      if (!existsSync(ancestorPath)) {
        await writeFile(`${localPath}.upstream`, upBuf);
        outcomes.push({
          rel,
          kind: "conflict",
          note: "no ancestor baseline; local kept, upstream written to .upstream sibling",
        });
        counts.conflict++;
        continue;
      }

      const ancestorBuf = await readFile(ancestorPath);
      const ancestorHash = sha256(ancestorBuf);

      if (ancestorHash === upHash) {
        outcomes.push({ rel, kind: "local-only" });
        counts["local-only"]++;
        continue;
      }

      if (ancestorHash === localHash) {
        await copyFile(full, localPath);
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "fast-forward" });
        counts["fast-forward"]++;
        continue;
      }

      const { exitCode } = runMerge(localPath, ancestorPath, full);
      if (exitCode === 0) {
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "auto-merged" });
        counts["auto-merged"]++;
      } else {
        outcomes.push({
          rel,
          kind: "conflict",
          note: "git merge-file emitted conflict markers — resolve in place, then re-run",
        });
        counts.conflict++;
      }
    }
  }

  return { outcomes, counts };
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function defaultRunGitMergeFile(
  local: string,
  ancestor: string,
  upstream: string,
): { exitCode: number } {
  const res = spawnSync(
    "git",
    ["merge-file", "-L", "local", "-L", "ancestor", "-L", "upstream", local, ancestor, upstream],
    { encoding: "utf8" },
  );
  return { exitCode: typeof res.status === "number" ? res.status : -1 };
}
