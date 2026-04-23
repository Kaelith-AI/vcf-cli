import { describe, it, expect } from "vitest";
import { parseSubmission } from "../../src/review/prompt.js";

describe("parseSubmission (followup #45 — extracted from review_execute)", () => {
  const base = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      verdict: "PASS",
      summary: "All checks pass. No issues above info severity.",
      findings: [],
      carry_forward: [],
      ...overrides,
    });

  it("accepts a clean PASS submission with empty findings", () => {
    const sub = parseSubmission(base());
    expect(sub.verdict).toBe("PASS");
    expect(sub.summary).toContain("All checks pass");
    expect(sub.findings).toHaveLength(0);
    expect(sub.carry_forward).toHaveLength(0);
  });

  it("tolerates a JSON object wrapped in prose (extracts balanced braces)", () => {
    const wrapped = `Here is my verdict:\n\n${base()}\n\nDone.`;
    const sub = parseSubmission(wrapped);
    expect(sub.verdict).toBe("PASS");
  });

  it("rejects a missing/unknown verdict with E_VALIDATION", () => {
    expect(() => parseSubmission(base({ verdict: "MAYBE" }))).toThrowError(/verdict/);
    expect(() => parseSubmission(base({ verdict: undefined }))).toThrowError(/verdict/);
  });

  it("rejects a summary outside 4-4000 chars", () => {
    expect(() => parseSubmission(base({ summary: "no" }))).toThrowError(/summary/);
    expect(() => parseSubmission(base({ summary: "x".repeat(4001) }))).toThrowError(/summary/);
  });

  it("drops findings with invalid severity or too-short description silently", () => {
    const raw = base({
      findings: [
        { severity: "banana", description: "bad severity value" },
        { severity: "warning", description: "x" }, // too short
        { severity: "warning", description: "valid finding here", file: "a.ts", line: 42 },
      ],
    });
    const sub = parseSubmission(raw);
    expect(sub.findings).toHaveLength(1);
    expect(sub.findings[0].file).toBe("a.ts");
    expect(sub.findings[0].line).toBe(42);
  });

  it("caps findings at 200 and carry_forward at 120", () => {
    const many = (n: number, src: string): Array<Record<string, unknown>> =>
      Array.from({ length: n }, (_, i) => ({
        severity: "info",
        description: `${src} entry ${i} with enough length to pass`,
      }));
    const rawFindings = base({
      findings: many(250, "f"),
    });
    expect(parseSubmission(rawFindings).findings).toHaveLength(200);

    const rawCarry = base({
      carry_forward: Array.from({ length: 150 }, () => ({
        section: "architecture",
        severity: "info",
        text: "carry-forward entry with enough text",
      })),
    });
    expect(parseSubmission(rawCarry).carry_forward).toHaveLength(120);
  });

  it("rejects non-JSON output with E_VALIDATION", () => {
    expect(() => parseSubmission("no json at all")).toThrowError(/JSON object/);
    expect(() => parseSubmission("{ not valid json }")).toThrowError(/JSON/);
  });

  it("drops carry_forward entries with unknown sections", () => {
    const raw = base({
      carry_forward: [
        { section: "made-up", severity: "info", text: "will be dropped" },
        { section: "architecture", severity: "warning", text: "valid entry kept" },
      ],
    });
    const sub = parseSubmission(raw);
    expect(sub.carry_forward).toHaveLength(1);
    expect(sub.carry_forward[0].section).toBe("architecture");
  });
});
