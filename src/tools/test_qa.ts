// test_qa — project scope. Followup #24.
//
// QA test kind — exhaustive coverage over every documented command surface.
// Distinct from test_stress (which is volume / fuzz): QA is coverage. Asks
// "has every tool + CLI command been exercised with realistic inputs,
// recently?"
//
// Shipped together with test_stress as the #23+#24 "testing package."
//
// Default shape: LLM-driven. Returns a coverage matrix (tool → last-QA-at
// from audit) + a scaffolding prompt the calling LLM uses to sweep the
// surface and flag gaps. Pair with a subagent for fresh eyes, same runner
// persona rule as test_stress.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const TestQaInput = z
  .object({
    stale_days: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(30)
      .describe("tools not QA'd within this window are flagged as 'stale'"),
    expand: z.boolean().default(true),
  })
  .strict();

type TestQaArgs = z.infer<typeof TestQaInput>;

interface ToolCoverage {
  tool: string;
  last_invoked_at: number | null;
  last_result_code: string | null;
  stale: boolean;
  invocations_30d: number;
}

export function registerTestQa(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_qa",
    {
      title: "QA Test — Command-Surface Coverage",
      description:
        "Produce a coverage matrix of every MCP tool + its last-invoked-at / result_code, flagging tools not exercised within stale_days. Returns the scaffolding prompt for the calling LLM to drive a subagent sweep across the surface.",
      inputSchema: TestQaInput,
    },
    async (args: TestQaArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "test_qa requires project scope");
          }
          const parsed = TestQaInput.parse(args);
          const projectRoot = readProjectRoot(deps);

          const coverage = buildCoverage(deps, projectRoot, parsed.stale_days);
          const stale = coverage.filter((c) => c.stale);
          const prompt = buildPrompt(coverage, stale, parsed.stale_days);

          return success(
            [],
            `test_qa: ${coverage.length} tool(s), ${stale.length} stale (>${parsed.stale_days}d)`,
            {
              ...(parsed.expand
                ? {
                    content: {
                      stale_days: parsed.stale_days,
                      coverage,
                      stale_tools: stale.map((s) => s.tool),
                      scaffolding_prompt: prompt,
                    },
                  }
                : {}),
            },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "test_qa",
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

function buildCoverage(
  deps: ServerDeps,
  projectRoot: string | null,
  staleDays: number,
): ToolCoverage[] {
  // Derive the tool list from the audit log itself — the server has already
  // fired each tool at least once in its lifetime if it's been used. Fall
  // back to an empty list when the project is fresh.
  const staleThreshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  const rows = deps.globalDb
    .prepare(
      `SELECT tool, MAX(ts) AS last_ts, COUNT(*) AS count_30d
       FROM audit
       WHERE (project_root = ? OR project_root IS NULL)
         AND ts >= ?
       GROUP BY tool
       ORDER BY tool`,
    )
    .all(projectRoot, staleThreshold) as Array<{
    tool: string;
    last_ts: number | null;
    count_30d: number;
  }>;

  const allRows = deps.globalDb
    .prepare(
      `SELECT tool, MAX(ts) AS last_ts, MAX(result_code) AS last_code
       FROM audit
       WHERE (project_root = ? OR project_root IS NULL)
       GROUP BY tool
       ORDER BY tool`,
    )
    .all(projectRoot) as Array<{ tool: string; last_ts: number | null; last_code: string | null }>;

  const recentMap = new Map(rows.map((r) => [r.tool, r]));
  return allRows.map((r) => {
    const lastTs = r.last_ts;
    const stale = lastTs === null || lastTs < staleThreshold;
    return {
      tool: r.tool,
      last_invoked_at: lastTs,
      last_result_code: r.last_code,
      stale,
      invocations_30d: recentMap.get(r.tool)?.count_30d ?? 0,
    };
  });
}

function buildPrompt(coverage: ToolCoverage[], stale: ToolCoverage[], staleDays: number): string {
  return [
    `# QA sweep — exhaustive command-surface coverage`,
    ``,
    `You are running a QA pass across the VCF MCP tool surface. Distinct`,
    `from stress / fuzz (volume): QA is coverage. Goal: exercise every`,
    `documented tool with one realistic input and verify the happy path`,
    `still works. Catches silent drift — a tool that passes unit tests`,
    `forever but whose CLI wrapper stopped working six weeks ago.`,
    ``,
    `## Coverage matrix`,
    ``,
    `- **${coverage.length}** tool(s) have audit rows against this project.`,
    `- **${stale.length}** flagged as stale (not invoked in ${staleDays}d).`,
    ``,
    stale.length > 0
      ? "Stale tools:\n" + stale.map((s) => `- \`${s.tool}\``).join("\n") + "\n"
      : "_No stale tools — every tool was exercised within the window._\n",
    ``,
    `## Runner persona`,
    `Subagent or a local LLM endpoint. NOT the main orchestrator (same`,
    `runner-persona rule as test_stress — avoid confirmation bias).`,
    ``,
    `## Step 1 — Pick a subset`,
    `Start with the stale tools. For each, look up its input schema via`,
    `\`primer_list({ query: "<tool_name>" })\` or by reading`,
    `\`src/tools/<tool_name>.ts\`. Invent a realistic (not adversarial)`,
    `argument set that matches the schema.`,
    ``,
    `## Step 2 — Invoke + observe`,
    `Call each tool once. Record: did it return \`ok: true\`? If no, what`,
    `error code and is it expected given the input? E.g. calling`,
    `\`plan_save\` without a preceding \`plan_context\` is expected to`,
    `return \`E_STATE_INVALID\` in some paths — that's a passing QA.`,
    ``,
    `## Step 3 — Report`,
    `For each tool, one of:`,
    `- **OK** — invoked successfully with a representative input`,
    `- **OK (expected error)** — call failed but the error is documented`,
    `  behavior; cite the doc path`,
    `- **FAIL** — call failed in a way that indicates regression; file a`,
    `  finding with the input, output, and the expected behavior`,
    `- **SKIP** — tool requires setup the current project can't provide`,
    `  (e.g. an external endpoint that's unavailable); cite the skip`,
    `  reason`,
    ``,
    `## Step 4 — Propose follow-ups`,
    `FAILs get filed as bug findings. OK-with-gap entries (schema unclear,`,
    `error message ambiguous) get filed as \`feedback_add\` notes for the`,
    `improvement cycle.`,
    ``,
    `## Guardrails`,
    `- Real inputs only. Don't invent credentials or fake endpoint URLs;`,
    `  mark as SKIP when required infrastructure isn't present.`,
    `- Don't retry a failing tool 10 times — that's a flake test, not a`,
    `  QA pass. Record the failure and move on.`,
    `- Keep invocations idempotent when possible. A QA pass that mutates`,
    `  persistent state (creates plans, writes reviews) should do so in`,
    `  a throwaway scratch path.`,
    ``,
    `## Provenance`,
    ``,
    `If you persist this QA pass to a file (recommended — operators want a`,
    `record), include a provenance block at the top:`,
    ``,
    `\`\`\`yaml`,
    `provenance:`,
    `  tool: test_qa`,
    `  phase: test-qa`,
    `  model: <exact model id of the runner>`,
    `  endpoint: claude-code-subagent  # or local-ollama / litellm / etc.`,
    `  generated_at: <ISO 8601 timestamp>`,
    `\`\`\``,
    ``,
    `If you don't know your exact model id, ask the operator. The provenance`,
    `is how the operator weights the QA verdict — a "FAIL" from a frontier`,
    `model carries different weight than a "FAIL" from a 3B local model.`,
  ].join("\n");
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { TestQaInput };
