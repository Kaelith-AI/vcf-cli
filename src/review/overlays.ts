// Reviewer overlay resolver.
//
// The review_execute tool composes a system prompt from the base reviewer
// role (`reviewer-<type>.md`). Phase-2 (#32) introduces per-model tuning:
// a reviewer may also receive a **family overlay** (`reviewer-code.qwen.md`)
// or a **trust-level overlay** (`reviewer-code.frontier.md`) that adjusts
// known calibration biases without rewriting the base role.
//
// Resolution order (first match wins, others are skipped — overlays are
// additive but the layer chosen is the most specific one available):
//
//   1. `reviewer-<type>.<family>.md`       (e.g. reviewer-code.qwen.md)
//   2. `reviewer-<type>.<trust_level>.md`  (e.g. reviewer-code.frontier.md)
//   3. `reviewer-<type>.md`                (base; always present)
//
// The base role is ALWAYS loaded. The picked overlay (if any) is appended
// after it, so the overlay's corrections are the last thing the model
// sees before the stage-specific instructions.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type ReviewType = "code" | "security" | "production";
export type TrustLevel = "local" | "trusted" | "public";

const KNOWN_FRONTIER_FAMILIES = new Set(["gpt", "claude", "gemini"]);
const KNOWN_LOCAL_FAMILIES = new Set([
  "qwen",
  "gemma",
  "deepseek",
  "mistral",
  "llama",
  "phi",
  "qwen2",
  "qwen3",
]);

/**
 * Extract the model family from a provider-native model id.
 * Examples:
 *   qwen3-coder:30b       → qwen
 *   qwen2.5-coder:32b     → qwen
 *   gemma4:31b            → gemma
 *   gpt-5.4               → gpt
 *   CLIProxyAPI/gpt-5.4   → gpt
 *   claude-opus-4-7       → claude
 *   deepseek-r1:70b       → deepseek
 *   openai/gpt-4o-mini    → gpt
 */
export function modelFamily(modelId: string): string | null {
  if (!modelId) return null;
  // Drop any provider prefix segment (e.g. "CLIProxyAPI/", "openai/").
  const tail = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  // Strip leading version-ish prefixes and grab the leading alpha run.
  const m = tail.toLowerCase().match(/^([a-z]+)/);
  if (!m?.[1]) return null;
  const raw = m[1];
  // Normalize a few known aliases to their canonical family name.
  if (raw === "qwen2" || raw === "qwen3") return "qwen";
  if (raw === "gemma4" || raw === "gemma3") return "gemma";
  return raw;
}

/**
 * Map a model family to its default trust tier. Used as a fallback when
 * the caller can't (or doesn't want to) supply the endpoint trust level
 * from config. Returns null for unknown families so the resolver can
 * still find a base-only match.
 */
export function familyTrustLevel(family: string | null): TrustLevel | null {
  if (!family) return null;
  if (KNOWN_FRONTIER_FAMILIES.has(family)) return "public";
  if (KNOWN_LOCAL_FAMILIES.has(family)) return "local";
  return null;
}

export interface ResolveOverlayOpts {
  kbRoot: string;
  reviewType: ReviewType;
  modelId: string;
  trustLevel: TrustLevel;
  /**
   * Optional override for the directory that actually holds the reviewer
   * files. When set, replaces the default `<kbRoot>/reviewers` lookup.
   * `review_execute` passes the run-dir snapshot so resolution reads only
   * the prepared copies, not live KB — keeps prepared runs self-contained.
   */
  reviewersDir?: string;
}

export interface ResolvedOverlay {
  baseRelPath: string;
  overlayRelPath: string | null;
  overlayMatch: "family" | "trust-level" | "none";
  family: string | null;
}

/**
 * Resolve the base reviewer role + the most-specific overlay available.
 * Callers load the files themselves (see readOverlayBundle) or use the
 * precomputed paths directly.
 */
export function resolveOverlay(opts: ResolveOverlayOpts): ResolvedOverlay {
  const family = modelFamily(opts.modelId);
  const trustToken = trustLevelToken(opts.trustLevel);
  const dir = opts.reviewersDir ?? join(opts.kbRoot, "reviewers");
  const base = join(dir, `reviewer-${opts.reviewType}.md`);
  const familyCandidate = family ? join(dir, `reviewer-${opts.reviewType}.${family}.md`) : null;
  const trustCandidate = trustToken
    ? join(dir, `reviewer-${opts.reviewType}.${trustToken}.md`)
    : null;

  if (familyCandidate && existsSync(familyCandidate)) {
    return {
      baseRelPath: base,
      overlayRelPath: familyCandidate,
      overlayMatch: "family",
      family,
    };
  }
  if (trustCandidate && existsSync(trustCandidate)) {
    return {
      baseRelPath: base,
      overlayRelPath: trustCandidate,
      overlayMatch: "trust-level",
      family,
    };
  }
  return { baseRelPath: base, overlayRelPath: null, overlayMatch: "none", family };
}

/**
 * Normalize the endpoint trust level into the token used in overlay file
 * names. `public` and `trusted` both map to `frontier` because the
 * frontier calibration overlay covers external / provider-hosted models
 * equally — we don't (yet) separate "OpenRouter-routed public" from
 * "API-keyed trusted partner".
 */
export function trustLevelToken(trust: TrustLevel): "local" | "frontier" {
  if (trust === "local") return "local";
  return "frontier";
}

export interface OverlayBundle {
  base: string;
  overlay: string | null;
  overlayMatch: "family" | "trust-level" | "none";
  overlayPath: string | null;
  family: string | null;
}

/**
 * Read the resolved base + overlay bodies. Base is required (throws if
 * missing); overlay is optional.
 */
export async function readOverlayBundle(opts: ResolveOverlayOpts): Promise<OverlayBundle> {
  const resolved = resolveOverlay(opts);
  const base = await readFile(resolved.baseRelPath, "utf8");
  let overlay: string | null = null;
  if (resolved.overlayRelPath) {
    overlay = await readFile(resolved.overlayRelPath, "utf8");
  }
  return {
    base,
    overlay,
    overlayMatch: resolved.overlayMatch,
    overlayPath: resolved.overlayRelPath,
    family: resolved.family,
  };
}
