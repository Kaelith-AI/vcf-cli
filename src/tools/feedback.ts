// feedback_add / feedback_list — project scope, global store (followup #41).
//
// Lightweight ad-hoc channel for "sigh, that was annoying" observations that
// don't meet the structured threshold for lesson_log (which wants context +
// observation + actionable_takeaway). Retrospectives read feedback alongside
// lessons from the same global store to triage case-by-case.
//
// Feedback is improvement-cycle data, not project-lifecycle data, so it
// lives in the global store (~/.vcf/lessons.db, `feedback` table) tagged
// with project_root. Disabling the store via
// `config.lessons.global_db_path: null` disables feedback too.
//
// NOTE (scope refactor): feedback_add could theoretically run at global scope
// because the backing store is the global lessons.db — not the per-project DB.
// However, it needs project_root to tag each entry, which currently comes from
// deps.projectDb. To move it to global scope, project_root would need to become
// an optional caller-supplied input, or the server would need to resolve it from
// the registry without projectDb. That is a schema-breaking change; deferred
// until global-scope feedback is explicitly requested as a follow-up.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { success, runTool } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { getGlobalLessonsDb } from "../db/globalLessons.js";

const FeedbackAddInput = z
  .object({
    note: z.string().min(1).max(2_000),
    stage: z
      .enum(["draft", "planning", "building", "testing", "reviewing", "shipping", "shipped"])
      .optional(),
    urgency: z.enum(["low", "normal", "high"]).optional(),
    expand: z.boolean().default(false),
  })
  .strict();

const FeedbackListInput = z
  .object({
    stage: z
      .enum(["draft", "planning", "building", "testing", "reviewing", "shipping", "shipped"])
      .optional(),
    urgency: z.enum(["low", "normal", "high"]).optional(),
    filter: z.enum(["current", "all"]).default("current"),
    limit: z.number().int().positive().max(500).default(50),
    expand: z.boolean().default(false),
  })
  .strict();

interface FeedbackRow {
  id: number;
  project_root: string;
  note: string;
  stage: string | null;
  urgency: string | null;
  created_at: number;
}

export function registerFeedbackAdd(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "feedback_add",
    {
      title: "Add Feedback",
      description:
        "Append a one-line feedback note to the global improvement-cycle store, tagged with this project's root. Lightweight alternative to lesson_log_add — no required context, no takeaway. Retrospectives triage feedback to decide whether it becomes a lesson, bug, or gets dropped.",
      inputSchema: FeedbackAddInput,
    },
    async (args: z.infer<typeof FeedbackAddInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "feedback_add requires project scope");
          }
          const parsed = FeedbackAddInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          if (globalDb === null) {
            throw new McpError(
              "E_SCOPE_DENIED",
              `feedback_add is disabled: config.lessons.global_db_path is null. ` +
                `Re-enable the store in ~/.vcf/config.yaml to log feedback.`,
            );
          }

          const redactedNote = redact(parsed.note) as string;
          const redactionApplied = redactedNote !== parsed.note;

          const createdAt = Date.now();
          const run = globalDb
            .prepare(
              `INSERT INTO feedback (project_root, note, stage, urgency, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              projectRoot,
              redactedNote,
              parsed.stage ?? null,
              parsed.urgency ?? null,
              createdAt,
            );
          const feedbackId = Number(run.lastInsertRowid);

          const summaryParts = [
            `feedback #${feedbackId} logged`,
            parsed.stage ? `stage=${parsed.stage}` : "no-stage",
            parsed.urgency ? `urgency=${parsed.urgency}` : "urgency=normal",
          ];
          if (redactionApplied) summaryParts.push("redaction-applied");

          return success([], summaryParts.join("; "), {
            content: {
              feedback_id: feedbackId,
              stage: parsed.stage ?? null,
              urgency: parsed.urgency ?? null,
              created_at: createdAt,
              redaction_applied: redactionApplied,
              ...(parsed.expand ? { stored_note: redactedNote } : {}),
            },
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "feedback_add",
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

export function registerFeedbackList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "feedback_list",
    {
      title: "List Feedback",
      description:
        "List feedback notes from the global store. filter=current (default) scopes to this project; filter=all reads cross-project. Newest first; pass stage / urgency to further filter. expand=true returns the note body.",
      inputSchema: FeedbackListInput,
    },
    async (args: z.infer<typeof FeedbackListInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "feedback_list requires project scope");
          }
          const parsed = FeedbackListInput.parse(args);
          const projectRoot = readProjectRoot(deps);

          const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          if (globalDb === null) {
            throw new McpError(
              "E_SCOPE_DENIED",
              `feedback_list is disabled: config.lessons.global_db_path is null. ` +
                `Re-enable the store in ~/.vcf/config.yaml to read feedback.`,
            );
          }

          const clauses: string[] = [];
          const params: Array<string | number> = [];
          if (parsed.filter === "current") {
            if (!projectRoot) {
              return success([], "feedback_list: 0 entries (no project root)", {
                content: { entries: [], returned: 0 },
              });
            }
            clauses.push("project_root = ?");
            params.push(projectRoot);
          }
          if (parsed.stage) {
            clauses.push("stage = ?");
            params.push(parsed.stage);
          }
          if (parsed.urgency) {
            clauses.push("urgency = ?");
            params.push(parsed.urgency);
          }
          const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
          const rows = globalDb
            .prepare(
              `SELECT id, project_root, note, stage, urgency, created_at FROM feedback ${where}
                 ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(...params, parsed.limit) as unknown as FeedbackRow[];

          return success(
            [],
            `feedback_list: ${rows.length} entr${rows.length === 1 ? "y" : "ies"} (filter=${parsed.filter}, stage=${parsed.stage ?? "∅"}, urgency=${parsed.urgency ?? "∅"})`,
            {
              content: {
                entries: rows.map((r) => ({
                  id: r.id,
                  project_root: r.project_root,
                  stage: r.stage,
                  urgency: r.urgency,
                  created_at: r.created_at,
                  ...(parsed.expand ? { note: r.note } : {}),
                })),
                returned: rows.length,
              },
              ...(parsed.expand ? {} : {}),
            },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "feedback_list",
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

export { FeedbackAddInput, FeedbackListInput };
