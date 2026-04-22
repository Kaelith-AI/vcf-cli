import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import { resolveOverlay } from "../../src/review/overlays.js";
import type { ResolvedScope } from "../../src/scope.js";

// Regression for the 0.5.0 release-gate finding (code stage 2 warning):
// `review_execute` used to resolve the reviewer overlay against the live KB
// at execute time, so KB edits between review_prepare and review_execute
// silently changed what the prepared run saw. The fix: review_prepare
// snapshots the base reviewer file + every `reviewer-<type>.*.md` variant
// into the run dir; review_execute resolves overlays against the run-dir
// snapshot instead of the KB.

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

describe("review_prepare snapshots reviewer overlays for prepare/execute isolation", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-ovsnap-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-ovsnap-home-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    // Stage file for review_prepare to pick up.
    await writeFile(
      join(kbRoot, "review-system", "code", "01-code-stage1.md"),
      `---\ntype: review-stage\nreview_type: code\nstage: 1\nstage_name: s1\nversion: 0.1\nupdated: 2026-04-22\n---\n# Code Stage 1\n`,
    );
    // Base reviewer + two per-trust-level variants. Content is tagged so
    // the test can detect which version made it into the snapshot.
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      `---\ntype: reviewer-config\nreviewer_type: code\nversion: 0.1\nupdated: 2026-04-22\n---\n# Code Reviewer VERSION=A\n`,
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.local.md"),
      "# Code Local Overlay VERSION=A\n",
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.frontier.md"),
      "# Code Frontier Overlay VERSION=A\n",
    );
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connect() {
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
      review: { categories: ["code"] },
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

  it("copies base + every per-variant overlay into the run dir at prepare time", async () => {
    const { client } = await connect();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const manifest = env.content as { run_dir: string };
    expect(existsSync(join(manifest.run_dir, "reviewer-code.md"))).toBe(true);
    expect(existsSync(join(manifest.run_dir, "reviewer-code.local.md"))).toBe(true);
    expect(existsSync(join(manifest.run_dir, "reviewer-code.frontier.md"))).toBe(true);
    // Each snapshot body must match its source at prepare time (tagged A).
    expect(await readFile(join(manifest.run_dir, "reviewer-code.md"), "utf8")).toContain(
      "VERSION=A",
    );
    expect(await readFile(join(manifest.run_dir, "reviewer-code.local.md"), "utf8")).toContain(
      "Local Overlay VERSION=A",
    );
    expect(await readFile(join(manifest.run_dir, "reviewer-code.frontier.md"), "utf8")).toContain(
      "Frontier Overlay VERSION=A",
    );
  });

  it("resolveOverlay against a run-dir snapshot sees only prepare-time content", async () => {
    const { client } = await connect();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    const runDir = (env.content as { run_dir: string }).run_dir;

    // Corrupt the live KB after prepare — simulates an operator editing
    // reviewer-code.local.md between prepare and execute. The snapshot
    // must be unaffected.
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.local.md"),
      "# Code Local Overlay VERSION=B — LIVE EDIT\n",
    );

    const resolvedFromSnap = resolveOverlay({
      kbRoot,
      reviewersDir: runDir,
      reviewType: "code",
      modelId: "qwen3-coder:30b",
      trustLevel: "local",
    });
    expect(resolvedFromSnap.overlayMatch).toBe("trust-level");
    expect(resolvedFromSnap.overlayRelPath).toBe(join(runDir, "reviewer-code.local.md"));
    const snapBody = await readFile(resolvedFromSnap.overlayRelPath!, "utf8");
    expect(snapBody).toContain("VERSION=A");
    expect(snapBody).not.toContain("VERSION=B");

    // A resolver pointed at the live KB DOES see the edit — proves the
    // only difference is where the resolver reads from.
    const resolvedFromKb = resolveOverlay({
      kbRoot,
      reviewType: "code",
      modelId: "qwen3-coder:30b",
      trustLevel: "local",
    });
    const liveBody = await readFile(resolvedFromKb.overlayRelPath!, "utf8");
    expect(liveBody).toContain("VERSION=B");
  });
});
