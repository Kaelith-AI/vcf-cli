// response_log_add — project scope.
//
// Append a builder-to-reviewer stance to the append-only
// plans/reviews/response-log.md file, and index the row in project.db
// response_log. M7 review_prepare re-reads this file before every pass so
// reviewers don't re-flag resolved disagreements.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const ResponseLogAddInput = z
  .object({
    review_run_id: z
      .string()
      .min(1)
      .max(128)
      .describe("id from a prior review_prepare/submit call (e.g. 'code-20260419T120000Z')"),
    stance: z.enum(["agree", "disagree"]),
    note: z
      .string()
      .min(8)
      .max(10_000)
      .describe("builder's rationale. Required whenever stance=disagree."),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerResponseLogAdd(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "response_log_add",
    {
      title: "Log Response to Reviewer",
      description:
        "Append builder's stance (agree|disagree + note) to plans/reviews/response-log.md and index in project.db. Read by every subsequent review_prepare pass.",
      inputSchema: ResponseLogAddInput.shape,
    },
    async (args: z.infer<typeof ResponseLogAddInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "response_log_add requires project scope");
          }
          const parsed = ResponseLogAddInput.parse(args);

          // M5 writes without validating the review_run_id existence (review
          // runs arrive in M7). When M7 lands, this block becomes a FK check.
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const dir = join(root, "plans", "reviews");
          await assertInsideAllowedRoot(dir, deps.config.workspace.allowed_roots);
          await mkdir(dir, { recursive: true });
          const logPath = join(dir, "response-log.md");
          await assertInsideAllowedRoot(logPath, deps.config.workspace.allowed_roots);

          if (!existsSync(logPath)) {
            await writeFile(
              logPath,
              "# Response Log (append-only)\n\n> Reviewers read this before every pass.\n\n",
              "utf8",
            );
          }

          const ts = new Date().toISOString();
          const block = [
            "---",
            `review_run_id: ${parsed.review_run_id}`,
            `stance: ${parsed.stance}`,
            `created_at: ${ts}`,
            "---",
            "",
            parsed.note.trim(),
            "",
            "---",
            "",
          ].join("\n");
          await appendFile(logPath, block, "utf8");

          deps.projectDb
            .prepare(
              `INSERT INTO response_log (review_run_id, stance, note, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(parsed.review_run_id, parsed.stance, parsed.note, Date.now());

          const payload = success(
            [logPath],
            `Appended ${parsed.stance} response for ${parsed.review_run_id} (${parsed.note.length} chars).`,
            parsed.expand
              ? {
                  content: {
                    log_path: logPath,
                    review_run_id: parsed.review_run_id,
                    stance: parsed.stance,
                  },
                }
              : {
                  expand_hint:
                    "Call response_log_add with expand=true to receive the appended entry metadata.",
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
