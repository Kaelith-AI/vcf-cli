// project_init_existing — global scope. Followup #20.
//
// Adopts a pre-existing project directory into VCF without demanding the
// retroactive full lifecycle paper trail. The current shipping mode is
// `bypass`: creates a minimal `.vcf/project.db` + registry row, flags the
// project as `adopted=1`, and does NOT scaffold AGENTS.md / CLAUDE.md /
// plans / decisions / git-hooks. The motivating use case is running the
// review surface against projects that weren't born in VCF (VCF dogfooding
// itself is the first example).
//
// Future modes (reserved in the schema but not yet implemented):
//   - `strict`      — fails if spec/plan/manifest docs are absent.
//   - `reconstruct` — returns a scaffolding prompt for the caller LLM to
//                     infer missing docs from code + README + git history.
//
// Non-negotiables:
//   - project_path must be inside workspace.allowed_roots.
//   - Idempotent: re-adopting the same path is a no-op (registry upsert).
//   - review_prepare and the rest of the lifecycle surface already handle
//     the "no spec, no plan" case gracefully; no changes required there.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { slugify } from "../util/slug.js";
import { openProjectDb, type ProjectState } from "../db/project.js";
import { writeAudit } from "../util/audit.js";
import { upsertProject } from "../util/projectRegistry.js";
import { McpError } from "../errors.js";

const ALLOWED_STATES = [
  "draft",
  "planning",
  "building",
  "testing",
  "reviewing",
  "shipping",
  "shipped",
] as const satisfies readonly ProjectState[];

const ProjectInitExistingInput = z
  .object({
    project_path: z
      .string()
      .min(1)
      .describe(
        "absolute path to the existing project directory. Must be inside workspace.allowed_roots.",
      ),
    name: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("human-readable name; defaults to basename(project_path)"),
    mode: z
      .enum(["bypass"])
      .default("bypass")
      .describe(
        "'bypass' (currently the only supported mode): minimal adoption — no scaffolding, review surface can run against live source+git. 'strict' and 'reconstruct' are reserved for future releases.",
      ),
    state: z
      .enum(ALLOWED_STATES)
      .default("reviewing")
      .describe(
        "initial project.state. Defaults to 'reviewing' because the typical reason to adopt is to run the review surface against existing code.",
      ),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectInitExistingArgs = z.infer<typeof ProjectInitExistingInput>;

export function registerProjectInitExisting(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_init_existing",
    {
      title: "Adopt Existing Project",
      description:
        "Bring an existing project directory under VCF tracking without re-scaffolding. Current mode: 'bypass' — creates .vcf/project.db + registry row, flags adopted=1. Future modes ('strict', 'reconstruct') will enforce or infer missing lifecycle artifacts. Use when you want to run review/portfolio tools against a project that wasn't born in VCF.",
      inputSchema: ProjectInitExistingInput.shape,
    },
    async (args: ProjectInitExistingArgs) => {
      return runTool(
        async () => {
          const parsed = ProjectInitExistingInput.parse(args);
          const target = resolvePath(parsed.project_path);
          await assertInsideAllowedRoot(target, deps.config.workspace.allowed_roots);

          if (!existsSync(target)) {
            throw new McpError("E_NOT_FOUND", `project_path ${target} does not exist`);
          }

          // `bypass` is the only implemented mode. We parse the enum so adding
          // 'strict' / 'reconstruct' later is purely additive — this check
          // keeps the current behavior honest.
          if (parsed.mode !== "bypass") {
            throw new McpError(
              "E_STATE_INVALID",
              `mode '${parsed.mode}' not yet implemented — use 'bypass'`,
            );
          }

          const name = parsed.name ?? basenameOf(target);
          const projectSlug = slugify(name);

          await mkdir(join(target, ".vcf"), { recursive: true });
          const dbPath = join(target, ".vcf", "project.db");
          const freshDb = !existsSync(dbPath);
          const db = openProjectDb({ path: dbPath });
          const now = Date.now();

          // Idempotent: if a project row already exists at id=1, don't clobber
          // its state/name silently. Re-adoption refreshes `adopted` and
          // `updated_at` but preserves whatever state + name the user already
          // chose.
          const existing = db
            .prepare("SELECT id, name, state, adopted FROM project WHERE id = 1")
            .get() as { id: number; name: string; state: string; adopted: number } | undefined;

          if (existing) {
            db.prepare(
              `UPDATE project SET adopted = 1, updated_at = ?, root_path = ? WHERE id = 1`,
            ).run(now, target);
          } else {
            db.prepare(
              `INSERT INTO project (id, name, root_path, state, created_at, updated_at, spec_path, adopted)
               VALUES (1, ?, ?, ?, ?, ?, NULL, 1)`,
            ).run(name, target, parsed.state, now, now);
          }
          db.close();

          // Registry upsert — surface in `vcf project list` + portfolio_graph.
          try {
            upsertProject(deps.globalDb, {
              name: projectSlug,
              root_path: target,
              state: existing?.state ?? parsed.state,
            });
          } catch {
            /* non-fatal — registry is a convenience, not a requirement */
          }

          const summary = existing
            ? `Re-adopted project "${existing.name}" at ${target} (mode=${parsed.mode}, state preserved=${existing.state}).`
            : `Adopted project "${name}" at ${target} (mode=${parsed.mode}, state=${parsed.state}, fresh project.db=${freshDb}).`;

          return success([target, dbPath], summary, {
            ...(parsed.expand
              ? {
                  content: {
                    project_path: target,
                    name: existing?.name ?? name,
                    slug: projectSlug,
                    state: existing?.state ?? parsed.state,
                    mode: parsed.mode,
                    adopted: true,
                    fresh_db: freshDb,
                    project_db: dbPath,
                  },
                }
              : {
                  expand_hint:
                    "Call project_init_existing again with expand=true for the full payload.",
                }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "project_init_existing",
            scope: "global",
            project_root:
              typeof (args as { project_path?: unknown }).project_path === "string"
                ? resolvePath((args as { project_path: string }).project_path)
                : null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
