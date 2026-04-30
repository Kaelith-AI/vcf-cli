// Tests for the SearXNG schema validation. The search_web tool's HTTP path
// is exercised by injecting a fakeFetch through globalThis; that's a bigger
// integration test (would need MCP wiring) — out of scope for this unit
// file. Here we verify the config schema gates the field shapes correctly.

import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

const BASE = {
  version: 1 as const,
  workspace: {
    allowed_roots: ["/home/user/work"],
    ideas_dir: "/home/user/work/ideas",
    specs_dir: "/home/user/work/specs",
  },
  endpoints: [
    {
      name: "local-stub",
      provider: "local-stub",
      base_url: "http://127.0.0.1:1",
      trust_level: "local",
    },
  ],
  kb: { root: "/home/user/.vcf/kb" },
};

describe("config.searxng", () => {
  it("accepts a minimal SearXNG block", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      searxng: { url: "http://127.0.0.1:8080/search" },
    });
    expect(r.searxng?.url).toBe("http://127.0.0.1:8080/search");
    // Defaults applied
    expect(r.searxng?.timeout_ms).toBe(10_000);
    expect(r.searxng?.default_limit).toBe(10);
  });

  it("accepts an auth_env_var", () => {
    const r = ConfigSchema.parse({
      ...BASE,
      searxng: {
        url: "https://search.example.com/search",
        auth_env_var: "SEARXNG_TOKEN",
        timeout_ms: 5000,
        default_limit: 20,
      },
    });
    expect(r.searxng?.auth_env_var).toBe("SEARXNG_TOKEN");
  });

  it("rejects non-URL searxng.url", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      searxng: { url: "not-a-url" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      searxng: { url: "http://127.0.0.1:8080/search", bogus: 1 },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects timeout_ms above the cap", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      searxng: { url: "http://127.0.0.1:8080/search", timeout_ms: 999_999 },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects malformed auth_env_var", () => {
    const bad = ConfigSchema.safeParse({
      ...BASE,
      searxng: { url: "http://127.0.0.1:8080/search", auth_env_var: "lower-case" },
    });
    expect(bad.success).toBe(false);
  });

  it("searxng is optional — config without it still validates", () => {
    const r = ConfigSchema.parse({ ...BASE });
    expect(r.searxng).toBeUndefined();
  });
});
