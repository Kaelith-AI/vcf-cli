import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// End-to-end test for the install-skills common/ pack wiring. Runs the
// built CLI against a scratch dest to verify both layouts (nested-md for
// claude-code/codex, flat-toml for gemini) produce a usable vcf-usage-guide
// entry transformed from the shared skills/common/ source.

const CLI = join(__dirname, "..", "..", "dist", "cli.js");

describe("install-skills installs the common pack", () => {
  let scratchRoot: string;

  beforeAll(async () => {
    if (!existsSync(CLI)) {
      throw new Error(
        `install-skills integration test needs dist/cli.js — run 'npm run build' first (missing ${CLI}).`,
      );
    }
    scratchRoot = await mkdtemp(join(tmpdir(), "vcf-install-skills-"));
  });

  afterAll(async () => {
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("claude-code (nested-md) lands vcf-usage-guide/SKILL.md alongside client skills", async () => {
    const dest = join(scratchRoot, "claude");
    const r = spawnSync(process.execPath, [CLI, "install-skills", "claude-code", "--dest", dest], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const skillPath = join(dest, "vcf-usage-guide", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const body = await readFile(skillPath, "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("name: vcf-usage-guide");
    expect(body).toContain("# VCF Usage Guide");
    expect(body).toContain("lesson_log_add");
  });

  it("gemini (flat-toml) lands vcf-usage-guide.toml with description + prompt", async () => {
    const dest = join(scratchRoot, "gemini");
    const r = spawnSync(process.execPath, [CLI, "install-skills", "gemini", "--dest", dest], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const tomlPath = join(dest, "vcf-usage-guide.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const toml = await readFile(tomlPath, "utf8");
    // Description key must be on its own line with the guide's lead sentence.
    expect(toml).toMatch(/^description = "Ground-truth reference/);
    // Prompt body lives in a triple-single-quoted literal so backticks and
    // nested double-quotes in the guide do not need escaping.
    expect(toml).toContain("prompt = '''");
    expect(toml).toContain("# VCF Usage Guide");
    expect(toml.trimEnd().endsWith("'''")).toBe(true);
  });

  it("second run is idempotent (skips existing entries, exit 0)", () => {
    const dest = join(scratchRoot, "claude");
    const r = spawnSync(process.execPath, [CLI, "install-skills", "claude-code", "--dest", dest], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("skipping");
    expect(r.stderr).toContain("vcf-usage-guide");
  });
});
