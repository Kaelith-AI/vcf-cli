// project_init_existing — adopts a pre-existing project directory into VCF
// tracking without scaffolding docs. Followup #20, bypass mode.

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
import { getProjectByRoot } from "../../src/util/projectRegistry.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  code?: string;
  content?: unknown;
  paths?: string[];
  summary?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("project_init_existing (bypass mode)", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-adopt-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-adopth-")));
    await mkdir(join(home, ".vcf"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function baseConfig() {
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

  async function connectGlobal(globalDb: ReturnType<typeof openGlobalDb>) {
    const config = baseConfig();
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return client;
  }

  it("adopts an existing directory: creates project.db, adopted=1, registered in global", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "legacy-app");
    await mkdir(target, { recursive: true });

    const env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: target, name: "Legacy App", expand: true },
      }),
    );
    expect(env.ok).toBe(true);

    const dbPath = join(target, ".vcf", "project.db");
    expect(existsSync(dbPath)).toBe(true);

    const pdb = openProjectDb({ path: dbPath });
    const row = pdb
      .prepare("SELECT name, root_path, state, adopted FROM project WHERE id = 1")
      .get() as { name: string; root_path: string; state: string; adopted: number };
    expect(row.name).toBe("Legacy App");
    expect(row.root_path).toBe(target);
    expect(row.state).toBe("reviewing");
    expect(row.adopted).toBe(1);

    const registered = getProjectByRoot(globalDb, target);
    expect(registered).not.toBeNull();
    expect(registered?.name).toBe("legacy-app");
    expect(registered?.state_cache).toBe("reviewing");
  });

  it("defaults name to the directory basename when --name omitted", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "myproj");
    await mkdir(target, { recursive: true });

    const env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: target, expand: true },
      }),
    );
    expect(env.ok).toBe(true);

    const pdb = openProjectDb({ path: join(target, ".vcf", "project.db") });
    const row = pdb.prepare("SELECT name FROM project WHERE id = 1").get() as { name: string };
    expect(row.name).toBe("myproj");
  });

  it("is idempotent: re-adopting preserves existing state + name", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "existing");
    await mkdir(target, { recursive: true });

    // First adoption with state=reviewing.
    let env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: target, name: "Existing", state: "reviewing" },
      }),
    );
    expect(env.ok).toBe(true);

    // Caller's subsequent state change (e.g. via another tool — simulated direct DB write).
    const pdb = openProjectDb({ path: join(target, ".vcf", "project.db") });
    pdb.prepare("UPDATE project SET state = 'shipped' WHERE id = 1").run();
    pdb.close();

    // Re-adopt with a different --state; should NOT clobber 'shipped'.
    env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: target, name: "Existing", state: "draft" },
      }),
    );
    expect(env.ok).toBe(true);

    const pdb2 = openProjectDb({ path: join(target, ".vcf", "project.db") });
    const row = pdb2.prepare("SELECT state, adopted FROM project WHERE id = 1").get() as {
      state: string;
      adopted: number;
    };
    expect(row.state).toBe("shipped");
    expect(row.adopted).toBe(1);
  });

  it("rejects a path outside workspace.allowed_roots", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);

    const env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: "/tmp/not-in-workspace", expand: true },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_SCOPE_DENIED");
  });

  it("rejects a nonexistent path", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const ghost = join(workRoot, "does-not-exist");

    const env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: ghost, expand: true },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_NOT_FOUND");
  });

  it("honors the state arg on fresh adoption (e.g. 'draft' instead of default 'reviewing')", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "draftish");
    await mkdir(target, { recursive: true });

    const env = parseResult(
      await client.callTool({
        name: "project_init_existing",
        arguments: { project_path: target, state: "draft", expand: true },
      }),
    );
    expect(env.ok).toBe(true);

    const pdb = openProjectDb({ path: join(target, ".vcf", "project.db") });
    const row = pdb.prepare("SELECT state FROM project WHERE id = 1").get() as { state: string };
    expect(row.state).toBe("draft");
  });
});
