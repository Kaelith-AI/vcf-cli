// project_init_existing — global scope. Followup #20.
//
// Adopts a pre-existing project directory into VCF without demanding the
// retroactive full lifecycle paper trail. Three modes:
//
//   bypass      — minimal adoption. Creates project.db + registry row; flags
//                 adopted=1. No validation of existing docs. Use when you
//                 want to run review/portfolio tools against a project that
//                 wasn't born in VCF (VCF dogfooding itself is the first
//                 example).
//
//   strict      — adopts only if the project already has the full paper
//                 trail: at least one spec, one plan, and one manifest.
//                 Validation runs BEFORE registry writes, so a strict
//                 failure leaves the registry untouched. Use when
//                 formalizing a project that already has everything.
//
//   reconstruct — adopts AND returns a scaffolding prompt for the calling
//                 LLM. The prompt tells the LLM to read README, package
//                 manifests, source tree, and git history; infer what the
//                 project DOES (not what's next); call spec_template +
//                 spec_save to persist a backwards-facing spec. No plan
//                 is created — planning is forward-facing and happens in
//                 a separate planner session after reconstruct returns.
//                 Project state defaults to 'draft' so the next step is
//                 naturally planning.
//
// Non-negotiables:
//   - project_path must be inside workspace.allowed_roots.
//   - Idempotent: re-adopting the same path is a no-op (registry upsert).
//   - strict validation runs first; failures leave the registry untouched.
//   - review_prepare and the rest of the lifecycle surface already handle
//     the "no spec, no plan" case gracefully; no changes required there.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { type ProjectState } from "../db/project.js";
import { writeAudit } from "../util/audit.js";
import { adoptProject } from "../project/adopt.js";
import { resolveOutputs } from "../util/outputs.js";
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
      .enum(["bypass", "strict", "reconstruct"])
      .default("bypass")
      .describe(
        "'bypass' (default): minimal adoption — review surface can run against live source+git. 'strict': refuses to adopt unless spec + plan + manifest already exist in the expected locations. 'reconstruct': adopts and returns a scaffolding prompt the caller LLM uses to infer + persist a backwards-facing spec via spec_save.",
      ),
    state: z
      .enum(ALLOWED_STATES)
      .optional()
      .describe(
        "initial project.state. Defaults: 'reviewing' for bypass/strict, 'draft' for reconstruct (next step is planning).",
      ),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectInitExistingArgs = z.infer<typeof ProjectInitExistingInput>;

interface StrictAuditResult {
  ok: boolean;
  spec_paths: string[];
  plan_paths: string[];
  manifest_paths: string[];
  missing: Array<"spec" | "plan" | "manifest">;
}

/**
 * Strict-mode audit: verify the adopted project already has the full paper
 * trail (spec + plan + manifest). Looks in workspace.specs_dir AND
 * <project_root>/specs/ for specs, and config.outputs.plans_dir for plan +
 * manifest files. Any `.md` filename in those dirs counts — we're checking
 * presence, not content.
 */
function auditStrict(projectRoot: string, specsDir: string, plansDir: string): StrictAuditResult {
  const specPaths = [...listMarkdown(specsDir), ...listMarkdown(join(projectRoot, "specs"))].filter(
    (p, i, arr) => arr.indexOf(p) === i,
  );
  const planPaths = listMarkdown(plansDir).filter((p) => /-plan\.md$/.test(p));
  const manifestPaths = listMarkdown(plansDir).filter((p) => /-manifest\.md$/.test(p));

  const missing: Array<"spec" | "plan" | "manifest"> = [];
  if (specPaths.length === 0) missing.push("spec");
  if (planPaths.length === 0) missing.push("plan");
  if (manifestPaths.length === 0) missing.push("manifest");

  return {
    ok: missing.length === 0,
    spec_paths: specPaths,
    plan_paths: planPaths,
    manifest_paths: manifestPaths,
    missing,
  };
}

function listMarkdown(dir: string): string[] {
  try {
    const s = statSync(dir);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* skip broken entry */
    }
  }
  return out;
}

function reconstructPrompt(projectRoot: string, name: string): string {
  return [
    `# Reconstruct backwards-facing spec for "${name}"`,
    ``,
    `You are adopting an existing project into VCF. Your job is to write a`,
    `spec that describes what this project DOES today, not what's next.`,
    `Planning for future changes happens separately after this spec lands.`,
    ``,
    `## Step 1 — Read`,
    `Read (in order, stop when you have enough to ground the spec):`,
    `  1. \`${projectRoot}/README.md\` — top-level purpose + audience`,
    `  2. \`${projectRoot}/package.json\` / \`pyproject.toml\` / \`Cargo.toml\` —`,
    `     declared deps, entry points, bin surface`,
    `  3. \`${projectRoot}/CLAUDE.md\` or \`${projectRoot}/AGENTS.md\` if present —`,
    `     operator conventions`,
    `  4. \`${projectRoot}/src/\` structure — module names + top-level exports`,
    `  5. \`git log --oneline -50\` from the project root — what's been`,
    `     changing recently (indicates active surface area)`,
    ``,
    `## Step 2 — Call spec_template`,
    `Call \`spec_template\` to get a blank spec scaffold with the current`,
    `schema. Do not hand-roll the frontmatter.`,
    ``,
    `## Step 3 — Fill in + call spec_save`,
    `Populate the template sections from what you read. Mark frontmatter`,
    `\`status: accepted\` (the project already exists — the spec describes`,
    `reality, not a proposal). Call \`spec_save\` with the result.`,
    ``,
    `## Step 4 — Next`,
    `Once the spec is in place, the operator enters planning mode to scope`,
    `a forward-facing change. That plan produces manifest + todo + plan`,
    `docs the normal way. Review stages then operate against the new plan`,
    `and diff, not against the historical code.`,
    ``,
    `## Guardrails`,
    `- The spec describes WHAT the project does, not HOW you'd change it.`,
    `- If the project has multiple distinct surfaces (e.g., a CLI + a`,
    `  library), consider splitting into multiple specs linked via`,
    `  \`related_specs:\` frontmatter.`,
    `- Do not fabricate features the code doesn't support. When uncertain,`,
    `  write the spec section as \`_TBD — needs operator confirmation_\``,
    `  and flag it for the operator.`,
    `- Redact secrets. Any committed API key or token you spot during the`,
    `  read step should be flagged to the operator, not copied into spec`,
    `  body.`,
    ``,
    `## Provenance`,
    ``,
    `The spec you author is a long-lived KB-class artifact. When you call`,
    `\`spec_save\`, include a \`provenance\` block in the spec's frontmatter:`,
    ``,
    `\`\`\`yaml`,
    `provenance:`,
    `  tool: project_init_existing`,
    `  phase: reconstruct`,
    `  model: <exact model id of the agent doing this reconstruction>`,
    `  endpoint: claude-code-main`,
    `  generated_at: <ISO 8601>`,
    `\`\`\``,
    ``,
    `Reconstructed specs are inferred from code that may have been authored`,
    `by humans — the spec is a model's READING of that code. Future operators`,
    `revisiting the spec need to know which model did the reading, especially`,
    `when re-validating against newer code.`,
  ].join("\n");
}

export function registerProjectInitExisting(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_init_existing",
    {
      title: "Adopt Existing Project",
      description:
        "Bring an existing project directory under VCF tracking. 'bypass' (default): register and create project.db, no content inspection. 'strict': refuse to adopt unless spec + plan + manifest already exist. 'reconstruct': adopt and return a scaffolding prompt the calling LLM uses to infer + persist a backwards-facing spec via spec_save (planning for future changes happens separately after).",
      inputSchema: ProjectInitExistingInput,
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

          // State default depends on mode. Bypass + strict default to
          // 'reviewing' (the typical reason to adopt is to run review
          // against existing code). Reconstruct defaults to 'draft'
          // because the operator's next step is planning mode.
          const state: ProjectState =
            parsed.state ?? (parsed.mode === "reconstruct" ? "draft" : "reviewing");

          // Strict audit runs BEFORE registry writes so a strict failure
          // leaves the registry untouched. A bypass-mode adoption can
          // always be converted to strict later by running the tool again.
          let strictAudit: StrictAuditResult | null = null;
          if (parsed.mode === "strict") {
            const outputs = resolveOutputs(target, deps.config);
            strictAudit = auditStrict(target, deps.config.workspace.specs_dir, outputs.plansDir);
            if (!strictAudit.ok) {
              throw new McpError(
                "E_STATE_INVALID",
                `strict adoption requires existing paper trail; missing: ${strictAudit.missing.join(", ")}. ` +
                  `Run with mode='bypass' to adopt without validation, or mode='reconstruct' to infer a spec from source.`,
              );
            }
          }

          const name = parsed.name ?? basenameOf(target);

          const result = await adoptProject({
            root: target,
            name,
            state,
            globalDb: deps.globalDb,
            ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          });

          const modeSuffix =
            parsed.mode === "strict"
              ? `, strict-audit=ok (${strictAudit!.spec_paths.length} spec(s), ${strictAudit!.plan_paths.length} plan(s), ${strictAudit!.manifest_paths.length} manifest(s))`
              : parsed.mode === "reconstruct"
                ? `, reconstruct-prompt attached`
                : "";
          const summary = result.existing
            ? `Re-adopted project "${result.existing.name}" at ${target} (mode=${parsed.mode}, state preserved=${result.existing.state})${modeSuffix}.`
            : `Adopted project "${name}" at ${target} (mode=${parsed.mode}, state=${state}, fresh project.db=${result.freshDb})${modeSuffix}.`;

          const prompt = parsed.mode === "reconstruct" ? reconstructPrompt(target, name) : null;

          return success([target, result.projectDbPath], summary, {
            ...(parsed.expand
              ? {
                  content: {
                    project_path: target,
                    name: result.existing?.name ?? name,
                    slug: result.slug,
                    state: result.existing?.state ?? state,
                    mode: parsed.mode,
                    adopted: true,
                    fresh_db: result.freshDb,
                    project_db: result.projectDbPath,
                    registry_warning: result.registryWarning,
                    ...(strictAudit
                      ? {
                          strict_audit: {
                            spec_paths: strictAudit.spec_paths,
                            plan_paths: strictAudit.plan_paths,
                            manifest_paths: strictAudit.manifest_paths,
                          },
                        }
                      : {}),
                    ...(prompt ? { reconstruct_prompt: prompt } : {}),
                  },
                }
              : {}),
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
