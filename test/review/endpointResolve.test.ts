import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";
import { resolveReviewEndpoint, pickModelId } from "../../src/review/endpointResolve.js";
import { McpError } from "../../src/errors.js";

// Unit tests for the trust-level gate + model resolver extracted from
// review_execute (followup #45). The orchestration path (review_execute
// integration test) still exercises these via the registered tool; these
// tests pin the boundary behavior at the module level so future refactors
// catch gate regressions faster than the full MCP surface does.

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    version: 1,
    workspace: {
      allowed_roots: ["/tmp/proj"],
      ideas_dir: "/tmp/ideas",
      specs_dir: "/tmp/specs",
    },
    endpoints: [
      {
        name: "local-ollama",
        provider: "openai-compatible",
        base_url: "http://127.0.0.1:11434/v1",
        trust_level: "local",
      },
      {
        name: "corp-trusted",
        provider: "openai-compatible",
        base_url: "https://internal.example/v1",
        auth_env_var: "CORP_API_KEY",
        trust_level: "trusted",
      },
      {
        name: "public-openai",
        provider: "openai-compatible",
        base_url: "https://api.example/v1",
        auth_env_var: "PUBLIC_API_KEY",
        trust_level: "public",
      },
    ],
    kb: { root: "/tmp/kb" },
    ...overrides,
  };
  return ConfigSchema.parse(base);
}

describe("resolveReviewEndpoint (followup #45)", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.CORP_API_KEY;
    delete process.env.PUBLIC_API_KEY;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("explicit endpoint=local-ollama resolves with no API key", () => {
    const r = resolveReviewEndpoint({
      config: makeConfig(),
      parsed: { endpoint: "local-ollama" },
      reviewType: "code",
    });
    expect(r.endpoint.name).toBe("local-ollama");
    expect(r.apiKey).toBeUndefined();
    expect(r.endpointFromDefaults).toBe(false);
  });

  it("rejects unknown endpoint name with E_VALIDATION", () => {
    expect(() =>
      resolveReviewEndpoint({
        config: makeConfig(),
        parsed: { endpoint: "nonexistent" },
        reviewType: "code",
      }),
    ).toThrow(McpError);
  });

  it("rejects endpoint=undefined when defaults.review.endpoint is also unset", () => {
    expect(() =>
      resolveReviewEndpoint({
        config: makeConfig(),
        parsed: {},
        reviewType: "code",
      }),
    ).toThrowError(/endpoint not provided/);
  });

  it("gates trust_level='public' unless allow_public_endpoint=true", () => {
    process.env.PUBLIC_API_KEY = "xxx";
    expect(() =>
      resolveReviewEndpoint({
        config: makeConfig(),
        parsed: { endpoint: "public-openai" },
        reviewType: "code",
      }),
    ).toThrowError(/trust_level='public'/);

    const ok = resolveReviewEndpoint({
      config: makeConfig(),
      parsed: { endpoint: "public-openai", allow_public_endpoint: true },
      reviewType: "code",
    });
    expect(ok.endpoint.trust_level).toBe("public");
    expect(ok.apiKey).toBe("xxx");
  });

  it("gates defaults-routing to non-local endpoints (even trusted)", () => {
    process.env.CORP_API_KEY = "yyy";
    const cfg = makeConfig({
      defaults: { review: { endpoint: "corp-trusted" } },
    });
    // defaults-routed, not explicit → gate fires
    expect(() =>
      resolveReviewEndpoint({
        config: cfg,
        parsed: {},
        reviewType: "code",
      }),
    ).toThrowError(/config\.defaults\.review\.endpoint/);

    // explicit pass-through → gate releases
    const explicit = resolveReviewEndpoint({
      config: cfg,
      parsed: { endpoint: "corp-trusted" },
      reviewType: "code",
    });
    expect(explicit.endpoint.name).toBe("corp-trusted");
    expect(explicit.endpointFromDefaults).toBe(false);
  });

  it("resolves apiKey from env on non-local endpoints; fails if env unset", () => {
    expect(() =>
      resolveReviewEndpoint({
        config: makeConfig(),
        parsed: { endpoint: "corp-trusted" },
        reviewType: "code",
      }),
    ).toThrowError(/CORP_API_KEY/);

    process.env.CORP_API_KEY = "zzz";
    const ok = resolveReviewEndpoint({
      config: makeConfig(),
      parsed: { endpoint: "corp-trusted" },
      reviewType: "code",
    });
    expect(ok.apiKey).toBe("zzz");
  });

  it("modelId: explicit > defaults.review.model > alias routing > fallback", () => {
    const cfg = makeConfig({
      model_aliases: [
        {
          alias: "reviewer-code",
          endpoint: "local-ollama",
          model_id: "qwen-coder:30b",
          prefer_for: ["reviewer-code"],
        },
        {
          alias: "reviewer",
          endpoint: "local-ollama",
          model_id: "qwen:32b",
          prefer_for: ["reviewer"],
        },
      ],
      defaults: { review: { endpoint: "local-ollama", model: "mistral:7b" } },
    });
    // explicit wins
    expect(
      resolveReviewEndpoint({
        config: cfg,
        parsed: { endpoint: "local-ollama", model_id: "claude-3-haiku" },
        reviewType: "code",
      }).modelId,
    ).toBe("claude-3-haiku");
    // defaults beats alias
    expect(
      resolveReviewEndpoint({
        config: cfg,
        parsed: { endpoint: "local-ollama" },
        reviewType: "code",
      }).modelId,
    ).toBe("mistral:7b");
  });

  it("pickModelId prefers reviewer-<type> alias, then reviewer, then first, then fallback", () => {
    const cfg = makeConfig({
      model_aliases: [
        {
          alias: "reviewer-code",
          endpoint: "local-ollama",
          model_id: "qwen-coder:30b",
          prefer_for: ["reviewer-code"],
        },
        {
          alias: "reviewer",
          endpoint: "local-ollama",
          model_id: "qwen:32b",
          prefer_for: ["reviewer"],
        },
      ],
    });
    expect(pickModelId(cfg, "code")).toBe("qwen-coder:30b");
    expect(pickModelId(cfg, "security")).toBe("qwen:32b");
    const noAlias = makeConfig();
    expect(pickModelId(noAlias, "code")).toBe("gpt-4o-mini");
  });
});
