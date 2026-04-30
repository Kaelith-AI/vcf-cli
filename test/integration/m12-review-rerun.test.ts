import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";

// M12 verification step 10: "Induced Stage 3 BLOCK halts progression …
// Fix applied, Stage 3 re-run passes, progression resumes."
//
// The existing m7 suite covers stage-1 supersession in isolation. This file
// drives the full non-PASS → re-run → PASS flow across two stages, using
// both NEEDS_WORK and BLOCK verdicts, and asserts:
//  - Stage N+1 prepare is rejected (E_STATE_INVALID) while Stage N's latest
//    submission is non-PASS
//  - Re-preparing Stage N marks the prior non-PASS row `superseded` and
//    creates a fresh `pending` row
//  - Carry-forward entries authored on the superseded run do not propagate
//    into Stage N+1 (only PASS entries flow forward)
//  - After the re-run submits PASS, Stage N+1 unlocks

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

function ok(env: Envelope): Envelope {
  if (!env.ok) {
    throw new Error(`tool failed: ${env.code ?? "?"} — ${env.summary ?? ""}`);
  }
  return env;
}

describe("M12 review re-run supersession (NEEDS_WORK / BLOCK → re-run → PASS)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-rerun-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-rerun-h-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    for (const stage of [1, 2, 3]) {
      await writeFile(
        join(kbRoot, "review-system", "code", `0${stage}-smoke.md`),
        [
          "---",
          "type: review-stage",
          "review_type: code",
          `stage: ${stage}`,
          `stage_name: smoke-${stage}`,
          "version: 1",
          "updated: 2026-04-18",
          "---",
          `# Stage ${stage}`,
        ].join("\n"),
      );
    }
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      [
        "---",
        "type: reviewer-config",
        "reviewer_type: code",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "# Reviewer",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function makeConfig() {
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
    });
  }

  async function connectProject() {
    const config = makeConfig();
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
      projectRoot: projectDir,
      projectSlug: "test-project",
      projectDbPath: join(projectDir, ".vcf", "project.db"),
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
    return { client, projectDb };
  }

  async function prepareStage(
    client: Client,
    stage: number,
  ): Promise<{ run_id: string; carry_forward_file: string }> {
    const env = ok(
      parseResult(
        await client.callTool({
          name: "review_prepare",
          arguments: { type: "code", stage, expand: true },
        }),
      ),
    );
    return env.content as { run_id: string; carry_forward_file: string };
  }

  async function submit(
    client: Client,
    runId: string,
    verdict: "PASS" | "NEEDS_WORK" | "BLOCK",
    cfText: string,
  ): Promise<void> {
    ok(
      parseResult(
        await client.callTool({
          name: "review_submit",
          arguments: {
            run_id: runId,
            verdict,
            summary: `Stage verdict=${verdict} summary text.`,
            carry_forward: [
              {
                section: "architecture",
                severity: verdict === "PASS" ? "info" : "warning",
                text: cfText,
              },
            ],
            expand: true,
          },
        }),
      ),
    );
  }

  it("NEEDS_WORK on stage 2 blocks stage 3 → re-run PASS unlocks stage 3, superseded carry-forward does not leak", async () => {
    const { client, projectDb } = await connectProject();

    // Stage 1: PASS so stage 2 is reachable.
    const run1 = await prepareStage(client, 1);
    await submit(client, run1.run_id, "PASS", "Stage 1 arch note OK.");

    // Stage 2: first attempt is NEEDS_WORK with a carry-forward entry that
    // we must NOT see leak into the stage-3 rehydration.
    const run2a = await prepareStage(client, 2);
    await submit(client, run2a.run_id, "NEEDS_WORK", "LEAKY-CF-ENTRY-SHOULD-NOT-PROPAGATE");

    // Stage 3 prepare must be rejected — the freshest stage-2 submission
    // is NEEDS_WORK, not PASS.
    const blocked = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 3 },
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("E_STATE_INVALID");

    // Re-prepare stage 2. The NEEDS_WORK row must be marked superseded
    // and a new pending row must appear, distinct id, fresh
    // started_at.
    const run2b = await prepareStage(client, 2);
    expect(run2b.run_id).not.toBe(run2a.run_id);

    const rows2 = projectDb
      .prepare(
        "SELECT id, status, verdict FROM review_runs WHERE type='code' AND stage=2 ORDER BY started_at",
      )
      .all() as Array<{ id: string; status: string; verdict: string | null }>;
    expect(rows2).toHaveLength(2);
    expect(rows2[0]).toMatchObject({
      id: run2a.run_id,
      status: "superseded",
      verdict: "NEEDS_WORK",
    });
    expect(rows2[1]).toMatchObject({ id: run2b.run_id, status: "pending" });

    // The fresh stage-2 carry-forward file must NOT contain the leaky text
    // from the superseded run — stage 2 rehydrates from stage 1's PASS
    // carry-forward only.
    const cfFresh = await readFile(run2b.carry_forward_file, "utf8");
    expect(cfFresh).not.toContain("LEAKY-CF-ENTRY-SHOULD-NOT-PROPAGATE");
    expect(cfFresh).toContain("Stage 1 arch note OK");

    // Submit stage 2 as PASS. Stage 3 must now unlock and its
    // carry-forward must include stage-2's fresh PASS entry.
    await submit(client, run2b.run_id, "PASS", "Stage 2 re-run clean.");

    const run3 = await prepareStage(client, 3);
    const cf3 = await readFile(run3.carry_forward_file, "utf8");
    expect(cf3).toContain("Stage 2 re-run clean");
    expect(cf3).not.toContain("LEAKY-CF-ENTRY-SHOULD-NOT-PROPAGATE");
  });

  it("BLOCK at stage 2 also gates stage 3 and is superseded on re-run the same way", async () => {
    const { client, projectDb } = await connectProject();

    const run1 = await prepareStage(client, 1);
    await submit(client, run1.run_id, "PASS", "S1 ok.");

    const run2a = await prepareStage(client, 2);
    await submit(client, run2a.run_id, "BLOCK", "Do not ship — critical gap.");

    // Stage 3 locked.
    const blocked = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 3 },
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("E_STATE_INVALID");

    // Re-run → supersede + fresh pending.
    const run2b = await prepareStage(client, 2);
    expect(run2b.run_id).not.toBe(run2a.run_id);
    const prior = projectDb
      .prepare("SELECT status, verdict FROM review_runs WHERE id=?")
      .get(run2a.run_id) as { status: string; verdict: string };
    expect(prior).toMatchObject({ status: "superseded", verdict: "BLOCK" });

    // PASS → stage 3 unlocked.
    await submit(client, run2b.run_id, "PASS", "S2 fixed.");
    const run3 = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 3, expand: true },
      }),
    );
    expect(run3.ok).toBe(true);
  });

  it("force=true lets a reviewer skip the prior-PASS gate and writes the flag to the manifest", async () => {
    const { client, projectDb } = await connectProject();
    // Stage 1 never prepared. Stage 2 without force should be rejected.
    const blocked = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 2 },
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("E_STATE_INVALID");

    // With force, it must succeed and the manifest records force_used=true.
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 2, force: true, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { force_used: boolean; run_id: string };
    expect(manifest.force_used).toBe(true);

    const row = projectDb
      .prepare("SELECT status FROM review_runs WHERE id=?")
      .get(manifest.run_id) as { status: string };
    expect(row.status).toBe("pending");
  });
});
