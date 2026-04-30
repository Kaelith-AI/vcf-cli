import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, realpath, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretsEnv, parseDotenv } from "../../src/util/secretsEnv.js";

describe("parseDotenv", () => {
  it("parses simple KEY=value pairs", () => {
    const out = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(out).toEqual([
      { kind: "valid", name: "FOO", value: "bar" },
      { kind: "valid", name: "BAZ", value: "qux" },
    ]);
  });

  it("strips optional `export ` prefix (bashrc compat)", () => {
    const out = parseDotenv("export FOO=bar\n");
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "bar" }]);
  });

  it("handles double-quoted values with embedded spaces and =", () => {
    const out = parseDotenv('FOO="hello world = with equals"\n');
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "hello world = with equals" }]);
  });

  it("handles single-quoted values literally (no $ expansion)", () => {
    const out = parseDotenv("FOO='$NOT_EXPANDED'\n");
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "$NOT_EXPANDED" }]);
  });

  it("strips trailing inline # comments on unquoted values", () => {
    const out = parseDotenv("FOO=bar # this is a comment\n");
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "bar" }]);
  });

  it("does NOT strip # inside a quoted value", () => {
    const out = parseDotenv('FOO="bar # not-a-comment"\n');
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "bar # not-a-comment" }]);
  });

  it("ignores blank lines and full-line comments", () => {
    const out = parseDotenv("# comment line\n\n   \nFOO=bar\n");
    expect(out).toEqual([{ kind: "valid", name: "FOO", value: "bar" }]);
  });

  it("rejects invalid env-var names (digits-first, dashes, dots)", () => {
    const out = parseDotenv("1FOO=x\nFOO-BAR=x\nFOO.BAR=x\n");
    expect(out.every((e) => e.kind === "invalid")).toBe(true);
  });

  it("rejects empty values (typo guard)", () => {
    const out = parseDotenv("FOO=\n");
    expect(out).toEqual([{ kind: "invalid", name: "FOO", value: "" }]);
  });

  it("rejects lines with no '='", () => {
    const out = parseDotenv("JUST_A_NAME\n");
    expect(out[0]?.kind).toBe("invalid");
  });

  it("rejects unterminated quotes", () => {
    const out = parseDotenv('FOO="never-closed\n');
    expect(out[0]?.kind).toBe("invalid");
  });

  it("preserves sk- style API key values verbatim", () => {
    const out = parseDotenv("KEY=sk-6f6dbccd0a354d0e6890edfe6163a0eb\n");
    expect(out[0]).toEqual({
      kind: "valid",
      name: "KEY",
      value: "sk-6f6dbccd0a354d0e6890edfe6163a0eb",
    });
  });
});

describe("loadSecretsEnv", () => {
  let dir: string;
  let envPath: string;
  const ORIGINAL_ENV = process.env;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-secrets-")));
    envPath = join(dir, "secrets.env");
    // Snapshot then reset relevant test-only keys before each run.
    process.env = { ...ORIGINAL_ENV };
    delete process.env["VCF_SECRETS_TEST_FOO"];
    delete process.env["VCF_SECRETS_TEST_BAR"];
    delete process.env["VCF_SECRETS_TEST_BAZ"];
  });

  afterEach(async () => {
    process.env = ORIGINAL_ENV;
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("returns fileExists=false when the file is absent", () => {
    const r = loadSecretsEnv(envPath);
    expect(r.fileExists).toBe(false);
    expect(r.loaded).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("loads keys not already in process.env", async () => {
    await writeFile(envPath, "VCF_SECRETS_TEST_FOO=value-foo\nVCF_SECRETS_TEST_BAR=value-bar\n");
    const r = loadSecretsEnv(envPath);
    expect(r.fileExists).toBe(true);
    expect(r.loaded.sort()).toEqual(["VCF_SECRETS_TEST_BAR", "VCF_SECRETS_TEST_FOO"]);
    expect(process.env["VCF_SECRETS_TEST_FOO"]).toBe("value-foo");
    expect(process.env["VCF_SECRETS_TEST_BAR"]).toBe("value-bar");
  });

  it("skips keys already set in process.env (existing env wins)", async () => {
    process.env["VCF_SECRETS_TEST_FOO"] = "shell-set";
    await writeFile(envPath, "VCF_SECRETS_TEST_FOO=file-value\n");
    const r = loadSecretsEnv(envPath);
    expect(r.skipped).toEqual(["VCF_SECRETS_TEST_FOO"]);
    expect(r.loaded).toEqual([]);
    expect(process.env["VCF_SECRETS_TEST_FOO"]).toBe("shell-set");
  });

  it("reports invalid lines but still loads the valid ones", async () => {
    await writeFile(envPath, "VCF_SECRETS_TEST_FOO=ok\n1BAD=x\nVCF_SECRETS_TEST_BAR=alsook\n");
    const r = loadSecretsEnv(envPath);
    expect(r.loaded.sort()).toEqual(["VCF_SECRETS_TEST_BAR", "VCF_SECRETS_TEST_FOO"]);
    expect(r.invalid).toEqual(["1BAD"]);
  });

  // POSIX chmod-mode semantics — Windows reports a flat 0o666 for any
  // writable file regardless of the mode requested, so these checks are
  // meaningless there. The permissive-detection codepath itself is
  // unix-only by design (it's a "warn the user their .env is world-
  // readable" guard).
  it.skipIf(process.platform === "win32")(
    "reports permissive=true on world/group readable file",
    async () => {
      await writeFile(envPath, "VCF_SECRETS_TEST_FOO=v\n");
      await chmod(envPath, 0o644);
      const r = loadSecretsEnv(envPath);
      expect(r.permissive).toBe(true);
      expect(r.mode).toBe("0644");
    },
  );

  it.skipIf(process.platform === "win32")("reports permissive=false on chmod 600", async () => {
    await writeFile(envPath, "VCF_SECRETS_TEST_FOO=v\n");
    await chmod(envPath, 0o600);
    const r = loadSecretsEnv(envPath);
    expect(r.permissive).toBe(false);
    expect(r.mode).toBe("0600");
  });

  it("never logs or returns secret values, only names", async () => {
    await writeFile(envPath, "VCF_SECRETS_TEST_FOO=super-secret-value-do-not-leak\n");
    const r = loadSecretsEnv(envPath);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("super-secret-value-do-not-leak");
    expect(r.loaded).toEqual(["VCF_SECRETS_TEST_FOO"]);
  });
});
