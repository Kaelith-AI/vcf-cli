// review_type_create — global scope. Followup #21.
//
// Extensible review-type builder. Per the user's spec: review types are
// meticulously crafted, not simply templated. The tool returns a
// multi-phase scaffolding prompt that walks the calling LLM through a
// subagent-driven flow:
//   1. Research the topic (one subagent) → propose step count + outline.
//   2. Per-step research (N subagents in parallel) → outline each stage.
//   3. Per-step fill-in (N subagents in parallel) → author each stage file.
//   4. Call review_type_apply with the assembled artifacts → KB write.
//
// mode=llm-driven (default) returns the scaffolding prompt; the calling
// LLM dispatches subagents and fills in each stage. mode=endpoint is a
// stub that hands the whole flow to a configured OpenAI-compatible
// endpoint — recommended only for frontier models (local models
// generally can't sustain the multi-subagent orchestration). This is
// intentional: the meticulous-review bar is HIGH.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const ReviewTypeCreateInput = z
  .object({
    topic: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "the domain to review — e.g. 'skill-authoring', 'data-pipeline', 'documentation', 'accessibility'",
      ),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "review type name must be lowercase kebab-case")
      .describe(
        "short slug used in KB paths and config.review.categories — e.g. 'skill' for skill reviews",
      ),
    suggested_step_count: z
      .number()
      .int()
      .min(3)
      .max(15)
      .optional()
      .describe(
        "hint to the research subagent for how many stages to propose. Default: the research subagent decides. Core types landed on 9 stages; 3-5 is typical for narrower scopes like skills.",
      ),
    quality_reference: z
      .enum(["code", "security", "production"])
      .default("code")
      .describe(
        "existing review type whose stage files serve as the quality bar for the new type",
      ),
    mode: z.enum(["llm-driven", "endpoint"]).default("llm-driven"),
    expand: z.boolean().default(true),
  })
  .strict();

type ReviewTypeCreateArgs = z.infer<typeof ReviewTypeCreateInput>;

export function registerReviewTypeCreate(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_type_create",
    {
      title: "Create a New Review Type",
      description:
        "Returns a multi-phase scaffolding prompt the calling LLM uses to build a new review type end-to-end via a subagent flow: research topic → propose step count + outline → per-step research → per-step fill-in → review_type_apply. Review types must be meticulously crafted — no simple templates. Default mode=llm-driven; mode=endpoint forwards to a configured endpoint (frontier recommended).",
      inputSchema: ReviewTypeCreateInput,
    },
    async (args: ReviewTypeCreateArgs) => {
      return runTool(
        async () => {
          const parsed = ReviewTypeCreateInput.parse(args);
          if (deps.config.review.categories.includes(parsed.name)) {
            throw new McpError(
              "E_ALREADY_EXISTS",
              `review type '${parsed.name}' already registered in config.review.categories. Rename or delete the existing type first.`,
            );
          }
          const prompt = buildPrompt(parsed);
          const kbRoot = deps.config.kb.root;

          return success([], `review_type_create: scaffold for '${parsed.name}' (topic=${parsed.topic})`, {
            ...(parsed.expand
              ? {
                  content: {
                    name: parsed.name,
                    topic: parsed.topic,
                    mode: parsed.mode,
                    suggested_step_count: parsed.suggested_step_count ?? null,
                    quality_reference: parsed.quality_reference,
                    quality_reference_dir: `${kbRoot}/review-system/${parsed.quality_reference}/`,
                    stage_target_dir: `${kbRoot}/review-system/${parsed.name}/`,
                    reviewer_target_path: `${kbRoot}/reviewers/reviewer-${parsed.name}.md`,
                    scaffolding_prompt: prompt,
                  },
                }
              : {
                  expand_hint: "Pass expand=true for the scaffolding prompt + KB paths.",
                }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "review_type_create",
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

function buildPrompt(parsed: ReviewTypeCreateArgs): string {
  const name = parsed.name;
  const topic = parsed.topic;
  const stepHint = parsed.suggested_step_count
    ? `The operator suggested roughly ${parsed.suggested_step_count} stages as a starting point — use your judgment.`
    : "No step-count hint from the operator; the core review types landed on 9 stages after extensive iteration. Short-scope reviews (e.g. skill authoring) may need 3-5; broad domains may need more. Pick based on what the topic genuinely demands.";

  return [
    `# Create review type: \`${name}\` — topic: ${topic}`,
    ``,
    `You are building a new VCF review type end-to-end. Review types are`,
    `meticulously crafted — never simply templated. Expect this to take`,
    `multiple turns across multiple subagents.`,
    ``,
    `Your reference for quality is the existing \`${parsed.quality_reference}\` review type:`,
    ``,
    `  Stage files: \`<kb>/review-system/${parsed.quality_reference}/stage-{1..9}-${parsed.quality_reference}.md\``,
    `  Reviewer overlay: \`<kb>/reviewers/reviewer-${parsed.quality_reference}.md\``,
    ``,
    `Read one stage file end-to-end before starting. Match that depth.`,
    ``,
    `---`,
    ``,
    `## Phase 1 — Research topic + propose outline (one subagent)`,
    ``,
    `Dispatch a **research subagent** with the topic "${topic}". Instruct it:`,
    ``,
    `> Research the ${topic} domain. Produce:`,
    `> 1. A proposed number of stages (3-15 range). ${stepHint}`,
    `> 2. A one-line description of each stage — what the reviewer`,
    `>    checks at that stage. Order matters: early stages are surface`,
    `>    / context, late stages are correctness / resilience.`,
    `> 3. For each stage, 3-5 open questions the research phase (Phase 2)`,
    `>    should answer.`,
    `> Return as JSON: { stage_count, stages: [{ number, title,`,
    `>   summary, research_questions: [] }] }`,
    ``,
    `Wait for the subagent to return. Review its proposal critically — if`,
    `the stage breakdown feels wrong (too coarse, too fine, missing a`,
    `concern), iterate once with the subagent before proceeding.`,
    ``,
    `## Phase 2 — Per-stage research (N subagents in parallel)`,
    ``,
    `For each stage from Phase 1, dispatch a **separate research subagent**`,
    `with that stage's questions. Each subagent produces a per-stage outline:`,
    ``,
    `> Given these ${name}-review stage questions: [questions],`,
    `> produce a stage outline with:`,
    `> 1. "Why This Stage Exists" (2-3 paragraphs)`,
    `> 2. "Stage Objective" (numbered checklist, what the reviewer answers)`,
    `> 3. "Anti-Patterns" (what counts as a violation of this stage's bar)`,
    `> 4. "Required Report Format" (the shape of findings the reviewer emits)`,
    `> 5. "Final Standard" (PASS criteria in plain English)`,
    `> Match the quality bar of \`<kb>/review-system/${parsed.quality_reference}/stage-N-${parsed.quality_reference}.md\`.`,
    ``,
    `Wait for all subagents to return. If any comes back with weak content,`,
    `re-dispatch that one subagent — don't average weak outlines into the`,
    `final stage file.`,
    ``,
    `## Phase 3 — Per-stage fill-in (N subagents in parallel)`,
    ``,
    `For each stage outline, dispatch a **fill-in subagent** with:`,
    ``,
    `- The outline from Phase 2`,
    `- The corresponding stage file from`,
    `  \`<kb>/review-system/${parsed.quality_reference}/stage-N-${parsed.quality_reference}.md\` as a depth/format reference`,
    `- A BASIC TEMPLATE (below) that the subagent EDITS to fit the topic.`,
    `  This template is guidance, not a constraint — the subagent rewrites`,
    `  sections whose shape doesn't fit.`,
    ``,
    `### Basic stage file template`,
    `\`\`\`markdown`,
    `---`,
    `type: review-stage`,
    `review_type: ${name}`,
    `stage: <N>`,
    `title: "<stage title>"`,
    `version: 0.1`,
    `updated: <YYYY-MM-DD>`,
    `---`,
    ``,
    `# Stage <N> — <title>`,
    ``,
    `## Why This Stage Exists`,
    `<2-3 paragraphs: what risk this stage guards against, why it's`,
    `separate from other stages>`,
    ``,
    `## Stage Objective`,
    `<numbered checklist of what the reviewer answers at this stage>`,
    ``,
    `## Anti-Patterns`,
    `<bulleted list: what counts as a violation>`,
    ``,
    `## Required Report Format`,
    `<the YAML / JSON / markdown shape the reviewer emits at this stage>`,
    ``,
    `## Final Standard`,
    `<PASS criteria in plain English — what "green" looks like>`,
    `\`\`\``,
    ``,
    `### Reviewer overlay`,
    `Separately, author a \`reviewer-${name}.md\` overlay modeled on`,
    `\`<kb>/reviewers/reviewer-${parsed.quality_reference}.md\`. Carry forward`,
    `its Verdict Calibration + Self-learning sections; adjust the "What You`,
    `Read Before Each Pass" and tone for the ${topic} context.`,
    ``,
    `## Phase 4 — Persist to KB`,
    ``,
    `Call \`review_type_apply\` with:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "name": "${name}",`,
    `  "stages": [`,
    `    { "stage_number": 1, "body": "<stage 1 markdown>" },`,
    `    { "stage_number": 2, "body": "<stage 2 markdown>" },`,
    `    ...`,
    `  ],`,
    `  "reviewer_overlay": "<reviewer-${name}.md markdown>",`,
    `  "register_in_config": true`,
    `}`,
    `\`\`\``,
    ``,
    `That tool writes the stage files + overlay under the KB and flags the`,
    `config.review.categories entry that needs adding. It does NOT mutate`,
    `the operator's config — they review the change, then add the slug`,
    `manually (or via \`vcf register-review-type ${name}\` if that command`,
    `is wired up).`,
    ``,
    `## Phase 5 — Dogfood`,
    ``,
    `Run a review of this change itself with the new type:`,
    `\`review_prepare --type ${name} --stage 1 --force=true\`. If your own`,
    `review type can't pass its stage 1 on the change that created it, the`,
    `stage file isn't right — iterate.`,
    ``,
    `---`,
    ``,
    `## Guardrails`,
    ``,
    `- **No templated reviews.** Every stage file should be different. If`,
    `  your subagents return outlines that are 90% identical, dispatch`,
    `  again with sharper per-stage questions.`,
    `- **Don't create types for things that aren't review-able.** "A`,
    `  review type for tracking which commits got tagged" is not a review`,
    `  — it's a report. Review types audit a change against a bar.`,
    `- **Redaction applies.** Subagent prompts may include source excerpts.`,
    `  Run outbound prompts through \`redact()\` when invoking via an API.`,
    `- **Propose, don't commit, config changes.** review_type_apply writes`,
    `  KB files but never modifies config.yaml. The operator reviews the`,
    `  change and adds the slug to \`config.review.categories\`.`,
  ].join("\n");
}

export { ReviewTypeCreateInput };
