// Positive-path coverage for ship_release → project.state = 'shipped'
// (followup #25 / flagged by the 2026-04-21 dogfood review at code/stage-3,
// code/stage-4, production/stage-5, production/stage-8).
//
// vi.mock on `node:child_process` doesn't cross file boundaries when
// vitest runs with `isolate: false` (see vitest.config.ts). Instead we use
// the test-only spawn override exposed by ship_release.ts. Production
// always runs with the real spawn; only this test flips it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import {
  __resetShipReleaseStoreForTests,
  __setShipReleaseSpawnImpl,
  __resetShipReleaseSpawnImpl,
} from "../../src/tools/ship_release.js";
import { upsertProject, getProjectByRoot } from "../../src/util/projectRegistry.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  paths?: string[];
  summary?: string;
  content?: unknown;
  code?: string;
  message?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

function makeExit0Spawn(): ChildProcess {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = () => true;
  setImmediate(() => {
    ee.stdout.emit(
      "data",
      Buffer.from("https://github.com/Kaelith-Labs/vcf-cli/releases/tag/v0.0.1-alpha.0\n"),
    );
    ee.emit("close", 0);
  });
  return ee as unknown as ChildProcess;
}

describe("ship_release positive-path state transition (followup #25 close-out)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-shipok-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-shipok-h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    __resetShipReleaseStoreForTests();
    __setShipReleaseSpawnImpl((() => makeExit0Spawn()) as never);
  });
  afterEach(async () => {
    __resetShipReleaseSpawnImpl();
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connectProject() {
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
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'Demo', ?, 'shipping', ?, ?)`,
      )
      .run(projectDir, now, now);
    upsertProject(globalDb, { name: "demo", root_path: projectDir, state: "shipping" });
    const resolved: ResolvedScope = {
      scope: "project",
      projectRoot: projectDir,
      projectSlug: "test-project",
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({ scope: "project", resolved, config, globalDb, projectDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, projectDb, globalDb };
  }

  it("transitions project.state to 'shipped' and mirrors to global registry on gh exit 0", async () => {
    const { client, projectDb, globalDb } = await connectProject();

    const first = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v0.0.1-alpha.0", draft: true, expand: true },
      }),
    );
    expect(first.ok).toBe(true);
    const token = (first.content as { confirm_token: string }).confirm_token;

    const exec = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: {
          tag: "v0.0.1-alpha.0",
          draft: true,
          confirm_token: token,
          expand: true,
        },
      }),
    );
    expect(exec.ok).toBe(true);

    const row = projectDb.prepare("SELECT state FROM project WHERE id = 1").get() as {
      state: string;
    };
    expect(row.state).toBe("shipped");

    const registered = getProjectByRoot(globalDb, projectDir);
    expect(registered?.state_cache).toBe("shipped");
  });
});
