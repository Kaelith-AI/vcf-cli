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

describe("feedback_add + feedback_list (followup #18)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;
  let projectDb: ReturnType<typeof openProjectDb>;
  let client: Client;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-fb-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-fbh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    clearKbCache();

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
    projectDb = openProjectDb({ path: dbPath });
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
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("feedback_add writes a row and returns the id", async () => {
    const res = await client.callTool({
      name: "feedback_add",
      arguments: { note: "the plan template is confusing" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const { feedback_id } = env.content as { feedback_id: number };
    expect(feedback_id).toBeGreaterThan(0);
    const row = projectDb
      .prepare("SELECT note FROM feedback WHERE id = ?")
      .get(feedback_id) as { note: string };
    expect(row.note).toBe("the plan template is confusing");
  });

  it("feedback_add honors stage + urgency enums", async () => {
    const res = await client.callTool({
      name: "feedback_add",
      arguments: { note: "review step too slow", stage: "reviewing", urgency: "high" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const row = projectDb
      .prepare("SELECT stage, urgency FROM feedback WHERE id = ?")
      .get((env.content as { feedback_id: number }).feedback_id) as {
      stage: string;
      urgency: string;
    };
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
    const row = projectDb
      .prepare("SELECT note FROM feedback WHERE id = ?")
      .get(feedback_id) as { note: string };
    expect(row.note).not.toContain(canary);
    expect(row.note).toContain("[REDACTED:openai-key]");
  });

  it("feedback_list returns rows newest-first; filters by stage/urgency", async () => {
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
    // Newest-first.
    expect(entries[0].note).toBe("three");
    expect(entries[1].note).toBe("two");
    for (const e of entries) expect(e.urgency).toBe("high");
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
});
