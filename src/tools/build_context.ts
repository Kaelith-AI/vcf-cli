// build_context — project scope.
//
// Returns builder.md + company-standards + vibe-coding best-practices (the
// how) + the current plan/todo/manifest so the client LLM can build.
// Optionally pre-loads a builder-type-specific best-practice (if one exists
// in the KB under kb/best-practices/<type>.md).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { readTemplate } from "../util/templates.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { loadKbCached } from "../primers/load.js";

const BUILDER_TYPES = ["backend", "frontend", "infra", "data", "ai", "cli", "generic"] as const;

const BuildContextInput = z
  .object({
    plan_name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128),
    builder_type: z.enum(BUILDER_TYPES).default("generic"),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerBuildContext(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "build_context",
    {
      title: "Build Context",
      description:
        "Assemble builder.md + company-standards + vibe-coding best-practices + current plan/todo/manifest. Optional builder_type loads the matching best-practice from the KB.",
      inputSchema: BuildContextInput.shape,
    },
    async (args: z.infer<typeof BuildContextInput>) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "build_context requires project scope");
          }
          const parsed = BuildContextInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const builderMd = await readTemplate("builder.md.tpl");
          const standards = await readOptionalKbFile(
            deps,
            join("standards", "company-standards.md"),
          );
          const vibeBp = await findBestPracticeByName(deps, "vibe-coding");
          const typedBp =
            parsed.builder_type === "generic"
              ? null
              : await findBestPracticeByName(deps, parsed.builder_type);

          // Read plan files (tolerate missing — a user may call build_context
          // before plan_save for exploration).
          const planPaths = {
            plan: join(root, "plans", `${parsed.plan_name}-plan.md`),
            todo: join(root, "plans", `${parsed.plan_name}-todo.md`),
            manifest: join(root, "plans", `${parsed.plan_name}-manifest.md`),
          };
          const planBodies: Record<string, string | null> = {};
          for (const [k, p] of Object.entries(planPaths)) {
            const canonical = await assertInsideAllowedRoot(p, deps.config.workspace.allowed_roots);
            planBodies[k] = existsSync(canonical) ? await readFile(canonical, "utf8") : null;
          }

          // Read decision log entries + response log so the builder doesn't
          // re-open resolved items.
          const decisions = readDecisions(deps);
          const responseLogPath = join(root, "plans", "reviews", "response-log.md");
          const responseLog = existsSync(responseLogPath)
            ? await readFile(responseLogPath, "utf8")
            : null;

          const contextContent = {
            plan_name: parsed.plan_name,
            builder_type: parsed.builder_type,
            builder_md: builderMd,
            standards_md: standards,
            vibe_best_practice_md: vibeBp,
            type_best_practice_md: typedBp,
            plan: planBodies,
            decisions,
            response_log_md: responseLog,
          };
          const payload = success(
            Object.values(planPaths),
            `Build context for "${parsed.plan_name}" (builder_type=${parsed.builder_type}); ${Object.values(planBodies).filter(Boolean).length}/3 plan files present.`,
            parsed.expand
              ? { content: contextContent }
              : { expand_hint: "Call build_context with expand=true for the assembled payload." },
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "build_context",
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

async function readOptionalKbFile(deps: ServerDeps, rel: string): Promise<string | null> {
  const candidate = join(deps.config.kb.root, rel);
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Look up a best-practice by name in the KB; returns body or null. */
async function findBestPracticeByName(deps: ServerDeps, name: string): Promise<string | null> {
  const entries = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
  const match = entries.find(
    (e) => e.kind === "best-practice" && e.name.toLowerCase() === name.toLowerCase(),
  );
  if (!match) return null;
  try {
    return await readFile(match.path, "utf8");
  } catch {
    return null;
  }
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

function readDecisions(
  deps: ServerDeps,
): Array<{ slug: string; path: string; created_at: number }> {
  const rows = deps.projectDb
    ?.prepare("SELECT slug, path, created_at FROM decisions ORDER BY created_at ASC")
    .all() as Array<{ slug: string; path: string; created_at: number }> | undefined;
  return rows ?? [];
}
