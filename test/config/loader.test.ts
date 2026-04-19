import { describe, it, expect } from "vitest";
import { parseConfig, interpolateEnv, ConfigError } from "../../src/config/loader.js";

const GOOD_YAML = `
version: 1
workspace:
  allowed_roots:
    - "\${VCF_WORK_ROOT}"
  ideas_dir: "\${VCF_WORK_ROOT}/ideas"
  specs_dir: "\${VCF_WORK_ROOT}/specs"
endpoints:
  - name: local-ollama
    provider: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    trust_level: local
kb:
  root: "\${VCF_WORK_ROOT}/.vcf/kb"
`;

describe("interpolateEnv", () => {
  it("replaces a single var", () => {
    expect(interpolateEnv("prefix-${FOO}-suffix", { FOO: "BAR" })).toBe("prefix-BAR-suffix");
  });

  it("replaces multiple vars", () => {
    expect(interpolateEnv("${A}-${B}", { A: "1", B: "2" })).toBe("1-2");
  });

  it("throws ConfigError on missing var, never leaks value", () => {
    try {
      interpolateEnv("${MISSING_XYZ_ABC}", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.code).toBe("E_CONFIG_MISSING_ENV");
      expect(e.message).toContain("MISSING_XYZ_ABC");
      // message must reference the name, not a partial value
      expect(e.message).not.toMatch(/[=:]\s*\S/);
    }
  });

  it("leaves literal strings without refs alone", () => {
    expect(interpolateEnv("no-refs-here", {})).toBe("no-refs-here");
  });
});

describe("parseConfig", () => {
  it("parses and freezes a valid YAML", () => {
    const cfg = parseConfig(GOOD_YAML, { env: { VCF_WORK_ROOT: "/home/user/work" } });
    expect(cfg.workspace.allowed_roots[0]).toBe("/home/user/work");
    expect(cfg.workspace.ideas_dir).toBe("/home/user/work/ideas");
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.workspace)).toBe(true);
    expect(Object.isFrozen(cfg.workspace.allowed_roots)).toBe(true);
  });

  it("throws E_CONFIG_MISSING_ENV when a referenced var is absent", () => {
    try {
      parseConfig(GOOD_YAML, { env: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("E_CONFIG_MISSING_ENV");
    }
  });

  it("throws E_CONFIG_PARSE on malformed YAML", () => {
    try {
      parseConfig("version: 1\n  bogus: : :\n", { skipEnvInterpolation: true });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("E_CONFIG_PARSE");
    }
  });

  it("throws E_CONFIG_VALIDATION on schema failure", () => {
    try {
      parseConfig("version: 2\n", { skipEnvInterpolation: true });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("E_CONFIG_VALIDATION");
    }
  });

  it("produces config where mutation attempts throw in strict mode", () => {
    const cfg = parseConfig(GOOD_YAML, { env: { VCF_WORK_ROOT: "/home/user/work" } });
    expect(() => {
      (cfg as { version: number }).version = 99;
    }).toThrow();
  });
});
