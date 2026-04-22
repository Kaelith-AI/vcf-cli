import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";

// Regression for the 0.5.0 release-gate finding (security stage 2 warning):
// `review_execute` (and `lifecycle_report` narrative) only gated trust_level
// === "public" endpoints. That left `trust_level="trusted"` endpoints
// resolved from config.defaults silently routing review/lifecycle bundles
// off-host on config drift. The tightened gate: any non-local endpoint
// resolved via defaults (no explicit endpoint arg) must carry an explicit
// opt-in. Explicit endpoint arg is the consent signal that bypasses the
// defaults gate (public still gates regardless).

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

describe("review_execute trust-level gate on defaults-resolved endpoints", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-trustgate-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-trustgate-home-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await writeFile(
      join(kbRoot, "review-system", "code", "01-code-stage1.md"),
      `---\ntype: review-stage\nreview_type: code\nstage: 1\nstage_name: s1\nversion: 0.1\nupdated: 2026-04-22\n---\n# Code Stage 1\n`,
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      `---\ntype: reviewer-config\nreviewer_type: code\nversion: 0.1\nupdated: 2026-04-22\n---\n# Code Reviewer\n`,
    );
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect(opts: {
    defaultEndpoint?: string;
    trustLevel?: "local" | "trusted" | "public";
  }) {
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
        {
          name: "trusted-proxy",
          provider: "openai-compatible",
          base_url: "http://127.0.0.1:4000/v1",
          trust_level: "trusted",
        },
      ],
      kb: { root: kbRoot },
      review: { categories: ["code"] },
      ...(opts.defaultEndpoint !== undefined
        ? { defaults: { review: { endpoint: opts.defaultEndpoint, model: "test-model" } } }
        : {}),
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'Demo', ?, 'reviewing', ?, ?)`,
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

  async function prepareRunId(client: Client): Promise<string> {
    const prep = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(prep.ok).toBe(true);
    const manifest = prep.content as { run_id: string };
    return manifest.run_id;
  }

  it("rejects defaults-resolved trusted endpoint without explicit override", async () => {
    const { client } = await connect({ defaultEndpoint: "trusted-proxy" });
    const runId = await prepareRunId(client);
    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, timeout_ms: 1000 },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_STATE_INVALID");
    const msg = (env as unknown as { message?: string }).message ?? "";
    expect(msg).toContain("trust_level='trusted'");
    expect(msg).toContain("config.defaults.review.endpoint");
  });

  it("accepts EXPLICIT trusted endpoint without override — explicit arg is consent", async () => {
    const { client } = await connect({ defaultEndpoint: "local-stub" });
    const runId = await prepareRunId(client);
    // Explicit endpoint=trusted-proxy should be allowed. It'll still fail
    // at the network layer (127.0.0.1:4000 not reachable in the test env)
    // with E_ENDPOINT_UNREACHABLE or E_CANCELED — that proves the trust
    // gate let the call through. What we must NOT see is E_STATE_INVALID
    // with the "trust_level=..." message.
    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: {
          run_id: runId,
          endpoint: "trusted-proxy",
          model_id: "test-model",
          timeout_ms: 500,
        },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).not.toBe("E_STATE_INVALID");
  });

  it("accepts defaults-resolved trusted endpoint with allow_public_endpoint=true", async () => {
    const { client } = await connect({ defaultEndpoint: "trusted-proxy" });
    const runId = await prepareRunId(client);
    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: {
          run_id: runId,
          allow_public_endpoint: true,
          model_id: "test-model",
          timeout_ms: 500,
        },
      }),
    );
    expect(env.ok).toBe(false);
    // Same rationale as the "explicit consent" test: we expect the trust
    // gate to pass and the call to fail at the network layer instead.
    expect(env.code).not.toBe("E_STATE_INVALID");
  });

  it("defaults-resolved LOCAL endpoint works with no gate", async () => {
    const { client } = await connect({ defaultEndpoint: "local-stub" });
    const runId = await prepareRunId(client);
    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, model_id: "test-model", timeout_ms: 500 },
      }),
    );
    expect(env.ok).toBe(false);
    // local-stub is trust_level=local → gate doesn't fire. Network failure
    // (E_ENDPOINT_UNREACHABLE / E_CANCELED) is expected and is NOT the
    // trust-level gate message.
    expect(env.code).not.toBe("E_STATE_INVALID");
  });
});
