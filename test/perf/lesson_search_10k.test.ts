import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../../src/db/migrate.js";
import { GLOBAL_MIGRATIONS, PROJECT_MIGRATIONS } from "../../src/db/schema.js";
import { GLOBAL_LESSONS_MIGRATIONS } from "../../src/db/globalLessons.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { createServer } from "../../src/server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Followup #40 — perf fixture for lesson_search SQL pushdown at scale.
// Global-only store (followup #41): 10_000 rows in ~/.vcf/lessons.db,
// half tagged with this project, half with a mix of other projects.
//
// Gate: p95 < 100ms across 50 calls for three shapes:
//   1. filter=current, free-text query → LIKE on title/observation
//   2. filter=all, tag filter → tags_json LIKE
//   3. filter=all, combined query + tag + stage → every predicate

const SCALE = 10_000;
const TRIALS = 50;
const P95_MS = 100;

async function ingestLessons(
  db: DatabaseSync,
  thisProjectRoot: string,
  count: number,
): Promise<void> {
  const stageCycle = ["planning", "building", "testing", "reviewing", "shipping"] as const;
  const tagPool = [
    "database",
    "migrations",
    "review",
    "ollama",
    "performance",
    "auth",
    "cache",
    "redaction",
    "ci",
    "release",
  ];
  db.exec("BEGIN");
  const stmt = db.prepare(
    `INSERT INTO lessons (project_root, title, context, observation, actionable_takeaway,
                          scope, stage, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const base = Date.now() - count;
  for (let i = 0; i < count; i++) {
    const stage = stageCycle[i % stageCycle.length];
    const tags = [tagPool[i % tagPool.length], tagPool[(i + 3) % tagPool.length]];
    const title = `lesson ${i} about ${tagPool[i % tagPool.length]} behavior`;
    const context = `context for lesson ${i}`;
    const observation = `Observation ${i}: we saw that ${tagPool[i % tagPool.length]} caused an edge case in stage ${stage}.`;
    const takeaway = `Take away: review ${tagPool[(i + 3) % tagPool.length]} config before shipping.`;
    const tagsJson = JSON.stringify(tags);
    const createdAt = base + i;
    // Split rows: half tagged with this project, half with other projects.
    const projectRoot = i % 2 === 0 ? thisProjectRoot : `/tmp/proj-${i % 5}`;
    stmt.run(
      projectRoot,
      title,
      context,
      observation,
      takeaway,
      "project",
      stage,
      tagsJson,
      createdAt,
    );
  }
  db.exec("COMMIT");
}

describe("lesson_search perf @ 10k global rows (#41)", () => {
  let home: string;
  let projectDir: string;
  let projectDb: DatabaseSync;
  let globalDb: DatabaseSync;
  let globalLessonsDb: DatabaseSync;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-lsperfh-")));
    projectDir = await realpath(await mkdtemp(join(tmpdir(), "vcf-lsperf-")));
    await mkdir(join(home, ".vcf", "projects", "demo"), { recursive: true });

    globalDb = new DatabaseSync(join(home, ".vcf", "vcf.db"), {
      enableForeignKeyConstraints: true,
    });
    globalDb.exec("PRAGMA journal_mode = WAL");
    globalDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(globalDb, GLOBAL_MIGRATIONS);
    globalDb
      .prepare(
        `INSERT INTO projects (name, root_path, state_cache, depends_on_json, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("demo", projectDir, "reviewing", "[]", Date.now(), Date.now());

    projectDb = new DatabaseSync(join(home, ".vcf", "projects", "demo", "project.db"), {
      enableForeignKeyConstraints: true,
    });
    projectDb.exec("PRAGMA journal_mode = WAL");
    projectDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(projectDb, PROJECT_MIGRATIONS);
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at, spec_path, adopted)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("demo", projectDir, "reviewing", Date.now(), Date.now(), null, 0);

    globalLessonsDb = new DatabaseSync(join(home, ".vcf", "lessons.db"), {
      enableForeignKeyConstraints: true,
    });
    globalLessonsDb.exec("PRAGMA journal_mode = WAL");
    globalLessonsDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(globalLessonsDb, GLOBAL_LESSONS_MIGRATIONS);
    await ingestLessons(globalLessonsDb, projectDir, SCALE);
    globalLessonsDb.close();

    const config = ConfigSchema.parse({
      version: 1,
      workspace: {
        allowed_roots: [projectDir],
        ideas_dir: join(projectDir, "ideas"),
        specs_dir: join(projectDir, "specs"),
      },
      endpoints: [
        {
          name: "local-ollama",
          provider: "openai-compatible",
          base_url: "http://127.0.0.1:11434/v1",
          trust_level: "local",
        },
      ],
      kb: { root: join(home, ".vcf", "kb") },
      lessons: { global_db_path: join(home, ".vcf", "lessons.db") },
    });

    server = createServer({
      scope: "project",
      resolved: {
        scope: "project",
        projectRoot: projectDir,
        projectSlug: "demo",
        projectDbPath: join(home, ".vcf", "projects", "demo", "project.db"),
        projectRole: "standard",
      },
      config,
      globalDb,
      projectDb,
      homeDir: home,
    });

    client = new Client({ name: "lesson-perf-test", version: "0.0.0" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
  }, 60_000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      /* noop */
    }
    try {
      await server.close();
    } catch {
      /* noop */
    }
    try {
      projectDb.close();
    } catch {
      /* noop */
    }
    try {
      globalDb.close();
    } catch {
      /* noop */
    }
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(projectDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function callLessonSearch(args: Record<string, unknown>): Promise<void> {
    await client.callTool({ name: "lesson_search", arguments: args });
  }

  function p95(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  async function measure(args: Record<string, unknown>): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) await callLessonSearch(args);
    for (let i = 0; i < TRIALS; i++) {
      const t0 = performance.now();
      await callLessonSearch(args);
      samples.push(performance.now() - t0);
    }
    return p95(samples);
  }

  it(`filter=current, query, limit=20: p95 < ${P95_MS}ms`, async () => {
    const val = await measure({ filter: "current", query: "ollama", limit: 20 });
    expect(val).toBeLessThan(P95_MS);
  }, 60_000);

  it(`filter=all, tag filter, limit=20: p95 < ${P95_MS}ms`, async () => {
    const val = await measure({ filter: "all", tags: ["ollama"], limit: 20 });
    expect(val).toBeLessThan(P95_MS);
  }, 60_000);

  it(`filter=all, query + tag + stage, limit=20: p95 < ${P95_MS}ms`, async () => {
    const val = await measure({
      filter: "all",
      query: "shipping",
      tags: ["performance"],
      stage: "shipping",
      limit: 20,
    });
    expect(val).toBeLessThan(P95_MS);
  }, 60_000);
});
