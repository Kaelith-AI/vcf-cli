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
import { runMigrations } from "../../src/db/migrate.js";
import { PROJECT_MIGRATIONS } from "../../src/db/schema.js";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedScope } from "../../src/scope.js";

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

describe("lesson_log_add / lesson_search (global-only, #41)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;
  let lessonsDbPath: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-lesson-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-lessonh-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    lessonsDbPath = join(home, ".vcf", "lessons.db");
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await mkdir(join(kbRoot, "best-practices"), { recursive: true });
    await mkdir(join(kbRoot, "standards"), { recursive: true });
    resetGlobalLessonsCache();
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    resetGlobalLessonsCache();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function makeConfig(overrides: { global_db_path?: string | null } = {}) {
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
      kb: { root: kbRoot },
      lessons: {
        global_db_path:
          overrides.global_db_path === undefined ? lessonsDbPath : overrides.global_db_path,
      },
    });
  }

  async function bootProjectScope(configOverrides: { global_db_path?: string | null } = {}) {
    {
      const config = makeConfig(configOverrides);
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      const server = createServer({
        scope: "global",
        resolved: { scope: "global" },
        config,
        globalDb,
        homeDir: home,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await client.connect(b);
      const init = await client.callTool({
        name: "project_init",
        arguments: { name: "Demo", target_dir: projectDir },
      });
      expect(parseResult(init).ok).toBe(true);
      globalDb.close();
    }

    const config = makeConfig(configOverrides);
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
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb, projectDb };
  }

  it("writes 10 lessons and returns them by tag + substring", async () => {
    const { client } = await bootProjectScope();
    for (let i = 0; i < 10; i++) {
      const res = await client.callTool({
        name: "lesson_log_add",
        arguments: {
          title: `lesson ${i}`,
          observation: `the answer to item ${i} is ${i * 7}`,
          tags: i % 2 === 0 ? ["even", "arithmetic"] : ["odd", "arithmetic"],
        },
      });
      expect(parseResult(res).ok).toBe(true);
    }

    const byTag = await client.callTool({
      name: "lesson_search",
      arguments: { tags: ["arithmetic", "even"], filter: "current", expand: true },
    });
    const byTagEnv = parseResult(byTag);
    expect(byTagEnv.ok).toBe(true);
    const tagContent = byTagEnv.content as { matches: Array<{ title: string }> };
    expect(tagContent.matches.length).toBe(5);

    const bySubstr = await client.callTool({
      name: "lesson_search",
      arguments: { query: "item 7", filter: "current", expand: true },
    });
    const ssEnv = parseResult(bySubstr);
    expect(ssEnv.ok).toBe(true);
    const ssContent = ssEnv.content as { matches: Array<{ title: string }> };
    expect(ssContent.matches.length).toBe(1);
    expect(ssContent.matches[0]?.title).toBe("lesson 7");
  });

  it("redacts an sk- canary to [REDACTED:openai-key] before persisting", async () => {
    const { client } = await bootProjectScope();
    const canary = "sk-proj-abc12345XYZdef67890HIJKLMNopqrstuv";
    const res = await client.callTool({
      name: "lesson_log_add",
      arguments: {
        title: "redaction canary",
        observation: `the key ${canary} should be redacted on persist`,
        tags: ["canary"],
      },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as { lesson_id: number; redaction_applied: boolean };
    expect(content.redaction_applied).toBe(true);

    const globalDb = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      const row = globalDb
        .prepare("SELECT observation FROM lessons WHERE id = ?")
        .get(content.lesson_id) as { observation: string };
      expect(row.observation).toContain("[REDACTED:openai-key]");
      expect(row.observation).not.toContain(canary);
    } finally {
      globalDb.close();
    }
  });

  it("rejects an unknown input key at the SDK validation layer", async () => {
    const { client } = await bootProjectScope();
    const res = (await client.callTool({
      name: "lesson_log_add",
      arguments: {
        title: "bogus",
        observation: "body",
        __bogus: 1,
      } as unknown as Record<string, unknown>,
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/unrecognized_keys/i);
    expect(text).toMatch(/__bogus/);
  });

  it("fails with E_SCOPE_DENIED when config.lessons.global_db_path is null", async () => {
    const { client } = await bootProjectScope({ global_db_path: null });
    const res = await client.callTool({
      name: "lesson_log_add",
      arguments: { title: "disabled-write", observation: "store off", tags: ["m41"] },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_SCOPE_DENIED");
  });

  it("filter=current only returns this project's lessons", async () => {
    const { client } = await bootProjectScope();
    await client.callTool({
      name: "lesson_log_add",
      arguments: { title: "mine", observation: "this project", tags: ["t"] },
    });
    const globalDb = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      globalDb
        .prepare(
          `INSERT INTO lessons (project_root, title, observation, scope, tags_json, created_at)
           VALUES (?, ?, ?, 'project', '[]', ?)`,
        )
        .run("/other/project", "not mine", "from elsewhere", Date.now());
    } finally {
      globalDb.close();
    }

    const current = await client.callTool({
      name: "lesson_search",
      arguments: { filter: "current", query: "mine" },
    });
    const currentEnv = parseResult(current);
    expect(currentEnv.ok).toBe(true);
    const currentContent = currentEnv.content as { matches: Array<{ title: string }> };
    expect(currentContent.matches.map((m) => m.title)).toEqual(["mine"]);

    const all = await client.callTool({
      name: "lesson_search",
      arguments: { filter: "all" },
    });
    const allContent = parseResult(all).content as { matches: Array<{ title: string }> };
    expect(allContent.matches.length).toBeGreaterThanOrEqual(2);
    expect(allContent.matches.some((m) => m.title === "not mine")).toBe(true);
  });

  it("project-DB migration v8 removes the lessons + feedback tables", async () => {
    const dbPath = join(workRoot, ".vcf", "idem.db");
    await mkdir(join(workRoot, ".vcf"), { recursive: true });
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, PROJECT_MIGRATIONS);
    const v8 = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=8").get() as {
      n: number;
    };
    expect(v8.n).toBe(1);
    const lessonsT = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lessons'")
      .get() as { name?: string } | undefined;
    expect(lessonsT?.name).toBeUndefined();
    const feedbackT = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'")
      .get() as { name?: string } | undefined;
    expect(feedbackT?.name).toBeUndefined();
    db.close();

    const db2 = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db2.exec("PRAGMA journal_mode = WAL");
    db2.exec("PRAGMA foreign_keys = ON");
    runMigrations(db2, PROJECT_MIGRATIONS);
    const v8b = db2
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=8")
      .get() as { n: number };
    expect(v8b.n).toBe(1);
    db2.close();
  });
});
