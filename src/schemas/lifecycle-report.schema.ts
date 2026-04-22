// Structured lifecycle-report output shape.
//
// Versioned JSON contract for the `lifecycle_report` tool + CLI. One
// section per lifecycle step so downstream consumers (retrospective
// in Phase-4, report-diffing later) can slice by step without touching
// a reviewer LLM.
//
// Stability contract (see docs/STABILITY.md):
//   - Adding a new optional field inside a section → minor bump.
//   - Adding a new section → minor bump.
//   - Renaming or removing a field / section → major bump + migrator.
//
// All timestamps are epoch ms; all paths are absolute; all identifiers
// are free-form strings (review run ids, artifact paths, etc.). No
// field carries lesson / observation bodies — the caller fetches those
// via `lesson_search` / file reads when the narrative mode needs them.

import { z } from "zod";

export const LIFECYCLE_REPORT_SCHEMA_VERSION = "1.0.0";

export const ProjectSummarySchema = z
  .object({
    name: z.string(),
    root_path: z.string(),
    state: z.string(),
    adopted: z.boolean(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    spec_path: z.string().nullable(),
  })
  .strict();

export const AuditCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    by_tool: z.record(z.string(), z.number().int().nonnegative()),
    earliest_ts: z.number().int().nullable(),
    latest_ts: z.number().int().nullable(),
  })
  .strict();

export const ArtifactEntrySchema = z
  .object({
    path: z.string(),
    kind: z.string(),
    mtime: z.number().int(),
    hash: z.string(),
  })
  .strict();

export const ReviewRunEntrySchema = z
  .object({
    id: z.string(),
    type: z.string(),
    stage: z.number().int(),
    status: z.string(),
    verdict: z.string().nullable(),
    started_at: z.number().int(),
    finished_at: z.number().int().nullable(),
    report_path: z.string().nullable(),
  })
  .strict();

export const DecisionEntrySchema = z
  .object({
    slug: z.string(),
    path: z.string(),
    created_at: z.number().int(),
  })
  .strict();

export const ResponseLogEntrySchema = z
  .object({
    id: z.number().int(),
    run_id: z.string(),
    finding_ref: z.string().nullable(),
    builder_claim: z.string(),
    created_at: z.number().int(),
    has_migration_note: z.boolean(),
  })
  .strict();

export const BuildEntrySchema = z
  .object({
    id: z.number().int(),
    target: z.string(),
    status: z.string(),
    started_at: z.number().int(),
    finished_at: z.number().int().nullable(),
    output_path: z.string().nullable(),
  })
  .strict();

export const LessonEntrySchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    scope: z.string(),
    stage: z.string().nullable(),
    tags: z.array(z.string()),
    created_at: z.number().int(),
  })
  .strict();

export const LifecycleSectionSchema = z.discriminatedUnion("section", [
  z
    .object({
      section: z.literal("project"),
      summary: ProjectSummarySchema,
    })
    .strict(),
  z
    .object({
      section: z.literal("audit"),
      counts: AuditCountsSchema,
      recent: z.array(
        z
          .object({
            ts: z.number().int(),
            tool: z.string(),
            scope: z.string(),
            result_code: z.string(),
            endpoint: z.string().nullable(),
          })
          .strict(),
      ),
      row_cap: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      section: z.literal("artifacts"),
      count: z.number().int().nonnegative(),
      by_kind: z.record(z.string(), z.number().int().nonnegative()),
      recent: z.array(ArtifactEntrySchema),
    })
    .strict(),
  z
    .object({
      section: z.literal("reviews"),
      count: z.number().int().nonnegative(),
      by_verdict: z.record(z.string(), z.number().int().nonnegative()),
      by_type: z.record(z.string(), z.number().int().nonnegative()),
      recent: z.array(ReviewRunEntrySchema),
    })
    .strict(),
  z
    .object({
      section: z.literal("decisions"),
      count: z.number().int().nonnegative(),
      entries: z.array(DecisionEntrySchema),
    })
    .strict(),
  z
    .object({
      section: z.literal("responses"),
      count: z.number().int().nonnegative(),
      by_claim: z.record(z.string(), z.number().int().nonnegative()),
      recent: z.array(ResponseLogEntrySchema),
    })
    .strict(),
  z
    .object({
      section: z.literal("builds"),
      count: z.number().int().nonnegative(),
      by_status: z.record(z.string(), z.number().int().nonnegative()),
      recent: z.array(BuildEntrySchema),
    })
    .strict(),
  z
    .object({
      section: z.literal("lessons"),
      count: z.number().int().nonnegative(),
      by_scope: z.record(z.string(), z.number().int().nonnegative()),
      recent: z.array(LessonEntrySchema),
    })
    .strict(),
]);

export type LifecycleSection = z.infer<typeof LifecycleSectionSchema>;

export const LifecycleReportSchema = z
  .object({
    schema_version: z.literal(LIFECYCLE_REPORT_SCHEMA_VERSION),
    generated_at: z.number().int(),
    project_root: z.string(),
    sections: z.array(LifecycleSectionSchema).min(1),
  })
  .strict();

export type LifecycleReport = z.infer<typeof LifecycleReportSchema>;

export const LIFECYCLE_SECTION_ORDER = [
  "project",
  "audit",
  "artifacts",
  "reviews",
  "decisions",
  "responses",
  "builds",
  "lessons",
] as const;

export type LifecycleSectionName = (typeof LIFECYCLE_SECTION_ORDER)[number];
