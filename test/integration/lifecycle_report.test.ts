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
import { resetGlobalLessonsCache } from "../../src/db/globalLessons.js";
import {
  buildStructuredReport,
  renderStructuredMarkdown,
  runNarrativeCore,
  LifecycleReportInput,
} from "../../src/tools/lifecycle_report.js";
import {
  LIFECYCLE_REPORT_SCHEMA_VERSION,
  LIFECYCLE_SECTION_ORDER,
  LifecycleReportSchema,
} from "../../src/schemas/lifecycle-report.schema.js";
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

describe("lifecycle_report (Phase C)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-lc-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-lch-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(kbRoot, "standards"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await writeFile(join(kbRoot, "standards", "company-standards.md"), "# Standards\n");
    await writeFile(join(kbRoot, "reviewers", "reviewer-code.md"), "# Reviewer code");
    resetGlobalLessonsCache();
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    resetGlobalLessonsCache();
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
      lessons: { global_db_path: join(home, ".vcf", "lessons.db"), default_scope: "project" },
      defaults: { lifecycle_report: { endpoint: "local-stub", model: "test-model" } },
    });
  }

  async function bootProjectScope() {
    {
      const config = makeConfig();
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
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await client.connect(b);
      const init = await client.callTool({
        name: "project_init",
        arguments: { name: "Demo", target_dir: projectDir },
      });
      expect(parseResult(init).ok).toBe(true);
      globalDb.close();
    }
    const config = makeConfig();
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const dbPath = join(home, ".vcf", "projects", "demo", "project.db");
    const projectDb = openProjectDb({ path: dbPath });
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
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb, projectDb, config };
  }

  it("structured mode returns a valid LifecycleReport with all 8 sections", async () => {
    const { projectDb, globalDb } = await bootProjectScope();
    // Seed one lesson so its section isn't empty.
    projectDb
      .prepare(
        `INSERT INTO lessons (title, observation, scope, stage, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("seed lesson", "body", "project", "building", "[]", Date.now());

    const report = buildStructuredReport({
      projectDb,
      globalDb,
      projectRoot: projectDir,
      include: [...LIFECYCLE_SECTION_ORDER],
      auditRowCap: 500,
      recentCap: 50,
    });
    const validated = LifecycleReportSchema.parse(report);
    expect(validated.schema_version).toBe(LIFECYCLE_REPORT_SCHEMA_VERSION);
    expect(validated.sections.length).toBe(LIFECYCLE_SECTION_ORDER.length);
    const names = validated.sections.map((s) => s.section);
    expect(names).toEqual([...LIFECYCLE_SECTION_ORDER]);
    const lessons = validated.sections.find((s) => s.section === "lessons");
    if (lessons?.section === "lessons") {
      expect(lessons.count).toBe(1);
      expect(lessons.recent[0]?.title).toBe("seed lesson");
    }
  });

  it("markdown rendering produces a non-empty document with section headers", async () => {
    const { projectDb, globalDb } = await bootProjectScope();
    const report = buildStructuredReport({
      projectDb,
      globalDb,
      projectRoot: projectDir,
      include: [...LIFECYCLE_SECTION_ORDER],
      auditRowCap: 500,
      recentCap: 50,
    });
    const md = renderStructuredMarkdown(report, {
      jsonPath: "/tmp/fake.json",
      includedSections: [...LIFECYCLE_SECTION_ORDER],
    });
    expect(md).toContain("# Lifecycle Report (structured)");
    expect(md).toContain("## Project");
    expect(md).toContain("## Audit");
    expect(md).toContain("## Lessons");
  });

  it("tool call writes plans/lifecycle-report.{md,json}", async () => {
    const { client } = await bootProjectScope();
    const res = await client.callTool({
      name: "lifecycle_report",
      arguments: { mode: "structured", format: "both" },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    expect(env.paths?.some((p) => p.endsWith("lifecycle-report.md"))).toBe(true);
    expect(env.paths?.some((p) => p.endsWith("lifecycle-report.json"))).toBe(true);
  });

  it("narrative mode redacts audit / lesson content before sending to the LLM", async () => {
    const { projectDb, globalDb, config } = await bootProjectScope();
    // Seed a lesson whose TITLE contains an sk- key — title survives into the
    // lessons section's `recent[].title` field, which gets serialized into
    // the narrative prompt. Redaction must fire before the prompt leaves.
    projectDb
      .prepare(
        `INSERT INTO lessons (title, observation, scope, stage, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "canary sk-proj-abc12345XYZ67890defGHIJKLmno",
        "body",
        "project",
        "building",
        "[]",
        Date.now(),
      );

    const report = buildStructuredReport({
      projectDb,
      globalDb,
      projectRoot: projectDir,
      include: ["project", "lessons"],
      auditRowCap: 50,
      recentCap: 10,
    });

    const observed: Array<{ body: unknown }> = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      observed.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Short narrative prose." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const parsed = LifecycleReportInput.parse({
      mode: "narrative",
      format: "md",
      endpoint: "local-stub",
      model_id: "test-model",
      allow_public_endpoint: false,
    });
    const result = await runNarrativeCore({
      config,
      parsed,
      report,
      fetchImpl: mockFetch,
    });
    expect(result.modelId).toBe("test-model");

    // Exactly one LLM call per non-project section. Project is skipped.
    expect(observed.length).toBe(1);
    const sent = JSON.stringify(observed[0]?.body ?? {});
    // The sk-* canary must be redacted before leaving the box.
    expect(sent).not.toContain("sk-proj-abc12345XYZ67890defGHIJKLmno");
    expect(sent).toContain("[REDACTED:openai-key]");
  });
});
