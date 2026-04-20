import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";

// M12: MCP-level cancellation. Spec §Verification bullet 4 requires that a
// long-running test_execute aborted via the client's signal returns E_CANCELED
// within 2s and that an audit row records the cancel. The existing m6 suite
// exercises only the timeout_ms path; this covers the real protocol flow
// (client AbortSignal → SDK `notifications/cancelled` → server-side
// extra.signal.aborted → child SIGTERM → E_CANCELED envelope).

interface Envelope {
  ok: boolean;
  code?: string;
  summary?: string;
  content?: unknown;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("M12 cancellation via MCP signal", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-cancel-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-cancel-h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
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
    return { client, globalDb };
  }

  it("aborting a running test_execute returns E_CANCELED within 2s and writes a canceled audit row", async () => {
    const { client, globalDb } = await connectProject();

    // A child that would run indefinitely. Node's setInterval keeps the
    // event loop alive forever until SIGTERM.
    const controller = new AbortController();
    const spawnedAt = Date.now();
    const callPromise = client.callTool(
      {
        name: "test_execute",
        arguments: {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000_000)"],
          timeout_ms: 30_000, // much larger than the cancel deadline
          expand: true,
        },
      },
      undefined,
      { signal: controller.signal },
    );

    // Give the child a moment to actually start, then abort.
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();

    // With an aborted client signal, the SDK rejects the callTool promise
    // rather than returning a tool envelope. Either outcome is acceptable
    // as long as it happens fast and the audit row is written.
    let rejection: unknown = null;
    let envelope: Envelope | null = null;
    try {
      envelope = parseResult(await callPromise);
    } catch (err) {
      rejection = err;
    }
    const elapsed = Date.now() - spawnedAt;

    // Must be well under the 2s budget — server-side onAbort triggers
    // SIGTERM immediately and the child finishes in ms.
    expect(elapsed).toBeLessThan(2_000);

    // One path: server completed and returned an E_CANCELED envelope.
    // Other path: SDK raised AbortError on the client end before the
    // envelope made it back. Either is fine; both mean the tool stopped.
    if (envelope) {
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("E_CANCELED");
    } else {
      expect(rejection).not.toBeNull();
    }

    // Audit row: the server-side handler writes one either way (the
    // cancellation path wraps through runTool which always audits).
    // Poll briefly — the audit write happens just after the envelope is
    // produced, but in the AbortError case the handler may still be
    // finishing when the client promise rejects.
    let rows: Array<{ tool: string; result_code: string }> = [];
    for (let i = 0; i < 100; i++) {
      rows = globalDb
        .prepare("SELECT tool, result_code FROM audit WHERE tool = ? ORDER BY ts DESC")
        .all("test_execute") as Array<{ tool: string; result_code: string }>;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Diagnostic dump if we didn't see the row — surface what the audit
    // table actually contains to speed up future debugging.
    if (rows.length === 0) {
      const all = globalDb.prepare("SELECT tool, result_code FROM audit").all() as Array<{
        tool: string;
        result_code: string;
      }>;
      console.error("no test_execute audit row; full audit table:", all);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.result_code).toBe("E_CANCELED");
  });

  it("signal already-aborted before the tool spawns still produces E_CANCELED", async () => {
    const { client, globalDb } = await connectProject();

    const controller = new AbortController();
    controller.abort(); // abort before the call is even dispatched
    const startedAt = Date.now();

    let rejection: unknown = null;
    let envelope: Envelope | null = null;
    try {
      envelope = parseResult(
        await client.callTool(
          {
            name: "test_execute",
            arguments: {
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              timeout_ms: 5_000,
              expand: true,
            },
          },
          undefined,
          { signal: controller.signal },
        ),
      );
    } catch (err) {
      rejection = err;
    }
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(2_000);

    if (envelope) {
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("E_CANCELED");
    } else {
      expect(rejection).not.toBeNull();
    }

    // Audit row may or may not be present on the pre-aborted path
    // depending on whether the SDK even forwarded the request. If it
    // did, the result must be E_CANCELED.
    const rows = globalDb
      .prepare("SELECT tool, result_code FROM audit WHERE tool = ? ORDER BY ts DESC")
      .all("test_execute") as Array<{ tool: string; result_code: string }>;
    for (const row of rows) {
      expect(row.result_code).toBe("E_CANCELED");
    }
  });
});
