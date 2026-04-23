import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";

// M10 exercises the built `vcf` CLI end-to-end. We shell out to
// dist/cli.js so packaging regressions (missing file in "files",
// bad bin shebang, ESM resolution) would surface here too.

const CLI = join(process.cwd(), "dist", "cli.js");

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? -1,
  };
}

describe("M10 vcf CLI", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m10-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m10h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function writeConfig(extra = ""): string {
    const kbRoot = join(home, ".vcf", "kb");
    const body = [
      "version: 1",
      "workspace:",
      `  allowed_roots:`,
      `    - ${workRoot}`,
      `  ideas_dir: ${workRoot}/ideas`,
      `  specs_dir: ${workRoot}/specs`,
      "endpoints:",
      "  - name: local-stub",
      "    provider: local-stub",
      "    base_url: http://127.0.0.1:1",
      "    trust_level: local",
      "kb:",
      `  root: ${kbRoot}`,
      extra,
      "",
    ].join("\n");
    const path = join(home, ".vcf", "config.yaml");
    // ensure dir exists synchronously — cross-platform
    const fsSync = require("node:fs") as typeof import("node:fs");
    fsSync.mkdirSync(join(home, ".vcf"), { recursive: true });
    fsSync.writeFileSync(path, body);
    return path;
  }

  it("vcf version prints the pinned version", () => {
    const res = runCli(["version"]);
    expect(res.status).toBe(0);
    // `vcf version` writes to stdout with the `vcf-cli` prefix so
    // downstream (brew formula test, smoke scripts, shell pipelines) all
    // agree on one format.
    expect(res.stdout).toMatch(/^vcf-cli \d+\.\d+\.\d+/);
  });

  it("vcf reindex writes artifact rows for plans/decisions markdown", async () => {
    // Register project in the global registry, then seed the state-dir DB.
    const { upsertProject } = await import("../../src/util/projectRegistry.js");
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(globalDb, { name: "demo", root_path: projectDir, state: "building" });
    globalDb.close();

    const statePath = join(home, ".vcf", "projects", "demo", "project.db");
    const db = openProjectDb({ path: statePath });
    const now = Date.now();
    db.prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, 'Demo', ?, 'building', ?, ?)`,
    ).run(projectDir, now, now);
    db.close();

    await mkdir(join(projectDir, "plans", "decisions"), { recursive: true });
    await writeFile(join(projectDir, "plans", "demo-plan.md"), "# Plan\n\nbody");
    await writeFile(
      join(projectDir, "plans", "decisions", "2026-04-19-example.md"),
      "# Decision\n",
    );

    const res = runCli(["reindex"], { cwd: projectDir, env: { VCF_HOME: home } });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/reindex complete: 2/);

    const verify = openProjectDb({ path: statePath });
    const kinds = (
      verify.prepare("SELECT kind FROM artifacts ORDER BY path").all() as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds.sort()).toEqual(["decision", "plan"]);
    verify.close();
  });

  it("vcf reindex fails without a registered project", async () => {
    const empty = join(workRoot, "empty");
    await mkdir(empty, { recursive: true });
    const res = runCli(["reindex"], { cwd: empty, env: { VCF_HOME: home } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no registered VCF project/);
  });

  it("vcf verify reports config load success and endpoint env var status", async () => {
    const cfg = writeConfig();
    const res = runCli(["verify"], { env: { VCF_CONFIG: cfg } });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/config\.yaml loaded and validated/);
    expect(res.stderr).toMatch(/verify ok/);
  });

  it("vcf register-endpoint appends a new block and re-validates", async () => {
    const cfg = writeConfig();
    const res = runCli(
      [
        "register-endpoint",
        "--name",
        "openai-main",
        "--provider",
        "openai-compatible",
        "--base-url",
        "https://api.openai.com/v1",
        "--trust-level",
        "public",
        "--auth-env-var",
        "OPENAI_API_KEY",
      ],
      { env: { VCF_CONFIG: cfg } },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/appended endpoint 'openai-main'/);
    expect(res.stderr).toMatch(/config re-validated/);
    const updated = await readFile(cfg, "utf8");
    expect(updated).toMatch(/name: openai-main/);
    expect(updated).toMatch(/auth_env_var: OPENAI_API_KEY/);
  });

  it("vcf test-trends aggregates cross-project test runs written by test_execute (#17)", async () => {
    const cfg = writeConfig();
    // Seed a handful of test_runs rows across two projects.
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const insert = globalDb.prepare(
      `INSERT INTO test_runs (project_root, command, args_json, cwd, started_at, finished_at,
                              duration_ms, exit_code, signal, timed_out, canceled, passed)
       VALUES (?, 'vitest', '[]', ?, ?, ?, ?, ?, NULL, 0, 0, ?)`,
    );
    const base = Date.now();
    const rows: Array<[string, number, number]> = [
      [projectDir, base - 3000, 1],
      [projectDir, base - 2000, 1],
      [projectDir, base - 1000, 0],
      ["/tmp/other-proj", base - 500, 1],
    ];
    for (const [root, started, passed] of rows) {
      insert.run(root, root, started, started + 100, 100, passed === 1 ? 0 : 1, passed);
    }
    globalDb.close();

    const res = runCli(["test-trends", "--format", "json"], {
      env: { VCF_CONFIG: cfg, VCF_HOME: home },
    });
    expect(res.status).toBe(0);
    const summaries = JSON.parse(res.stdout) as Array<{
      project_root: string;
      total_runs: number;
      passed: number;
      failed: number;
    }>;
    expect(summaries).toHaveLength(2);
    const mine = summaries.find((s) => s.project_root === projectDir);
    expect(mine).toBeDefined();
    expect(mine?.total_runs).toBe(3);
    expect(mine?.passed).toBe(2);
    expect(mine?.failed).toBe(1);
  });

  it("vcf admin audit returns an empty table from a fresh global DB", () => {
    const cfg = writeConfig();
    const res = runCli(["admin", "audit", "--format", "json"], {
      env: { VCF_CONFIG: cfg, HOME: home },
    });
    expect(res.status).toBe(0);
    // Empty audit DB prints [] on stdout so `| jq` works.
    expect(res.stdout.trim()).toBe("[]");
  });

  it("vcf admin config-history prints JSON rows recorded by vcf-mcp boot (#48)", async () => {
    // We can't actually spawn vcf-mcp here (it'd block on stdio). Instead,
    // directly write a boot row via the helper and then query via CLI.
    const cfg = writeConfig();
    const { recordConfigBoot } = await import("../../src/util/configBoot.js");
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    recordConfigBoot(globalDb, cfg, "0.6.0");
    globalDb.close();
    const res = runCli(["admin", "config-history", "--format", "json"], {
      env: { VCF_CONFIG: cfg, VCF_HOME: home },
    });
    expect(res.status).toBe(0);
    const rows = JSON.parse(res.stdout) as Array<{ config_path: string; sha256: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].config_path).toBe(cfg);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("vcf install-skills claude-code copies every shipped skill with Claude /foo invocation", async () => {
    const dest = join(workRoot, "claude-skills");
    const res = runCli(["install-skills", "claude-code", "--dest", dest]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/install-skills: \d+ installed, 0 skipped/);
    const dirs = await readdir(dest);
    expect(dirs).toEqual(
      expect.arrayContaining(["capture-idea", "plan", "review", "review-execute"]),
    );
    const body = await readFile(join(dest, "capture-idea", "SKILL.md"), "utf8");
    expect(body).toMatch(/\/capture-idea/);
    expect(body).not.toMatch(/\$capture-idea/);
  });

  it("vcf install-skills codex copies every shipped skill with Codex $foo invocation", async () => {
    const dest = join(workRoot, "codex-skills");
    const res = runCli(["install-skills", "codex", "--dest", dest]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/install-skills: \d+ installed, 0 skipped/);
    const dirs = await readdir(dest);
    expect(dirs).toEqual(
      expect.arrayContaining(["capture-idea", "plan", "review", "review-execute"]),
    );
    const body = await readFile(join(dest, "capture-idea", "SKILL.md"), "utf8");
    expect(body).toMatch(/\$capture-idea/);
    expect(body).not.toMatch(/\/capture-idea/);
  });

  it("vcf install-skills skips when skill dir already exists", async () => {
    const dest = join(workRoot, "codex-skills-reinstall");
    const first = runCli(["install-skills", "codex", "--dest", dest]);
    const firstMatch = first.stderr.match(/install-skills: (\d+) installed, 0 skipped/);
    expect(first.status).toBe(0);
    expect(firstMatch).not.toBeNull();
    const installedCount = Number(firstMatch![1]);
    const second = runCli(["install-skills", "codex", "--dest", dest]);
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(
      new RegExp(`install-skills: 0 installed, ${installedCount} skipped`),
    );
  });

  it("vcf install-skills gemini copies every shipped .toml command (flat layout)", async () => {
    const dest = join(workRoot, "gemini-commands");
    const res = runCli(["install-skills", "gemini", "--dest", dest]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/install-skills: \d+ installed, 0 skipped/);
    const files = await readdir(dest);
    const tomls = files.filter((f) => f.endsWith(".toml")).sort();
    expect(tomls).toEqual(
      expect.arrayContaining([
        "capture-idea.toml",
        "plan.toml",
        "review.toml",
        "review-execute.toml",
      ]),
    );
    // TOML shape: must start with description = then a prompt = block.
    const body = await readFile(join(dest, "capture-idea.toml"), "utf8");
    expect(body).toMatch(/^description = "/);
    expect(body).toMatch(/\nprompt = """\n/);
    expect(body).toMatch(/idea_capture/);
  });

  it("vcf install-skills gemini skips existing .toml files on re-run", async () => {
    const dest = join(workRoot, "gemini-reinstall");
    const first = runCli(["install-skills", "gemini", "--dest", dest]);
    expect(first.status).toBe(0);
    const firstMatch = first.stderr.match(/install-skills: (\d+) installed, 0 skipped/);
    expect(firstMatch).not.toBeNull();
    const installedCount = Number(firstMatch![1]);
    const second = runCli(["install-skills", "gemini", "--dest", dest]);
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(
      new RegExp(`install-skills: 0 installed, ${installedCount} skipped`),
    );
  });

  it("vcf install-skills rejects unknown clients with exit code 2", () => {
    const res = runCli(["install-skills", "cursor"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown client 'cursor'/);
    expect(res.stderr).toMatch(/supported: claude-code, codex, gemini/);
  });
});
