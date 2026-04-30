import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import { resetGlobalLessonsCache, openGlobalLessonsDb } from "../../src/db/globalLessons.js";
import type { ResolvedScope } from "../../src/scope.js";

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

describe("feedback_add + feedback_list (global-only, #41)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;
  let lessonsDbPath: string;
  let client: Client;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-fb-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-fbh-")));
    projectDir = join(workRoot, "demo");
    lessonsDbPath = join(home, ".vcf", "lessons.db");
    await mkdir(projectDir, { recursive: true });
    clearKbCache();
    resetGlobalLessonsCache();

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
      lessons: { global_db_path: lessonsDbPath },
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
    client = new Client({ name: "fb", version: "0" }, { capabilities: {} });
    await client.connect(b);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      /* noop */
    }
    closeTrackedDbs();
    resetGlobalLessonsCache();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function readGlobalFeedback(id: number): {
    note: string;
    stage: string | null;
    urgency: string | null;
    project_root: string;
  } {
    const db = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      const row = db
        .prepare("SELECT note, stage, urgency, project_root FROM feedback WHERE id = ?")
        .get(id) as {
        note: string;
        stage: string | null;
        urgency: string | null;
        project_root: string;
      };
      return row;
    } finally {
      db.close();
    }
  }

  it("feedback_add writes a row to the global store tagged with project_root", async () => {
    const res = await client.callTool({
      name: "feedback_add",
      arguments: { note: "the plan template is confusing" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { feedback_id } = env.content as { feedback_id: number };
    expect(feedback_id).toBeGreaterThan(0);
    const row = readGlobalFeedback(feedback_id);
    expect(row.note).toBe("the plan template is confusing");
    expect(row.project_root).toBe(projectDir);
  });

  it("feedback_add honors stage + urgency enums", async () => {
    const res = await client.callTool({
      name: "feedback_add",
      arguments: { note: "review step too slow", stage: "reviewing", urgency: "high" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { feedback_id } = env.content as { feedback_id: number };
    const row = readGlobalFeedback(feedback_id);
    expect(row.stage).toBe("reviewing");
    expect(row.urgency).toBe("high");
  });

  it("feedback_add redacts secrets before persist", async () => {
    const canary = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    const res = await client.callTool({
      name: "feedback_add",
      arguments: { note: `seeing this leak: ${canary}` },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { feedback_id, redaction_applied } = env.content as {
      feedback_id: number;
      redaction_applied: boolean;
    };
    expect(redaction_applied).toBe(true);
    const row = readGlobalFeedback(feedback_id);
    expect(row.note).not.toContain(canary);
    expect(row.note).toContain("[REDACTED:openai-key]");
  });

  it("feedback_list returns rows newest-first scoped to this project; filters by stage/urgency", async () => {
    for (const [note, stage, urgency] of [
      ["one", "planning", "low"],
      ["two", "building", "high"],
      ["three", "reviewing", "high"],
    ] as const) {
      await client.callTool({
        name: "feedback_add",
        arguments: { note, stage, urgency },
      });
    }
    const res = await client.callTool({
      name: "feedback_list",
      arguments: { urgency: "high", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { entries } = env.content as {
      entries: Array<{ note: string; urgency: string; stage: string }>;
    };
    expect(entries).toHaveLength(2);
    expect(entries[0].note).toBe("three");
    expect(entries[1].note).toBe("two");
    for (const e of entries) expect(e.urgency).toBe("high");
  });

  it("feedback_list filter=all returns cross-project feedback", async () => {
    await client.callTool({
      name: "feedback_add",
      arguments: { note: "mine" },
    });
    // Inject a foreign-project row directly into the global store.
    const db = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      db.prepare(`INSERT INTO feedback (project_root, note, created_at) VALUES (?, ?, ?)`).run(
        "/other/project",
        "not mine",
        Date.now(),
      );
    } finally {
      db.close();
    }
    const res = await client.callTool({
      name: "feedback_list",
      arguments: { filter: "all", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { entries } = env.content as {
      entries: Array<{ note: string; project_root: string }>;
    };
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e) => e.note === "not mine")).toBe(true);
  });

  it("feedback_add rejects unknown keys with E_VALIDATION via the SDK", async () => {
    const res = (await client.callTool({
      name: "feedback_add",
      arguments: { note: "test", __bogus: 1 } as unknown as Record<string, unknown>,
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/unrecognized_keys/i);
    expect(text).toMatch(/__bogus/);
  });

  it("fails with E_SCOPE_DENIED when global_db_path is null", async () => {
    // Separate client with a null-path config.
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
      lessons: { global_db_path: null },
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const dbPath = join(home, ".vcf", "projects", "demo", "project.db");
    const projectDb = openProjectDb({ path: dbPath });
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
    const c = new Client({ name: "fb2", version: "0" }, { capabilities: {} });
    await c.connect(b);
    const res = await c.callTool({
      name: "feedback_add",
      arguments: { note: "disabled" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_SCOPE_DENIED");
    await c.close();
  });
});
