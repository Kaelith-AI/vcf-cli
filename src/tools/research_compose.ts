// research_compose — global scope. Followup #29 (minimum-viable shape).
//
// Multi-agent KB-entry creation. Returns a scaffolding prompt that walks
// the calling LLM through a fan-out: one research subagent per aspect of
// the topic, each returns structured findings with source references, a
// composition step assembles them into a draft KB entry shape. The verify
// step (#29c) is a separate tool — research_verify — that wraps the draft
// in a different-model cross-check before merge.
//
// Staging-only: this tool never touches the live KB. Drafts live under
// `~/.vcf/kb-drafts/<research_run_id>/` until explicitly promoted via
// `vcf research merge <run_id>` (a CLI command tracked as a followup).
//
// mode=llm-driven (default) returns the scaffolding prompt. mode=endpoint
// is deferred — a real endpoint-driven research flow needs outbound-HTTP
// fetching + source-tracking + redaction, all of which are followup work.
// For now the LLM-driven mode is the primary surface.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const ResearchComposeInput = z
  .object({
    kind: z
      .enum(["primer", "best-practice", "review-stage", "reviewer", "standard", "lens"])
      .describe("KB entry kind the draft will land as"),
    topic: z.string().min(1).max(256),
    aspects: z
      .array(z.string().min(1).max(256))
      .min(2)
      .max(10)
      .describe(
        "distinct research angles — one subagent per aspect. Example for database-migrations topic: ['tooling landscape 2026', 'safety patterns / locking', 'CI-CD integration', 'failure-mode literature']",
      ),
    recency_window_days: z
      .number()
      .int()
      .positive()
      .max(3650)
      .default(365)
      .describe("only cite sources published within this window"),
    mode: z.enum(["llm-driven"]).default("llm-driven"),
    expand: z.boolean().default(true),
  })
  .strict();

type ResearchComposeArgs = z.infer<typeof ResearchComposeInput>;

export function registerResearchCompose(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "research_compose",
    {
      title: "Compose a New KB Entry via Research Subagents",
      description:
        "Returns a scaffolding prompt that walks the calling LLM through a fan-out research flow: one subagent per aspect, structured findings with source refs, assembled into a KB-shaped draft under ~/.vcf/kb-drafts/. Verify via research_verify before merging into the live KB.",
      inputSchema: ResearchComposeInput,
    },
    async (args: ResearchComposeArgs) => {
      return runTool(
        async () => {
          const parsed = ResearchComposeInput.parse(args);
          if (parsed.aspects.length < 2) {
            throw new McpError(
              "E_VALIDATION",
              "research_compose requires at least 2 aspects — single-aspect research is research_refresh territory",
            );
          }
          const prompt = buildPrompt(parsed);
          return success(
            [],
            `research_compose: scaffold for ${parsed.kind} on '${parsed.topic}' across ${parsed.aspects.length} aspects`,
            {
              ...(parsed.expand
                ? {
                    content: {
                      kind: parsed.kind,
                      topic: parsed.topic,
                      aspects: parsed.aspects,
                      recency_window_days: parsed.recency_window_days,
                      staging_hint: `~/.vcf/kb-drafts/<run_id>/`,
                      scaffolding_prompt: prompt,
                    },
                  }
                : { expand_hint: "Pass expand=true for the scaffolding prompt." }),
            },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "research_compose",
            scope: "global",
            project_root: null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function buildPrompt(parsed: ResearchComposeArgs): string {
  return [
    `# Research compose — ${parsed.kind} on ${parsed.topic}`,
    ``,
    `You are producing a NEW KB entry via multi-subagent research. The entry`,
    `is a draft — it goes to a staging dir, not the live KB, and must pass`,
    `\`research_verify\` (different model, different endpoint) before merge.`,
    ``,
    `## Phase 1 — Fan out (${parsed.aspects.length} subagents in parallel)`,
    ``,
    `Dispatch one research subagent per aspect. For each, give it:`,
    ``,
    `- Topic: "${parsed.topic}"`,
    `- Recency window: sources published within the last`,
    `  ${parsed.recency_window_days} days`,
    `- The subagent's specific aspect:`,
    ``,
    parsed.aspects.map((a, i) => `  ${i + 1}. **${a}**`).join("\n"),
    ``,
    `Instruct each subagent to return structured findings:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "aspect": "<the aspect>",`,
    `  "findings": [`,
    `    {`,
    `      "claim": "<one-sentence factual claim>",`,
    `      "source": { "url": "...", "title": "...", "published": "YYYY-MM-DD" },`,
    `      "quote": "<verbatim supporting passage, ≤50 words>",`,
    `      "confidence": "high" | "medium" | "low"`,
    `    }`,
    `  ],`,
    `  "open_questions": ["<things you couldn't resolve>"]`,
    `}`,
    `\`\`\``,
    ``,
    `## Phase 2 — Assemble draft`,
    ``,
    `Fan-in the aspect reports. Produce a draft KB entry in the shape`,
    `required by \`${parsed.kind}\`. Hard rules:`,
    ``,
    `- **Every claim needs a \`source\` reference.** Unsourced claims get`,
    `  dropped. Don't paraphrase your training data.`,
    `- **Resolve contradictions.** If two aspects report conflicting`,
    `  claims, surface the contradiction in the entry with both sources`,
    `  and either (a) pick the more recent / authoritative source and`,
    `  name why, or (b) file an open question for operator review.`,
    `- **Write to the frontmatter contract** for \`${parsed.kind}\`. Check`,
    `  \`kb/standards/tag-vocabulary.md\` for tag tokens.`,
    ``,
    `## Phase 3 — Stage`,
    ``,
    `Write the draft to \`~/.vcf/kb-drafts/<run_id>/\` with:`,
    ``,
    `- The draft KB entry at \`draft.md\``,
    `- \`sources.json\` — list of every source cited`,
    `- \`aspects/<aspect-name>.json\` — each subagent's raw report`,
    ``,
    `(\`<run_id>\` is an ISO timestamp slug — \`$(date +%Y%m%dT%H%M%S)-<topic-slug>\`.)`,
    ``,
    `## Phase 4 — Verify`,
    ``,
    `Call \`research_verify\` (once that tool ships) or manually dispatch`,
    `a different model at a different endpoint to:`,
    ``,
    `- Verify source URLs still resolve + publish dates match`,
    `- Check each claim is actually supported by the cited quote`,
    `- Flag hallucination risk (claim without a strong source)`,
    `- Return \`{ references_verified, contested_claims, hallucination_risk,`,
    `  recommendation: merge | revise | reject }\``,
    ``,
    `## Phase 5 — Operator review`,
    ``,
    `Only the operator moves a staged draft into the live KB. The operator`,
    `reads \`draft.md\` + the verify verdict and decides. Do not modify`,
    `\`<kb>/\` directly from this flow — the live KB is a trust boundary.`,
    ``,
    `## Guardrails`,
    `- **Different model for verify.** Same-model verify is confirmation`,
    `  bias, not verification. If your only option is same-model, name`,
    `  that limitation in the verify verdict.`,
    `- **Redaction.** Outbound prompts may include lesson text, spec`,
    `  snippets, or source excerpts. Run through \`redact()\`.`,
    `- **No auto-merge.** Ever. The staging dir is the boundary.`,
  ].join("\n");
}

export { ResearchComposeInput };
