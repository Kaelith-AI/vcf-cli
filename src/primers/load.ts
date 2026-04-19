// KB walker: scan the user's KB directory, parse frontmatter, emit indexable
// records for primers / best-practices / lenses / stages / reviewers /
// standards. This is the raw data feed for the primer tag-matching engine
// (./match.ts) and for the MCP catalog tools (primer_list, etc.).
//
// We do not load file bodies here — only frontmatter. Bodies are read on
// demand by the tools that need them. Matching the token-economy rule: cheap
// list, lazy read.

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export type KbKind = "primer" | "best-practice" | "lens" | "stage" | "reviewer-config" | "standard";

export interface KbEntry {
  id: string; // path-relative key, e.g. "primers/mcp"
  kind: KbKind;
  path: string; // absolute path to the file
  name: string; // primer_name | best_practice_name | lens_name | stage_name | standard_name | reviewer_type
  category?: string | undefined;
  tags: string[];
  applies_to: string[];
  version: string | number | undefined;
  status?: string | undefined;
  updated?: string | undefined;
  last_reviewed?: string | undefined;
  /** Raw frontmatter object for tools that want to surface it verbatim. */
  frontmatter: Record<string, unknown>;
}

const DIR_TO_KIND: Record<string, KbKind> = {
  primers: "primer",
  "best-practices": "best-practice",
  lenses: "lens",
  "review-system": "stage",
  reviewers: "reviewer-config",
  standards: "standard",
};

/**
 * Walk `kb/` and return every *.md file's metadata. Skips files whose first
 * directory isn't a known KB kind — unrecognized subtrees are tolerated but
 * not surfaced.
 */
export async function loadKb(kbRoot: string): Promise<KbEntry[]> {
  const out: KbEntry[] = [];
  for await (const full of walk(kbRoot)) {
    if (extname(full).toLowerCase() !== ".md") continue;
    const rel = relative(kbRoot, full);
    const top = rel.split(/[\\/]/)[0];
    if (!top) continue;
    const kind = DIR_TO_KIND[top];
    if (!kind) continue;
    const raw = await readFile(full, "utf8");
    const fm = extractFrontmatter(raw);
    if (!fm) continue;
    out.push(normalize(fm, full, rel, kind));
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing KB dir is not fatal; tool returns empty list
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full);
    else if (ent.isFile()) yield full;
  }
}

/** Ultra-lightweight frontmatter parser so we don't pull gray-matter into the server bundle. */
function extractFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = raw.slice(3, end).trim();
  const obj: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: string = trimmed.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      obj[key] = parseInlineList(value);
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    obj[key] = value;
  }
  return obj;
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

function normalize(
  fm: Record<string, unknown>,
  absolutePath: string,
  rel: string,
  kind: KbKind,
): KbEntry {
  const toStringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (typeof v === "string" && v.length > 0) return [v];
    return [];
  };
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  const name =
    s(fm["primer_name"]) ??
    s(fm["best_practice_name"]) ??
    s(fm["lens_name"]) ??
    s(fm["stage_name"]) ??
    s(fm["standard_name"]) ??
    s(fm["reviewer_type"]) ??
    rel.replace(/\.md$/, "");

  const id = rel.replace(/\.md$/, "").replace(/[\\/]/g, "/");

  const entry: KbEntry = {
    id,
    kind,
    path: absolutePath,
    name,
    tags: toStringArray(fm["tags"]),
    applies_to: toStringArray(fm["applies_to"]),
    version:
      typeof fm["version"] === "string" || typeof fm["version"] === "number"
        ? (fm["version"] as string | number)
        : undefined,
    status: s(fm["status"]),
    updated: s(fm["updated"]),
    last_reviewed: s(fm["last_reviewed"]),
    frontmatter: fm,
  };
  const cat = s(fm["category"]);
  if (cat !== undefined) entry.category = cat;
  return entry;
}

/** Filter the loaded KB to a single kind. */
export function byKind(entries: KbEntry[], kind: KbKind): KbEntry[] {
  return entries.filter((e) => e.kind === kind);
}

/** Module-level lazy cache keyed by (kbRoot + last-scan mtime). */
interface CacheRecord {
  entries: KbEntry[];
  scannedAt: number;
}
const cache = new Map<string, CacheRecord>();
const CACHE_TTL_MS = 30_000;

/**
 * Return the KB entries for `kbRoot`, using a short-lived cache to keep
 * repeated tool calls fast. The cache expires after 30 seconds so primer
 * edits during active development become visible without a restart.
 */
export async function loadKbCached(kbRoot: string): Promise<KbEntry[]> {
  const hit = cache.get(kbRoot);
  const now = Date.now();
  if (hit && now - hit.scannedAt < CACHE_TTL_MS) return hit.entries;
  try {
    await stat(kbRoot);
  } catch {
    return [];
  }
  const entries = await loadKb(kbRoot);
  cache.set(kbRoot, { entries, scannedAt: now });
  return entries;
}

/** Clear the cache — for tests. */
export function clearKbCache(): void {
  cache.clear();
}
