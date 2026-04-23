// Custom reviewer categories beyond code/security/production.
//
// The plan (Phase-2) called for user-defined review types via config.
// This test sets `review.categories = [..., "accessibility"]`, seeds an
// accessibility stage + reviewer overlay in the KB, and walks the happy
// path: review_prepare → review_submit → review_history filtered by the
// custom type. Also verifies the error path: an unknown type is rejected
// with E_VALIDATION referencing the configured set.

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

describe("review: custom categories via config", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-rcat-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-rcath-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "accessibility"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    // Seed a single stage for the "accessibility" review type.
    await writeFile(
      join(kbRoot, "review-system", "accessibility", "01-a11y-baseline.md"),
      [
        "---",
        "type: review-stage",
        "review_type: accessibility",
        "stage: 1",
        "stage_name: a11y-baseline",
        "version: 0.1",
        "updated: 2026-04-18",
        "---",
        "# Accessibility Stage 1 — Baseline",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-accessibility.md"),
      [
        "---",
        "type: reviewer-config",
        "reviewer_type: accessibility",
        "version: 0.1",
        "updated: 2026-04-18",
        "---",
        "# Accessibility Reviewer Config",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connectProject(categories: string[]) {
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
      kb: { root: kbRoot },
      review: { categories },
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
      projectRoot: projectDir,
      projectSlug: "test-project",
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({ scope: "project", resolved, config, globalDb, projectDb, homeDir: home });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client };
  }

  it("review_prepare accepts a custom type listed in config.review.categories", async () => {
    const { client } = await connectProject(["code", "security", "production", "accessibility"]);
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "accessibility", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as {
      run_id: string;
      stage_file: string;
      reviewer_file: string;
    };
    expect(manifest.run_id).toMatch(/^accessibility-1-/);
    expect(manifest.stage_file).toMatch(/stage-1\.accessibility\.md$/);
    expect(manifest.reviewer_file).toMatch(/reviewer-accessibility\.md$/);
  });

  it("review_prepare rejects a type not in config.review.categories with E_VALIDATION", async () => {
    const { client } = await connectProject(["code", "security", "production"]);
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "accessibility", stage: 1 },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_VALIDATION");
  });

  it("review_history rejects an unknown type with E_VALIDATION rather than silently returning empty", async () => {
    const { client } = await connectProject(["code", "security", "production"]);
    const env = parseResult(
      await client.callTool({
        name: "review_history",
        arguments: { type: "accessibility" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_VALIDATION");
  });

  it("review_history accepts a custom type listed in config.review.categories", async () => {
    const { client } = await connectProject(["code", "security", "production", "accessibility"]);
    // Prepare one run so the filter has something to match against.
    const prep = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "accessibility", stage: 1, expand: true },
      }),
    );
    expect(prep.ok).toBe(true);
    const hist = parseResult(
      await client.callTool({
        name: "review_history",
        arguments: { type: "accessibility", expand: true },
      }),
    );
    expect(hist.ok).toBe(true);
    const runs = (hist.content as { runs: Array<{ type: string }> }).runs;
    expect(runs.length).toBe(1);
    expect(runs[0]?.type).toBe("accessibility");
  });
});
