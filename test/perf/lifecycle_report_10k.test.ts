import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../../src/db/migrate.js";
import { GLOBAL_MIGRATIONS, PROJECT_MIGRATIONS } from "../../src/db/schema.js";
import {
  buildStructuredReport,
  renderStructuredMarkdown,
  runNarrativeCore,
  LifecycleReportInput,
} from "../../src/tools/lifecycle_report.js";
import { LIFECYCLE_SECTION_ORDER } from "../../src/schemas/lifecycle-report.schema.js";
import { ConfigSchema } from "../../src/config/schema.js";

// Perf fixture per the plan: 10k audit rows, 500 artifacts, 100 review runs.
// Structured mode < 2s. Narrative mode < 60s against a mocked LLM (the real
// wall-clock target assumes an already-warm local model; CI mocks the call).

const AUDIT_ROWS = 10_000;
const ARTIFACTS = 500;
const REVIEW_RUNS = 100;
const RESPONSE_LOG_ROWS = 50;
const BUILDS = 30;
const LESSONS = 200;

describe("lifecycle_report perf @ 10k audit rows", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;
  let projectDb: DatabaseSync;
  let globalDb: DatabaseSync;
  let lessonsDb: DatabaseSync;

  beforeAll(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-lcperf-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-lcperfh-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(home, ".vcf"), { recursive: true });

    const now = Date.now();

    globalDb = new DatabaseSync(join(home, ".vcf", "vcf.db"), {
      enableForeignKeyConstraints: true,
    });
    globalDb.exec("PRAGMA journal_mode = WAL");
    globalDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(globalDb, GLOBAL_MIGRATIONS);

    projectDb = new DatabaseSync(join(projectDir, ".vcf", "project.db"), {
      enableForeignKeyConstraints: true,
    });
    projectDb.exec("PRAGMA journal_mode = WAL");
    projectDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(projectDb, PROJECT_MIGRATIONS);
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at, spec_path, adopted)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("perf-project", projectDir, "reviewing", now, now, null, 0);

    // Batch inserts for speed.
    const insertAudit = globalDb.prepare(
      `INSERT INTO audit (ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, endpoint, result_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    globalDb.exec("BEGIN");
    const tools = [
      "spec_save",
      "plan_save",
      "review_execute",
      "response_log_add",
      "lesson_log_add",
      "lifecycle_report",
    ];
    for (let i = 0; i < AUDIT_ROWS; i++) {
      insertAudit.run(
        now - (AUDIT_ROWS - i) * 60_000,
        tools[i % tools.length],
        "project",
        projectDir,
        null,
        "sha256:" + "a".repeat(64),
        "sha256:" + "b".repeat(64),
        i % 5 === 0 ? "local-ollama" : null,
        i % 17 === 0 ? "E_VALIDATION" : "ok",
      );
    }
    globalDb.exec("COMMIT");

    const insertArtifact = projectDb.prepare(
      `INSERT INTO artifacts (path, kind, frontmatter_json, mtime, hash)
       VALUES (?, ?, ?, ?, ?)`,
    );
    projectDb.exec("BEGIN");
    for (let i = 0; i < ARTIFACTS; i++) {
      insertArtifact.run(
        `${projectDir}/artifact-${i}.md`,
        i % 3 === 0 ? "spec" : i % 3 === 1 ? "plan" : "memory",
        "{}",
        now - i * 1000,
        "hash" + i,
      );
    }
    projectDb.exec("COMMIT");

    const insertReview = projectDb.prepare(
      `INSERT INTO review_runs (id, type, stage, status, started_at, finished_at, report_path, verdict, carry_forward_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    projectDb.exec("BEGIN");
    const types = ["code", "security", "production"];
    const verdicts = ["PASS", "NEEDS_WORK", "PASS", "PASS", "PASS"];
    for (let i = 0; i < REVIEW_RUNS; i++) {
      insertReview.run(
        `${types[i % 3]}-${(i % 9) + 1}-${now}-${i}`,
        types[i % 3],
        (i % 9) + 1,
        "submitted",
        now - i * 60_000,
        now - i * 60_000 + 30_000,
        `${projectDir}/plans/reviews/${types[i % 3]}/stage-${(i % 9) + 1}-x.md`,
        verdicts[i % verdicts.length] ?? "PASS",
        "{}",
      );
    }
    projectDb.exec("COMMIT");

    const insertResponse = projectDb.prepare(
      `INSERT INTO response_log (run_id, finding_ref, builder_claim, response_text, references_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    projectDb.exec("BEGIN");
    for (let i = 0; i < RESPONSE_LOG_ROWS; i++) {
      insertResponse.run(
        `run-${i}`,
        i % 3 === 0 ? null : `code:stage-${i % 9}:finding-${i}`,
        i % 2 === 0 ? "agree" : "disagree",
        `response body ${i}`,
        "[]",
        now - i * 1000,
      );
    }
    projectDb.exec("COMMIT");

    const insertBuild = projectDb.prepare(
      `INSERT INTO builds (target, started_at, finished_at, status, output_path)
       VALUES (?, ?, ?, ?, ?)`,
    );
    projectDb.exec("BEGIN");
    for (let i = 0; i < BUILDS; i++) {
      insertBuild.run(
        i % 2 === 0 ? "npm" : "tsup",
        now - i * 3600_000,
        now - i * 3600_000 + 120_000,
        i % 5 === 0 ? "failed" : "success",
        null,
      );
    }
    projectDb.exec("COMMIT");

    // #41: lessons live in the global store, tagged with project_root.
    const { GLOBAL_LESSONS_MIGRATIONS } = await import("../../src/db/globalLessons.js");
    lessonsDb = new DatabaseSync(join(home, ".vcf", "lessons.db"), {
      enableForeignKeyConstraints: true,
    });
    lessonsDb.exec("PRAGMA journal_mode = WAL");
    lessonsDb.exec("PRAGMA synchronous = NORMAL");
    runMigrations(lessonsDb, GLOBAL_LESSONS_MIGRATIONS);
    const insertLesson = lessonsDb.prepare(
      `INSERT INTO lessons (project_root, title, observation, scope, stage, tags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    lessonsDb.exec("BEGIN");
    for (let i = 0; i < LESSONS; i++) {
      insertLesson.run(
        projectDir,
        `lesson ${i}`,
        `observation body ${i}`,
        i % 5 === 0 ? "universal" : "project",
        null,
        JSON.stringify(i % 3 === 0 ? ["perf", "fixture"] : ["perf"]),
        now - i * 60_000,
      );
    }
    lessonsDb.exec("COMMIT");
  }, 120_000);

  afterAll(async () => {
    projectDb.close();
    globalDb.close();
    try {
      lessonsDb.close();
    } catch {
      /* noop */
    }
    await rm(workRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("structured mode completes under 2s", () => {
    const t0 = performance.now();
    const report = buildStructuredReport({
      projectDb,
      globalDb,
      lessonsDb,
      projectRoot: projectDir,
      include: [...LIFECYCLE_SECTION_ORDER],
      auditRowCap: 500,
      recentCap: 50,
    });
    const rendered = renderStructuredMarkdown(report, {
      jsonPath: "/tmp/perf.json",
      includedSections: [...LIFECYCLE_SECTION_ORDER],
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Sanity: the report reflects the seeded fixture sizes.
    const audit = report.sections.find((s) => s.section === "audit");
    if (audit?.section === "audit") expect(audit.counts.total).toBe(AUDIT_ROWS);
    const artifacts = report.sections.find((s) => s.section === "artifacts");
    if (artifacts?.section === "artifacts") expect(artifacts.count).toBe(ARTIFACTS);
    expect(rendered.length).toBeGreaterThan(500);
  });

  it("narrative mode completes under 60s with mocked LLM", async () => {
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
      defaults: { lifecycle_report: { endpoint: "local-stub", model: "mock" } },
    });
    const report = buildStructuredReport({
      projectDb,
      globalDb,
      lessonsDb,
      projectRoot: projectDir,
      include: [...LIFECYCLE_SECTION_ORDER],
      auditRowCap: 500,
      recentCap: 50,
    });
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "narrative prose." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const parsed = LifecycleReportInput.parse({
      mode: "narrative",
      format: "md",
      endpoint: "local-stub",
      model_id: "mock",
    });
    const t0 = performance.now();
    const result = await runNarrativeCore({ config, parsed, report, fetchImpl: mockFetch });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(60_000);
    // Provenance frontmatter at top of markdown (replaced legacy "generated_by" footer).
    expect(result.markdown).toContain("provenance:");
    expect(result.markdown).toContain("tool: lifecycle_report");
    expect(result.markdown).toContain("phase: lifecycle-narrative");
    expect(result.markdown).toContain("mock");
  });
});
