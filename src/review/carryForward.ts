// Carry-forward manifest — the contract every review stage reads and writes.
//
// The six sections are fixed (spec + plan M7). Entries inside each section
// are stage-qualified so the reader can see which stage raised them.
//
// Storage:
//   - on disk: `.review-runs/<type>-<ts>/carry-forward.yaml` — simple YAML
//   - in DB:   `review_runs.carry_forward_json` — same shape as JSON
//
// Re-run semantics: re-running Stage N copies the carry-forward from the
// most recent Stage (N-1) PASS and supersedes any prior Stage N run.

export const CARRY_FORWARD_SECTIONS = [
  "architecture",
  "verification",
  "security",
  "compliance",
  "supportability",
  "release_confidence",
] as const;

export type CarryForwardSection = (typeof CARRY_FORWARD_SECTIONS)[number];

export interface CarryForwardEntry {
  stage: number;
  severity: "info" | "warning" | "blocker";
  text: string;
  /**
   * Number of stages this entry has been carried forward without resolution.
   * 0 on first appearance, +1 per merge that preserves the entry. A reviewer
   * observing carried_count ≥ 3 on a warning/blocker should treat it as a
   * drift signal (followup #19) and consider `lesson_log_add` with
   * `tags: ["carry-forward-drift"]`. Optional on parse for back-compat with
   * pre-#19 carry-forward YAML.
   */
  carried_count?: number;
}

export type CarryForward = Record<CarryForwardSection, CarryForwardEntry[]>;

export function emptyCarryForward(): CarryForward {
  return {
    architecture: [],
    verification: [],
    security: [],
    compliance: [],
    supportability: [],
    release_confidence: [],
  };
}

/**
 * Merge a newer CarryForward into a prior one. Prior entries carry through
 * with `carried_count` bumped by 1 (drift signal, #19). Newer entries append
 * at `carried_count: 0`.
 */
export function mergeCarryForward(prior: CarryForward, next: Partial<CarryForward>): CarryForward {
  const out = emptyCarryForward();
  for (const section of CARRY_FORWARD_SECTIONS) {
    const carried = prior[section].map((e) => ({
      ...e,
      carried_count: (e.carried_count ?? 0) + 1,
    }));
    const fresh = (next[section] ?? []).map((e) => ({
      carried_count: 0,
      ...e,
    }));
    out[section] = [...carried, ...fresh];
  }
  return out;
}

/** Render a CarryForward to YAML for on-disk storage. No 3rd-party dep. */
export function renderYaml(cf: CarryForward): string {
  const parts: string[] = [];
  for (const section of CARRY_FORWARD_SECTIONS) {
    parts.push(`${section}:`);
    const entries = cf[section];
    if (entries.length === 0) {
      parts.push("  []");
      continue;
    }
    for (const e of entries) {
      parts.push(`  - stage: ${e.stage}`);
      parts.push(`    severity: ${e.severity}`);
      if ((e.carried_count ?? 0) > 0) {
        parts.push(`    carried_count: ${e.carried_count}`);
      }
      parts.push(`    text: ${JSON.stringify(e.text)}`);
    }
  }
  return parts.join("\n") + "\n";
}
