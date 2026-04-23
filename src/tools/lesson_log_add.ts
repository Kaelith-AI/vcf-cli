// lesson_log_add — project scope; writes to the global lessons store.
//
// Lessons are improvement-cycle data, not project-lifecycle data (followup
// #41). Every lesson lands in the single global store at the resolved
// `config.lessons.global_db_path` (default ~/.vcf/lessons.db) tagged with
// the originating project_root. Retrospectives and self-improvement passes
// read cross-project from this one store.
//
// Privacy escape hatch: setting `config.lessons.global_db_path: null`
// disables lessons entirely — lesson_log_add fails with E_SCOPE_DENIED so
// the caller knows the boundary is shut. Operators running VCF on a shared
// workstation alongside sensitive / NDA work use this to keep the lesson
// log off.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { success, runTool } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { getGlobalLessonsDb } from "../db/globalLessons.js";

const TagToken = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "tags must be lowercase kebab-case");

const LessonLogAddInput = z
  .object({
    title: z.string().min(1).max(256),
    observation: z.string().min(1).max(10_000),
    context: z.string().max(4_000).optional(),
    actionable_takeaway: z.string().max(4_000).optional(),
    scope: z.enum(["project", "universal"]).default("project"),
    stage: z
      .enum(["draft", "planning", "building", "testing", "reviewing", "shipping", "shipped"])
      .optional(),
    tags: z.array(TagToken).max(16).default([]),
    expand: z.boolean().default(false),
  })
  .strict();

type LessonLogAddArgs = z.infer<typeof LessonLogAddInput>;

export function registerLessonLogAdd(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "lesson_log_add",
    {
      title: "Log Lesson",
      description:
        "Append a lesson to the global improvement-cycle store, tagged with this project's root. Redacts secrets pre-store. Returns the lesson id + a summary; pass expand=true to receive the stored payload.",
      inputSchema: LessonLogAddInput,
    },
    async (args: LessonLogAddArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "lesson_log_add requires project scope");
          }
          const parsed = LessonLogAddInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          if (globalDb === null) {
            throw new McpError(
              "E_SCOPE_DENIED",
              `lesson_log_add is disabled: config.lessons.global_db_path is null. ` +
                `Re-enable the store in ~/.vcf/config.yaml to log lessons.`,
            );
          }

          const scope = parsed.scope;
          const stage = parsed.stage ?? null;
          const createdAt = Date.now();

          const redactedBody = redact({
            title: parsed.title,
            observation: parsed.observation,
            context: parsed.context ?? null,
            actionable_takeaway: parsed.actionable_takeaway ?? null,
          }) as {
            title: string;
            observation: string;
            context: string | null;
            actionable_takeaway: string | null;
          };
          const redactionApplied =
            redactedBody.title !== parsed.title ||
            redactedBody.observation !== parsed.observation ||
            redactedBody.context !== (parsed.context ?? null) ||
            redactedBody.actionable_takeaway !== (parsed.actionable_takeaway ?? null);

          const tagsJson = JSON.stringify(parsed.tags);

          const run = globalDb
            .prepare(
              `INSERT INTO lessons
                 (project_root, title, context, observation, actionable_takeaway,
                  scope, stage, tags_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              projectRoot,
              redactedBody.title,
              redactedBody.context,
              redactedBody.observation,
              redactedBody.actionable_takeaway,
              scope,
              stage,
              tagsJson,
              createdAt,
            );
          const lessonId = Number(run.lastInsertRowid);

          const summaryParts = [
            `lesson #${lessonId} logged`,
            `scope=${scope}`,
            parsed.tags.length > 0 ? `tags=${parsed.tags.join(",")}` : "no-tags",
          ];
          if (redactionApplied) summaryParts.push("redaction-applied");

          return success([], summaryParts.join("; "), {
            content: {
              lesson_id: lessonId,
              scope,
              stage,
              tags: parsed.tags,
              redaction_applied: redactionApplied,
              created_at: createdAt,
              ...(parsed.expand
                ? {
                    stored: {
                      title: redactedBody.title,
                      observation: redactedBody.observation,
                      context: redactedBody.context,
                      actionable_takeaway: redactedBody.actionable_takeaway,
                    },
                  }
                : {}),
            },
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "lesson_log_add",
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

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { LessonLogAddInput };
