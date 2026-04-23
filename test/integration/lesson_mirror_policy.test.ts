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

// Followup #41 — lessons.mirror_policy gates writes and cross-scope reads.
//
// Modes (default: write-and-read preserves prior behavior):
//   write-only   — writes mirror out; scope=global|all refuses with E_SCOPE_DENIED
//   read-only    — writes stay local (envelope: 'policy-suppressed'); cross-scope reads allowed
//   off          — neither writes nor reads

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

describe("lessons.mirror_policy", () => {
  let home: string;
  let workRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-mp-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-mph-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    resetGlobalLessonsCache();
    clearKbCache();
  });

  afterEach(async () => {
    resetGlobalLessonsCache();
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect(mirrorPolicy: "write-and-read" | "write-only" | "read-only" | "off") {
    const lessonsDbPath = join(home, ".vcf", "lessons.db");
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
      lessons: { global_db_path: lessonsDbPath, mirror_policy: mirrorPolicy },
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({
      path: join(home, ".vcf", "projects", "demo", "project.db"),
    });
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
      projectDbPath: join(home, ".vcf", "projects", "demo", "project.db"),
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
    return { client, projectDb, lessonsDbPath };
  }

  it("write-only: logs write to mirror but cross-scope reads refuse", async () => {
    const { client, lessonsDbPath } = await connect("write-only");
    const wrote = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: { title: "wo-write", observation: "mirror write permitted" },
      }),
    );
    expect(wrote.ok).toBe(true);
    const c = wrote.content as { mirror_status: string };
    expect(c.mirror_status).toBe("ok");

    // Mirror has the row.
    const gdb = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      const count = (gdb.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
      expect(count).toBe(1);
    } finally {
      gdb.close();
    }

    // But the project refuses cross-scope reads.
    const res = (await client.callTool({
      name: "lesson_search",
      arguments: { scope: "global" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/E_SCOPE_DENIED|write-only/);
  });

  it("read-only: writes are policy-suppressed but cross-scope reads work", async () => {
    const { client, lessonsDbPath } = await connect("read-only");
    const wrote = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: { title: "ro-write", observation: "mirror write suppressed" },
      }),
    );
    expect(wrote.ok).toBe(true);
    const c = wrote.content as { mirror_status: string };
    expect(c.mirror_status).toBe("policy-suppressed");

    // Mirror has zero rows (write suppressed).
    const gdb = openGlobalLessonsDb({ path: lessonsDbPath });
    try {
      const count = (gdb.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      gdb.close();
    }

    // Cross-scope reads work (return empty but don't refuse).
    const search = parseResult(
      await client.callTool({
        name: "lesson_search",
        arguments: { scope: "all" },
      }),
    );
    expect(search.ok).toBe(true);
  });

  it("off: neither writes nor reads", async () => {
    const { client } = await connect("off");
    const wrote = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: { title: "off-write", observation: "everything suppressed" },
      }),
    );
    expect(wrote.ok).toBe(true);
    // Either 'disabled-by-config' (if global_db_path is treated as null)
    // or 'policy-suppressed'. Both mean the same thing here.
    const c = wrote.content as { mirror_status: string };
    expect(["disabled-by-config", "policy-suppressed"]).toContain(c.mirror_status);

    const res = (await client.callTool({
      name: "lesson_search",
      arguments: { scope: "all" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("write-and-read (default) preserves prior behavior", async () => {
    const { client } = await connect("write-and-read");
    const wrote = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: { title: "wr-write", observation: "normal mirror" },
      }),
    );
    const c = wrote.content as { mirror_status: string };
    expect(c.mirror_status).toBe("ok");

    const search = parseResult(
      await client.callTool({
        name: "lesson_search",
        arguments: { scope: "all" },
      }),
    );
    expect(search.ok).toBe(true);
  });
});
