// Panel-mode utilities: directive builder + parallel dispatch.
// Real LLM calls are out of scope — runPanel uses dispatcher which has its
// own coverage. These tests verify the slot-resolution + directive shape.

import { describe, it, expect } from "vitest";
import { ConfigSchema, type Config } from "../../src/config/schema.js";
import { buildDirective, runPanel } from "../../src/util/panel.js";

const BASE = {
  version: 1 as const,
  workspace: {
    allowed_roots: ["/home/user/work"],
    ideas_dir: "/home/user/work/ideas",
    specs_dir: "/home/user/work/specs",
  },
  kb: { root: "/home/user/.vcf/kb" },
};

function buildConfig(): Config {
  return ConfigSchema.parse({
    ...BASE,
    endpoints: [
      {
        name: "anthropic-api",
        provider: "anthropic",
        base_url: "https://api.anthropic.com",
        trust_level: "trusted",
      },
      {
        name: "openai-api",
        provider: "openai-compatible",
        base_url: "https://api.openai.com",
        trust_level: "trusted",
      },
      {
        name: "gemini-api",
        provider: "gemini",
        base_url: "https://generativelanguage.googleapis.com",
        trust_level: "trusted",
      },
    ],
    model_aliases: [
      {
        alias: "opus",
        endpoint: "anthropic-api",
        model_id: "claude-opus-4-7",
        vendor: "anthropic",
        tags: ["frontier", "web_search"],
      },
      {
        alias: "gpt55",
        endpoint: "openai-api",
        model_id: "gpt-5-5",
        vendor: "openai",
        tags: ["frontier", "web_search"],
      },
      {
        alias: "gem31",
        endpoint: "gemini-api",
        model_id: "gemini-3-1-pro",
        vendor: "google",
        tags: ["frontier", "web_search"],
      },
    ],
    roles: {
      research_panel: {
        defaults: ["opus", "gpt55", "gem31"],
        requires: ["frontier", "web_search"],
        vendor_diverse: true,
      },
    },
  });
}

describe("buildDirective", () => {
  it("emits one slot per panel default with prompts + output paths", () => {
    const config = buildConfig();
    const d = buildDirective({
      config,
      roleName: "research_panel",
      staging_dir: "/tmp/staging",
      buildMessages: (slot, model) => [
        { role: "system", content: `slot ${slot} for ${model.model.alias}` },
        { role: "user", content: "go" },
      ],
      outputPathFor: (slot, model) => `/tmp/staging/aspect-${slot}-${model.model.alias}.json`,
      next_tool: "research_assemble",
      next_tool_args: { draft_id: "abc" },
      instructions: "spawn each agent fresh-context",
    });

    expect(d.mode).toBe("directive");
    expect(d.panel).toHaveLength(3);
    expect(d.panel.map((p) => p.vendor)).toEqual(["anthropic", "openai", "google"]);
    expect(d.panel[0].expected_output_path).toBe("/tmp/staging/aspect-0-opus.json");
    expect(d.panel[0].messages[0].content).toContain("slot 0");
    expect(d.next_tool).toBe("research_assemble");
    expect(d.next_tool_args).toEqual({ draft_id: "abc" });
  });

  it("includes endpoint_kind for orchestrator routing decisions", () => {
    const config = buildConfig();
    const d = buildDirective({
      config,
      roleName: "research_panel",
      staging_dir: "/tmp",
      buildMessages: () => [],
      outputPathFor: (i) => `/tmp/${i}`,
      next_tool: "x",
      next_tool_args: {},
      instructions: "",
    });
    expect(d.panel.every((p) => p.endpoint_kind === "api")).toBe(true);
  });
});

describe("runPanel", () => {
  it("rejects with the first error when dispatch fails on every slot", async () => {
    const config = buildConfig();
    // disable all endpoints by mutating in-place would require unfreezing —
    // instead, test via a config whose role points at a disabled endpoint.
    // Easier: pass a buildMessages that returns valid input, but the real
    // dispatch will fail because the test environment has no live HTTP.
    await expect(
      runPanel({
        config,
        roleName: "research_panel",
        buildMessages: () => [{ role: "user", content: "hi" }],
        resolveApiKey: () => undefined,
      }),
    ).rejects.toBeDefined();
  });
});
