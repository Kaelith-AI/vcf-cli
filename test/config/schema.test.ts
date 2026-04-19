import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

// A known-good minimal config for positive tests. Negative tests mutate a
// clone of this to prove each invariant fires.
const MIN_VALID = {
  version: 1,
  workspace: {
    allowed_roots: ["/home/user/work"],
    ideas_dir: "/home/user/work/ideas",
    specs_dir: "/home/user/work/specs",
  },
  endpoints: [
    {
      name: "local-ollama",
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1",
      trust_level: "local",
    },
  ],
  kb: { root: "/home/user/.vcf/kb" },
};

describe("ConfigSchema", () => {
  it("accepts a minimal valid config with defaults filled", () => {
    const parsed = ConfigSchema.parse(MIN_VALID);
    expect(parsed.version).toBe(1);
    // telemetry defaults to off (locked decision 2026-04-18)
    expect(parsed.telemetry.error_reporting_enabled).toBe(false);
    // review defaults include all three MVP categories
    expect(parsed.review.categories).toEqual(["code", "security", "production"]);
    // prefer_local default false
    expect(parsed.prefer_local).toBe(false);
    // redaction on public always true (hardcoded literal)
    expect(parsed.redaction.on_public_endpoints).toBe(true);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    const bad = { ...MIN_VALID, bogus_field: 42 };
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects wrong version literal", () => {
    const r = ConfigSchema.safeParse({ ...MIN_VALID, version: 2 });
    expect(r.success).toBe(false);
  });

  it("rejects non-absolute allowed_roots", () => {
    const r = ConfigSchema.safeParse({
      ...MIN_VALID,
      workspace: { ...MIN_VALID.workspace, allowed_roots: ["relative/path"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty allowed_roots", () => {
    const r = ConfigSchema.safeParse({
      ...MIN_VALID,
      workspace: { ...MIN_VALID.workspace, allowed_roots: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid trust_level", () => {
    const bad = structuredClone(MIN_VALID);
    (bad.endpoints[0] as Record<string, unknown>).trust_level = "mostly-trusted";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects model_alias referencing unknown endpoint", () => {
    const bad = {
      ...MIN_VALID,
      model_aliases: [
        { alias: "planner", endpoint: "nonexistent", model_id: "foo", prefer_for: [] },
      ],
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate endpoint names", () => {
    const bad = {
      ...MIN_VALID,
      endpoints: [MIN_VALID.endpoints[0], MIN_VALID.endpoints[0]],
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate model aliases", () => {
    const bad = {
      ...MIN_VALID,
      model_aliases: [
        { alias: "planner", endpoint: "local-ollama", model_id: "a", prefer_for: [] },
        { alias: "planner", endpoint: "local-ollama", model_id: "b", prefer_for: [] },
      ],
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a fully-populated config", () => {
    const full = {
      ...MIN_VALID,
      endpoints: [
        MIN_VALID.endpoints[0],
        {
          name: "anthropic-main",
          provider: "anthropic",
          base_url: "https://api.anthropic.com",
          auth_env_var: "ANTHROPIC_API_KEY",
          trust_level: "public",
        },
      ],
      model_aliases: [
        {
          alias: "planner",
          endpoint: "anthropic-main",
          model_id: "claude-opus-4-7",
          prefer_for: ["planning"],
        },
        {
          alias: "reviewer-code",
          endpoint: "local-ollama",
          model_id: "gemma-3-12b",
          prefer_for: ["review"],
        },
      ],
      review: {
        categories: ["code", "security"],
        auto_advance_on_pass: false,
        stale_primer_days: 90,
      },
      prefer_local: true,
      redaction: {
        on_public_endpoints: true,
        on_trusted_endpoints: true,
        on_local_endpoints: true,
        extra_patterns: ["password\\s*=\\s*\\S+"],
      },
      telemetry: { error_reporting_enabled: true, dsn: "https://example.sentry.io/1" },
    };
    expect(() => ConfigSchema.parse(full)).not.toThrow();
  });

  it("rejects redaction.on_public_endpoints=false (hardcoded literal)", () => {
    const bad = {
      ...MIN_VALID,
      redaction: {
        on_public_endpoints: false,
        on_trusted_endpoints: true,
        on_local_endpoints: false,
        extra_patterns: [],
      },
    };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });
});
