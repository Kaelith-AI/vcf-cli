import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import { resetGlobalLessonsCache } from "../../src/db/globalLessons.js";
import type { ResolvedScope } from "../../src/scope.js";

// Regression for the 0.5.0 release-gate finding: README + CHANGELOG claimed
// `config.lessons.global_db_path: null` disabled the cross-project lesson
// mirror, but the code never honored that claim. Mirror writes still went to
// the default path; cross-project reads still succeeded. These tests cover
// the full behavioral contract: writes skip the mirror, reads reject global/
// all scopes with E_SCOPE_DENIED, the project DB remains authoritative.

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

describe("lesson mirror disabled via global_db_path: null", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-mirroff-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-mirroff-home-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(home, ".vcf"), { recursive: true });
    resetGlobalLessonsCache();
    clearKbCache();
  });

  afterEach(async () => {
    resetGlobalLessonsCache();
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect(globalDbPath: string | null | undefined) {
    const lessons: Record<string, unknown> = {};
    if (globalDbPath === null) lessons["global_db_path"] = null;
    else if (globalDbPath !== undefined) lessons["global_db_path"] = globalDbPath;
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
      lessons,
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'Demo', ?, 'building', ?, ?)`,
      )
      .run(projectDir, now, now);
    const resolved: ResolvedScope = {
      scope: "project",
      vcfDir: join(projectDir, ".vcf"),
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({ scope: "project", resolved, config, globalDb, projectDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client };
  }

  it("lesson_log_add writes only to project DB; envelope surfaces disabled state", async () => {
    const { client } = await connect(null);
    const env = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: {
          title: "no-mirror write",
          observation: "This lesson must never land in ~/.vcf/lessons.db.",
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const content = env.content as {
      lesson_id: number;
      global_lesson_id: number | null;
      mirror_status: string;
    };
    expect(content.lesson_id).toBeGreaterThan(0);
    expect(content.global_lesson_id).toBeNull();
    expect(content.mirror_status).toBe("disabled-by-config");
    expect(env.summary ?? "").toContain("mirror-disabled-by-config");
    // Explicit filesystem assertion: the default mirror path must not exist.
    expect(existsSync(join(home, ".vcf", "lessons.db"))).toBe(false);
  });

  it("lesson_search(scope=global) rejects with E_SCOPE_DENIED when mirror is disabled", async () => {
    const { client } = await connect(null);
    // Seed a project-scope lesson so we know the project surface still works.
    await client.callTool({
      name: "lesson_log_add",
      arguments: { title: "local only", observation: "only project scope" },
    });
    const denied = parseResult(
      await client.callTool({
        name: "lesson_search",
        arguments: { query: "only", scope: "global" },
      }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("E_SCOPE_DENIED");
    const deniedAll = parseResult(
      await client.callTool({
        name: "lesson_search",
        arguments: { query: "only", scope: "all" },
      }),
    );
    expect(deniedAll.ok).toBe(false);
    expect(deniedAll.code).toBe("E_SCOPE_DENIED");
    // Project scope must still work unaffected.
    const projectHit = parseResult(
      await client.callTool({
        name: "lesson_search",
        arguments: { query: "only", scope: "project", expand: true },
      }),
    );
    expect(projectHit.ok).toBe(true);
    const matches = (projectHit.content as { matches: Array<{ title: string }> }).matches;
    expect(matches.length).toBe(1);
    expect(matches[0]?.title).toBe("local only");
  });

  it("default config (no global_db_path) still mirrors — regression guard", async () => {
    const customMirror = join(home, ".vcf", "custom-lessons.db");
    const { client } = await connect(customMirror);
    const env = parseResult(
      await client.callTool({
        name: "lesson_log_add",
        arguments: { title: "mirrored", observation: "should land in custom mirror", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const content = env.content as {
      global_lesson_id: number | null;
      mirror_status: string;
    };
    expect(content.mirror_status).toBe("ok");
    expect(content.global_lesson_id).not.toBeNull();
    expect(existsSync(customMirror)).toBe(true);
  });
});
