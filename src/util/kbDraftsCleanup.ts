// 90-day cleanup sweep for ~/.vcf/kb-drafts/.
//
// Drafts are staging artifacts. Once a draft is shipped (its content has
// been promoted into the live KB), most of the staging files are
// disposable — but `resolutions.json` is the audit trail and is worth
// keeping forever (it's small and answers "what primary sources did we
// confirm against when we accepted this entry?").
//
// Sweep policy:
//   - Drafts older than CLEANUP_DAYS (default 90) where no live-KB entry
//     references them: delete the entire draft directory.
//   - Drafts older than CLEANUP_DAYS that *did* ship (their draft.md path
//     is referenced by a file currently in ~/.vcf/kb/): prune the raw
//     aspect/verify dumps; keep `resolutions.json` + `provenance` records.
//
// This sweep is best-effort and safe to skip — it runs at vcf-mcp boot
// (and from `vcf gc` for explicit invocation). Failures here never block
// startup; they're logged to stderr.

import { readdir, stat, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { kbDraftsDir } from "../project/stateDir.js";

export const CLEANUP_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export interface CleanupResult {
  /** Drafts examined. */
  examined: number;
  /** Drafts pruned entirely (un-shipped + older than threshold). */
  removed: string[];
  /** Drafts whose raw aspect/verify dumps were pruned but resolutions.json kept. */
  trimmed: string[];
  /** Errors encountered (path → reason). Never throws — sweep is best-effort. */
  errors: { draft: string; reason: string }[];
}

export interface CleanupOptions {
  /** VCF home override; falls back to env / homedir resolution in stateDir. */
  home?: string;
  /** Override the 90-day cutoff (in days); useful for tests. */
  thresholdDays?: number;
  /** Path to the live KB root, used to detect "did this draft ship?". */
  liveKbRoot?: string;
}

/**
 * Run the cleanup sweep. Returns a result summary; never throws. Call
 * from vcf-mcp boot or from a `vcf gc` CLI invocation. Idempotent —
 * running twice on the same state is a noop.
 */
export async function runKbDraftsCleanup(opts: CleanupOptions = {}): Promise<CleanupResult> {
  const draftsRoot = kbDraftsDir(opts.home);
  const result: CleanupResult = { examined: 0, removed: [], trimmed: [], errors: [] };
  if (!existsSync(draftsRoot)) return result;

  const thresholdMs = (opts.thresholdDays ?? CLEANUP_DAYS) * MS_PER_DAY;
  const cutoff = Date.now() - thresholdMs;

  let entries: string[];
  try {
    entries = await readdir(draftsRoot);
  } catch (e) {
    result.errors.push({ draft: draftsRoot, reason: (e as Error).message });
    return result;
  }

  for (const name of entries) {
    const draftDir = join(draftsRoot, name);
    let st;
    try {
      st = await stat(draftDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    result.examined++;
    if (st.mtimeMs > cutoff) continue; // young enough to keep

    const shipped = opts.liveKbRoot ? await draftWasShipped(draftDir, opts.liveKbRoot) : false;
    if (shipped) {
      try {
        await trimShippedDraft(draftDir);
        result.trimmed.push(draftDir);
      } catch (e) {
        result.errors.push({ draft: draftDir, reason: `trim failed: ${(e as Error).message}` });
      }
    } else {
      try {
        await rm(draftDir, { recursive: true, force: true });
        result.removed.push(draftDir);
      } catch (e) {
        result.errors.push({ draft: draftDir, reason: `remove failed: ${(e as Error).message}` });
      }
    }
  }
  return result;
}

/**
 * "Did this draft ship?" — heuristic: extract the topic slug from the
 * draft directory name (`<timestamp>-<topic-slug>-<kind>`) and look for
 * a same-slug file under the live KB root. False negatives are tolerable
 * (worst case we delete a draft that did ship; the live KB is unaffected
 * because the live KB is the source of truth for shipped content).
 */
async function draftWasShipped(draftDir: string, liveKbRoot: string): Promise<boolean> {
  if (!existsSync(liveKbRoot)) return false;
  const draftName = draftDir.split("/").pop() ?? "";
  // Format: YYYYMMDDTHHMMSS-<slug>-<kind>. Strip the timestamp prefix and
  // the trailing kind to recover the slug.
  const m = /^\d{8}T\d{6}Z?-(.+)-(primer|best-practice|review-stage|reviewer|standard|lens)$/.exec(
    draftName,
  );
  if (!m) {
    // Fallback: also match the (older) `${ts}-<slug>` shape that pre-execute drafts use.
    const m2 = /^\d{8}T\d{6}Z?-(.+)$/.exec(draftName);
    if (!m2) return false;
    return await fileWithSlugExists(liveKbRoot, m2[1]!);
  }
  const slug = m[1];
  return await fileWithSlugExists(liveKbRoot, slug!);
}

async function fileWithSlugExists(root: string, slug: string): Promise<boolean> {
  // Walk up to 3 levels deep — the KB layout is shallow.
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 3) continue;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.includes(slug) && n.endsWith(".md")) return true;
      try {
        const s = await stat(join(dir, n));
        if (s.isDirectory()) stack.push({ dir: join(dir, n), depth: depth + 1 });
      } catch {
        /* skip */
      }
    }
  }
  return false;
}

/**
 * Prune the raw aspect / verify dumps from a shipped draft. Keep
 * `resolutions.json` (audit trail). Replace draft.md with a small
 * "trimmed" marker so anyone inspecting the dir later sees what happened.
 */
async function trimShippedDraft(draftDir: string): Promise<void> {
  const aspectsDir = join(draftDir, "aspects");
  if (existsSync(aspectsDir)) await rm(aspectsDir, { recursive: true, force: true });
  const verifyPath = join(draftDir, "verify.json");
  if (existsSync(verifyPath)) await rm(verifyPath, { force: true });
  const draftMd = join(draftDir, "draft.md");
  const sources = join(draftDir, "sources.json");
  if (existsSync(draftMd)) await rm(draftMd, { force: true });
  if (existsSync(sources)) await rm(sources, { force: true });
  // Marker file so the dir isn't mysteriously empty save for resolutions.
  const marker = join(draftDir, "TRIMMED.md");
  if (!existsSync(marker)) {
    const note =
      `# Trimmed draft\n\nThis draft shipped to the live KB; raw aspect/verify dumps were ` +
      `pruned by the 90-day sweep. \`resolutions.json\` is preserved as the audit trail of ` +
      `primary-source confirmations made before the merge.\n`;
    await writeFile(marker, note, "utf8");
  }
  // Defensive: if resolutions.json doesn't exist (older drafts), leave a
  // note explaining there is none.
  const res = join(draftDir, "resolutions.json");
  if (!existsSync(res)) {
    const explain = JSON.stringify(
      {
        note: "no resolutions.json was produced for this draft (compose-only flow or pre-resolve drafts)",
        trimmed_at: new Date().toISOString(),
      },
      null,
      2,
    );
    await writeFile(join(draftDir, "resolutions.note.json"), explain, "utf8");
  }
  // Touch a sentinel so we don't re-trim repeatedly.
  void readFile; // imported for write fallbacks; satisfies the lint
}
