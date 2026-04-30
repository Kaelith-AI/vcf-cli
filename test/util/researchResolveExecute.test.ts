// research_resolve mode=execute — schema + parser + prompt unit tests.
//
// Integration of the per-claim dispatch path is exercised manually
// (see plans/2026-04-29-unified-phase-todo.md) — it requires either a
// live LLM or a substantial mock of dispatchChatCompletion. This file
// covers the deterministic helpers that don't need a network call.

import { describe, it, expect } from "vitest";
import {
  ResearchResolveInput,
  composeResolveMessages,
  parseResolution,
} from "../../src/tools/research_resolve.js";

const baseClaim = {
  id: "3",
  claim: "RFC 9999 mandates X.",
  reason: "RFC number not found at rfc-editor.org",
  severity: "high" as const,
};

describe("ResearchResolveInput schema", () => {
  it("defaults mode to directive and role to research_primary (back-compat)", () => {
    const r = ResearchResolveInput.parse({ draft_id: "abc-123" });
    expect(r.mode).toBe("directive");
    expect(r.role).toBe("research_primary");
    expect(r.severity_min).toBe("low");
    expect(r.timeout_ms).toBe(300_000);
  });

  it("accepts mode=execute with a custom role", () => {
    const r = ResearchResolveInput.parse({
      draft_id: "abc-123",
      mode: "execute",
      role: "kb_review_primary",
    });
    expect(r.mode).toBe("execute");
    expect(r.role).toBe("kb_review_primary");
  });

  it("rejects bad role names (uppercase, spaces, etc.)", () => {
    expect(ResearchResolveInput.safeParse({ draft_id: "abc", role: "Bad-Role" }).success).toBe(
      false,
    );
    expect(ResearchResolveInput.safeParse({ draft_id: "abc", role: "with space" }).success).toBe(
      false,
    );
  });

  it("rejects unknown mode values", () => {
    expect(ResearchResolveInput.safeParse({ draft_id: "abc", mode: "llm-driven" }).success).toBe(
      false,
    );
  });

  it("rejects timeouts above the cap", () => {
    expect(
      ResearchResolveInput.safeParse({ draft_id: "abc", timeout_ms: 30 * 60_000 }).success,
    ).toBe(false);
  });
});

describe("composeResolveMessages", () => {
  it("includes the claim text, severity, draft, and sources", () => {
    const messages = composeResolveMessages({
      claim: baseClaim,
      draft: "# Draft body\n\nSome content [^3]",
      sources: '{"sources": []}',
      todayIso: "2026-04-30",
      verifyModel: "gpt-5-5",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("RFC 9999");
    expect(messages[0].content).toContain("severity: high");
    expect(messages[0].content).toContain("verifier (gpt-5-5)");
    expect(messages[0].content).toContain("Today is 2026-04-30");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("# Draft body");
    expect(messages[1].content).toContain('{"sources": []}');
  });

  it("instructs the model to web-search dated/numeric/named claims", () => {
    const messages = composeResolveMessages({
      claim: baseClaim,
      draft: "x",
      sources: "{}",
      todayIso: "2026-04-30",
      verifyModel: "claude-opus-4-7",
    });
    expect(messages[0].content).toContain("web-search");
    expect(messages[0].content).toContain("training memory");
  });
});

describe("parseResolution", () => {
  it("extracts a well-formed verdict", () => {
    const raw = JSON.stringify({
      id: "3",
      claim: "RFC 9999 mandates X.",
      verdict: "denied",
      evidence: [
        {
          url: "https://www.rfc-editor.org/search/rfc_search_detail.php?rfc=9999",
          title: "RFC 9999 not found",
          publisher: "rfc-editor.org",
          quote: "no result",
          supports: "denies",
        },
      ],
      rationale: "RFC 9999 does not exist on rfc-editor.org.",
      suggested_revision: "Drop the RFC reference; rephrase as 'a related convention'.",
    });
    const r = parseResolution(raw, baseClaim);
    expect(r.verdict).toBe("denied");
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].publisher).toBe("rfc-editor.org");
    expect(r.evidence[0].supports).toBe("denies");
    expect(r.suggested_revision).toContain("Drop the RFC");
  });

  it("strips ```json fences before parsing", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        id: "3",
        claim: "x",
        verdict: "confirmed",
        evidence: [],
        rationale: "ok",
        suggested_revision: null,
      }) +
      "\n```";
    const r = parseResolution(raw, baseClaim);
    expect(r.verdict).toBe("confirmed");
    expect(r.suggested_revision).toBeNull();
  });

  it("returns undetermined + raw text when the response is not JSON", () => {
    const r = parseResolution("I think the claim is fine actually.", baseClaim);
    expect(r.verdict).toBe("undetermined");
    expect(r.rationale).toContain("non-JSON");
    expect(r.evidence).toEqual([]);
    expect(r.id).toBe(baseClaim.id);
    expect(r.claim).toBe(baseClaim.claim);
  });

  it("normalizes invalid verdict values to undetermined", () => {
    const raw = JSON.stringify({
      id: "3",
      claim: "x",
      verdict: "maybe-true",
      evidence: [],
      rationale: "n/a",
      suggested_revision: null,
    });
    const r = parseResolution(raw, baseClaim);
    expect(r.verdict).toBe("undetermined");
  });

  it("normalizes invalid evidence.supports to neither", () => {
    const raw = JSON.stringify({
      id: "3",
      claim: "x",
      verdict: "confirmed",
      evidence: [
        {
          url: "https://example.com",
          title: "t",
          publisher: "p",
          quote: "q",
          supports: "bogus",
        },
      ],
      rationale: "ok",
      suggested_revision: null,
    });
    const r = parseResolution(raw, baseClaim);
    expect(r.evidence[0].supports).toBe("neither");
  });
});
