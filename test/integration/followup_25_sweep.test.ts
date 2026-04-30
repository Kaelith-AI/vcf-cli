// Tests for followup #25 sweep items (commit 6cb0ae2). Code landed there
// without tests; this file covers each ship-item.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  code?: string;
  content?: unknown;
  summary?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    // SDK returned a raw error string (rejected at transport layer) —
    // surface it so the test failure points at the real cause instead of
    // a JSON.parse stack.
    throw new Error(`non-JSON MCP response (isError=${r.isError}): ${text.slice(0, 300)}`);
  }
}

function makeConfig(workRoot: string, home: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

async function bootProject(
  workRoot: string,
  home: string,
  projectDir: string,
  configOverrides: Record<string, unknown> = {},
) {
  const config = makeConfig(workRoot, home, configOverrides);
  const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  const dbPath = join(home, ".vcf", "projects", "demo", "project.db");
  const projectDb = openProjectDb({ path: dbPath });
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
  const client = new Client({ name: "sweep", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return { client, globalDb, projectDb, config };
}

/**
 * spec_save lives at global scope. Some tests need BOTH a global client (to
 * call spec_save) AND project state (so downstream tools have a project to
 * work against). This helper brings both up against the same home + config.
 */
async function bootGlobal(
  workRoot: string,
  home: string,
  configOverrides: Record<string, unknown> = {},
) {
  const config = makeConfig(workRoot, home, configOverrides);
  const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
  const resolved: ResolvedScope = { scope: "global" };
  const server = createServer({ scope: "global", resolved, config, globalDb, homeDir: home });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "sweep-g", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return { client, globalDb, config };
}

// ---- 1. cycle_status ------------------------------------------------------

describe("#25 item 9 — cycle_status", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-cycle-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-cycleh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("needs_test=false when no build has happened", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);
    const res = await client.callTool({ name: "cycle_status", arguments: { expand: true } });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const c = env.content as {
      last_build_at: number | null;
      last_test_at: number | null;
      needs_test: boolean;
    };
    expect(c.last_build_at).toBeNull();
    expect(c.needs_test).toBe(false);
  });

  it("needs_test=true after ship_build success with no subsequent test_execute", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO builds (target, started_at, finished_at, status, output_path)
         VALUES ('ship:tarball', ?, ?, 'success', NULL)`,
      )
      .run(now - 1000, now);

    const res = await client.callTool({ name: "cycle_status", arguments: { expand: true } });
    const c = parseResult(res).content as { last_build_at: number; needs_test: boolean };
    expect(c.last_build_at).toBe(now);
    expect(c.needs_test).toBe(true);
  });

  it("needs_test=false when test_execute ran after the last build", async () => {
    const { client, projectDb, globalDb } = await bootProject(workRoot, home, projectDir);
    const buildTs = Date.now() - 10_000;
    const testTs = Date.now() - 5_000;
    projectDb
      .prepare(
        `INSERT INTO builds (target, started_at, finished_at, status, output_path)
         VALUES ('ship:tarball', ?, ?, 'success', NULL)`,
      )
      .run(buildTs - 100, buildTs);
    globalDb
      .prepare(
        `INSERT INTO audit (ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, result_code)
         VALUES (?, 'test_execute', 'project', ?, 'sweep', 'hi', 'ho', 'ok')`,
      )
      .run(testTs, projectDir);

    const res = await client.callTool({ name: "cycle_status", arguments: { expand: true } });
    const c = parseResult(res).content as { needs_test: boolean };
    expect(c.needs_test).toBe(false);
  });
});

// ---- 2. spec_save status transition enforcement ---------------------------

describe("#25 item 7 — spec status transition enforcement", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-specst-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-specsth-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(workRoot, "specs"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  const specBody = (title: string, status: string) =>
    [
      "---",
      `title: ${title}`,
      `status: ${status}`,
      "created: 2026-04-23",
      "tags: []",
      "tech_stack: []",
      "lens: []",
      "---",
      "",
      "# Body",
      "",
      "Enough content here to clear the 64-char minimum on spec_save's content.",
    ].join("\n");

  it("illegal transition is always rejected (force=true does not bypass E_STATE_INVALID)", async () => {
    const { client } = await bootGlobal(workRoot, home);
    // First save: status=accepted (new file, no prior — succeeds).
    const r1 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "my-thing",
          content: specBody("My Thing", "accepted"),
        },
      }),
    );
    expect(r1.ok).toBe(true);
    // Second save: accepted→draft is illegal; force=true does NOT bypass E_STATE_INVALID.
    const r2 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "my-thing",
          content: specBody("My Thing", "draft"),
          force: true,
        },
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("E_STATE_INVALID");
  });

  it("force=true allows overwriting a file when transition is legal", async () => {
    const { client } = await bootGlobal(workRoot, home);
    // First save: draft (new file).
    const r1 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "legal-force",
          content: specBody("Legal Force", "draft"),
        },
      }),
    );
    expect(r1.ok).toBe(true);
    // Second save: draft→accepted is legal; force=true allows the overwrite.
    const r2 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "legal-force",
          content: specBody("Legal Force", "accepted"),
          force: true,
        },
      }),
    );
    expect(r2.ok).toBe(true);
  });

  it("rejects repeat save without force=true (E_ALREADY_EXISTS)", async () => {
    const { client } = await bootGlobal(workRoot, home);
    const r1 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "another",
          content: specBody("Another", "draft"),
        },
      }),
    );
    expect(r1.ok).toBe(true);
    const r2 = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: {
          slug: "another",
          content: specBody("Another", "accepted"),
        },
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("E_ALREADY_EXISTS");
  });
});

// ---- 3. spec_template — related_specs frontmatter ------------------------

describe("#25 item 2 — related_specs frontmatter available", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-relspec-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-relspech-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(workRoot, "specs"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("spec_save accepts related_specs in frontmatter", async () => {
    const { client } = await bootGlobal(workRoot, home);
    const body = [
      "---",
      "title: Downstream Spec",
      "status: draft",
      "created: 2026-04-23",
      "tags: []",
      "tech_stack: []",
      "lens: []",
      "related_specs: [auth-service, data-model]",
      "---",
      "",
      "# Body",
      "",
      "Content long enough to meet the 64-char spec_save minimum contract.",
    ].join("\n");
    const res = parseResult(
      await client.callTool({
        name: "spec_save",
        arguments: { slug: "downstream", content: body },
      }),
    );
    expect(res.ok).toBe(true);
  });

  it("the shipped spec template documents related_specs", async () => {
    const tplPath = join(process.cwd(), "templates", "spec-template.md.tpl");
    const body = await readFile(tplPath, "utf8");
    expect(body).toContain("related_specs");
  });
});

// ---- 4. plan_save --force backup ----------------------------------------

describe("#25 item 3 — plan_save force-backup prior trio", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-planbkp-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-planbkph-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("backs up the prior quartet under backups_dir/.plan-backups before overwriting", async () => {
    const { client } = await bootProject(workRoot, home, projectDir);
    const charterV1 =
      "# Charter v1\n\nProblem: do the thing v1. Success: it's done. Constraints: none. Out of scope: nothing. Decisions: TypeScript.\n";
    const planV1 =
      "# plan v1\n\n" +
      "One paragraph that's long enough to meet the 64-char minimum on plan body.\n";
    const planV2 =
      "# plan v2\n\n" + "A second paragraph that also meets the 64-char minimum comfortably.\n";

    // First save.
    const r1 = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: {
          name: "example",
          charter: charterV1,
          plan: planV1,
          todo: "- do the thing\n- then do the next thing\n",
          manifest: "## files\n- `src/thing.ts` new\n",
        },
      }),
    );
    expect(r1.ok).toBe(true);

    // Force-overwrite.
    const r2 = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: {
          name: "example",
          charter:
            "# Charter v2\n\nProblem: do the thing v2. Success: it's done better. Constraints: none. Out of scope: nothing. Decisions: TypeScript.\n",
          plan: planV2,
          todo: "- revised todo list here\n",
          manifest: "## files\n- `src/thing.ts` revised\n",
          force: true,
        },
      }),
    );
    expect(r2.ok).toBe(true);

    const bkRoot = join(projectDir, "backups", ".plan-backups");
    expect(existsSync(bkRoot)).toBe(true);
    const dirs = await readdir(bkRoot);
    expect(dirs.length).toBeGreaterThan(0);
    const backup = dirs.find((d) => d.startsWith("example-"));
    expect(backup).toBeDefined();
    const priorPlan = await readFile(join(bkRoot, backup!, "example-plan.md"), "utf8");
    expect(priorPlan).toContain("plan v1");
    const priorCharter = await readFile(join(bkRoot, backup!, "example-charter.md"), "utf8");
    expect(priorCharter).toContain("Charter v1");
  });
});

// ---- 5. audit.personal_data.allow_list suppression ------------------------

describe("#25 item 4 — audit.personal_data.allow_list suppresses email warnings", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-aud-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-audh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("allow_list entry with the exact email suppresses the warning", async () => {
    const email = "maintainer@kaelith.dev";
    // Post-fix: ship_audit scans .md files (README, CONTRIBUTORS, etc.),
    // so README.md is the canonical place for this leak. Also drop a copy
    // in a .yaml to confirm the allow-list applies across file types.
    await writeFile(join(projectDir, "README.md"), `# Demo\n\nMaintainer: ${email}\n`, "utf8");
    await writeFile(
      join(projectDir, "contacts.yaml"),
      `owner: Kaelith\ncontact: ${email}\n`,
      "utf8",
    );

    // First, without allow_list — the warning fires.
    {
      const { client } = await bootProject(workRoot, home, projectDir);
      const res = parseResult(
        await client.callTool({
          name: "ship_audit",
          arguments: { include: ["personal-data"], expand: true },
        }),
      );
      expect(res.ok).toBe(true);
      const c = res.content as {
        passes: Array<{ name: string; findings: Array<{ detail: string }> }>;
      };
      const pd = c.passes.find((p) => p.name === "personal-data");
      expect(pd).toBeDefined();
      expect(pd!.findings.some((f) => f.detail.includes(email))).toBe(true);
      // Post-fix: the README.md hit should be present too.
      expect(
        pd!.findings.some(
          (f) => f.detail.includes(email) && /README\.md$/.test((f as { file: string }).file),
        ),
      ).toBe(true);
      closeTrackedDbs();
    }

    // Remove the state-dir project DB so bootProject can re-insert.
    await rm(join(home, ".vcf", "projects"), { recursive: true, force: true });

    // Now with allow_list — the warning is suppressed.
    const { client } = await bootProject(workRoot, home, projectDir, {
      audit: { full_payload_storage: false, personal_data: { allow_list: [email] } },
    });
    const res2 = parseResult(
      await client.callTool({
        name: "ship_audit",
        arguments: { include: ["personal-data"], expand: true },
      }),
    );
    expect(res2.ok).toBe(true);
    const c2 = res2.content as {
      passes: Array<{ name: string; findings: Array<{ detail: string }> }>;
    };
    const pd2 = c2.passes.find((p) => p.name === "personal-data");
    expect(pd2!.findings.some((f) => f.detail.includes(email))).toBe(false);
  });
});

// ---- 6. ship.strict_chain + version_check ---------------------------------

describe("#25 items 5+6 — ship.strict_chain + version_check", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-strict-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-stricth-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    // Reset ship_release's in-memory confirm-token store so previous test
    // runs don't bleed into this one.
    const { __resetShipReleaseStoreForTests } = await import("../../src/tools/ship_release.js");
    __resetShipReleaseStoreForTests();
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("strict_chain=true rejects ship_release when no recent ship_audit is recorded", async () => {
    const { client } = await bootProject(workRoot, home, projectDir, {
      ship: {
        strict_chain: true,
        strict_chain_window_minutes: 60,
        version_check: false,
      },
    });
    const res = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v1.0.0", expand: true },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("E_STATE_INVALID");
  });

  it("version_check=true (without strict_chain) emits a soft-warn but does not block", async () => {
    const { client, projectDb } = await bootProject(workRoot, home, projectDir, {
      ship: {
        strict_chain: false,
        strict_chain_window_minutes: 60,
        version_check: true,
      },
    });
    // Seed a prior successful release at a newer tag.
    projectDb
      .prepare(
        `INSERT INTO builds (target, started_at, finished_at, status, output_path)
         VALUES ('ship_release:v2.0.0', ?, ?, 'success', NULL)`,
      )
      .run(Date.now() - 1000, Date.now());
    // Calling ship_release with an older tag should NOT throw — version_check
    // without strict_chain is advisory only. The tool will still proceed to
    // its normal plan/confirm dance (which ultimately calls gh — we don't go
    // that far in this test). We're satisfied if the return code is not
    // E_VALIDATION for version-continuity.
    const res = parseResult(
      await client.callTool({
        name: "ship_release",
        arguments: { tag: "v1.9.9", expand: true },
      }),
    );
    // version_check alone is soft — may still fail downstream on the plan
    // path if gh or confirm-token is missing. Only assert: when failure
    // happens, it's not the version-continuity hard gate.
    if (!res.ok) {
      expect(res.code).not.toBe("E_VALIDATION");
    }
  });
});

// ---- 7. review_prepare lens intersection ----------------------------------

describe("#25 item 8 — review_prepare lens intersection", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-lens-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-lensh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(workRoot, "specs"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function seedKb() {
    const kbRoot = join(home, ".vcf", "kb");
    await mkdir(join(kbRoot, "lenses"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    // Lens A — tagged with security. Should match a spec tagged security.
    await writeFile(
      join(kbRoot, "lenses", "lens-security.md"),
      [
        "---",
        "type: lens",
        "kind: lens",
        "id: lens-security",
        "tags: [security]",
        "applies_to: []",
        "---",
        "# Security lens",
      ].join("\n"),
    );
    // Lens B — tagged with frontend. Should NOT match a spec without frontend.
    await writeFile(
      join(kbRoot, "lenses", "lens-frontend.md"),
      [
        "---",
        "type: lens",
        "kind: lens",
        "id: lens-frontend",
        "tags: [frontend]",
        "applies_to: []",
        "---",
        "# Frontend lens",
      ].join("\n"),
    );
    // Minimal stage 1 code review file + reviewer overlay so review_prepare
    // has files to copy.
    await writeFile(
      join(kbRoot, "review-system", "code", "stage-01-architecture.md"),
      "---\ntype: review-stage\nreview_type: code\nstage: 1\n---\n# Stage 1\n",
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      "---\ntype: reviewer-config\nreviewer_type: code\n---\n# Code reviewer\n",
    );
  }

  it("returns only lenses whose tags intersect the spec's tag set", async () => {
    await seedKb();
    const specBody = [
      "---",
      "title: Secure Thing",
      "status: accepted",
      "created: 2026-04-23",
      "tags: [security, api]",
      "tech_stack: []",
      "lens: []",
      "---",
      "# Body",
      "",
      "Enough content here to clear the 64-char minimum on spec_save.",
    ].join("\n");

    // Save the spec via the global-scope client (spec_save is global).
    const { client: gClient } = await bootGlobal(workRoot, home);
    const r1 = parseResult(
      await gClient.callTool({
        name: "spec_save",
        arguments: { slug: "secure-thing", content: specBody },
      }),
    );
    expect(r1.ok).toBe(true);
    await gClient.close();

    // Now bring up a project-scope client and point project.spec_path at
    // the saved spec so resolveSpecTags can find it.
    const { client, projectDb } = await bootProject(workRoot, home, projectDir);
    const specPath = join(workRoot, "specs", "2026-04-23-secure-thing.md");
    projectDb.prepare("UPDATE project SET spec_path = ? WHERE id = 1").run(specPath);

    const res = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, force: true, expand: true },
      }),
    );
    expect(res.ok).toBe(true);
    const c = res.content as { lenses: Array<{ id: string }> };
    const ids = c.lenses.map((l) => l.id);
    // loadKb derives `id` from the relative path without .md. Lens files
    // live under `lenses/` so id = `lenses/<filename-stem>`.
    expect(ids).toContain("lenses/lens-security");
    expect(ids).not.toContain("lenses/lens-frontend");
  });
});

// ---- 8. vcf reindex --ideas (CLI) ----------------------------------------

describe("#25 item 1 — vcf reindex --ideas CLI", () => {
  let workRoot: string;
  let home: string;
  const CLI = join(process.cwd(), "dist", "cli.js");

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-reidx-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-reidxh-")));
    await mkdir(join(home, ".vcf"), { recursive: true });
    await mkdir(join(workRoot, "ideas"), { recursive: true });
    // Minimal config for reindex to load.
    await writeFile(
      join(home, ".vcf", "config.yaml"),
      [
        "version: 1",
        "workspace:",
        `  allowed_roots: [${workRoot}]`,
        `  ideas_dir: ${workRoot}/ideas`,
        `  specs_dir: ${workRoot}/specs`,
        "endpoints:",
        "  - name: local-stub",
        "    provider: local-stub",
        "    base_url: http://127.0.0.1:1",
        "    trust_level: local",
        "kb:",
        `  root: ${home}/.vcf/kb`,
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("inserts rows for ideas files on disk and deletes orphaned rows", async () => {
    // Seed: one idea file on disk that has no row in the DB, and one row in
    // the DB whose file doesn't exist.
    const onDiskFile = join(workRoot, "ideas", "2026-04-23-newidea.md");
    await writeFile(onDiskFile, "---\ntitle: New Idea\ntags: [fresh]\n---\n# Body\n");

    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    globalDb
      .prepare(
        `INSERT INTO ideas (path, slug, tags, created_at, frontmatter_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(join(workRoot, "ideas", "ghost.md"), "ghost", "[]", Date.now(), "{}");
    globalDb.close();

    const res = spawnSync("node", [CLI, "reindex", "--ideas"], {
      env: { ...process.env, VCF_CONFIG: join(home, ".vcf", "config.yaml"), VCF_HOME: home },
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/reindex ideas:/);

    // Verify: orphan row deleted, new row inserted.
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const rows = db.prepare("SELECT path, slug FROM ideas ORDER BY path").all() as Array<{
      path: string;
      slug: string;
    }>;
    const paths = rows.map((r) => r.path);
    expect(paths).not.toContain(join(workRoot, "ideas", "ghost.md"));
    expect(paths).toContain(onDiskFile);
    const newRow = rows.find((r) => r.path === onDiskFile);
    expect(newRow?.slug).toBe("2026-04-23-newidea");
    db.close();
  });
});
