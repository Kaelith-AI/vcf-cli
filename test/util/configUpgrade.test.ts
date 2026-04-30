// `vcf config upgrade` — pure-function coverage of the inference table
// + the YAML mutation. The CLI wrapper (file write + backup) is exercised
// indirectly; here we focus on the deterministic helpers so a regression
// in either inference or the doc walker fails fast.

import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { inferVendor, renderDoc, upgradeConfigDoc } from "../../src/cli/configUpgrade.js";

describe("inferVendor", () => {
  it("maps known model_id prefixes to vendors", () => {
    expect(inferVendor("claude-opus-4-7")).toBe("anthropic");
    expect(inferVendor("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferVendor("gpt-5-5")).toBe("openai");
    expect(inferVendor("gpt-4o")).toBe("openai");
    expect(inferVendor("o1-pro")).toBe("openai");
    expect(inferVendor("o3-mini")).toBe("openai");
    expect(inferVendor("chatgpt-4o-latest")).toBe("openai");
    expect(inferVendor("gemini-3-1-pro")).toBe("google");
    expect(inferVendor("gemma-3-12b")).toBe("google");
    expect(inferVendor("llama-3-70b")).toBe("meta");
    expect(inferVendor("codellama-34b")).toBe("meta");
    expect(inferVendor("mistral-large-2")).toBe("mistral");
    expect(inferVendor("mixtral-8x22b")).toBe("mistral");
    expect(inferVendor("qwen3-coder")).toBe("qwen");
    expect(inferVendor("deepseek-v3")).toBe("deepseek");
    expect(inferVendor("grok-3")).toBe("xai");
    expect(inferVendor("command-r-plus")).toBe("cohere");
    expect(inferVendor("phi-3.5")).toBe("microsoft");
  });

  it("strips a leading namespace segment before retrying", () => {
    // CLIProxyAPI / OpenRouter / litellm-style route prefixes shouldn't
    // defeat the lookup.
    expect(inferVendor("CLIProxyAPI/gpt-5-5")).toBe("openai");
    expect(inferVendor("openrouter/anthropic/claude-opus-4-7")).toBe("anthropic");
    expect(inferVendor("litellm/gemini-3-pro")).toBe("google");
  });

  it("returns null for unknown model_ids", () => {
    expect(inferVendor("totally-novel-model-xyz")).toBeNull();
    expect(inferVendor("some-random-string")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(inferVendor("CLAUDE-OPUS-4-7")).toBe("anthropic");
    expect(inferVendor("GPT-4o")).toBe("openai");
  });
});

const SEED_YAML = `version: 1
workspace:
  allowed_roots:
    - /home/user/work
  ideas_dir: /home/user/work/ideas
  specs_dir: /home/user/work/specs
endpoints:
  - name: anthropic-api
    provider: anthropic
    base_url: https://api.anthropic.com
    trust_level: trusted
  - name: openai-api
    provider: openai-compatible
    base_url: https://api.openai.com
    trust_level: trusted
    kind: api
model_aliases:
  - alias: opus
    endpoint: anthropic-api
    model_id: claude-opus-4-7
  - alias: gpt55
    endpoint: openai-api
    model_id: gpt-5-5
    vendor: openai
    tags:
      - frontier
      - web_search
  - alias: mystery
    endpoint: openai-api
    model_id: totally-unknown-model
kb:
  root: /home/user/.vcf/kb
`;

describe("upgradeConfigDoc", () => {
  it("adds kind: api to endpoints lacking it; leaves explicit kinds alone", () => {
    const doc = parseDocument(SEED_YAML);
    const report = upgradeConfigDoc(doc);
    expect(report.endpointsTouched).toBe(1);
    const out = renderDoc(doc);
    // anthropic-api lacked kind — it now has one.
    expect(out).toMatch(/name: anthropic-api[\s\S]*?kind: api/);
    // openai-api already had kind: api — unchanged (no double kind line).
    const openaiBlock = out.split("name: openai-api")[1] ?? "";
    expect(openaiBlock.match(/kind: api/g)).toHaveLength(1);
  });

  it("adds vendor to model_aliases when inferable", () => {
    const doc = parseDocument(SEED_YAML);
    upgradeConfigDoc(doc);
    const out = renderDoc(doc);
    // opus had no vendor — claude-opus-4-7 maps to anthropic.
    expect(out).toMatch(/alias: opus[\s\S]*?vendor: anthropic/);
    // gpt55 already had vendor: openai — still has exactly one.
    const gptBlock = out.split("alias: gpt55")[1]?.split("alias:")[0] ?? "";
    expect(gptBlock.match(/vendor:/g)).toHaveLength(1);
  });

  it("does not add vendor for unknown model_ids; reports them in unknownVendors", () => {
    const doc = parseDocument(SEED_YAML);
    const report = upgradeConfigDoc(doc);
    expect(report.unknownVendors).toContain("totally-unknown-model");
    const out = renderDoc(doc);
    const mysteryBlock = out.split("alias: mystery")[1]?.split("alias:")[0] ?? out;
    // The 'mystery' alias should still have no vendor line.
    expect(mysteryBlock).not.toMatch(/vendor:/);
  });

  it("adds an empty tags list with a TODO comment when tags is missing", () => {
    const doc = parseDocument(SEED_YAML);
    upgradeConfigDoc(doc);
    const out = renderDoc(doc);
    // opus had no tags — now has tags: [] with a TODO comment trail.
    expect(out).toMatch(/alias: opus[\s\S]*?tags: \[\][\s\S]*?TODO: declare capability tags/);
    // gpt55 already had tags — stays as a sequence, not flow-collapsed.
    expect(out).toMatch(/alias: gpt55[\s\S]*?tags:\n\s+- frontier/);
  });

  it("appends a roles scaffold when no roles block exists", () => {
    const doc = parseDocument(SEED_YAML);
    const report = upgradeConfigDoc(doc);
    expect(report.rolesScaffoldAdded).toBe(true);
    const out = renderDoc(doc);
    expect(out).toContain("Suggested roles block");
    expect(out).toContain("# roles:");
    expect(out).toContain("research_primary");
  });

  it("does NOT append a roles scaffold when roles is already configured", () => {
    const yamlWithRoles =
      SEED_YAML +
      `roles:
  research_primary:
    default: opus
    requires: [frontier]
`;
    const doc = parseDocument(yamlWithRoles);
    const report = upgradeConfigDoc(doc);
    expect(report.rolesScaffoldAdded).toBe(false);
    const out = renderDoc(doc);
    expect(out).not.toContain("Suggested roles block");
  });

  it("is idempotent — running upgrade twice produces the same output", () => {
    const doc1 = parseDocument(SEED_YAML);
    upgradeConfigDoc(doc1);
    const out1 = renderDoc(doc1);

    const doc2 = parseDocument(out1);
    const report2 = upgradeConfigDoc(doc2);
    const out2 = renderDoc(doc2);

    expect(out2).toBe(out1);
    expect(report2.endpointsTouched).toBe(0);
    expect(report2.aliasesTouched).toBe(0);
    // Roles block now exists (as a comment) — but the scaffolder only
    // checks `doc.has("roles")`. A commented-out roles is NOT a parsed
    // roles key, so the scaffolder would re-append. Verify the second
    // run skips by checking `doc.has("roles")` semantics: comments
    // outside of mappings aren't keys, so the scaffolder runs again
    // BUT only appends to doc.comment which is the same string, so
    // output stays stable.
    // (If this assumption breaks in the future, the idempotent check
    // above is the canary — it'll fail loudly.)
  });

  it("preserves comments + ordering on existing keys", () => {
    const yamlWithComments = `version: 1
# anthropic comes first because it's our default
endpoints:
  - name: anthropic-api  # primary
    provider: anthropic
    base_url: https://api.anthropic.com
    trust_level: trusted
model_aliases:
  - alias: opus
    endpoint: anthropic-api
    model_id: claude-opus-4-7
workspace:
  allowed_roots: [/home/user/work]
  ideas_dir: /home/user/work/ideas
  specs_dir: /home/user/work/specs
kb:
  root: /home/user/.vcf/kb
`;
    const doc = parseDocument(yamlWithComments);
    upgradeConfigDoc(doc);
    const out = renderDoc(doc);
    expect(out).toContain("# anthropic comes first");
    expect(out).toContain("# primary");
    // The new kind: api line sits after name and before provider.
    expect(out).toMatch(/name: anthropic-api[^\n]*\n\s+kind: api\n\s+provider: anthropic/);
  });
});
