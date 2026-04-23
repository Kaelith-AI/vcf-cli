import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}
function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("test-surface tools (#12, #13, #14)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;
  let client: Client;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-testsurface-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-testsurfaceh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(projectDir, { recursive: true });

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
    client = new Client({ name: "ts", version: "0" }, { capabilities: {} });
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

  it("test_add_missing_case returns a scaffolding prompt that references the manifest", async () => {
    const plansDir = join(projectDir, "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "thing-plan.md"), "# thing plan\n");
    await writeFile(join(plansDir, "thing-todo.md"), "# thing todo\n");
    await writeFile(join(plansDir, "thing-manifest.md"), "# thing manifest\n- `src/thing.ts`\n");

    const res = await client.callTool({
      name: "test_add_missing_case",
      arguments: { plan_name: "thing", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      plan_name: string;
      scaffolding_prompt: string;
    };
    expect(content.plan_name).toBe("thing");
    expect(content.scaffolding_prompt).toContain("thing-manifest.md");
    expect(content.scaffolding_prompt).toContain("spec");
    expect(content.scaffolding_prompt).toContain("test_for_lesson");
  });

  it("conformance_check flags manifest files that don't exist on disk", async () => {
    const plansDir = join(projectDir, "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "demo-manifest.md"), "- `src/real.ts`\n- `src/missing.ts`\n");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(join(projectDir, "src", "real.ts"), "export {};\n");

    const res = await client.callTool({
      name: "conformance_check",
      arguments: { plan_name: "demo", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      verdict: string;
      findings: Array<{ kind: string; path: string; severity: string }>;
    };
    expect(content.verdict).toBe("BLOCK");
    const missing = content.findings.find((f) => f.kind === "missing-file");
    expect(missing).toBeDefined();
    expect(missing?.path).toBe("src/missing.ts");
    expect(missing?.severity).toBe("blocker");
  });

  it("test_stress returns a scaffolding prompt in llm-driven mode", async () => {
    const res = await client.callTool({
      name: "test_stress",
      arguments: { subject: "idea_capture", shape: "invalid-fuzz", count: 50, expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      mode: string;
      subject: string;
      scaffolding_prompt: string;
    };
    expect(content.mode).toBe("llm-driven");
    expect(content.subject).toBe("idea_capture");
    expect(content.scaffolding_prompt).toContain("idea_capture");
    expect(content.scaffolding_prompt).toContain("50 adversarial inputs");
  });

  it("test_qa returns a coverage matrix + scaffolding prompt", async () => {
    const res = await client.callTool({
      name: "test_qa",
      arguments: { stale_days: 7, expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      coverage: Array<{ tool: string; stale: boolean }>;
      scaffolding_prompt: string;
    };
    expect(Array.isArray(content.coverage)).toBe(true);
    expect(typeof content.scaffolding_prompt).toBe("string");
    expect(content.scaffolding_prompt).toContain("QA sweep");
  });

  it("review_type_create returns a multi-phase scaffolding prompt", async () => {
    // review_type_create is global-scope; the project-scope client above
    // can't reach it. Spin up a separate global-scope client.
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
    const server = createServer({
      scope: "global",
      resolved: { scope: "global" },
      config,
      globalDb,
      homeDir: home,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "rt", version: "0" }, { capabilities: {} });
    await c.connect(b);
    const res = await c.callTool({
      name: "review_type_create",
      arguments: { name: "skill", topic: "skill authoring quality", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      name: string;
      scaffolding_prompt: string;
      quality_reference: string;
    };
    expect(content.name).toBe("skill");
    expect(content.quality_reference).toBe("code");
    expect(content.scaffolding_prompt).toContain("Phase 1");
    expect(content.scaffolding_prompt).toContain("Phase 4");
    expect(content.scaffolding_prompt).toContain("review_type_apply");
    await c.close();
  });

  it("review_type_create rejects names already in config.review.categories", async () => {
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
    const server = createServer({
      scope: "global",
      resolved: { scope: "global" },
      config,
      globalDb,
      homeDir: home,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "rt2", version: "0" }, { capabilities: {} });
    await c.connect(b);
    const res = await c.callTool({
      name: "review_type_create",
      arguments: { name: "code", topic: "already exists" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_ALREADY_EXISTS");
    await c.close();
  });

  it("vibe_check flags `as any` + silent-catch + ts-ignore in source", async () => {
    const srcDir = join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    const body = [
      "export const x = fetch('/api').catch(() => {});",
      "const y = 42 as any;",
      "// @ts-ignore — because reasons",
      "",
    ].join("\n");
    await writeFile(join(srcDir, "offender.ts"), body);

    const res = await client.callTool({
      name: "vibe_check",
      arguments: { paths: ["src"], expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const content = env.content as {
      verdict: string;
      findings: Array<{ rule: string; path: string; line: number }>;
    };
    expect(content.verdict).toBe("NEEDS_WORK");
    const rules = new Set(content.findings.map((f) => f.rule));
    expect(rules.has("silent-catch")).toBe(true);
    expect(rules.has("as-any")).toBe(true);
    expect(rules.has("ts-ignore")).toBe(true);
  });
});
