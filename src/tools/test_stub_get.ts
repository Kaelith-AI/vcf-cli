// test_stub_get — project scope.
//
// Phase G-C: Query project.db.artifacts for saved test stubs (kind=test-stub)
// by plan_name and optional slug. Returns paths + summaries; on expand=true,
// reads and returns file contents.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const TestStubGetInput = z
  .object({
    plan_name: z.string().min(1).max(128),
    slug: z.string().optional().describe("filter to a specific stub slug"),
    expand: z.boolean().default(false),
  })
  .strict();

interface ArtifactRow {
  path: string;
  frontmatter_json: string;
  mtime: number;
}

export function registerTestStubGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_stub_get",
    {
      title: "Get Test Stubs",
      description:
        "Query saved test stubs (written by test_generate with save=true) for a plan. Optionally filter by slug. Returns paths + summaries; pass expand=true to include file contents.",
      inputSchema: TestStubGetInput.shape,
    },
    async (args: z.infer<typeof TestStubGetInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "test_stub_get requires project scope");
          }
          const parsed = TestStubGetInput.parse(args);

          // Build query — filter by plan_name embedded in frontmatter_json
          // (stored as JSON object with plan_name key).
          let sql = `SELECT path, frontmatter_json, mtime FROM artifacts WHERE kind = 'test-stub'`;
          const params: (string | number)[] = [];

          // Filter by plan_name via JSON field match.
          sql += ` AND json_extract(frontmatter_json, '$.plan_name') = ?`;
          params.push(parsed.plan_name);

          if (parsed.slug !== undefined) {
            sql += ` AND json_extract(frontmatter_json, '$.slug') = ?`;
            params.push(parsed.slug);
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
                slug: fm["slug"] ?? null,
                test_kind: fm["test_kind"] ?? null,
                mtime: r.mtime,
              };
              if (parsed.expand && existsSync(r.path)) {
                item["content"] = await readFile(r.path, "utf8");
              }
              return item;
            }),
          );

          return success(
            rows.map((r) => r.path),
            `test_stub_get: found ${rows.length} stub(s) for plan "${parsed.plan_name}"${parsed.slug ? ` (slug=${parsed.slug})` : ""}.`,
            parsed.expand ? { content: items } : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "test_stub_get",
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
