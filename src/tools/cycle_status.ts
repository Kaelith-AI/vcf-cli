// cycle_status — project scope.
//
// Followup #25 item 9: read-only helper that surfaces the build/test cycle
// state so an orchestrator can nudge the developer toward running tests
// after a build without having to manually inspect logs.
//
// Returns:
//   { last_build_at, last_test_at, needs_test }
//
// needs_test = true when last_build_at > last_test_at (or when there is a
// build but no test run at all), signalling that the latest build has not
// yet been covered by a test_execute run.
//
// Read-only: no state writes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const CycleStatusInput = z
  .object({
    expand: z.boolean().default(true),
  })
  .strict();

export function registerCycleStatus(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "cycle_status",
    {
      title: "Build/Test Cycle Status",
      description:
        "Read-only. Returns { last_build_at, last_test_at, needs_test } from the project audit log. needs_test=true when the most recent build post-dates the most recent test_execute run — a nudge to run tests before shipping.",
      inputSchema: CycleStatusInput.shape,
    },
    async (args: z.infer<typeof CycleStatusInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "cycle_status requires project scope");
          }
          const parsed = CycleStatusInput.parse(args);

          // Last successful build (ship_build tool writes a builds row;
          // test_execute also writes one — discriminate by target prefix).
          const lastBuildRow = deps.projectDb
            .prepare(
              `SELECT finished_at FROM builds
               WHERE target LIKE 'ship_build%' AND status = 'success'
               ORDER BY finished_at DESC LIMIT 1`,
            )
            .get() as { finished_at: number } | undefined;

          // Last test_execute run. test_execute writes a builds row with
          // target = 'test_execute:<cmd>' or similar, plus the global test_runs.
          // Use the global audit log to find any recent test_execute call.
          const lastTestRow = deps.globalDb
            .prepare(
              `SELECT ts FROM audit
               WHERE tool = 'test_execute' AND result_code = 'ok'
               ORDER BY ts DESC LIMIT 1`,
            )
            .get() as { ts: number } | undefined;

          const lastBuildAt = lastBuildRow?.finished_at ?? null;
          const lastTestAt = lastTestRow?.ts ?? null;
          const needsTest =
            lastBuildAt !== null &&
            (lastTestAt === null || lastBuildAt > lastTestAt);

          const status = {
            last_build_at: lastBuildAt,
            last_test_at: lastTestAt,
            needs_test: needsTest,
          };

          return success(
            [],
            needsTest
              ? `Build/test cycle: needs_test=true — run test_execute before shipping.`
              : lastBuildAt === null
                ? `Build/test cycle: no builds recorded yet.`
                : `Build/test cycle: test_execute is current (last_test >= last_build).`,
            parsed.expand
              ? { content: status }
              : { expand_hint: "Call cycle_status with expand=true for the full status object." },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "cycle_status",
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
