import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { __resetShipReleaseStoreForTests } from "../../src/tools/ship_release.js";
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

describe("ship_release plan/confirm contract", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-ship-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-ship-h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    __resetShipReleaseStoreForTests();
  });
  afterEach(async () => {
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

  it("first call (no confirm_token) returns a plan + token without shelling out", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: {
          tag: "v0.0.1-alpha.0",
          title: "alpha",
          draft: true,
          generate_notes: true,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      plan: { tag: string; draft: boolean };
      command: { name: string; args: string[]; cwd: string };
      confirm_token: string;
    };
    expect(c.plan.tag).toBe("v0.0.1-alpha.0");
    expect(c.command.name).toBe("gh");
    expect(c.command.args.slice(0, 3)).toEqual(["release", "create", "v0.0.1-alpha.0"]);
    expect(c.command.args).toContain("--draft");
    expect(typeof c.confirm_token).toBe("string");
    expect(c.confirm_token.length).toBeGreaterThan(20);
  });

  it("malformed tag rejected via schema (no token issued)", async () => {
    const { client } = await connectProject();
    const r = (await client.callTool({
      name: "ship_release",
      arguments: { tag: "not-a-semver" },
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it("second call with mismatched input payload is refused (E_CONFIRM_REQUIRED)", async () => {
    const { client } = await connectProject();
    const first = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v0.0.1-alpha.0", draft: true, expand: true },
      }),
    );
    const token = (first.content as { confirm_token: string }).confirm_token;
    // Try to execute with a DIFFERENT tag but the same token.
    const env = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v9.9.9", draft: true, confirm_token: token },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_CONFIRM_REQUIRED");
  });

  it("failed release does NOT transition project.state away from 'shipping' (followup #25 guard)", async () => {
    // Don't mock spawn — gh either isn't installed or isn't authed in the
    // test env, so the child exits non-zero. That's exactly the path we
    // want to exercise: passed=false ⇒ no state transition.
    const { client } = await connectProject();
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });

    const first = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v0.0.1-alpha.0", draft: true, expand: true },
      }),
    );
    const token = (first.content as { confirm_token: string }).confirm_token;

    await client.callTool({
      name: "ship_release",
      arguments: {
        tag: "v0.0.1-alpha.0",
        draft: true,
        confirm_token: token,
        timeout_ms: 2000,
      },
    });

    // State stayed 'shipping' — the transition to 'shipped' is gated on
    // gh exiting 0, which didn't happen. The positive-path transition is
    // verified end-to-end by real releases (the 0.4 tag push is the test).
    const row = projectDb.prepare("SELECT state FROM project WHERE id = 1").get() as {
      state: string;
    };
    expect(row.state).toBe("shipping");
  });

  it("reusing a token (even with matching input) is refused — single-use", async () => {
    const { client } = await connectProject();
    const first = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v0.0.1-alpha.0", draft: true, expand: true },
      }),
    );
    const token = (first.content as { confirm_token: string }).confirm_token;
    // First consumption — `gh` behavior varies by platform: on Linux CI
    // runners it errors fast with an auth failure; on Windows Node 22
    // CI runners it can hang indefinitely on an interactive auth prompt.
    // Short timeout_ms keeps this test deterministic. The timeout is in
    // the tool code itself (it kills the child and resolves with
    // timed_out=true), so the test doesn't rely on the subprocess ever
    // returning on its own.
    await client.callTool({
      name: "ship_release",
      arguments: {
        tag: "v0.0.1-alpha.0",
        draft: true,
        confirm_token: token,
        timeout_ms: 2000,
      },
    });
    // Second consumption — must be refused.
    const env = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v0.0.1-alpha.0", draft: true, confirm_token: token },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_CONFIRM_REQUIRED");
  });
});
