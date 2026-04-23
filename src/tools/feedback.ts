// feedback_add / feedback_list — project scope (followup #18).
//
// Lightweight ad-hoc channel for "sigh, that was annoying" observations
// that don't meet the structured threshold for lesson_log (which wants
// context + observation + actionable_takeaway). Retrospectives read
// feedback alongside lessons and decide case-by-case whether to promote a
// note to a lesson, file a bug, or drop.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { success, runTool } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";

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
    limit: z.number().int().positive().max(500).default(50),
    expand: z.boolean().default(false),
  })
  .strict();

interface FeedbackRow {
  id: number;
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
        "Append a one-line feedback note to the project. Lightweight alternative to lesson_log_add — no required context, no takeaway. Retrospectives triage feedback to decide whether it becomes a lesson, bug, or gets dropped.",
      inputSchema: FeedbackAddInput,
    },
    async (args: z.infer<typeof FeedbackAddInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "feedback_add requires project scope");
          }
          const parsed = FeedbackAddInput.parse(args);
          const redactedNote = redact(parsed.note) as string;
          const redactionApplied = redactedNote !== parsed.note;

          const createdAt = Date.now();
          const run = deps.projectDb
            .prepare(
              `INSERT INTO feedback (note, stage, urgency, created_at) VALUES (?, ?, ?, ?)`,
            )
            .run(redactedNote, parsed.stage ?? null, parsed.urgency ?? null, createdAt);
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
        "List recent feedback notes for this project. Newest first; pass stage / urgency to filter. expand=true returns the note body; otherwise only ids + metadata.",
      inputSchema: FeedbackListInput,
    },
    async (args: z.infer<typeof FeedbackListInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "feedback_list requires project scope");
          }
          const parsed = FeedbackListInput.parse(args);
          const clauses: string[] = [];
          const params: Array<string | number> = [];
          if (parsed.stage) {
            clauses.push("stage = ?");
            params.push(parsed.stage);
          }
          if (parsed.urgency) {
            clauses.push("urgency = ?");
            params.push(parsed.urgency);
          }
          const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
          const rows = deps.projectDb
            .prepare(
              `SELECT id, note, stage, urgency, created_at FROM feedback ${where}
                 ORDER BY created_at DESC LIMIT ?`,
            )
            .all(...params, parsed.limit) as unknown as FeedbackRow[];

          return success(
            [],
            `feedback_list: ${rows.length} entr${rows.length === 1 ? "y" : "ies"} (stage=${parsed.stage ?? "∅"}, urgency=${parsed.urgency ?? "∅"})`,
            {
              content: {
                entries: rows.map((r) => ({
                  id: r.id,
                  stage: r.stage,
                  urgency: r.urgency,
                  created_at: r.created_at,
                  ...(parsed.expand ? { note: r.note } : {}),
                })),
                returned: rows.length,
              },
              ...(parsed.expand
                ? {}
                : { expand_hint: "Pass expand=true for note bodies." }),
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
