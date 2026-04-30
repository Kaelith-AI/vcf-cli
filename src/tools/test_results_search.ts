// test_results_search — project scope.
//
// Phase G-C: Query project.db.artifacts for saved test results
// (kind=test-result) with optional filters for plan_name, passed, and
// since date. Returns paths + summaries; on expand=true, reads file contents.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const TestResultsSearchInput = z
  .object({
    plan_name: z.string().min(1).max(128).optional().describe("filter by plan name slug"),
    passed: z.boolean().optional().describe("filter by pass/fail status"),
    since: z.string().optional().describe("ISO date string; only results at or after this time"),
    expand: z.boolean().default(false),
  })
  .strict();

interface ArtifactRow {
  path: string;
  frontmatter_json: string;
  mtime: number;
}

export function registerTestResultsSearch(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_results_search",
    {
      title: "Search Test Results",
      description:
        "Search saved test results (written by test_execute when plan_name is provided) with optional filters for plan_name, passed, and since date. Pass expand=true to include file contents.",
      inputSchema: TestResultsSearchInput.shape,
    },
    async (args: z.infer<typeof TestResultsSearchInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "test_results_search requires project scope");
          }
          const parsed = TestResultsSearchInput.parse(args);

          // Build the query with optional filters.
          let sql = `SELECT path, frontmatter_json, mtime FROM artifacts WHERE kind = 'test-result'`;
          const params: (string | number)[] = [];

          if (parsed.plan_name !== undefined) {
            sql += ` AND json_extract(frontmatter_json, '$.plan_name') = ?`;
            params.push(parsed.plan_name);
          }

          if (parsed.passed !== undefined) {
            // passed is stored as JSON boolean (true/false literal).
            sql += ` AND json_extract(frontmatter_json, '$.passed') = ?`;
            params.push(parsed.passed ? 1 : 0);
          }

          if (parsed.since !== undefined) {
            const sinceMs = new Date(parsed.since).getTime();
            if (!isNaN(sinceMs)) {
              sql += ` AND mtime >= ?`;
              params.push(sinceMs);
            }
          }

          sql += ` ORDER BY mtime DESC`;

          const rows = deps.projectDb.prepare(sql).all(...params) as unknown as ArtifactRow[];

          const items = await Promise.all(
            rows.map(async (r) => {
              let fm: Record<string, unknown> = {};
              try {
                fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
              } catch {
                /* ignore */
              }
              const item: Record<string, unknown> = {
                path: r.path,
                plan_name: fm["plan_name"] ?? null,
                passed: fm["passed"] ?? null,
                exit_code: fm["exit_code"] ?? null,
                timestamp: fm["timestamp"] ?? null,
                mtime: r.mtime,
              };
              if (parsed.expand && existsSync(r.path)) {
                item["content"] = await readFile(r.path, "utf8");
              }
              return item;
            }),
          );

          const filterDesc: string[] = [];
          if (parsed.plan_name) filterDesc.push(`plan=${parsed.plan_name}`);
          if (parsed.passed !== undefined) filterDesc.push(`passed=${parsed.passed}`);
          if (parsed.since) filterDesc.push(`since=${parsed.since}`);

          return success(
            rows.map((r) => r.path),
            `test_results_search: found ${rows.length} result(s)${filterDesc.length > 0 ? ` (${filterDesc.join(", ")})` : ""}.`,
            parsed.expand ? { content: items } : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "test_results_search",
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
