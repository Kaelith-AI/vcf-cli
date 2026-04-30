import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProvenance,
  requireProvenance,
  readJsonProvenance,
  readMarkdownProvenance,
  provenanceToYaml,
} from "../../src/util/provenance.js";
import { McpError } from "../../src/errors.js";

describe("buildProvenance", () => {
  it("produces a complete block with required fields", () => {
    const p = buildProvenance({
      tool: "research_verify",
      phase: "verify",
      model: "CLIProxyAPI/gemini-3.1-pro-preview",
      endpoint: "litellm",
      generatedAt: new Date("2026-04-29T07:00:00Z"),
    });
    expect(p).toEqual({
      tool: "research_verify",
      phase: "verify",
      model: "CLIProxyAPI/gemini-3.1-pro-preview",
      endpoint: "litellm",
      generated_at: "2026-04-29T07:00:00.000Z",
    });
  });

  it("includes fallback_used only when set", () => {
    const withFallback = buildProvenance({
      tool: "x",
      phase: "y",
      model: "m",
      endpoint: "e",
      fallback_used: true,
    });
    expect(withFallback.fallback_used).toBe(true);
    const without = buildProvenance({ tool: "x", phase: "y", model: "m", endpoint: "e" });
    expect(without.fallback_used).toBeUndefined();
  });
});

describe("requireProvenance", () => {
  const valid = {
    tool: "research_verify",
    phase: "verify",
    model: "claude-opus-4-7",
    endpoint: "claude-code-main",
    generated_at: "2026-04-29T00:00:00.000Z",
  };

  it("returns the parsed block when valid", () => {
    const out = requireProvenance(valid, { artifact: "test.json" });
    expect(out).toEqual(valid);
  });

  it("throws E_VALIDATION when missing entirely", () => {
    expect(() => requireProvenance(undefined, { artifact: "test.json" })).toThrow(McpError);
    expect(() => requireProvenance(null, { artifact: "test.json" })).toThrow(McpError);
    expect(() => requireProvenance("not-an-object", { artifact: "test.json" })).toThrow(McpError);
  });

  it("throws when required fields are missing or empty", () => {
    expect(() => requireProvenance({ ...valid, model: "" }, { artifact: "x" })).toThrow(/model/);
    expect(() => requireProvenance({ ...valid, tool: "  " }, { artifact: "x" })).toThrow(/tool/);
    const partial = { ...valid } as Record<string, unknown>;
    delete partial["endpoint"];
    expect(() => requireProvenance(partial, { artifact: "x" })).toThrow(/endpoint/);
  });

  it("throws when expectedPhase doesn't match", () => {
    expect(() => requireProvenance(valid, { artifact: "x", expectedPhase: "compose" })).toThrow(
      /phase=.+expected 'compose'/,
    );
  });

  it("preserves optional fallback_used", () => {
    const out = requireProvenance({ ...valid, fallback_used: true }, { artifact: "x" });
    expect(out.fallback_used).toBe(true);
  });
});

describe("readJsonProvenance", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-prov-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads provenance from a top-level field", async () => {
    const path = join(dir, "verify.json");
    const body = {
      provenance: {
        tool: "research_verify",
        phase: "verify",
        model: "x",
        endpoint: "y",
        generated_at: "2026-04-29T00:00:00.000Z",
      },
      contested_claims: [],
    };
    await writeFile(path, JSON.stringify(body));
    const out = await readJsonProvenance(path, { expectedPhase: "verify" });
    expect(out.provenance.tool).toBe("research_verify");
  });

  it("throws E_NOT_FOUND for missing file", async () => {
    await expect(readJsonProvenance(join(dir, "nope.json"), {})).rejects.toThrow(/cannot read/);
  });

  it("throws E_VALIDATION for invalid JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{{ this is not json }}");
    await expect(readJsonProvenance(path, {})).rejects.toThrow(/not valid JSON/);
  });

  it("throws E_VALIDATION when provenance field is missing", async () => {
    const path = join(dir, "noprov.json");
    await writeFile(path, JSON.stringify({ contested_claims: [] }));
    await expect(readJsonProvenance(path, {})).rejects.toThrow(/missing a provenance/);
  });
});

describe("readMarkdownProvenance", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-prov-md-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads nested provenance from YAML frontmatter", async () => {
    const path = join(dir, "draft.md");
    const content = [
      "---",
      "type: best-practices",
      "best_practice_name: backend",
      "provenance:",
      "  tool: research_compose",
      "  phase: compose",
      "  model: claude-opus-4-7",
      "  endpoint: claude-code-main",
      "  generated_at: 2026-04-29T00:00:00.000Z",
      "---",
      "",
      "# Body",
      "",
      "Some content.",
      "",
    ].join("\n");
    await writeFile(path, content);
    const out = await readMarkdownProvenance(path, { expectedPhase: "compose" });
    expect(out.provenance.model).toBe("claude-opus-4-7");
    expect(out.body).toContain("# Body");
    expect(out.body).not.toContain("---");
    expect(out.frontmatter["type"]).toBe("best-practices");
  });

  it("throws when there's no frontmatter", async () => {
    const path = join(dir, "noframe.md");
    await writeFile(path, "# Just a title\n\nNo frontmatter here.");
    await expect(readMarkdownProvenance(path, {})).rejects.toThrow(/no YAML frontmatter/);
  });

  it("throws when frontmatter is unterminated", async () => {
    const path = join(dir, "open.md");
    await writeFile(path, "---\nfoo: bar\nno closing fence here\n");
    await expect(readMarkdownProvenance(path, {})).rejects.toThrow(/unterminated/);
  });

  it("throws when provenance key is missing from frontmatter", async () => {
    const path = join(dir, "noprov.md");
    await writeFile(path, "---\ntype: foo\n---\n\n# Body\n");
    await expect(readMarkdownProvenance(path, {})).rejects.toThrow(/missing a provenance/);
  });

  it("throws when expectedPhase doesn't match", async () => {
    const path = join(dir, "wrongphase.md");
    const content = [
      "---",
      "provenance:",
      "  tool: research_verify",
      "  phase: verify",
      "  model: x",
      "  endpoint: y",
      "  generated_at: 2026-04-29T00:00:00.000Z",
      "---",
      "",
    ].join("\n");
    await writeFile(path, content);
    await expect(readMarkdownProvenance(path, { expectedPhase: "compose" })).rejects.toThrow(
      /expected 'compose'/,
    );
  });
});

describe("provenanceToYaml", () => {
  it("produces a YAML block with provenance: parent key", () => {
    const yaml = provenanceToYaml({
      tool: "research_compose",
      phase: "compose",
      model: "claude-opus-4-7",
      endpoint: "claude-code-main",
      generated_at: "2026-04-29T00:00:00.000Z",
    });
    expect(yaml).toContain("provenance:");
    expect(yaml).toContain("  tool: research_compose");
    expect(yaml).toContain("  model: claude-opus-4-7");
  });

  it("round-trips through readMarkdownProvenance", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-prov-rt-")));
    try {
      const p = buildProvenance({
        tool: "research_compose",
        phase: "compose",
        model: "claude-opus-4-7",
        endpoint: "claude-code-main",
        generatedAt: new Date("2026-04-29T00:00:00Z"),
      });
      const path = join(dir, "rt.md");
      await writeFile(path, ["---", provenanceToYaml(p), "---", "", "# Body", ""].join("\n"));
      const out = await readMarkdownProvenance(path, { expectedPhase: "compose" });
      expect(out.provenance).toEqual(p);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
