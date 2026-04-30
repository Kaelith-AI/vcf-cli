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

// Regression for the prompt-pollution fix: review_prepare's two snapshot
// files must be scoped to the current review type. A code reviewer should
// not read security-scoped decisions or production-scoped response-log
// entries as context — that's cross-type noise. Universal decisions
// (review_type IS NULL) remain visible everywhere.

interface Envelope {
  ok: boolean;
  paths?: string[];
  summary?: string;
  content?: unknown;
  code?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("review_prepare snapshot scoping (decisions + response log)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-snapscope-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-snapscope-home-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "security"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    for (const type of ["code", "security"] as const) {
      await writeFile(
        join(kbRoot, "review-system", type, `01-${type}-stage1.md`),
        `---\ntype: review-stage\nreview_type: ${type}\nstage: 1\nstage_name: s1\nversion: 0.1\nupdated: 2026-04-22\n---\n# ${type} Stage 1\n`,
      );
      await writeFile(
        join(kbRoot, "reviewers", `reviewer-${type}.md`),
        `---\ntype: reviewer-config\nreviewer_type: ${type}\nversion: 0.1\nupdated: 2026-04-22\n---\n# ${type} Reviewer Config\n`,
      );
    }
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect() {
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
      review: { categories: ["code", "security", "production"] },
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'Demo', ?, 'reviewing', ?, ?)`,
      )
      .run(projectDir, now, now);
    const resolved: ResolvedScope = {
      scope: "project",
      projectRoot: projectDir,
      projectSlug: "test-project",
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
    return { client, projectDb };
  }

  it("decisions.snapshot.md includes universal + same-type only", async () => {
    const { client, projectDb } = await connect();

    // Seed three decisions directly: one code-scoped, one security-scoped,
    // one universal. The decision_log_add path is covered by its own test
    // suite — here we're exercising the snapshot filter.
    const now = Date.now();
    projectDb
      .prepare("INSERT INTO decisions (slug, created_at, path, review_type) VALUES (?, ?, ?, ?)")
      .run("use-zod-v4", now - 3000, "plans/decisions/universal.md", null);
    projectDb
      .prepare("INSERT INTO decisions (slug, created_at, path, review_type) VALUES (?, ?, ?, ?)")
      .run("wrap-sqlite-writes", now - 2000, "plans/decisions/code.md", "code");
    projectDb
      .prepare("INSERT INTO decisions (slug, created_at, path, review_type) VALUES (?, ?, ?, ?)")
      .run("redaction-two-point-rule", now - 1000, "plans/decisions/security.md", "security");

    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string; decisions_snapshot: string };
    const snap = await readFile(manifest.decisions_snapshot, "utf8");
    expect(snap).toContain("use-zod-v4");
    expect(snap).toContain("wrap-sqlite-writes");
    expect(snap).not.toContain("redaction-two-point-rule");
    // Header must name the scope so the reviewer knows what they're reading.
    expect(snap).toMatch(/scope=code\+universal/);
  });

  it("response-log.snapshot.md contains only same-type entries", async () => {
    const { client, projectDb } = await connect();
    const now = Date.now();

    // Seed two review_runs rows (one code, one security) and one response
    // against each, then verify the code snapshot contains only the code
    // response.
    projectDb
      .prepare(
        `INSERT INTO review_runs
           (id, type, stage, status, started_at, finished_at, report_path, verdict, carry_forward_json)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, '{}')`,
      )
      .run("code-4-seed", "code", 4, now - 5000, now - 4000, null, "NEEDS_WORK");
    projectDb
      .prepare(
        `INSERT INTO review_runs
           (id, type, stage, status, started_at, finished_at, report_path, verdict, carry_forward_json)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, '{}')`,
      )
      .run("security-2-seed", "security", 2, now - 3500, now - 3000, null, "NEEDS_WORK");

    projectDb
      .prepare(
        `INSERT INTO response_log
           (run_id, finding_ref, builder_claim, response_text, references_json, created_at)
         VALUES (?, ?, ?, ?, '[]', ?)`,
      )
      .run(
        "code-4-seed",
        "code:stage-4:find-1",
        "agree",
        "fixed the POSIX-only split.",
        now - 2500,
      );
    projectDb
      .prepare(
        `INSERT INTO response_log
           (run_id, finding_ref, builder_claim, response_text, references_json, created_at)
         VALUES (?, ?, ?, ?, '[]', ?)`,
      )
      .run(
        "security-2-seed",
        "security:stage-2:find-3",
        "disagree",
        "Redaction marker flagged as secret — hallucination.",
        now - 1500,
      );

    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string; response_log_snapshot: string };
    const snap = await readFile(manifest.response_log_snapshot, "utf8");
    expect(snap).toContain("fixed the POSIX-only split");
    expect(snap).not.toContain("Redaction marker flagged as secret");
    expect(snap).toMatch(/type=code/);
    expect(snap).toContain("run_id: code-4-seed");
    expect(snap).not.toContain("run_id: security-2-seed");
  });

  it("scoped-diff excludes plans/reviews and lifecycle-report by default", async () => {
    const { client } = await connect();
    // Init a git repo with a real code change and a review-output change.
    const git = (args: string[]) => spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@e"]);
    git(["config", "user.name", "t"]);
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(join(projectDir, "plans", "reviews", "code"), { recursive: true });
    await writeFile(join(projectDir, "src", "a.ts"), "export const v = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(join(projectDir, "src", "a.ts"), "export const v = 2;\n// real change\n");
    await writeFile(
      join(projectDir, "plans", "reviews", "code", "stage-9-prior.md"),
      "PRIOR GATE REPORT " + "X".repeat(4000),
    );
    git(["add", "."]);
    git(["commit", "-q", "-m", "feat + prior-report"]);

    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, diff_ref: "HEAD~1..HEAD", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { diff_file: string };
    expect(manifest.diff_file).toBeTruthy();
    const diff = await readFile(manifest.diff_file, "utf8");
    expect(diff).toContain("src/a.ts");
    expect(diff).toContain("real change");
    expect(diff).not.toContain("PRIOR GATE REPORT");
  });
});
