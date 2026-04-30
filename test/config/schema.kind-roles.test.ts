// Schema tests for Workstream A: endpoint kind/enabled, model tags/vendor,
// roles with capability tags + vendor diversity.

import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

const BASE = {
  version: 1 as const,
  workspace: {
    allowed_roots: ["/home/user/work"],
    ideas_dir: "/home/user/work/ideas",
    specs_dir: "/home/user/work/specs",
  },
  kb: { root: "/home/user/.vcf/kb" },
};

const apiEndpoint = (over: Record<string, unknown> = {}) => ({
  name: "anthropic-api",
  provider: "anthropic",
  base_url: "https://api.anthropic.com",
  trust_level: "trusted",
  ...over,
});

const cliEndpoint = (over: Record<string, unknown> = {}) => ({
  name: "claude-cli",
  provider: "anthropic",
  kind: "cli",
  cmd: "claude",
  trust_level: "local",
  ...over,
});

describe("Endpoint kind", () => {
  it("defaults kind to 'api' for back-compat", () => {
    const r = ConfigSchema.parse({ ...BASE, endpoints: [apiEndpoint()] });
    expect(r.endpoints[0].kind).toBe("api");
    expect(r.endpoints[0].enabled).toBe(true);
  });

  it("accepts kind:cli with cmd", () => {
    const r = ConfigSchema.parse({ ...BASE, endpoints: [cliEndpoint()] });
    expect(r.endpoints[0].kind).toBe("cli");
    expect(r.endpoints[0].cmd).toBe("claude");
    expect(r.endpoints[0].workdir_mode).toBe("ephemeral");
  });

  it("rejects kind:api without base_url", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint({ base_url: undefined })],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects kind:cli without cmd", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [cliEndpoint({ cmd: undefined })],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects kind:cli with base_url (api-only field)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [cliEndpoint({ base_url: "https://example.com" })],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects kind:cli with auth_env_var (api-only field)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [cliEndpoint({ auth_env_var: "FOO" })],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects kind:api with cmd (cli-only field)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint({ cmd: "claude" })],
    });
    expect(bad.success).toBe(false);
  });

  it("respects enabled=false", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      endpoints: [apiEndpoint({ enabled: false })],
    });
    expect(r.endpoints[0].enabled).toBe(false);
  });
});

describe("Roles + capability tags", () => {
  it("accepts a singleton role whose model has required tags", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: ["frontier", "web_search"],
        },
      ],
      roles: {
        research_primary: { default: "opus", requires: ["frontier", "web_search"] },
      },
    });
    expect(r.roles.research_primary.default).toBe("opus");
  });

  it("rejects role whose model lacks required tags (E_ROLE_CAPABILITY_MISMATCH)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: ["frontier"],
        },
      ],
      roles: {
        kb_review_primary: { default: "opus", requires: ["frontier", "web_search"] },
      },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes("E_ROLE_CAPABILITY_MISMATCH"))).toBe(
        true,
      );
    }
  });

  it("rejects role pointing at unknown model alias", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint()],
      roles: {
        research_primary: { default: "ghost", requires: [] },
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects role pointing at disabled endpoint", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint({ enabled: false })],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: ["frontier"],
        },
      ],
      roles: {
        research_primary: { default: "opus", requires: ["frontier"] },
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects role with both default and defaults", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          tags: [],
        },
      ],
      roles: {
        research_primary: { default: "opus", defaults: ["opus"] },
      },
    });
    expect(bad.success).toBe(false);
  });

  it("accepts a vendor-diverse panel", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      endpoints: [
        apiEndpoint({ name: "anthropic-api" }),
        apiEndpoint({ name: "openai-api", base_url: "https://api.openai.com" }),
        apiEndpoint({ name: "gemini-api", base_url: "https://generativelanguage.googleapis.com" }),
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
    expect(r.roles.research_panel.defaults).toHaveLength(3);
  });

  it("rejects a panel with two same-vendor models (E_PANEL_VENDOR_COLLISION)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: ["frontier"],
        },
        {
          alias: "sonnet",
          endpoint: "anthropic-api",
          model_id: "claude-sonnet-4-6",
          vendor: "anthropic",
          tags: ["frontier"],
        },
      ],
      roles: {
        research_panel: {
          defaults: ["opus", "sonnet"],
          requires: ["frontier"],
          vendor_diverse: true,
        },
      },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes("E_PANEL_VENDOR_COLLISION"))).toBe(
        true,
      );
    }
  });

  it("allows same-vendor panel when vendor_diverse=false", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: ["frontier"],
        },
        {
          alias: "sonnet",
          endpoint: "anthropic-api",
          model_id: "claude-sonnet-4-6",
          vendor: "anthropic",
          tags: ["frontier"],
        },
      ],
      roles: {
        research_panel: {
          defaults: ["opus", "sonnet"],
          requires: ["frontier"],
          vendor_diverse: false,
        },
      },
    });
    expect(r.roles.research_panel.defaults).toHaveLength(2);
  });

  it("rejects vendor_diverse panel where a slot lacks vendor field", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      endpoints: [apiEndpoint()],
      model_aliases: [
        {
          alias: "opus",
          endpoint: "anthropic-api",
          model_id: "claude-opus-4-7",
          vendor: "anthropic",
          tags: [],
        },
        { alias: "mystery", endpoint: "anthropic-api", model_id: "x", tags: [] },
      ],
      roles: {
        research_panel: {
          defaults: ["opus", "mystery"],
          requires: [],
          vendor_diverse: true,
        },
      },
    });
    expect(bad.success).toBe(false);
  });
});
