// build_swap — project scope.
//
// Emit a compaction hint and return the best-practice doc for a new builder
// type. Used at the "finish backend → swap to frontend" boundaries the plan
// names. The server doesn't actually compact the client's context (it
// can't); it returns a structured instruction the client's skill layer can
// act on (stop session, load the new best-practice, resume).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { loadKbCached } from "../primers/load.js";

const BUILDER_TYPES = ["backend", "frontend", "infra", "data", "ai", "cli", "generic"] as const;

const BuildSwapInput = z
  .object({
    from_type: z.enum(BUILDER_TYPES),
    to_type: z.enum(BUILDER_TYPES),
    plan_name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerBuildSwap(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "build_swap",
    {
      title: "Build-Type Swap",
      description:
        "Return a compaction hint + the target builder type's best-practice doc. Client skill should stop the current session, compact, and resume with the returned doc loaded.",
      inputSchema: BuildSwapInput.shape,
    },
    async (args: z.infer<typeof BuildSwapInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "build_swap requires project scope");
        }
        const parsed = BuildSwapInput.parse(args);
        const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
        const bp = entries.find(
          (e) => e.kind === "best-practice" && e.name.toLowerCase() === parsed.to_type,
        );
        const bpBody = bp ? await readFile(bp.path, "utf8") : null;

        const hint = [
          `Compact the current session before resuming.`,
          `New builder type: ${parsed.to_type}. Re-read plans/${parsed.plan_name}-plan.md and`,
          `plans/${parsed.plan_name}-manifest.md, then proceed with the best-practice doc below.`,
        ].join(" ");

        const payload = success(
          bp ? [bp.path] : [],
          `Swap ${parsed.from_type} → ${parsed.to_type} for plan "${parsed.plan_name}"${
            bp ? "" : " (no matching best-practice in KB — proceeding with generic guidance)"
          }.`,
          parsed.expand
            ? {
                content: {
                  compaction_hint: hint,
                  from_type: parsed.from_type,
                  to_type: parsed.to_type,
                  best_practice_md: bpBody,
                },
              }
            : {
                expand_hint:
                  "Call build_swap with expand=true to receive the hint + best-practice body.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "build_swap",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
