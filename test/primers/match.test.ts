import { describe, it, expect } from "vitest";
import { matchPrimers } from "../../src/primers/match.js";
import type { KbEntry } from "../../src/primers/load.js";

const entry = (over: Partial<KbEntry>): KbEntry => ({
  id: over.id ?? "primers/x",
  kind: over.kind ?? "primer",
  path: over.path ?? "/kb/primers/x.md",
  name: over.name ?? "x",
  tags: over.tags ?? [],
  applies_to: over.applies_to ?? [],
  version: over.version,
  status: over.status,
  updated: over.updated,
  last_reviewed: over.last_reviewed,
  frontmatter: over.frontmatter ?? {},
  category: over.category,
});

describe("matchPrimers", () => {
  it("returns empty when no candidate has overlapping tags", () => {
    const entries = [entry({ tags: ["unrelated"] })];
    expect(matchPrimers(entries, { tech_tags: ["typescript"] })).toEqual([]);
  });

  it("ranks by weighted Jaccard (primary tech_tags beat secondary)", () => {
    const entries = [
      entry({ id: "primers/ts", tags: ["typescript"] }),
      entry({ id: "primers/security", tags: ["security"] }),
    ];
    const out = matchPrimers(entries, {
      tech_tags: ["typescript"],
      lens_tags: ["security"],
    });
    expect(out.map((r) => r.id)).toEqual(["primers/ts", "primers/security"]);
    expect(out[0]?.score).toBeGreaterThan(out[1]!.score);
  });

  it("is deterministic for identical input (ties broken by last_reviewed then id)", () => {
    const entries = [
      entry({ id: "a", tags: ["x"], last_reviewed: "2024-01-01" }),
      entry({ id: "b", tags: ["x"], last_reviewed: "2026-04-18" }),
      entry({ id: "c", tags: ["x"] }),
    ];
    const first = matchPrimers(entries, { tech_tags: ["x"] });
    const second = matchPrimers(entries, { tech_tags: ["x"] });
    expect(first).toEqual(second);
    // fresher last_reviewed wins
    expect(first[0]?.id).toBe("b");
  });

  it("honors the kind filter", () => {
    const entries = [
      entry({ id: "primers/ts", kind: "primer", tags: ["typescript"] }),
      entry({ id: "bp/ts", kind: "best-practice", tags: ["typescript"] }),
    ];
    const out = matchPrimers(entries, { tech_tags: ["typescript"], kind: "best-practice" });
    expect(out.map((r) => r.id)).toEqual(["bp/ts"]);
  });

  it("respects limit", () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `e${i}`, tags: ["x"] }));
    const out = matchPrimers(entries, { tech_tags: ["x"], limit: 2 });
    expect(out.length).toBe(2);
  });

  it("matched_tags contains only tags that actually overlap", () => {
    const entries = [entry({ id: "a", tags: ["ai", "cli", "noise"] })];
    const out = matchPrimers(entries, { tech_tags: ["ai", "cli"], lens_tags: ["other"] });
    expect(out[0]?.matched_tags.sort()).toEqual(["ai", "cli"]);
  });
});
