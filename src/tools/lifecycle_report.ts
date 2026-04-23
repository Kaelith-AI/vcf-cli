// lifecycle_report — project scope.
//
// Emit a point-in-time lifecycle snapshot of the project, assembled from
// the DBs the server already maintains (project.db.artifacts /
// review_runs / decisions / response_log / builds / lessons, and the
// global audit trail filtered to this project_root).
//
// Two modes:
//   structured  — deterministic, no LLM. Target: <2s on a 10k-audit-row
//                 project. Emits a versioned JSON (stable shape) +
//                 rendered markdown view.
//   narrative   — fan-out per-section LLM calls that summarize the
//                 structured data as vibe-coder prose. Target: <60s on
//                 the same dataset. Output carries a generated_by
//                 footer naming the model + endpoint, and links to the
//                 structured JSON so a reader can cross-check the prose.
//
// Envelope follows best-practices/mcp-tool-surface-token-economy.md:
// paths + summary by default; content behind `expand=true`. Writes land
// in `<project>/plans/lifecycle-report.md` and `.json`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { resolveOutputs } from "../util/outputs.js";
import { getGlobalLessonsDb } from "../db/globalLessons.js";
import { McpError } from "../errors.js";
import { callChatCompletion, LlmError, type ChatMessage } from "../util/llmClient.js";
import {
  LIFECYCLE_REPORT_SCHEMA_VERSION,
  LIFECYCLE_SECTION_ORDER,
  type LifecycleReport,
  type LifecycleSection,
  type LifecycleSectionName,
} from "../schemas/lifecycle-report.schema.js";

const SECTION_ENUM = z.enum(LIFECYCLE_SECTION_ORDER);

const LifecycleReportInput = z
  .object({
    mode: z.enum(["structured", "narrative"]).default("structured"),
    format: z.enum(["md", "json", "both"]).default("md"),
    endpoint: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe("narrative-mode endpoint; falls back to config.defaults.lifecycle_report"),
    model_id: z.string().min(1).max(128).optional(),
    include: z.array(SECTION_ENUM).max(LIFECYCLE_SECTION_ORDER.length).optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(180_000),
    allow_public_endpoint: z.boolean().default(false),
    expand: z.boolean().default(false),
  })
  .strict();

type LifecycleReportArgs = z.infer<typeof LifecycleReportInput>;

export function registerLifecycleReport(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "lifecycle_report",
    {
      title: "Project Lifecycle Report",
      description:
        "Emit a structured (no-LLM) or narrative (per-section LLM fan-out) lifecycle snapshot covering audit, artifacts, reviews, decisions, responses, builds, and lessons. Writes markdown + JSON under plans/. Token-economy envelope: paths+summary by default, content behind expand.",
      inputSchema: LifecycleReportInput,
    },
    async (args: LifecycleReportArgs, extra: { signal?: AbortSignal }) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "lifecycle_report requires project scope");
          }
          const parsed = LifecycleReportInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const include: LifecycleSectionName[] = parsed.include ?? [...LIFECYCLE_SECTION_ORDER];
          const lessonsDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          const report = buildStructuredReport({
            projectDb: deps.projectDb,
            globalDb: deps.globalDb,
            lessonsDb,
            projectRoot: root,
            include,
            auditRowCap: deps.config.report.audit_rows_per_section,
            recentCap: deps.config.report.recent_rows_per_section,
          });

          const outDir = resolveOutputs(root, deps.config).lifecycleReportDir;
          await assertInsideAllowedRoot(outDir, deps.config.workspace.allowed_roots);
          await mkdir(outDir, { recursive: true });
          const jsonPath = join(outDir, "lifecycle-report.json");
          const mdPath = join(outDir, "lifecycle-report.md");

          await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");

          let narrativeMarkdown: string | null = null;
          let narrativeMeta: { endpoint: string; model_id: string } | null = null;
          if (parsed.mode === "narrative") {
            const result = await runNarrative(deps, parsed, report, extra?.signal);
            narrativeMarkdown = result.markdown;
            narrativeMeta = { endpoint: result.endpoint, model_id: result.modelId };
          }

          const rendered =
            narrativeMarkdown ??
            renderStructuredMarkdown(report, {
              jsonPath,
              includedSections: include,
            });
          await writeFile(mdPath, rendered, "utf8");

          const paths = buildPaths(parsed.format, jsonPath, mdPath);
          const summaryParts: string[] = [
            `lifecycle_report mode=${parsed.mode}`,
            `sections=${include.length}`,
          ];
          if (narrativeMeta) {
            summaryParts.push(`model=${narrativeMeta.model_id}@${narrativeMeta.endpoint}`);
          }

          return success(paths, summaryParts.join("; "), {
            content: {
              mode: parsed.mode,
              format: parsed.format,
              schema_version: LIFECYCLE_REPORT_SCHEMA_VERSION,
              json_path: jsonPath,
              markdown_path: mdPath,
              sections: report.sections.map((s) => s.section),
              narrative: narrativeMeta,
              ...(parsed.expand
                ? { report, markdown: rendered }
                : {
                    expand_hint:
                      "Pass expand=true for the inlined structured report + rendered markdown.",
                  }),
            },
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "lifecycle_report",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Structured assembly
// ---------------------------------------------------------------------------

interface BuildOpts {
  projectDb: DatabaseSync;
  globalDb: DatabaseSync;
  /** Global lessons+feedback DB, or null when disabled via config.lessons.global_db_path: null. */
  lessonsDb: DatabaseSync | null;
  projectRoot: string;
  include: LifecycleSectionName[];
  auditRowCap: number;
  recentCap: number;
}

export function buildStructuredReport(opts: BuildOpts): LifecycleReport {
  const sections: LifecycleSection[] = [];
  for (const name of opts.include) {
    const section = buildSection(name, opts);
    if (section) sections.push(section);
  }
  return {
    schema_version: LIFECYCLE_REPORT_SCHEMA_VERSION,
    generated_at: Date.now(),
    project_root: opts.projectRoot,
    sections,
  };
}

function buildSection(name: LifecycleSectionName, opts: BuildOpts): LifecycleSection | null {
  switch (name) {
    case "project":
      return buildProjectSection(opts);
    case "audit":
      return buildAuditSection(opts);
    case "artifacts":
      return buildArtifactsSection(opts);
    case "reviews":
      return buildReviewsSection(opts);
    case "decisions":
      return buildDecisionsSection(opts);
    case "responses":
      return buildResponsesSection(opts);
    case "builds":
      return buildBuildsSection(opts);
    case "lessons":
      return buildLessonsSection(opts);
    default:
      return null;
  }
}

function buildProjectSection(opts: BuildOpts): LifecycleSection {
  const row = opts.projectDb
    .prepare(
      "SELECT name, root_path, state, adopted, created_at, updated_at, spec_path FROM project WHERE id=1",
    )
    .get() as
    | {
        name: string;
        root_path: string;
        state: string;
        adopted: number;
        created_at: number;
        updated_at: number;
        spec_path: string | null;
      }
    | undefined;
  if (!row) throw new McpError("E_STATE_INVALID", "project row missing");
  return {
    section: "project",
    summary: {
      name: row.name,
      root_path: row.root_path,
      state: row.state,
      adopted: row.adopted === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      spec_path: row.spec_path,
    },
  };
}

function buildAuditSection(opts: BuildOpts): LifecycleSection {
  const counts = opts.globalDb
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN result_code='ok' THEN 1 ELSE 0 END) AS ok_count,
         SUM(CASE WHEN result_code<>'ok' THEN 1 ELSE 0 END) AS err_count,
         MIN(ts) AS earliest,
         MAX(ts) AS latest
       FROM audit
       WHERE project_root = ?`,
    )
    .get(opts.projectRoot) as
    | { total: number; ok_count: number | null; err_count: number | null; earliest: number | null; latest: number | null }
    | undefined;

  const byToolRows = opts.globalDb
    .prepare(
      `SELECT tool, COUNT(*) AS n FROM audit WHERE project_root = ? GROUP BY tool ORDER BY n DESC`,
    )
    .all(opts.projectRoot) as unknown as Array<{ tool: string; n: number }>;
  const by_tool: Record<string, number> = {};
  for (const r of byToolRows) by_tool[r.tool] = r.n;

  const recent = opts.globalDb
    .prepare(
      `SELECT ts, tool, scope, result_code, endpoint
         FROM audit
        WHERE project_root = ?
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(opts.projectRoot, opts.auditRowCap) as unknown as Array<{
    ts: number;
    tool: string;
    scope: string;
    result_code: string;
    endpoint: string | null;
  }>;

  return {
    section: "audit",
    counts: {
      total: counts?.total ?? 0,
      ok: counts?.ok_count ?? 0,
      errors: counts?.err_count ?? 0,
      by_tool,
      earliest_ts: counts?.earliest ?? null,
      latest_ts: counts?.latest ?? null,
    },
    recent,
    row_cap: opts.auditRowCap,
  };
}

function buildArtifactsSection(opts: BuildOpts): LifecycleSection {
  const total = (
    opts.projectDb.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }
  ).n;
  const byKindRows = opts.projectDb
    .prepare("SELECT kind, COUNT(*) AS n FROM artifacts GROUP BY kind ORDER BY n DESC")
    .all() as unknown as Array<{ kind: string; n: number }>;
  const by_kind: Record<string, number> = {};
  for (const r of byKindRows) by_kind[r.kind] = r.n;

  const recent = opts.projectDb
    .prepare(
      "SELECT path, kind, mtime, hash FROM artifacts ORDER BY mtime DESC LIMIT ?",
    )
    .all(opts.recentCap) as unknown as Array<{
    path: string;
    kind: string;
    mtime: number;
    hash: string;
  }>;

  return { section: "artifacts", count: total, by_kind, recent };
}

function buildReviewsSection(opts: BuildOpts): LifecycleSection {
  const total = (
    opts.projectDb.prepare("SELECT COUNT(*) AS n FROM review_runs").get() as { n: number }
  ).n;
  const byVerdictRows = opts.projectDb
    .prepare(
      "SELECT COALESCE(verdict,'(pending)') AS verdict, COUNT(*) AS n FROM review_runs GROUP BY verdict ORDER BY n DESC",
    )
    .all() as unknown as Array<{ verdict: string; n: number }>;
  const by_verdict: Record<string, number> = {};
  for (const r of byVerdictRows) by_verdict[r.verdict] = r.n;

  const byTypeRows = opts.projectDb
    .prepare("SELECT type, COUNT(*) AS n FROM review_runs GROUP BY type ORDER BY n DESC")
    .all() as unknown as Array<{ type: string; n: number }>;
  const by_type: Record<string, number> = {};
  for (const r of byTypeRows) by_type[r.type] = r.n;

  const recent = opts.projectDb
    .prepare(
      `SELECT id, type, stage, status, verdict, started_at, finished_at, report_path
         FROM review_runs
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(opts.recentCap) as unknown as Array<{
    id: string;
    type: string;
    stage: number;
    status: string;
    verdict: string | null;
    started_at: number;
    finished_at: number | null;
    report_path: string | null;
  }>;

  return { section: "reviews", count: total, by_verdict, by_type, recent };
}

function buildDecisionsSection(opts: BuildOpts): LifecycleSection {
  const entries = opts.projectDb
    .prepare("SELECT slug, path, created_at FROM decisions ORDER BY created_at ASC")
    .all() as unknown as Array<{ slug: string; path: string; created_at: number }>;
  return { section: "decisions", count: entries.length, entries };
}

function buildResponsesSection(opts: BuildOpts): LifecycleSection {
  const total = (
    opts.projectDb.prepare("SELECT COUNT(*) AS n FROM response_log").get() as { n: number }
  ).n;
  const byClaimRows = opts.projectDb
    .prepare(
      "SELECT builder_claim, COUNT(*) AS n FROM response_log GROUP BY builder_claim ORDER BY n DESC",
    )
    .all() as unknown as Array<{ builder_claim: string; n: number }>;
  const by_claim: Record<string, number> = {};
  for (const r of byClaimRows) by_claim[r.builder_claim] = r.n;

  const recent = (
    opts.projectDb
      .prepare(
        `SELECT id, run_id, finding_ref, builder_claim, created_at,
                CASE WHEN migration_note IS NULL THEN 0 ELSE 1 END AS has_note
           FROM response_log
           ORDER BY id DESC
           LIMIT ?`,
      )
      .all(opts.recentCap) as unknown as Array<{
      id: number;
      run_id: string;
      finding_ref: string | null;
      builder_claim: string;
      created_at: number;
      has_note: number;
    }>
  ).map((r) => ({
    id: r.id,
    run_id: r.run_id,
    finding_ref: r.finding_ref,
    builder_claim: r.builder_claim,
    created_at: r.created_at,
    has_migration_note: r.has_note === 1,
  }));

  return { section: "responses", count: total, by_claim, recent };
}

function buildBuildsSection(opts: BuildOpts): LifecycleSection {
  const total = (
    opts.projectDb.prepare("SELECT COUNT(*) AS n FROM builds").get() as { n: number }
  ).n;
  const byStatusRows = opts.projectDb
    .prepare("SELECT status, COUNT(*) AS n FROM builds GROUP BY status ORDER BY n DESC")
    .all() as unknown as Array<{ status: string; n: number }>;
  const by_status: Record<string, number> = {};
  for (const r of byStatusRows) by_status[r.status] = r.n;

  const recent = opts.projectDb
    .prepare(
      `SELECT id, target, status, started_at, finished_at, output_path
         FROM builds
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(opts.recentCap) as unknown as Array<{
    id: number;
    target: string;
    status: string;
    started_at: number;
    finished_at: number | null;
    output_path: string | null;
  }>;

  return { section: "builds", count: total, by_status, recent };
}

function buildLessonsSection(opts: BuildOpts): LifecycleSection {
  // #41: lessons live in the global store, tagged with project_root.
  // When the store is disabled (global_db_path: null), the section reports
  // zero rows rather than failing — lifecycle_report is a summary, not a
  // strict check.
  if (opts.lessonsDb === null) {
    return { section: "lessons", count: 0, by_scope: {}, recent: [] };
  }
  const total = (
    opts.lessonsDb
      .prepare("SELECT COUNT(*) AS n FROM lessons WHERE project_root = ?")
      .get(opts.projectRoot) as { n: number }
  ).n;
  const byScopeRows = opts.lessonsDb
    .prepare(
      "SELECT scope, COUNT(*) AS n FROM lessons WHERE project_root = ? GROUP BY scope ORDER BY n DESC",
    )
    .all(opts.projectRoot) as unknown as Array<{ scope: string; n: number }>;
  const by_scope: Record<string, number> = {};
  for (const r of byScopeRows) by_scope[r.scope] = r.n;

  const recent = (
    opts.lessonsDb
      .prepare(
        `SELECT id, title, scope, stage, tags_json, created_at
           FROM lessons
           WHERE project_root = ?
           ORDER BY created_at DESC
           LIMIT ?`,
      )
      .all(opts.projectRoot, opts.recentCap) as unknown as Array<{
      id: number;
      title: string;
      scope: string;
      stage: string | null;
      tags_json: string;
      created_at: number;
    }>
  ).map((r) => ({
    id: r.id,
    title: r.title,
    scope: r.scope,
    stage: r.stage,
    tags: safeParseTags(r.tags_json),
    created_at: r.created_at,
  }));

  return { section: "lessons", count: total, by_scope, recent };
}

function safeParseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering (structured + narrative)
// ---------------------------------------------------------------------------

export function renderStructuredMarkdown(
  report: LifecycleReport,
  opts: { jsonPath: string; includedSections: LifecycleSectionName[] },
): string {
  const lines: string[] = [];
  lines.push("# Lifecycle Report (structured)");
  lines.push("");
  lines.push(
    `> Generated ${new Date(report.generated_at).toISOString()} · schema ${LIFECYCLE_REPORT_SCHEMA_VERSION} · ${report.sections.length} section(s).`,
  );
  lines.push(`> Structured JSON: \`${opts.jsonPath}\``);
  lines.push("");
  for (const section of report.sections) {
    lines.push(...renderSectionMarkdown(section));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function renderSectionMarkdown(section: LifecycleSection): string[] {
  const lines: string[] = [];
  const title = sectionTitle(section.section);
  lines.push(`## ${title}`);
  lines.push("");
  switch (section.section) {
    case "project":
      lines.push(`- name: ${section.summary.name}`);
      lines.push(`- state: ${section.summary.state}`);
      lines.push(`- adopted: ${section.summary.adopted}`);
      lines.push(
        `- created: ${new Date(section.summary.created_at).toISOString()} · updated: ${new Date(section.summary.updated_at).toISOString()}`,
      );
      if (section.summary.spec_path) lines.push(`- spec: \`${section.summary.spec_path}\``);
      break;
    case "audit":
      lines.push(
        `- total: ${section.counts.total} (ok ${section.counts.ok} / errors ${section.counts.errors})`,
      );
      if (section.counts.earliest_ts && section.counts.latest_ts) {
        lines.push(
          `- span: ${new Date(section.counts.earliest_ts).toISOString()} → ${new Date(section.counts.latest_ts).toISOString()}`,
        );
      }
      lines.push(`- top tools: ${renderTopCounts(section.counts.by_tool, 6)}`);
      lines.push(
        `- recent (${section.recent.length} / cap ${section.row_cap}): ${renderRecentTs(section.recent.slice(0, 5).map((r) => ({ ts: r.ts, label: `${r.tool}:${r.result_code}` })))}`,
      );
      break;
    case "artifacts":
      lines.push(`- count: ${section.count}`);
      lines.push(`- by kind: ${renderTopCounts(section.by_kind, 8)}`);
      if (section.recent.length > 0) {
        lines.push(`- recent:`);
        for (const a of section.recent.slice(0, 5)) {
          lines.push(`  - \`${a.path}\` · ${a.kind} · ${new Date(a.mtime).toISOString()}`);
        }
      }
      break;
    case "reviews":
      lines.push(`- count: ${section.count}`);
      lines.push(`- verdicts: ${renderTopCounts(section.by_verdict)}`);
      lines.push(`- types: ${renderTopCounts(section.by_type)}`);
      if (section.recent.length > 0) {
        lines.push(`- recent:`);
        for (const r of section.recent.slice(0, 5)) {
          lines.push(
            `  - \`${r.id}\` · ${r.type} stage ${r.stage} · ${r.status}${r.verdict ? ` (${r.verdict})` : ""}`,
          );
        }
      }
      break;
    case "decisions":
      lines.push(`- count: ${section.count}`);
      for (const d of section.entries.slice(0, 10)) {
        lines.push(`  - \`${d.slug}\` · ${new Date(d.created_at).toISOString()}`);
      }
      break;
    case "responses":
      lines.push(`- count: ${section.count}`);
      lines.push(`- claims: ${renderTopCounts(section.by_claim)}`);
      for (const r of section.recent.slice(0, 5)) {
        lines.push(
          `  - #${r.id} · ${r.run_id}${r.finding_ref ? ` :: ${r.finding_ref}` : ""} · ${r.builder_claim}${r.has_migration_note ? " · [migrated]" : ""}`,
        );
      }
      break;
    case "builds":
      lines.push(`- count: ${section.count}`);
      lines.push(`- statuses: ${renderTopCounts(section.by_status)}`);
      for (const b of section.recent.slice(0, 5)) {
        lines.push(`  - #${b.id} · ${b.target} · ${b.status}`);
      }
      break;
    case "lessons":
      lines.push(`- count: ${section.count}`);
      lines.push(`- scopes: ${renderTopCounts(section.by_scope)}`);
      for (const l of section.recent.slice(0, 8)) {
        lines.push(
          `  - #${l.id} · ${l.title}${l.stage ? ` · stage=${l.stage}` : ""}${l.tags.length > 0 ? ` · [${l.tags.join(", ")}]` : ""}`,
        );
      }
      break;
  }
  return lines;
}

function renderTopCounts(obj: Record<string, number>, max = 8): string {
  const entries = Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  if (entries.length === 0) return "_none_";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function renderRecentTs(items: Array<{ ts: number; label: string }>): string {
  if (items.length === 0) return "_none_";
  return items.map((x) => `${new Date(x.ts).toISOString().slice(11, 19)} ${x.label}`).join(" · ");
}

function sectionTitle(name: LifecycleSectionName): string {
  return name[0]!.toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// Narrative mode (per-section LLM fan-out)
// ---------------------------------------------------------------------------

interface NarrativeResult {
  markdown: string;
  endpoint: string;
  modelId: string;
}

export interface RunNarrativeOpts {
  config: ServerDeps["config"];
  parsed: LifecycleReportArgs;
  report: LifecycleReport;
  mcpSignal?: AbortSignal | undefined;
  /** Injected fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

async function runNarrative(
  deps: ServerDeps,
  parsed: LifecycleReportArgs,
  report: LifecycleReport,
  mcpSignal: AbortSignal | undefined,
): Promise<NarrativeResult> {
  return runNarrativeCore({ config: deps.config, parsed, report, mcpSignal });
}

export async function runNarrativeCore(opts: RunNarrativeOpts): Promise<NarrativeResult> {
  const { config, parsed, report, mcpSignal } = opts;
  const endpointFromDefaults = parsed.endpoint === undefined;
  const endpointName =
    parsed.endpoint ?? config.defaults?.lifecycle_report?.endpoint;
  if (!endpointName) {
    throw new McpError(
      "E_VALIDATION",
      "narrative mode needs endpoint (arg or config.defaults.lifecycle_report.endpoint)",
    );
  }
  const endpoint = config.endpoints.find((e) => e.name === endpointName);
  if (!endpoint) {
    throw new McpError(
      "E_VALIDATION",
      `endpoint '${endpointName}' not declared in config.endpoints`,
    );
  }
  // Same defaults-resolution gate as review_execute: public trust always
  // requires opt-in; silent defaults routing to any non-local endpoint also
  // requires opt-in. Explicit endpoint arg (narrative mode's --frontier CLI
  // or `endpoint: "..."` MCP arg) is the consent signal.
  if (endpoint.trust_level === "public" && !parsed.allow_public_endpoint) {
    throw new McpError(
      "E_STATE_INVALID",
      `endpoint '${endpoint.name}' has trust_level='public'; pass allow_public_endpoint=true to override`,
    );
  }
  if (
    endpointFromDefaults &&
    endpoint.trust_level !== "local" &&
    !parsed.allow_public_endpoint
  ) {
    throw new McpError(
      "E_STATE_INVALID",
      `endpoint '${endpoint.name}' resolved from config.defaults.lifecycle_report.endpoint has ` +
        `trust_level='${endpoint.trust_level}'; either pass endpoint explicitly to ` +
        `acknowledge the off-host route or set allow_public_endpoint=true`,
    );
  }
  const modelId =
    parsed.model_id ?? config.defaults?.lifecycle_report?.model;
  if (!modelId) {
    throw new McpError(
      "E_VALIDATION",
      "narrative mode needs model (arg or config.defaults.lifecycle_report.model)",
    );
  }
  let apiKey: string | undefined;
  if (endpoint.auth_env_var) {
    apiKey = process.env[endpoint.auth_env_var];
    if (!apiKey && endpoint.trust_level !== "local") {
      throw new McpError(
        "E_CONFIG_MISSING_ENV",
        `env var ${endpoint.auth_env_var} is unset; endpoint '${endpoint.name}' needs it`,
      );
    }
  }
  const providerOptions = endpoint.provider_options as
    | Record<string, unknown>
    | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);
  const onAbort = (): void => ctrl.abort();
  mcpSignal?.addEventListener("abort", onAbort);

  try {
    const sectionProses: Array<{ section: string; prose: string }> = [];
    for (const section of report.sections) {
      if (section.section === "project") {
        // Project section has no LLM-worthy content beyond the summary.
        continue;
      }
      const messages = buildNarrativePrompt(section);
      const redactedMessages = redact(messages) as ChatMessage[];
      let prose: string;
      try {
        prose = await callChatCompletion({
          baseUrl: endpoint.base_url,
          apiKey,
          model: modelId,
          messages: redactedMessages,
          temperature: 0.2,
          signal: ctrl.signal,
          ...(providerOptions ? { providerOptions } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
      } catch (e) {
        if (e instanceof LlmError) {
          if (e.kind === "canceled") throw new McpError("E_CANCELED", e.message);
          if (e.kind === "unreachable") {
            throw new McpError("E_ENDPOINT_UNREACHABLE", e.message);
          }
          throw new McpError("E_INTERNAL", `narrative LLM call failed: ${e.kind}`, e.message);
        }
        throw e;
      }
      sectionProses.push({ section: section.section, prose: prose.trim() });
    }

    const markdown = composeNarrativeMarkdown({
      report,
      sectionProses,
      modelId,
      endpointName: endpoint.name,
    });
    return { markdown, endpoint: endpoint.name, modelId };
  } finally {
    clearTimeout(timer);
    mcpSignal?.removeEventListener("abort", onAbort);
  }
}

function buildNarrativePrompt(section: LifecycleSection): ChatMessage[] {
  const sectionTitleText = sectionTitle(section.section);
  const system = [
    "You are summarizing one section of a project lifecycle report for a vibe coder.",
    "Write 1-3 tight paragraphs (no headers, no bullet lists).",
    "Focus on activity patterns, verdicts, counts, and any signal in the data — not on restating numbers.",
    "If the section is empty, say so in one short sentence.",
    "Do not invent content that isn't in the structured data.",
  ].join(" ");
  const user = [
    `# ${sectionTitleText}`,
    "",
    "Structured data for this section (JSON):",
    "",
    "```json",
    JSON.stringify(section, null, 2),
    "```",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function composeNarrativeMarkdown(opts: {
  report: LifecycleReport;
  sectionProses: Array<{ section: string; prose: string }>;
  modelId: string;
  endpointName: string;
}): string {
  const lines: string[] = [];
  lines.push("# Lifecycle Report (narrative)");
  lines.push("");
  lines.push(
    `> Generated ${new Date(opts.report.generated_at).toISOString()} · schema ${LIFECYCLE_REPORT_SCHEMA_VERSION}.`,
  );
  lines.push(`> Structured JSON: see \`plans/lifecycle-report.json\`.`);
  lines.push("");

  const projectSection = opts.report.sections.find((s) => s.section === "project");
  if (projectSection && projectSection.section === "project") {
    lines.push("## Project");
    lines.push("");
    lines.push(
      `**${projectSection.summary.name}** — state: ${projectSection.summary.state} · ${projectSection.summary.adopted ? "adopted" : "scaffolded"} · last update ${new Date(projectSection.summary.updated_at).toISOString()}.`,
    );
    lines.push("");
  }

  for (const p of opts.sectionProses) {
    lines.push(`## ${sectionTitle(p.section as LifecycleSectionName)}`);
    lines.push("");
    lines.push(p.prose);
    lines.push("");
  }

  lines.push("---");
  lines.push(`generated_by: { model_id: "${opts.modelId}", endpoint: "${opts.endpointName}" }`);
  return lines.join("\n").trim() + "\n";
}

function buildPaths(format: "md" | "json" | "both", jsonPath: string, mdPath: string): string[] {
  if (format === "json") return [jsonPath];
  if (format === "both") return [mdPath, jsonPath];
  return [mdPath];
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { LifecycleReportInput };
