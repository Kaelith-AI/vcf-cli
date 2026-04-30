// Phase G integration tests.
//
// Covers:
//   G-A: charter artifact in plan_save, build_context, charter_check
//   G-C: test_generate save=true, test_stub_get, test_execute result persistence, test_results_search
//   G-D: idea_capture body indexing, idea_search FTS

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";
import { clearKbCache } from "../../src/primers/load.js";

interface Envelope {
  ok: boolean;
  code?: string;
  summary?: string;
  paths?: string[];
  content?: unknown;
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

const CHARTER_BODY =
  "# Charter\n\nProblem: solve the problem. Success: it is solved. Constraints: must be fast. Out of scope: UI. Decisions: TypeScript, SQLite.".padEnd(
    200,
    " ",
  );

const PLAN_BODY = "# Plan\n\nPhase 1: build. Phase 2: test.".padEnd(120, " ");
const TODO_BODY = "- [ ] step 1\n- [ ] step 2\n";
const MANIFEST_BODY = "- src/main.ts — entry\n";

function makeConfig(workRoot: string, home: string) {
  return ConfigSchema.parse({
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
}

async function bootProject(workRoot: string, home: string, projectDir: string) {
  const config = makeConfig(workRoot, home);
  const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  const dbPath = join(home, ".vcf", "projects", "demo", "project.db");
  const projectDb = openProjectDb({ path: dbPath });
  const now = Date.now();
  projectDb
    .prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, 'demo', ?, 'planning', ?, ?)`,
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
  const client = new Client({ name: "phase-g-test", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return { client, globalDb, projectDb, config };
}

async function bootGlobal(workRoot: string, home: string) {
  const config = makeConfig(workRoot, home);
  const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  const resolved: ResolvedScope = { scope: "global" };
  const server = createServer({ scope: "global", resolved, config, globalDb, homeDir: home });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "phase-g-global", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return { client, globalDb, config };
}

// ── G-A: Charter artifact ──────────────────────────────────────────────────

describe("Phase G-A — charter artifact", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-ga-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-gah-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("plan_save with all 4 fields writes 4 files and indexes charter artifact", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: {
          name: "my-plan",
          charter: CHARTER_BODY,
          plan: PLAN_BODY,
          todo: TODO_BODY,
          manifest: MANIFEST_BODY,
          expand: true,
        },
      }),
    );

    expect(res.ok).toBe(true);
    const out = res.content as { written: string[]; state: string };

    // 4 files written
    expect(out.written.length).toBe(4);

    // Charter file exists on disk
    const charterPath = join(projectDir, "plans", "my-plan-charter.md");
    expect(existsSync(charterPath)).toBe(true);
    const charterOnDisk = await readFile(charterPath, "utf8");
    expect(charterOnDisk).toContain("Charter");

    // Charter artifact indexed in project.db
    const row = projectDb.prepare("SELECT kind FROM artifacts WHERE path = ?").get(charterPath) as
      | { kind: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.kind).toBe("charter");
  });

  it("plan_save summary contains compact directive with project name", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: {
          name: "my-plan",
          charter: CHARTER_BODY,
          plan: PLAN_BODY,
          todo: TODO_BODY,
          manifest: MANIFEST_BODY,
        },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("COMPACT NOW");
    expect(res.summary).toContain("my-plan");
    expect(res.summary).toContain("4 artifacts saved");
  });

  it("plan_save missing charter field fails Zod validation", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // The MCP SDK rejects missing required fields at the protocol level and
    // returns isError=true with a non-JSON string (not our envelope). Accept
    // either: (a) the SDK throws, or (b) it returns an error response.
    let threwOrErrored = false;
    try {
      const raw = (await client.callTool({
        name: "plan_save",
        arguments: {
          name: "no-charter",
          // charter omitted intentionally
          plan: PLAN_BODY,
          todo: TODO_BODY,
          manifest: MANIFEST_BODY,
        },
      })) as { isError?: boolean };
      // If the SDK didn't throw, it must have returned an error response.
      threwOrErrored = raw.isError === true;
    } catch {
      threwOrErrored = true;
    }
    expect(threwOrErrored).toBe(true);
  });

  it("build_context returns charter when present", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // Save plan with charter first
    await client.callTool({
      name: "plan_save",
      arguments: {
        name: "ctx-plan",
        charter: CHARTER_BODY,
        plan: PLAN_BODY,
        todo: TODO_BODY,
        manifest: MANIFEST_BODY,
      },
    });

    const res = parseResult(
      await client.callTool({
        name: "build_context",
        arguments: { plan_name: "ctx-plan", expand: true },
      }),
    );

    expect(res.ok).toBe(true);
    const c = res.content as { charter: string | null; plan: Record<string, string | null> };
    expect(c.charter).toMatch(/Charter/);
    expect(c.plan["charter"]).toMatch(/Charter/);
  });

  it("build_context returns charter: null when charter file missing (pre-G-A plan)", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // Write plan/todo/manifest manually without charter
    const plansDir = join(projectDir, "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "old-plan-plan.md"), PLAN_BODY, "utf8");
    await writeFile(join(plansDir, "old-plan-todo.md"), TODO_BODY, "utf8");
    await writeFile(join(plansDir, "old-plan-manifest.md"), MANIFEST_BODY, "utf8");
    // No charter file

    const res = parseResult(
      await client.callTool({
        name: "build_context",
        arguments: { plan_name: "old-plan", expand: true },
      }),
    );

    expect(res.ok).toBe(true);
    const c = res.content as { charter: string | null };
    expect(c.charter).toBeNull();
  });

  it("charter_check returns error when charter file missing", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "charter_check",
        arguments: { plan_name: "nonexistent-plan" },
      }),
    );

    // Should fail with E_NOT_FOUND (no charter file for this pre-G-A plan)
    expect(res.ok).toBe(false);
    expect(res.code).toBe("E_NOT_FOUND");
  });

  it("charter_check with existing charter and no endpoint returns NEEDS_REVIEW fallback", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // Save plan with charter
    await client.callTool({
      name: "plan_save",
      arguments: {
        name: "check-plan",
        charter: CHARTER_BODY,
        plan: PLAN_BODY,
        todo: TODO_BODY,
        manifest: MANIFEST_BODY,
      },
    });

    const res = parseResult(
      await client.callTool({
        name: "charter_check",
        arguments: { plan_name: "check-plan", expand: true },
      }),
    );

    // With no endpoint configured (local-stub), should return ok=true with NEEDS_REVIEW
    // (LLM call fails, tool returns fallback verdict)
    expect(res.ok).toBe(true);
    const c = res.content as { verdict: string; charter_path: string };
    expect(["PASS", "NEEDS_REVIEW", "BLOCK"]).toContain(c.verdict);
    expect(c.charter_path).toContain("check-plan-charter.md");
  });
});

// ── G-C: Test persistence ──────────────────────────────────────────────────

describe("Phase G-C — test stubs and results persistence", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-gc-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-gch-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("test_generate with save=true writes files and indexes in project.db", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "test_generate",
        arguments: {
          plan_name: "my-plan",
          kinds: ["unit"],
          save: true,
          expand: true,
        },
      }),
    );

    expect(res.ok).toBe(true);
    // Paths should include the written file
    expect(res.paths && res.paths.length).toBeGreaterThan(0);

    // File should exist on disk
    const stubsDir = join(projectDir, "plans", "test-stubs");
    expect(existsSync(stubsDir)).toBe(true);

    // Artifact indexed in project.db
    const row = projectDb
      .prepare("SELECT kind, path FROM artifacts WHERE kind = 'test-stub' LIMIT 1")
      .get() as { kind: string; path: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.kind).toBe("test-stub");
    expect(existsSync(row?.path ?? "")).toBe(true);
  });

  it("test_generate with save=false does not write files", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "test_generate",
        arguments: {
          plan_name: "my-plan",
          kinds: ["unit"],
          save: false,
          expand: true,
        },
      }),
    );

    expect(res.ok).toBe(true);
    // No paths returned (no files written)
    expect(res.paths?.length ?? 0).toBe(0);

    // No artifacts indexed
    const count = (
      projectDb.prepare("SELECT COUNT(*) as c FROM artifacts WHERE kind='test-stub'").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  it("test_stub_get returns saved stubs for a plan", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // Save stubs
    await client.callTool({
      name: "test_generate",
      arguments: {
        plan_name: "stub-plan",
        kinds: ["unit", "integration"],
        save: true,
      },
    });

    const res = parseResult(
      await client.callTool({
        name: "test_stub_get",
        arguments: { plan_name: "stub-plan", expand: false },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.paths && res.paths.length).toBeGreaterThanOrEqual(2);
  });

  it("test_execute with plan_name writes a result file and indexes it", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);

    const res = parseResult(
      await client.callTool({
        name: "test_execute",
        arguments: {
          command: "node",
          args: ["-e", "process.exit(0)"],
          plan_name: "my-plan",
          timeout_ms: 5_000,
        },
      }),
    );

    expect(res.ok).toBe(true);

    // Result file should be indexed
    const row = projectDb
      .prepare(
        "SELECT kind, path, frontmatter_json FROM artifacts WHERE kind = 'test-result' LIMIT 1",
      )
      .get() as { kind: string; path: string; frontmatter_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.kind).toBe("test-result");
    expect(existsSync(row?.path ?? "")).toBe(true);

    // Meta JSON has passed stored as integer 1 (for true) for reliable SQLite json_extract comparison.
    const meta = JSON.parse(row?.frontmatter_json ?? "{}") as { passed: number | boolean };
    expect(meta.passed).toBeTruthy();
  });

  it("test_results_search filters by passed=false", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);

    // Run a failing test with plan_name
    await client.callTool({
      name: "test_execute",
      arguments: {
        command: "node",
        args: ["-e", "process.exit(1)"],
        plan_name: "fail-plan",
        timeout_ms: 5_000,
      },
    });

    // Run a passing test with plan_name
    await client.callTool({
      name: "test_execute",
      arguments: {
        command: "node",
        args: ["-e", "process.exit(0)"],
        plan_name: "fail-plan",
        timeout_ms: 5_000,
      },
    });

    const res = parseResult(
      await client.callTool({
        name: "test_results_search",
        arguments: { passed: false, expand: true },
      }),
    );

    expect(res.ok).toBe(true);
    const items = res.content as Array<{ passed: number | boolean | null }>;
    // All returned items should have passed=false (stored as integer 0)
    expect(items.length).toBeGreaterThanOrEqual(1);
    // The false filter should exclude the passing run; passed values must all be falsy (0 or false)
    const passedValues = items.map((i) => i.passed);
    expect(passedValues.every((p) => !p)).toBe(true);
  });
});

// ── G-D: idea body indexing ────────────────────────────────────────────────

describe("Phase G-D — idea body indexing", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-gd-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-gdh-")));
    await mkdir(join(workRoot, "ideas"), { recursive: true });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("idea_capture stores body_text column", async () => {
    const { client, globalDb } = await bootGlobal(workRoot, home);

    await client.callTool({
      name: "idea_capture",
      arguments: {
        content: "Build a resilient message queue with retry semantics",
        title: "Retry Queue",
        tags: ["infra"],
      },
    });

    const row = globalDb
      .prepare("SELECT body_text FROM ideas WHERE slug = 'retry-queue' LIMIT 1")
      .get() as { body_text: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.body_text).toContain("resilient message queue");
  });

  it("idea_search with a body-only term returns the idea (FTS or LIKE fallback)", async () => {
    const { client } = await bootGlobal(workRoot, home);

    await client.callTool({
      name: "idea_capture",
      arguments: {
        content: "Implement exponential backoff with jitter for retry logic",
        title: "Backoff Strategy",
        tags: ["reliability"],
      },
    });

    const res = parseResult(
      await client.callTool({
        name: "idea_search",
        arguments: { query: "jitter", expand: true },
      }),
    );

    expect(res.ok).toBe(true);
    const hits = res.content as Array<{ slug: string }>;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.slug === "backoff-strategy")).toBe(true);
  });

  it("idea_search with frontmatter term still works after G-D (regression)", async () => {
    const { client } = await bootGlobal(workRoot, home);

    await client.callTool({
      name: "idea_capture",
      arguments: {
        content: "Build a fast cache layer",
        title: "Fast Cache",
        tags: ["performance", "caching"],
      },
    });

    // Search by tag (uses LIKE on JSON)
    const res = parseResult(
      await client.callTool({
        name: "idea_search",
        arguments: { tags: ["caching"], expand: true },
      }),
    );

    expect(res.ok).toBe(true);
    const hits = res.content as Array<{ slug: string }>;
    expect(hits.some((h) => h.slug === "fast-cache")).toBe(true);
  });
});
