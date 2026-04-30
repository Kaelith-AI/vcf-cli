// Tests for runtime role resolver.
// Schema-level validation lives in test/config/schema.kind-roles.test.ts.
// These cover the call-site behavior: resolveRole / resolveRolePanel /
// hasRole on already-validated configs.

import { describe, it, expect } from "vitest";
import { ConfigSchema, type Config } from "../../src/config/schema.js";
import { resolveRole, resolveRolePanel, hasRole } from "../../src/util/roleResolve.js";

const BASE = {
  version: 1 as const,
  workspace: {
    allowed_roots: ["/home/user/work"],
    ideas_dir: "/home/user/work/ideas",
    specs_dir: "/home/user/work/specs",
  },
  kb: { root: "/home/user/.vcf/kb" },
};

function buildConfig(override: Record<string, unknown> = {}): Config {
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
      research_primary: { default: "opus", requires: ["frontier", "web_search"] },
      research_panel: {
        defaults: ["opus", "gpt55", "gem31"],
        requires: ["frontier", "web_search"],
        vendor_diverse: true,
      },
    },
    ...override,
  });
}

describe("resolveRole (singleton)", () => {
  it("returns model + endpoint + modelId", () => {
    const config = buildConfig();
    const r = resolveRole(config, "research_primary");
    expect(r.modelId).toBe("claude-opus-4-7");
    expect(r.endpoint.name).toBe("anthropic-api");
    expect(r.model.alias).toBe("opus");
  });

  it("throws E_NOT_FOUND for unknown role", () => {
    const config = buildConfig();
    expect(() => resolveRole(config, "ghost")).toThrowError(/not declared/);
  });

  it("throws E_VALIDATION when called on a panel role", () => {
    const config = buildConfig();
    expect(() => resolveRole(config, "research_panel")).toThrowError(/panel/);
  });
});

describe("resolveRolePanel", () => {
  it("returns one ResolvedModel per slot", () => {
    const config = buildConfig();
    const r = resolveRolePanel(config, "research_panel");
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.model.vendor)).toEqual(["anthropic", "openai", "google"]);
  });

  it("throws E_VALIDATION when called on a singleton role", () => {
    const config = buildConfig();
    expect(() => resolveRolePanel(config, "research_primary")).toThrowError(/singleton/);
  });
});

describe("hasRole", () => {
  it("returns true for a valid singleton", () => {
    const config = buildConfig();
    expect(hasRole(config, "research_primary")).toBe(true);
  });

  it("returns true for a valid panel", () => {
    const config = buildConfig();
    expect(hasRole(config, "research_panel")).toBe(true);
  });

  it("returns false for unknown role", () => {
    const config = buildConfig();
    expect(hasRole(config, "ghost")).toBe(false);
  });
});
