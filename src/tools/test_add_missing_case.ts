// test_add_missing_case — project scope. Followup #12.
//
// LLM-driven scaffolding: given the current spec + plan + manifest + test
// file list, returns a prompt that walks the calling LLM through identifying
// missing test cases and generating stubs. Mirrors the
// prompt-driven pattern from review_prepare / project_init_existing
// (reconstruct mode) — the server assembles the relevant context, the LLM
// decides what tests to write.
//
// Lesson linkage (followup #11 wiring): when the LLM generates a stub for a
// case that came from a lesson_log entry, the prompt tells it to add
// `test_for_lesson: <slug>` frontmatter to the stub so the improvement
// cycle can later verify lessons turned into real regression guards.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { resolveOutputs } from "../util/outputs.js";

const TestAddMissingCaseInput = z
  .object({
    plan_name: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "name prefix of plan files (e.g. 'feature-x' for feature-x-plan.md). If omitted, the most recently modified plan/manifest in plans_dir is used.",
      ),
    test_dirs: z
      .array(z.string().min(1).max(512))
      .max(16)
      .default(["test", "tests", "__tests__"])
      .describe("directories to scan for existing test files"),
    expand: z.boolean().default(true),
  })
  .strict();

type TestAddMissingCaseArgs = z.infer<typeof TestAddMissingCaseInput>;

export function registerTestAddMissingCase(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_add_missing_case",
    {
      title: "Propose Missing Test Cases",
      description:
        "Scans the plan + manifest + existing test files and returns a scaffolding prompt the calling LLM uses to identify test cases that aren't yet covered. Output is a prompt; the LLM does the analysis and generates stubs. When a proposed case comes from a lesson_log entry, the prompt asks the LLM to add `test_for_lesson: <slug>` frontmatter so the improvement cycle can verify the guard.",
      inputSchema: TestAddMissingCaseInput,
    },
    async (args: TestAddMissingCaseArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError(
              "E_STATE_INVALID",
              "test_add_missing_case requires project scope",
            );
          }
          const parsed = TestAddMissingCaseInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const outputs = resolveOutputs(projectRoot, deps.config);
          const plansDir = outputs.plansDir;

          // Pick a plan: explicit --plan_name wins, otherwise the newest
          // -plan.md in plans_dir.
          let planName: string | undefined = parsed.plan_name;
          if (!planName) {
            planName = findNewestPlanName(plansDir) ?? undefined;
          }
          if (!planName) {
            throw new McpError(
              "E_NOT_FOUND",
              `no plan found under ${plansDir}. Pass plan_name explicitly, or run plan_save first.`,
            );
          }

          const planPath = join(plansDir, `${planName}-plan.md`);
          const manifestPath = join(plansDir, `${planName}-manifest.md`);
          const todoPath = join(plansDir, `${planName}-todo.md`);

          const testFiles = listTestFiles(projectRoot, parsed.test_dirs);

          const prompt = buildPrompt({
            projectRoot,
            planPath,
            manifestPath,
            todoPath,
            specsDir: deps.config.workspace.specs_dir,
            testFiles,
          });

          return success([planPath, manifestPath, todoPath], `Proposed missing-case scaffold for ${planName}`, {
            ...(parsed.expand
              ? {
                  content: {
                    plan_name: planName,
                    plan_path: planPath,
                    manifest_path: manifestPath,
                    todo_path: todoPath,
                    specs_dir: deps.config.workspace.specs_dir,
                    test_file_count: testFiles.length,
                    test_files: testFiles,
                    scaffolding_prompt: prompt,
                  },
                }
              : {
                  expand_hint:
                    "Pass expand=true for the scaffolding prompt + full test-file inventory.",
                }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "test_add_missing_case",
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

interface PromptOpts {
  projectRoot: string;
  planPath: string;
  manifestPath: string;
  todoPath: string;
  specsDir: string;
  testFiles: string[];
}

function buildPrompt(opts: PromptOpts): string {
  return [
    `# Propose missing test cases`,
    ``,
    `You are adding coverage to an in-flight VCF project. Your job is to`,
    `identify test cases the manifest + plan + spec imply but the existing`,
    `test files don't cover, then generate stubs the operator can flesh out.`,
    `You are NOT adding coverage for code that wasn't planned. If the plan`,
    `doesn't ask for it, don't guess.`,
    ``,
    `## Step 1 — Read`,
    `Read in order:`,
    `  1. \`${opts.manifestPath}\` — the file-by-file map of what this change`,
    `     writes. Every file here should have a corresponding test row in`,
    `     the manifest's test section.`,
    `  2. \`${opts.planPath}\` — risks, forbids, review gates, test plan.`,
    `     Pay attention to the "What A Good Plan Forbids" section — each`,
    `     forbid is a candidate test.`,
    `  3. \`${opts.todoPath}\` (if present) — items the builder has checked`,
    `     off. Missing tests often lag the last-checked code item.`,
    `  4. The spec under \`${opts.specsDir}\` — behaviors and invariants.`,
    `  5. Recent \`lesson_search({ filter: "current", stage: "testing" })\``,
    `     results — lessons tagged with the testing stage are strong`,
    `     signals that a class of case was missed on prior work.`,
    ``,
    `## Step 2 — Inventory existing coverage`,
    `The server has listed ${opts.testFiles.length} test file(s) under this`,
    `project:`,
    ``,
    opts.testFiles.length > 0
      ? opts.testFiles
          .slice(0, 40)
          .map((f) => `- \`${f}\``)
          .join("\n") +
        (opts.testFiles.length > 40 ? `\n- _…and ${opts.testFiles.length - 40} more_` : "")
      : "_No test files found. First-time coverage — plan out the initial test layer._",
    ``,
    `Grep these for behaviors the manifest promises. A behavior the manifest`,
    `lists that doesn't appear in the greps is a candidate missing case.`,
    ``,
    `## Step 3 — Propose stubs`,
    `For each missing case, propose a test stub with:`,
    `  - file path (under an existing test dir where possible)`,
    `  - test name (imperative, describes what's being verified)`,
    `  - a \`_TBD_\` body the operator will flesh out`,
    `  - severity: blocker | warning | info — same calibration as review`,
    `    findings. Blocker = manifest-promised behavior untested. Warning =`,
    `    spec-named invariant untested. Info = nice-to-have coverage.`,
    `  - optional \`test_for_lesson: <slug>\` frontmatter when the case was`,
    `    surfaced by a lesson_log entry. Closes the improvement-cycle loop:`,
    `    a lesson becomes a permanent guard when the test lands.`,
    ``,
    `## Step 4 — Return`,
    `Return your proposals as a ranked list. Do not call \`test_generate\`;`,
    `the operator reviews your list first and invokes test_generate per`,
    `accepted proposal.`,
    ``,
    `## Guardrails`,
    `- **Every claim needs evidence.** If you claim "error path X is untested,"`,
    `  name the manifest line that promises X AND the grep that returned`,
    `  zero hits. Unsupported claims get dropped.`,
    `- **Don't propose tests for code the plan didn't ask for.** That's`,
    `  scope creep at best and refactor-pressure at worst.`,
    `- **Respect prior \`accepted_risk\` entries in the response log.** A`,
    `  case the operator explicitly accepted as untested is not a missing`,
    `  case; it's a closed one.`,
  ].join("\n");
}

function listTestFiles(projectRoot: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    const full = join(projectRoot, d);
    if (!existsSync(full)) continue;
    walk(full, projectRoot, out);
  }
  return out;
}

function walk(dir: string, projectRoot: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, projectRoot, out);
    } else if (
      /(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift)$/.test(name)
    ) {
      out.push(relative(projectRoot, full));
    }
  }
}

function findNewestPlanName(plansDir: string): string | null {
  try {
    const entries = readdirSync(plansDir);
    const candidates: Array<{ name: string; mtime: number }> = [];
    for (const n of entries) {
      const m = /^(.+)-plan\.md$/.exec(n);
      if (!m || !m[1]) continue;
      try {
        const s = statSync(join(plansDir, n));
        candidates.push({ name: m[1], mtime: s.mtimeMs });
      } catch {
        /* skip */
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]!.name;
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

export { TestAddMissingCaseInput };
