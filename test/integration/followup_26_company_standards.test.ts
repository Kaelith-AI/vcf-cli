// Tests for followup #26 — ship_audit company-standards pass + vcf standards init.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  code?: string;
  content?: unknown;
  summary?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    throw new Error(`non-JSON MCP response (isError=${r.isError}): ${text.slice(0, 300)}`);
  }
}

interface Pass {
  name: string;
  status: "ok" | "warning" | "blocker";
  findings: Array<{ file: string; severity: string; detail: string }>;
  notes?: string;
}

async function initGitRepo(
  root: string,
  opts: { commits?: string[]; branch?: string } = {},
): Promise<void> {
  const run = (args: string[], env?: Record<string, string>) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  const gitEnv = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  run(["init", "-b", opts.branch ?? "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "seed\n");
  run(["add", "."], gitEnv);
  run(["commit", "-m", "chore: seed"], gitEnv);
  for (const msg of opts.commits ?? []) {
    await writeFile(join(root, `f-${Math.random().toString(36).slice(2, 8)}.ts`), "export {};\n");
    run(["add", "."], gitEnv);
    run(["commit", "-m", msg], gitEnv);
  }
}

async function bootProject(workRoot: string, home: string, projectDir: string) {
  const config = ConfigSchema.parse({
    version: 1,
    workspace: {
      allowed_roots: [workRoot],
      ideas_dir: join(workRoot, "ideas"),
      specs_dir: join(workRoot, "specs"),
    },
    endpoints: [
      {
        name: "local-stub",
        provider: "local-stub",
        base_url: "http://127.0.0.1:1",
        trust_level: "local",
      },
    ],
    kb: { root: join(home, ".vcf", "kb") },
  });
  const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  const dbPath = join(home, ".vcf", "projects", "demo", "project.db");
  const projectDb = openProjectDb({ path: dbPath });
  const now = Date.now();
  projectDb
    .prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, 'demo', ?, 'building', ?, ?)`,
    )
    .run(projectDir, now, now);
  const resolved: ResolvedScope = {
    scope: "project",
    projectRoot: projectDir,
    projectSlug: "demo",
    projectDbPath: dbPath,
  };
  const server = createServer({
    scope: "project",
    resolved,
    config,
    globalDb,
    projectDb,
    homeDir: home,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "std26", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return { client };
}

async function writeStandards(kbRoot: string, checks: Record<string, unknown>): Promise<void> {
  const dir = join(kbRoot, "standards");
  await mkdir(dir, { recursive: true });
  const yaml = Object.entries(checks)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `  ${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      }
      return `  ${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  const body = `---\ntype: standard\nstandard_name: company-standards\nchecks:\n${yaml}\n---\n\n# Company Standards\n`;
  await writeFile(join(dir, "company-standards.md"), body);
}

async function runAudit(client: Client): Promise<Pass[]> {
  const res = await client.callTool({
    name: "ship_audit",
    arguments: { include: ["company-standards"], expand: true, fail_fast: false },
  });
  const env = parseResult(res);
  expect(env.ok).toBe(true);
  const content = env.content as { passes: Pass[] };
  return content.passes;
}

describe("followup #26 — ship_audit company-standards pass", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;
  let client: Client;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-std26-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-std26h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    ({ client } = await bootProject(workRoot, home, projectDir));
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      /* noop */
    }
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("skips cleanly when no company-standards.md exists", async () => {
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards");
    expect(pass).toBeDefined();
    expect(pass!.status).toBe("ok");
    expect(pass!.findings.length).toBe(0);
    expect(pass!.notes ?? "").toMatch(/vcf standards init/);
  });

  it("skips cleanly when standards file has no checks block", async () => {
    const dir = join(home, ".vcf", "kb", "standards");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "company-standards.md"), "---\ntype: standard\n---\n# text\n");
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("ok");
    expect(pass.notes ?? "").toMatch(/no `checks:` block/);
  });

  it("license_header — blocker when source files lack the header", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { license_header: "Apache-2.0" });
    const src = join(projectDir, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "with.ts"), "// SPDX-License-Identifier: Apache-2.0\nexport {};\n");
    await writeFile(join(src, "without.ts"), "export const x = 1;\n");
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("blocker");
    const paths = pass.findings.map((f) => f.file);
    expect(paths.some((p) => p.endsWith("without.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("with.ts"))).toBe(false);
  });

  it("license_header — ok when every source file carries the header", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { license_header: "Apache-2.0" });
    const src = join(projectDir, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.ts"), "// SPDX-License-Identifier: Apache-2.0\nexport {};\n");
    await writeFile(join(src, "b.ts"), "/* SPDX-License-Identifier: Apache-2.0 */\nexport {};\n");
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("ok");
  });

  it("required_files — blocker per missing path", async () => {
    await writeStandards(join(home, ".vcf", "kb"), {
      required_files: ["LICENSE", "CHANGELOG.md", "README.md"],
    });
    await writeFile(join(projectDir, "README.md"), "# demo\n");
    // LICENSE and CHANGELOG.md missing on purpose.
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("blocker");
    const details = pass.findings.map((f) => f.detail).join("\n");
    expect(details).toMatch(/LICENSE/);
    expect(details).toMatch(/CHANGELOG.md/);
    expect(details).not.toMatch(/README.md/);
  });

  it("branch_prefix — blocker when on a topic branch that doesn't match", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { branch_prefix: ["feat", "fix"] });
    await initGitRepo(projectDir);
    spawnSync("git", ["checkout", "-b", "spike-xyz"], { cwd: projectDir });
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("blocker");
    expect(pass.findings[0]!.detail).toMatch(/spike-xyz/);
  });

  it("branch_prefix — ok when branch matches a configured prefix", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { branch_prefix: ["feat", "fix"] });
    await initGitRepo(projectDir);
    spawnSync("git", ["checkout", "-b", "feat/add-widget"], { cwd: projectDir });
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("ok");
  });

  it("branch_prefix — ok on default branch regardless of prefix", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { branch_prefix: ["feat", "fix"] });
    await initGitRepo(projectDir);
    // Still on main — should not trigger the prefix check.
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("ok");
  });

  it("commit_style — blocker on non-conventional commits since diverged from main", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { commit_style: "conventional" });
    await initGitRepo(projectDir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    spawnSync("git", ["checkout", "-b", "feat/widget"], { cwd: projectDir });
    await writeFile(join(projectDir, "a.ts"), "export {};\n");
    spawnSync("git", ["add", "."], { cwd: projectDir, env });
    spawnSync("git", ["commit", "-m", "feat: add widget"], { cwd: projectDir, env });
    await writeFile(join(projectDir, "b.ts"), "export {};\n");
    spawnSync("git", ["add", "."], { cwd: projectDir, env });
    spawnSync("git", ["commit", "-m", "oops fix a bug"], { cwd: projectDir, env });

    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("blocker");
    const details = pass.findings.map((f) => f.detail).join("\n");
    expect(details).toMatch(/non-conventional/);
    expect(details).toMatch(/oops fix a bug/);
    expect(pass.notes ?? "").toMatch(/since diverged from main/);
  });

  it("commit_style — ok on default branch with last-tag window", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { commit_style: "conventional" });
    await initGitRepo(projectDir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    spawnSync("git", ["tag", "v0.1.0"], { cwd: projectDir });
    // After the tag, add only conventional commits.
    await writeFile(join(projectDir, "a.ts"), "export {};\n");
    spawnSync("git", ["add", "."], { cwd: projectDir, env });
    spawnSync("git", ["commit", "-m", "feat: first"], { cwd: projectDir, env });

    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("ok");
    expect(pass.notes ?? "").toMatch(/since tag v0\.1\.0/);
  });

  it("commit_style — blocker when not a git repo", async () => {
    await writeStandards(join(home, ".vcf", "kb"), { commit_style: "conventional" });
    const passes = await runAudit(client);
    const pass = passes.find((p) => p.name === "company-standards")!;
    expect(pass.status).toBe("blocker");
    expect(pass.findings[0]!.detail).toMatch(/not a git repository/);
  });
});

describe("followup #26 — runStandardsInit", () => {
  let home: string;
  let kbRoot: string;
  let kbUpstream: string;
  const origEnv: Record<string, string | undefined> = {};
  let origExit: typeof process.exit;
  let origWrite: typeof process.stderr.write;
  let stderrBuf: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-stdinit-")));
    kbRoot = join(home, ".vcf", "kb");
    kbUpstream = await realpath(await mkdtemp(join(tmpdir(), "vcf-stdinit-upstream-")));
    await mkdir(join(kbUpstream, "standards"), { recursive: true });
    for (const kind of ["company-standards", "design-system", "brand", "privacy"]) {
      await writeFile(join(kbUpstream, "standards", `${kind}.example.md`), `# ${kind}\n`);
    }
    await mkdir(join(home, ".vcf"), { recursive: true });
    const cfg = [
      "version: 1",
      "workspace:",
      `  allowed_roots: [${JSON.stringify(home)}]`,
      `  ideas_dir: ${JSON.stringify(join(home, "ideas"))}`,
      `  specs_dir: ${JSON.stringify(join(home, "specs"))}`,
      "endpoints:",
      "  - name: local-stub",
      "    provider: local-stub",
      "    base_url: http://127.0.0.1:1",
      "    trust_level: local",
      "kb:",
      `  root: ${JSON.stringify(kbRoot)}`,
      "",
    ].join("\n");
    await writeFile(join(home, ".vcf", "config.yaml"), cfg);

    for (const k of ["VCF_HOME", "VCF_CONFIG", "VCF_KB_SOURCE"]) origEnv[k] = process.env[k];
    process.env["VCF_HOME"] = home;
    process.env["VCF_CONFIG"] = join(home, ".vcf", "config.yaml");
    process.env["VCF_KB_SOURCE"] = kbUpstream;
    stderrBuf = "";
    origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: unknown) => {
      stderrBuf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
      return true;
    };
    origExit = process.exit;
    (process.exit as unknown) = (code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    };
  });

  afterEach(async () => {
    for (const k of ["VCF_HOME", "VCF_CONFIG", "VCF_KB_SOURCE"]) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
    process.exit = origExit;
    process.stderr.write = origWrite;
    closeTrackedDbs();
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(kbUpstream, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function runInit(kinds: string[] = []): Promise<{ exitCode: number; stderr: string }> {
    const { runStandardsInit } = await import("../../src/cli/standards.js");
    stderrBuf = "";
    try {
      await runStandardsInit({ kinds });
      return { exitCode: 0, stderr: stderrBuf };
    } catch (e) {
      const m = (e as Error).message.match(/^__exit:(\d+)$/);
      if (m) return { exitCode: Number(m[1]!), stderr: stderrBuf };
      throw e;
    }
  }

  it("creates all four standards files on first run", async () => {
    const r = await runInit();
    expect(r.exitCode).toBe(0);
    for (const kind of ["company-standards", "design-system", "brand", "privacy"]) {
      expect(existsSync(join(kbRoot, "standards", `${kind}.md`))).toBe(true);
    }
  });

  it("is idempotent — second run skips existing files without clobbering", async () => {
    await runInit();
    const p = join(kbRoot, "standards", "company-standards.md");
    await writeFile(p, "# EDITED\n");
    const r2 = await runInit();
    expect(r2.exitCode).toBe(0);
    expect(r2.stderr).toMatch(/skipping/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(p, "utf8")).toBe("# EDITED\n");
  });

  it("accepts a specific kind and seeds only that one", async () => {
    const r = await runInit(["design-system"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(kbRoot, "standards", "design-system.md"))).toBe(true);
    expect(existsSync(join(kbRoot, "standards", "company-standards.md"))).toBe(false);
  });

  it("rejects unknown kinds", async () => {
    const r = await runInit(["bogus"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown standard/);
  });
});
