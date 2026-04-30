// research_assemble — global scope.
//
// New tool (B2 in Workstream B). Closes the missing step between the 3-agent
// build panel (research_compose / orchestrator-driven) and the verifier:
//
//   compose → ASSEMBLE → verify → resolve → operator merge
//
// Reads the per-aspect JSONs from `~/.vcf/kb-drafts/<draft_id>/aspects/`
// (each emitted by one slot of the build panel) and produces a single
// draft.md + sources.json with a unified provenance block.
//
// Two-step write pattern (both modes):
//   1. Outline. Think the entire draft through end-to-end first —
//      narrative arc, major claims, what evidence supports the
//      conclusions — then write a structured outline (frontmatter
//      sketch + section list with key claims + citation pointers).
//   2. Fill in. Use the outline + the aspect findings to produce the
//      final draft.md. The outline gates the body: nothing in the
//      draft that wasn't in the outline; nothing in the outline that
//      isn't backed by an aspect finding.
// Catches the "LLM writes whatever comes to mind first, then has to
// retrofit citations" failure mode the early dogfood runs surfaced.
// Doubles the latency in execute mode — that's the trade.
//
// Each kind ships with a structural exemplar pointer. The assembler
// inlines a truncated copy of the exemplar in the prompt so the LLM
// has a concrete shape to mimic (frontmatter, section ordering,
// citation style) instead of inventing one.
//
// Two modes (panel-mode shared schema):
//   mode=execute   — MCP calls the configured kb_finalize role via the
//                    dispatcher TWICE (outline, then draft), parses the
//                    structured output, writes draft.md + sources.json.
//   mode=directive — MCP returns both prompts + expected output paths.
//                    Orchestrator runs both calls and writes the files.
//                    Useful when the orchestrator wants the harness's
//                    web search in scope for the draft step.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { PanelModeSchema } from "../util/panel.js";
import { resolveRole } from "../util/roleResolve.js";
import { dispatchChatCompletion } from "../util/dispatcher.js";
import { resolveAuthKey } from "../review/endpointResolve.js";
import { buildProvenance } from "../util/provenance.js";
import type { ChatMessage } from "../util/llmClient.js";

const DraftIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "draft_id must be a safe directory name");

const ResearchAssembleInput = z
  .object({
    draft_id: DraftIdSchema.describe(
      "staging dir under ~/.vcf/kb-drafts/ containing aspects/*.json from the compose-phase build panel",
    ),
    kind: z
      .enum(["primer", "best-practice", "review-stage", "reviewer", "standard", "lens"])
      .describe("KB entry kind the draft will land as"),
    topic: z.string().min(1).max(256),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("kb_finalize")
      .describe("role name to use for execute mode (default 'kb_finalize')"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(180_000),
    mode: PanelModeSchema,
    expand: z.boolean().default(false),
  })
  .strict();

type ResearchAssembleArgs = z.infer<typeof ResearchAssembleInput>;

export function registerResearchAssemble(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "research_assemble",
    {
      title: "Assemble Compose-Phase Aspects Into a Single Draft",
      description:
        "Read per-aspect JSONs from ~/.vcf/kb-drafts/<draft_id>/aspects/ and merge them into draft.md + sources.json with provenance. mode=execute calls the configured kb_finalize role via the dispatcher; mode=directive returns the prompt for the orchestrator to run.",
      inputSchema: ResearchAssembleInput.shape,
    },
    async (args: ResearchAssembleArgs, extra: { signal?: AbortSignal } | undefined) => {
      let auditOutputs: unknown = undefined;
      return runTool(
        async () => {
          const parsed = ResearchAssembleInput.parse(args);
          const draftDir = join(kbDraftsDir(deps.homeDir), parsed.draft_id);
          if (!existsSync(draftDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `kb-drafts directory '${parsed.draft_id}' not found at ${draftDir}`,
            );
          }
          const aspectsDir = join(draftDir, "aspects");
          if (!existsSync(aspectsDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `aspects/ subdir missing in ${draftDir} — run the compose build panel first`,
            );
          }

          // Read every aspect-*.json. Order by filename so the assembled
          // draft is reproducible across runs.
          const entries = (await readdir(aspectsDir)).filter((f) => f.endsWith(".json")).sort();
          if (entries.length === 0) {
            throw new McpError(
              "E_NOT_FOUND",
              `no aspect-*.json files in ${aspectsDir} — compose build panel produced no output`,
            );
          }
          const aspectPayloads: { filename: string; body: string }[] = [];
          for (const f of entries) {
            const body = await readFile(join(aspectsDir, f), "utf8");
            aspectPayloads.push({ filename: f, body });
          }

          const draftPath = join(draftDir, "draft.md");
          const sourcesPath = join(draftDir, "sources.json");
          const outlinePath = join(draftDir, "outline.json");

          const exemplar = await loadExemplar(parsed.kind, deps.config.kb.root);
          const composeOpts = {
            kind: parsed.kind,
            topic: parsed.topic,
            aspects: aspectPayloads,
            exemplar,
          };
          const outlineMessages = composeOutlineMessages(composeOpts);

          if (parsed.mode === "directive") {
            // Directive emits BOTH prompts. The orchestrator runs step 1
            // (writes outline.json), then step 2 (uses outline to write
            // draft.md + sources.json). Per-step prompts let it route
            // each call to whichever subagent fits.
            auditOutputs = {
              ok: true,
              mode: "directive",
              draft_id: parsed.draft_id,
              expected_outputs: {
                outline_path: outlinePath,
                draft_path: draftPath,
                sources_path: sourcesPath,
              },
              aspect_count: entries.length,
              exemplar_path: exemplar?.absPath ?? null,
            };
            return success<Record<string, unknown>>(
              [outlinePath, draftPath, sourcesPath],
              `research_assemble: directive emitted for '${parsed.draft_id}' (${entries.length} aspect(s)) — two-step pattern: outline → draft. Orchestrator runs both calls.`,
              parsed.expand
                ? {
                    content: {
                      mode: "directive",
                      draft_id: parsed.draft_id,
                      staging_dir: draftDir,
                      pattern: "outline-then-draft",
                      step_1: {
                        purpose:
                          "Write the outline. Think the entire draft through end-to-end before producing the JSON.",
                        messages: outlineMessages,
                        expected_output_path: outlinePath,
                      },
                      step_2: {
                        purpose: "Fill in the draft using the step-1 outline as the contract.",
                        // Step 2's prompt is built later (it needs the
                        // outline content). Orchestrator should call back
                        // into the assembler with mode=execute after step 1
                        // is written, OR build step 2's prompt itself by
                        // mirroring composeDraftMessages's shape.
                        build_prompt_after_outline: true,
                        expected_output_paths: {
                          draft_path: draftPath,
                          sources_path: sourcesPath,
                        },
                      },
                      exemplar: exemplar
                        ? { rel_path: exemplar.relPath, abs_path: exemplar.absPath }
                        : null,
                      aspect_files: entries.map((f) => join(aspectsDir, f)),
                      next_tool: "research_verify",
                      next_tool_args: { draft_id: parsed.draft_id },
                      instructions:
                        "Two-step assembler. Step 1: run a frontier-tier model on the step_1 prompt; " +
                        "write the outline JSON to expected_output_path. Step 2: build the draft prompt " +
                        "by including the outline content, run a frontier-tier model, write draft.md + " +
                        "sources.json to expected_output_paths. Both files carry provenance " +
                        "(tool=research_assemble, phase=assemble). Then call research_verify.",
                    },
                  }
                : {},
            );
          }

          // mode=execute: resolve role, dispatch step 1 (outline), then
          // step 2 (draft body + sources). Two LLM calls in series — the
          // outline is the contract step 2 fills in.
          const resolved = resolveRole(deps.config, parsed.role);
          const { apiKey } = resolveAuthKey(resolved.endpoint, undefined);

          const ctrl = new AbortController();
          const onAbort = (): void => ctrl.abort();
          extra?.signal?.addEventListener("abort", onAbort);
          // Timeout covers BOTH dispatches plus the file writes between them.
          const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);

          let outlineDispatch;
          let draftDispatch;
          try {
            // ---- Step 1: outline -------------------------------------
            outlineDispatch = await dispatchChatCompletion({
              endpoint: resolved.endpoint,
              modelId: resolved.modelId,
              messages: outlineMessages,
              ...(apiKey !== undefined ? { apiKey } : {}),
              temperature: 0.1,
              jsonResponse: true,
              signal: ctrl.signal,
              ...(resolved.endpoint.provider_options
                ? {
                    providerOptions: resolved.endpoint.provider_options as Record<string, unknown>,
                  }
                : {}),
            });

            const outlineRaw = stripCodeFence(outlineDispatch.content).trim();
            // Validate parseability — if step 1 didn't produce JSON, step 2
            // would be running against unstructured text. Better to fail loud.
            try {
              JSON.parse(outlineRaw);
            } catch {
              throw new McpError(
                "E_INTERNAL",
                `research_assemble step 1 (outline) did not return JSON. Raw (first 500): ${outlineRaw.slice(0, 500)}`,
              );
            }
            await writeFile(outlinePath, outlineRaw + "\n", "utf8");

            // ---- Step 2: fill in draft -------------------------------
            const draftMessages = composeDraftMessages({
              ...composeOpts,
              outline: outlineRaw,
            });
            draftDispatch = await dispatchChatCompletion({
              endpoint: resolved.endpoint,
              modelId: resolved.modelId,
              messages: draftMessages,
              ...(apiKey !== undefined ? { apiKey } : {}),
              temperature: 0.1,
              signal: ctrl.signal,
              ...(resolved.endpoint.provider_options
                ? {
                    providerOptions: resolved.endpoint.provider_options as Record<string, unknown>,
                  }
                : {}),
            });
          } finally {
            clearTimeout(timer);
            extra?.signal?.removeEventListener("abort", onAbort);
          }

          const split = splitDraftAndSources(draftDispatch.content);
          if (!split) {
            throw new McpError(
              "E_INTERNAL",
              `research_assemble step 2 (draft) missing required '<<<SOURCES_JSON>>>' separator. ` +
                `Raw output (first 500 chars): ${draftDispatch.content.slice(0, 500)}`,
            );
          }
          const provenance = buildProvenance({
            tool: "research_assemble",
            phase: "assemble",
            model: resolved.modelId,
            endpoint: resolved.endpoint.name,
          });

          // Inject provenance into the markdown frontmatter and the JSON top-level.
          const finalMd = injectMarkdownProvenance(split.draftMd, provenance);
          const finalJson = injectJsonProvenance(split.sourcesJson, provenance);
          await writeFile(draftPath, finalMd, "utf8");
          await writeFile(sourcesPath, finalJson, "utf8");

          auditOutputs = {
            ok: true,
            mode: "execute",
            draft_id: parsed.draft_id,
            outline_path: outlinePath,
            draft_path: draftPath,
            sources_path: sourcesPath,
            aspect_count: entries.length,
            route: draftDispatch.route,
            exemplar_path: exemplar?.absPath ?? null,
          };
          return success<Record<string, unknown>>(
            [outlinePath, draftPath, sourcesPath],
            `research_assemble: two-step executed via ${resolved.endpoint.name}/${resolved.modelId} (${entries.length} aspect(s)) → outline + draft`,
            parsed.expand
              ? {
                  content: {
                    mode: "execute",
                    draft_id: parsed.draft_id,
                    pattern: "outline-then-draft",
                    outline_path: outlinePath,
                    draft_path: draftPath,
                    sources_path: sourcesPath,
                    aspect_count: entries.length,
                    route: draftDispatch.route,
                    provenance,
                    exemplar: exemplar
                      ? { rel_path: exemplar.relPath, abs_path: exemplar.absPath }
                      : null,
                  },
                }
              : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "research_assemble",
            scope: "global",
            project_root: null,
            inputs: { draft_id: args.draft_id, mode: args.mode, role: args.role, kind: args.kind },
            outputs: auditOutputs ?? payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

// Per-kind structural exemplar. Pointed at the strongest existing
// instance of each kind in the KB so new drafts have something concrete
// to mirror (frontmatter, section ordering, citation density). Paths
// are relative to the seeded kb root (~/.vcf/kb/ at runtime).
const KIND_EXEMPLARS: Record<string, string> = {
  primer: "primers/coding.md",
  "best-practice": "best-practices/coding.md",
  "review-stage": "review-system/code/01-project-definition-scope-reviewability.md",
  reviewer: "reviewers/reviewer-code.md",
  lens: "lenses/code-health.md",
  standard: "standards/tag-vocabulary.md",
};

interface Exemplar {
  /** kb-relative path the operator/orchestrator can read in full. */
  relPath: string;
  /** Absolute path used for the directive-mode pointer. */
  absPath: string;
  /** Truncated content inlined into execute-mode prompts. */
  excerpt: string;
  /** True when the inlined content was clipped. */
  truncated: boolean;
}

async function loadExemplar(kind: string, kbRoot: string): Promise<Exemplar | null> {
  const rel = KIND_EXEMPLARS[kind];
  if (!rel) return null;
  const absPath = join(kbRoot, rel);
  if (!existsSync(absPath)) return null;
  const raw = await readFile(absPath, "utf8");
  // Budget: ~6KB inline. Exemplar is a structural reference, not a study guide;
  // truncating preserves the frontmatter + first few sections, which is enough
  // to mimic shape without doubling the prompt.
  const BUDGET = 6000;
  if (raw.length <= BUDGET) {
    return { relPath: rel, absPath, excerpt: raw, truncated: false };
  }
  return {
    relPath: rel,
    absPath,
    excerpt:
      raw.slice(0, BUDGET) + `\n\n[... truncated for prompt size; full exemplar at ${absPath}]\n`,
    truncated: true,
  };
}

interface ComposeOpts {
  kind: string;
  topic: string;
  aspects: { filename: string; body: string }[];
  exemplar: Exemplar | null;
}

/** Step 1 of the two-step assembler. Asks the model to think the draft
 *  through end-to-end and emit a structured outline JSON. */
function composeOutlineMessages(opts: ComposeOpts): ChatMessage[] {
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    `You are PLANNING a single KB ${opts.kind} draft from ${opts.aspects.length} aspect reports`,
    `produced by parallel research subagents. Today is ${today}.`,
    ``,
    `# This is step 1 of 2 — outline only`,
    ``,
    `Do NOT write the draft body yet. Your job is to think the entire draft`,
    `through END-TO-END first — every section, what claims it makes, what`,
    `evidence supports those claims, what the narrative arc is — and only`,
    `then emit a structured outline. The next step will fill in the body`,
    `using your outline. Skip the thinking and the body will be retrofitted`,
    `prose; that's the failure mode this step exists to prevent.`,
    ``,
    `# Discipline`,
    ``,
    `  - Every section must trace to specific aspect findings. If you can't`,
    `    point at an aspect that supports a section, drop the section.`,
    `  - Every key claim must have at least one source from the aspects.`,
    `    Mark claims that don't with "weak: true" so step 2 knows to soften`,
    `    or drop them.`,
    `  - Resolve contradictions in the outline, not the body. Prefer tier-1/2`,
    `    sources (primary, official-docs) over tier-3+ (vendor-blog,`,
    `    personal-blog, aggregator). When still in conflict, name both and`,
    `    decide which the draft will lead with.`,
    `  - Frontmatter sketch: tags, lens, topic — match the exemplar shape`,
    `    below. Don't include a provenance block; the assembler injects it.`,
    ``,
    opts.exemplar
      ? [
          `# Structural exemplar — kb/${opts.exemplar.relPath}`,
          ``,
          `Mirror this exemplar's shape: frontmatter keys, section ordering,`,
          `citation style, depth of treatment. Don't copy its content; copy its`,
          `STRUCTURE.${opts.exemplar.truncated ? " (Truncated below — see absolute path for the full file.)" : ""}`,
          ``,
          "```markdown",
          opts.exemplar.excerpt,
          "```",
          ``,
        ].join("\n")
      : "",
    `# Output format`,
    ``,
    `Output ONLY a JSON object matching this shape (no prose outside the JSON):`,
    ``,
    `{`,
    `  "topic": "${opts.topic}",`,
    `  "kind": "${opts.kind}",`,
    `  "frontmatter_sketch": {`,
    `    "tags": ["..."],`,
    `    "lens": "...",`,
    `    "type": "${opts.kind}"`,
    `  },`,
    `  "narrative_arc": "<2-3 sentence summary of how the draft moves from intro to conclusion>",`,
    `  "sections": [`,
    `    {`,
    `      "heading": "...",`,
    `      "purpose": "<one sentence>",`,
    `      "key_claims": [`,
    `        {`,
    `          "claim": "<one sentence>",`,
    `          "supporting_aspects": ["aspect-00.json", ...],`,
    `          "weak": false`,
    `        }`,
    `      ]`,
    `    }`,
    `  ],`,
    `  "open_questions": ["..."],`,
    `  "dropped_aspects": ["<filenames whose findings didn't survive resolution>"]`,
    `}`,
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `# Topic`,
    ``,
    opts.topic,
    ``,
    `# Aspect reports (${opts.aspects.length} total)`,
    ``,
    ...opts.aspects.flatMap((a) => [`## ${a.filename}`, ``, "```json", a.body, "```", ""]),
    `Think it through end-to-end first. Then output the outline JSON.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Step 2 of the two-step assembler. Given the step-1 outline, fill in
 *  the draft body + sources.json. */
function composeDraftMessages(opts: ComposeOpts & { outline: string }): ChatMessage[] {
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    `You are WRITING a single KB ${opts.kind} draft from ${opts.aspects.length} aspect reports`,
    `produced by parallel research subagents. Today is ${today}.`,
    ``,
    `# This is step 2 of 2 — fill in the body`,
    ``,
    `An outline has already been produced (step 1). Your job: produce the`,
    `final draft.md + sources.json that REALIZES that outline. The outline`,
    `is the contract:`,
    `  - Every section in the outline must appear in the draft.`,
    `  - No section in the draft that wasn't in the outline.`,
    `  - Every key_claim must show up in the draft and cite its supporting`,
    `    aspects' sources.`,
    `  - Claims marked "weak": true must either get softened wording`,
    `    ("often", "in some cases") or be dropped.`,
    ``,
    `# Draft discipline`,
    ``,
    `  - Resolve every footnote to an entry in sources.json. Numeric ids 1..N.`,
    `  - Drop any claim that lost its source during deduplication.`,
    `  - Frontmatter must follow the exemplar shape; provenance is injected`,
    `    by the assembler — do NOT add a provenance: block yourself.`,
    ``,
    opts.exemplar
      ? [
          `# Structural exemplar — kb/${opts.exemplar.relPath}`,
          ``,
          `Mirror its shape: frontmatter keys, section ordering, citation`,
          `style.${opts.exemplar.truncated ? " (Truncated below.)" : ""}`,
          ``,
          "```markdown",
          opts.exemplar.excerpt,
          "```",
          ``,
        ].join("\n")
      : "",
    `# Output format — TWO sections separated by an exact sentinel line`,
    ``,
    `  <draft.md content here, including YAML frontmatter — topic, kind=${opts.kind},`,
    `   tags, lens, etc. Do NOT add a provenance: block; the assembler injects it.>`,
    ``,
    `<<<SOURCES_JSON>>>`,
    ``,
    `  {`,
    `    "sources": [`,
    `      {"id": 1, "url": "...", "title": "...", "tier": "primary", "published": "YYYY-MM-DD"},`,
    `      ...`,
    `    ]`,
    `  }`,
    ``,
    `No prose outside those two sections. The sentinel line must be exactly`,
    `\`<<<SOURCES_JSON>>>\` on its own line.`,
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `# Topic`,
    ``,
    opts.topic,
    ``,
    `# Outline (from step 1 — this is the contract for the draft)`,
    ``,
    "```json",
    opts.outline,
    "```",
    ``,
    `# Aspect reports (${opts.aspects.length} total — for citation back-references)`,
    ``,
    ...opts.aspects.flatMap((a) => [`## ${a.filename}`, ``, "```json", a.body, "```", ""]),
    `Realize the outline as the draft. Output draft.md content first,`,
    `then a line with exactly \`<<<SOURCES_JSON>>>\`, then the sources JSON.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const SOURCES_SENTINEL = "<<<SOURCES_JSON>>>";

function stripCodeFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const firstNl = t.indexOf("\n");
    if (firstNl > 0) t = t.slice(firstNl + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}

function splitDraftAndSources(raw: string): { draftMd: string; sourcesJson: string } | null {
  const idx = raw.indexOf(SOURCES_SENTINEL);
  if (idx < 0) return null;
  let draftMd = raw.slice(0, idx).trim();
  let sourcesJson = raw.slice(idx + SOURCES_SENTINEL.length).trim();
  // Strip a leading code fence if present.
  if (sourcesJson.startsWith("```")) {
    const nl = sourcesJson.indexOf("\n");
    if (nl > 0) sourcesJson = sourcesJson.slice(nl + 1);
    if (sourcesJson.endsWith("```")) sourcesJson = sourcesJson.slice(0, -3).trim();
  }
  if (draftMd.startsWith("```")) {
    const nl = draftMd.indexOf("\n");
    if (nl > 0) draftMd = draftMd.slice(nl + 1);
    if (draftMd.endsWith("```")) draftMd = draftMd.slice(0, -3).trim();
  }
  return { draftMd, sourcesJson };
}

function injectMarkdownProvenance(
  md: string,
  provenance: ReturnType<typeof buildProvenance>,
): string {
  const yaml = [
    `provenance:`,
    `  tool: ${provenance.tool}`,
    `  phase: ${provenance.phase}`,
    `  model: ${provenance.model}`,
    `  endpoint: ${provenance.endpoint}`,
    `  generated_at: ${provenance.generated_at}`,
  ].join("\n");

  const trimmed = md.trim();
  if (trimmed.startsWith("---")) {
    // Insert provenance into the existing frontmatter just before the closing `---`.
    const closingIdx = trimmed.indexOf("\n---", 4);
    if (closingIdx > 0) {
      return trimmed.slice(0, closingIdx) + "\n" + yaml + trimmed.slice(closingIdx) + "\n";
    }
  }
  // No frontmatter — wrap one.
  return `---\n${yaml}\n---\n\n${trimmed}\n`;
}

function injectJsonProvenance(raw: string, provenance: ReturnType<typeof buildProvenance>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // LLM emitted bad JSON — wrap as a defensive payload so the operator
    // still has something to inspect.
    return JSON.stringify({ provenance, raw }, null, 2) + "\n";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify({ provenance, sources: parsed }, null, 2) + "\n";
  }
  const merged = { provenance, ...(parsed as Record<string, unknown>) };
  return JSON.stringify(merged, null, 2) + "\n";
}
