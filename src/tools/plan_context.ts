// plan_context — project scope.
//
// Prepare the context payload for the client LLM to write a plan against.
// Returns: planner.md role overlay, company-standards + vibe-coding-primer,
// the tag-matched primer suggestions for the project's spec, and the spec
// content itself. The client runs the plan conversation; plan_save persists
// the output.
//
// The server never calls an LLM; this is a pure read + assemble step. Pays
// the token economy contract: planner gets what it needs, nothing more.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { readTemplate } from "../util/templates.js";
import { writeAudit } from "../util/audit.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { McpError } from "../errors.js";
import { loadKbCached } from "../primers/load.js";
import { matchPrimers } from "../primers/match.js";

const PlanContextInput = z
  .object({
    /**
     * Name slug for this plan (lowercase kebab). Drives the output file
     * names plans/<name>-plan.md, plans/<name>-todo.md, -manifest.md.
     */
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128),
    /**
     * Optional spec path override. If omitted, we read the project row's
     * `spec_path`; if both are absent, we fail with E_STATE_INVALID.
     */
    spec_path: z.string().min(1).optional(),
    limit_primers: z.number().int().min(1).max(30).default(12),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerPlanContext(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "plan_context",
    {
      title: "Plan Context",
      description:
        "Assemble planner.md + company-standards + vibe-coding-primer + tag-matched primer/best-practice suggestions + the spec content. The client LLM writes the plan; plan_save persists it.",
      inputSchema: PlanContextInput.shape,
    },
    async (args: z.infer<typeof PlanContextInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError(
            "E_STATE_INVALID",
            "plan_context requires project scope — server booted without a project DB",
          );
        }
        const parsed = PlanContextInput.parse(args);

        // Resolve spec.
        const specPath = parsed.spec_path ?? readProjectSpecPath(deps);
        if (!specPath) {
          throw new McpError(
            "E_STATE_INVALID",
            "no spec_path configured for this project — pass spec_path or re-run project_init with --spec_path",
          );
        }
        const specAbs = await assertInsideAllowedRoot(
          specPath,
          deps.config.workspace.allowed_roots,
        );
        if (!existsSync(specAbs)) {
          throw new McpError("E_NOT_FOUND", `spec file missing: ${specAbs}`);
        }
        const specBody = await readFile(specAbs, "utf8");
        const specFm = extractFrontmatter(specBody);
        const techTags = toStringArray(specFm?.["tech_stack"]);
        const lensTags = toStringArray(specFm?.["lens"]);

        // KB loads.
        const planner = await readTemplate("planner.md.tpl");
        const standards = await readOptionalKbFile(deps, join("standards", "company-standards.md"));
        const vibePrimer = await readOptionalKbFile(
          deps,
          join("standards", "vibe-coding-primer.md"),
        );

        // Tag-matched primers.
        const entries = await loadKbCached(deps.config.kb.root);
        const kinds = new Set(["primer", "best-practice"]);
        const suggestions = matchPrimers(
          entries.filter((e) => kinds.has(e.kind)),
          {
            tech_tags: techTags,
            lens_tags: lensTags,
            limit: parsed.limit_primers,
          },
        );

        const targetOut = planOutputPaths(deps, parsed.name);

        const contextContent = {
          name: parsed.name,
          spec_path: specAbs,
          output_targets: targetOut,
          planner_md: planner,
          standards_md: standards,
          vibe_primer_md: vibePrimer,
          spec_md: specBody,
          suggested_primers: suggestions,
          tech_tags: techTags,
          lens_tags: lensTags,
        };
        const payload = success(
          [specAbs, ...suggestions.map((s) => s.path)].slice(0, 10),
          `Plan context assembled for "${parsed.name}": ${suggestions.length} primer(s), ${techTags.length} tech tag(s).`,
          parsed.expand
            ? { content: contextContent }
            : {
                expand_hint: "Call plan_context with expand=true to receive the assembled payload.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "plan_context",
            scope: "project",
            project_root: readProjectRootPath(deps),
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

function readProjectSpecPath(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT spec_path FROM project WHERE id=1").get() as
    | { spec_path: string | null }
    | undefined;
  return row?.spec_path ?? null;
}

function readProjectRootPath(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

async function readOptionalKbFile(deps: ServerDeps, rel: string): Promise<string | null> {
  const candidate = join(deps.config.kb.root, rel);
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return null;
  }
}

function planOutputPaths(deps: ServerDeps, name: string): Record<string, string> {
  const root = readProjectRootPath(deps) ?? ".";
  return {
    plan_md: join(root, "plans", `${name}-plan.md`),
    todo_md: join(root, "plans", `${name}-todo.md`),
    manifest_md: join(root, "plans", `${name}-manifest.md`),
  };
}

function extractFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = raw.slice(3, end).trim();
  const obj: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      obj[key] =
        inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    obj[key] = value;
  }
  return obj;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}
