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

/** Merge a newer CarryForward into a prior one. Newer entries append. */
export function mergeCarryForward(prior: CarryForward, next: Partial<CarryForward>): CarryForward {
  const out = emptyCarryForward();
  for (const section of CARRY_FORWARD_SECTIONS) {
    out[section] = [...prior[section], ...(next[section] ?? [])];
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
      parts.push(`    text: ${JSON.stringify(e.text)}`);
    }
  }
  return parts.join("\n") + "\n";
}
