// Primer tag-matching engine.
//
// Deterministic ranking used by spec_suggest_primers (M4) and any future
// tool that needs to pick the N most-relevant primers / best-practices for
// a given spec's tags.
//
// Scoring (weighted Jaccard):
//   - `tech_stack` tags are the primary signal (weight PRIMARY_WEIGHT).
//   - `lens` / `category` tags from the spec are secondary (SECONDARY_WEIGHT).
//   - Score = (w_primary * |tech∩tags| + w_secondary * |lens∩tags|) /
//             (|tech∪tags| + |lens∪tags| ε-floored to 1)
//
// Ties broken by `last_reviewed` descending so fresher primers win.
// Output is an ordered list of { id, score, matched_tags } — stable for
// identical inputs so snapshot tests lock the contract.

import type { KbEntry } from "./load.js";

const PRIMARY_WEIGHT = 3;
const SECONDARY_WEIGHT = 1;

export interface MatchInput {
  /** Primary tags (from spec frontmatter's tech_stack). */
  tech_tags: readonly string[];
  /** Secondary tags (spec lens / category). */
  lens_tags?: readonly string[];
  /** Max results returned; falls back to all candidates if undefined. */
  limit?: number;
  /** Optional filter: only consider entries of this kind. */
  kind?: KbEntry["kind"];
}

export interface MatchResult {
  id: string;
  kind: KbEntry["kind"];
  name: string;
  path: string;
  score: number;
  matched_tags: string[];
}

export function matchPrimers(entries: readonly KbEntry[], input: MatchInput): MatchResult[] {
  const tech = normalize(input.tech_tags);
  const lens = normalize(input.lens_tags ?? []);
  const candidates = input.kind ? entries.filter((e) => e.kind === input.kind) : entries;

  const scored: MatchResult[] = [];
  for (const entry of candidates) {
    const entryTags = new Set([...entry.tags, ...entry.applies_to].map((t) => t.toLowerCase()));
    if (entryTags.size === 0 && tech.size === 0 && lens.size === 0) continue;

    const techHit = intersect(tech, entryTags);
    const lensHit = intersect(lens, entryTags);
    const unionTech = unionSize(tech, entryTags);
    const unionLens = unionSize(lens, entryTags);
    const denom = Math.max(1, unionTech + unionLens);
    const score = (PRIMARY_WEIGHT * techHit.length + SECONDARY_WEIGHT * lensHit.length) / denom;
    if (score === 0) continue;

    scored.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      path: entry.path,
      score: Math.round(score * 1000) / 1000, // snap to 3 decimals so tests are stable
      matched_tags: Array.from(new Set([...techHit, ...lensHit])).sort(),
    });
  }

  // Sort: score desc, then last_reviewed desc (fresher primer wins), then id asc for determinism.
  const indexById = new Map<string, KbEntry>();
  for (const e of entries) indexById.set(e.id, e);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = indexById.get(a.id)?.last_reviewed ?? "";
    const fb = indexById.get(b.id)?.last_reviewed ?? "";
    if (fa !== fb) return fa < fb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return typeof input.limit === "number" ? scored.slice(0, input.limit) : scored;
}

function normalize(tags: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tags) {
    const lower = t.toLowerCase().trim();
    if (lower.length > 0) out.add(lower);
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

function unionSize(a: Set<string>, b: Set<string>): number {
  const u = new Set<string>(a);
  for (const x of b) u.add(x);
  return u.size;
}
