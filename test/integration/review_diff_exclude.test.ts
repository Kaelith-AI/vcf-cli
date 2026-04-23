import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";

// Followup #38 (partial) — review.diff_exclude pathspecs drop noisy files
// (package-lock.json, dist/**, …) from the scoped diff that review_prepare
// writes. Keeps the reviewer-prompt within budget.

interface Envelope {
  ok: boolean;
  content?: unknown;
  code?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

describe("review.diff_exclude (followup #38)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-dx-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-dxh-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await writeFile(
      join(kbRoot, "review-system", "code", "01-stage1.md"),
      `---\ntype: review-stage\nreview_type: code\nstage: 1\nstage_name: s1\nversion: 0.1\nupdated: 2026-04-22\n---\n# Stage 1\n`,
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      `---\ntype: reviewer-config\nreviewer_type: code\nversion: 0.1\nupdated: 2026-04-22\n---\n# Reviewer\n`,
    );
    clearKbCache();

    // Initialize a git repo with two commits: the second touches both a
    // human-authored source file and a package-lock.json that should be
    // filtered out of review_prepare's diff.
    await mkdir(projectDir, { recursive: true });
    git(projectDir, ["init", "-q"]);
    git(projectDir, ["config", "user.email", "t@t"]);
    git(projectDir, ["config", "user.name", "t"]);
    await writeFile(join(projectDir, "src.ts"), "export const a = 1;\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-q", "-m", "c1"]);
    git(projectDir, ["tag", "v0"]);
    await writeFile(join(projectDir, "src.ts"), "export const a = 2;\n// new line\n");
    await writeFile(
      join(projectDir, "package-lock.json"),
      JSON.stringify({ huge: "x".repeat(10_000) }, null, 2),
    );
    await mkdir(join(projectDir, "dist"), { recursive: true });
    await writeFile(join(projectDir, "dist", "bundle.js"), "eval('big')".repeat(500));
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-q", "-m", "c2"]);
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect(diffExclude?: string[]) {
    const reviewBlock: Record<string, unknown> = { categories: ["code", "security", "production"] };
    if (diffExclude !== undefined) reviewBlock["diff_exclude"] = diffExclude;
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
      kb: { root: kbRoot },
      review: reviewBlock,
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'demo', ?, 'reviewing', ?, ?)`,
      )
      .run(projectDir, now, now);
    const resolved: ResolvedScope = {
      scope: "project",
      projectRoot: projectDir,
      projectSlug: "demo-dx",
      projectDbPath: join(projectDir, ".vcf", "project.db"),
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
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client };
  }

  it("default excludes drop package-lock.json and dist/** from scoped diff", async () => {
    const { client } = await connect();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, diff_ref: "v0", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string };
    const diffPath = join(manifest.run_dir, "scoped-diff.patch");
    const diff = await readFile(diffPath, "utf8");
    expect(diff).toContain("src.ts");
    expect(diff).not.toContain("package-lock.json");
    expect(diff).not.toContain("bundle.js");
  });

  it("operator override via diff_exclude=[] keeps everything", async () => {
    const { client } = await connect([]);
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, diff_ref: "v0", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string };
    const diff = await readFile(join(manifest.run_dir, "scoped-diff.patch"), "utf8");
    expect(diff).toContain("src.ts");
    expect(diff).toContain("package-lock.json");
  });

  it("custom diff_exclude filters only the listed patterns", async () => {
    const { client } = await connect(["package-lock.json"]);
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, diff_ref: "v0", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string };
    const diff = await readFile(join(manifest.run_dir, "scoped-diff.patch"), "utf8");
    expect(diff).not.toContain("package-lock.json");
    // dist/** not in the custom list → still present
    expect(diff).toContain("bundle.js");
  });
});
