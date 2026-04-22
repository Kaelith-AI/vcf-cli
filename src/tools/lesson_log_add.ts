// lesson_log_add — project scope.
//
// Append a lesson to the project lesson log and mirror it into the global
// lessons DB so a vibe coder can search across projects. Per plan:
//  - title + observation required; everything else optional with defaults.
//  - lesson text runs through `redact()` before any persist.
//  - one audit row per call via `runTool` finally hook.
// Regression surface: the input schema is `.strict()` and .parse() runs inside
// the handler so an unknown key fails with `E_VALIDATION`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
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
    scope: z.enum(["project", "universal"]).optional(),
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
        "Append a lesson to this project's log and mirror it to the global lessons DB. Redacts secrets pre-store. Returns the lesson id + a summary; pass expand=true to receive the stored payload.",
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

          const scope = parsed.scope ?? deps.config.lessons.default_scope;
          const stage = parsed.stage ?? null;
          const createdAt = Date.now();

          // Redact before persist — lesson text may contain session-captured
          // secrets (API keys the caller pasted while debugging, JWTs from
          // request logs, .env-style assignments). The redact pass also runs
          // again inside the audit hook, so secrets never hit either DB row
          // nor either hash.
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

          // Project DB write.
          const projectInsert = deps.projectDb.prepare(
            `INSERT INTO lessons
               (title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const projectRun = projectInsert.run(
            redactedBody.title,
            redactedBody.context,
            redactedBody.observation,
            redactedBody.actionable_takeaway,
            scope,
            stage,
            tagsJson,
            createdAt,
          );
          const projectLessonId = Number(projectRun.lastInsertRowid);

          // Global DB mirror. Three outcomes:
          //   - `disabled-by-config`: operator set `config.lessons.global_db_path: null`
          //     to opt out of cross-project mirroring. Skip cleanly, no error.
          //   - success: write mirrored, id returned.
          //   - failure: local write is authoritative; log the mirror error
          //     into the envelope and audit but do not fail the tool call.
          let globalLessonId: number | null = null;
          let globalMirrorStatus: "ok" | "disabled-by-config" | "failed" = "ok";
          let globalMirrorError: string | null = null;
          const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          if (globalDb === null) {
            globalMirrorStatus = "disabled-by-config";
          } else {
            try {
              const globalRun = globalDb
                .prepare(
                  `INSERT INTO lessons
                     (project_root, title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at)
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
              globalLessonId = Number(globalRun.lastInsertRowid);
            } catch (err) {
              globalMirrorStatus = "failed";
              globalMirrorError = err instanceof Error ? err.message : String(err);
            }
          }

          const summaryParts = [
            `lesson #${projectLessonId} logged`,
            `scope=${scope}`,
            parsed.tags.length > 0 ? `tags=${parsed.tags.join(",")}` : "no-tags",
          ];
          if (redactionApplied) summaryParts.push("redaction-applied");
          if (globalMirrorStatus === "disabled-by-config")
            summaryParts.push("mirror-disabled-by-config");
          else if (globalMirrorStatus === "failed") summaryParts.push("mirror-failed");

          return success([], summaryParts.join("; "), {
            content: {
              lesson_id: projectLessonId,
              global_lesson_id: globalLessonId,
              scope,
              stage,
              tags: parsed.tags,
              redaction_applied: redactionApplied,
              mirror_status: globalMirrorStatus,
              global_mirror_error: globalMirrorError,
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
export type { DatabaseSync as LessonsDb };
