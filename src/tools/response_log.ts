// response_log_add — project scope.
//
// Append a builder-to-reviewer response to the project response_log table
// and re-render the append-only markdown view at
// plans/reviews/response-log.md. review_prepare snapshots the markdown into
// each run's workspace so reviewers see prior responses without re-opening
// the DB.
//
// Phase-2 (#22) formalizes the schema: `run_id`, `finding_ref`,
// `response_text`, `builder_claim`, `references`. Legacy rows
// (pre-migration-v4) have finding_ref=NULL and references_json='[]'.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { renderResponseLogMarkdown } from "../review/responseLogMigrator.js";
import { resolveOutputs } from "../util/outputs.js";

const ResponseLogAddInput = z
  .object({
    run_id: z
      .string()
      .min(1)
      .max(128)
      .describe("id from a prior review_prepare/submit call (e.g. 'code-1-20260419T120000Z')"),
    finding_ref: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Pointer to a specific finding within the run. Free-form (e.g. 'code:stage-3:finding-2'). Omit to respond to the run as a whole.",
      ),
    builder_claim: z.enum(["agree", "disagree"]),
    response_text: z
      .string()
      .min(8)
      .max(10_000)
      .describe("builder's rationale. Required whenever builder_claim=disagree."),
    references: z
      .array(z.string().min(1).max(512))
      .max(16)
      .default([])
      .describe("Optional cross-refs (commit SHAs, file:line, ADR paths)."),
    expand: z.boolean().default(false),
  })
  .strict();

type ResponseLogAddArgs = z.infer<typeof ResponseLogAddInput>;

export function registerResponseLogAdd(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "response_log_add",
    {
      title: "Log Response to Reviewer",
      description:
        "Persist a builder response (agree|disagree + text + optional finding_ref + references) to the project response_log table and re-render plans/reviews/response-log.md. Read by every subsequent review_prepare pass.",
      inputSchema: ResponseLogAddInput,
    },
    async (args: ResponseLogAddArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "response_log_add requires project scope");
          }
          const parsed = ResponseLogAddInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const logPath = resolveOutputs(root, deps.config).responseLogPath;
          await assertInsideAllowedRoot(logPath, deps.config.workspace.allowed_roots);
          await mkdir(dirname(logPath), { recursive: true });

          const insert = deps.projectDb.prepare(
            `INSERT INTO response_log
               (run_id, finding_ref, builder_claim, response_text, references_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          const runResult = insert.run(
            parsed.run_id,
            parsed.finding_ref ?? null,
            parsed.builder_claim,
            parsed.response_text,
            JSON.stringify(parsed.references),
            Date.now(),
          );
          const rowId = Number(runResult.lastInsertRowid);

          // Re-render the whole log to the markdown file. Append-only
          // semantics are preserved because the source-of-truth is the DB
          // (monotonic AUTOINCREMENT) and we always emit rows in id order.
          await writeFile(logPath, renderResponseLogMarkdown(deps.projectDb), "utf8");

          const payload = success(
            [logPath],
            `Logged ${parsed.builder_claim} response #${rowId} for ${parsed.run_id}${parsed.finding_ref ? ` :: ${parsed.finding_ref}` : ""} (${parsed.response_text.length} chars).`,
            parsed.expand
              ? {
                  content: {
                    response_id: rowId,
                    run_id: parsed.run_id,
                    finding_ref: parsed.finding_ref ?? null,
                    builder_claim: parsed.builder_claim,
                    references: parsed.references,
                    log_path: logPath,
                  },
                }
              : {
                  expand_hint:
                    "Call response_log_add with expand=true to receive the row id + rendered log path.",
                },
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "response_log_add",
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

export { ResponseLogAddInput };
