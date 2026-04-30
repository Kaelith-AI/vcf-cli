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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { runPanel } from "../util/panel.js";
import { resolveAuthKey } from "../review/endpointResolve.js";
import { hasRole } from "../util/roleResolve.js";

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
    /**
     * Update flow (B6). When set, the panel prompts include "focus on what
     * has changed since {recency_floor_iso}" — the date the existing
     * artifact was last refreshed. The compose flow is otherwise identical
     * to a fresh build: same panel, same aspects, same staging.
     *
     * Pass the existing artifact's `provenance.generated_at` as this value.
     * The tool does not read the existing artifact itself — that's the
     * caller's job (or a thin `research_update` wrapper's).
     */
    recency_floor_iso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, "recency_floor_iso must be ISO 8601 (YYYY-MM-DD or full)")
      .optional(),
    /**
     * mode controls how the build phase (one agent per aspect) runs:
     *   "directive" / "llm-driven" (default, back-compat): return the
     *      scaffolding prompt; the orchestrator dispatches its own
     *      subagents and writes aspect JSONs itself.
     *   "execute": MCP resolves the configured panel role (default
     *      `research_panel`), runs all aspect prompts in parallel via
     *      the dispatcher, writes each slot's output to
     *      ~/.vcf/kb-drafts/<draft_id>/aspects/aspect-{slot}.json, then
     *      returns the staging dir + path to call research_assemble.
     */
    mode: z.enum(["llm-driven", "directive", "execute"]).default("llm-driven"),
    /**
     * Panel role used in mode=execute. Must satisfy
     * [frontier, web_search] capabilities and have at least as many
     * default slots as `aspects.length`. Slots are paired with aspects
     * in order; if there are fewer slots than aspects, the remaining
     * aspects are batched onto the last slot (the role's panel
     * shouldn't be smaller than your aspect count — fix the config).
     */
    panel_role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("research_panel"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(15 * 60_000)
      .default(300_000)
      .describe("execute mode only: per-call timeout for each panel slot"),
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
    async (args: ResearchComposeArgs, extra: { signal?: AbortSignal } | undefined) => {
      return runTool(
        async () => {
          const parsed = ResearchComposeInput.parse(args);
          if (parsed.aspects.length < 2) {
            throw new McpError(
              "E_VALIDATION",
              "research_compose requires at least 2 aspects — single-aspect research is research_refresh territory",
            );
          }

          if (parsed.mode === "execute") {
            return await runExecute(deps, parsed, extra?.signal);
          }

          // mode=directive (or legacy llm-driven): return the scaffolding prompt.
          const prompt = buildPrompt(parsed);
          return success<Record<string, unknown>>(
            [],
            `research_compose: scaffold for ${parsed.kind} on '${parsed.topic}' across ${parsed.aspects.length} aspects`,
            {
              ...(parsed.expand
                ? {
                    content: {
                      mode: parsed.mode,
                      kind: parsed.kind,
                      topic: parsed.topic,
                      aspects: parsed.aspects,
                      recency_window_days: parsed.recency_window_days,
                      staging_hint: `~/.vcf/kb-drafts/<run_id>/`,
                      scaffolding_prompt: prompt,
                    },
                  }
                : {}),
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
    ...(parsed.recency_floor_iso
      ? [
          `- **UPDATE FLOW** — the existing artifact was last refreshed on`,
          `  ${parsed.recency_floor_iso}. Focus on what has CHANGED since that date:`,
          `  new versions, deprecations, post-${parsed.recency_floor_iso} releases,`,
          `  retracted claims. Carry forward stable material verbatim where the`,
          `  primary source still supports it.`,
        ]
      : []),
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
    `      "confidence": "high" | "medium" | "low",`,
    `      "source_tier": "primary" | "official-docs" | "vendor-blog" | "personal-blog" | "aggregator"`,
    `    }`,
    `  ],`,
    `  "open_questions": ["<things you couldn't resolve>"]`,
    `}`,
    `\`\`\``,
    ``,
    `### Source-quality rules (the verify pass will police these)`,
    ``,
    `Subagents MUST tier every source and downgrade confidence when the tier`,
    `is weak. Verify will flag the same claims you flag — better to flag them`,
    `here than have the verifier reject the draft.`,
    ``,
    `**Tier 1 — Primary** (use freely, confidence high):`,
    `  - RFCs verified at \`https://www.rfc-editor.org/rfc/rfcNNNN.html\` —`,
    `    you MUST confirm the RFC number resolves at that exact URL before`,
    `    citing it. LLMs hallucinate RFC numbers regularly. If you cannot`,
    `    fetch \`rfc-editor.org/rfc/rfcNNNN\`, the citation is invalid.`,
    `  - W3C / IETF / WHATWG specs at canonical URLs.`,
    `  - OWASP project pages on \`owasp.org\`. The current Web Top 10 is 2021;`,
    `    the current API Top 10 is 2023. Do NOT cite a "2025 OWASP Top 10"`,
    `    unless you can fetch the page on owasp.org confirming it.`,
    `  - Peer-reviewed papers (DOI / journal / ACM / IEEE / USENIX).`,
    ``,
    `**Tier 2 — Official docs** (use, confidence medium-high):`,
    `  - The project's own documentation site (postgres.org, kubernetes.io,`,
    `    grafana.com/docs/, etc.). Specifically NOT their /blog/ subtree.`,
    ``,
    `**Tier 3 — Vendor blog** (downgrade to confidence "medium" or "low"):`,
    `  - Marketing posts on vendor sites. Acceptable for ARCHITECTURAL`,
    `    patterns ("we adopted X for reason Y") but NOT for STATISTICS.`,
    `  - Any specific percentage ("78% of teams", "1.4x more defects",`,
    `    "70-90% pipeline reduction") cited from a vendor blog without`,
    `    methodology MUST be flagged \`confidence: low\` AND moved to`,
    `    \`open_questions\` rather than baked into the draft as fact.`,
    ``,
    `**Tier 4 — Personal blog / Medium** (rarely usable):`,
    `  - Acceptable only for code patterns that link to working repos.`,
    `  - Statistics from personal blogs are NEVER acceptable as load-bearing`,
    `    claims. Either find a primary source or move the claim to`,
    `    \`open_questions\`.`,
    ``,
    `**Tier 5 — Aggregator** (not acceptable):`,
    `  - If a source is a roundup/aggregator, follow through to the original`,
    `    and cite that. If the original is unreachable, the claim is dropped.`,
    ``,
    `### Date / version sanity checks`,
    ``,
    `  - Publication dates must be ≤ today. Future-dated articles are a sign`,
    `    of LLM-fabricated metadata.`,
    `  - "RFC NNNN, January 2025" — confirm BOTH the number AND the date at`,
    `    rfc-editor.org. They publish errata; check status.`,
    `  - "OWASP Top 10 2025" — confirm at owasp.org/Top10/. Don't trust`,
    `    blog posts paraphrasing it.`,
    ``,
    `## Phase 2 — Assemble draft`,
    ``,
    `Fan-in the aspect reports. Produce a draft KB entry in the shape`,
    `required by \`${parsed.kind}\`. Hard rules:`,
    ``,
    `- **Every claim needs a \`source\` reference.** Unsourced claims get`,
    `  dropped. Don't paraphrase your training data.`,
    `- **Tier-1/2 for load-bearing claims.** Architecture decisions, security`,
    `  guarantees, and concrete numbers (latency targets, lifetime ranges)`,
    `  must cite tier 1 or tier 2 sources. Tier 3+ stays at the level of`,
    `  examples / illustrations, never as the primary support.`,
    `- **Statistics demand methodology.** Any "X% of teams do Y" claim must`,
    `  link to a source that shows sample size + survey design + year. If`,
    `  the methodology is missing, the stat is moved to \`open_questions\``,
    `  with a "lower confidence — vendor stat without methodology" note.`,
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
    `### Provenance is mandatory in EVERY artifact you write`,
    ``,
    `\`research_verify\` will refuse to verify a draft.md that's missing a`,
    `\`provenance\` block in its frontmatter. Without it the operator can't tell`,
    `which model authored the claims they're being asked to merge.`,
    ``,
    `**\`draft.md\` frontmatter must include a \`provenance\` key:**`,
    ``,
    `\`\`\`yaml`,
    `---`,
    `type: best-practices`,
    `# ... your normal frontmatter ...`,
    `provenance:`,
    `  tool: research_compose`,
    `  phase: compose`,
    `  model: <exact model id of the COMPOSER — the agent that fanned out and`,
    `         assembled this draft. NOT the subagents — the orchestrator. If`,
    `         you don't know your exact model id, ask the operator.>`,
    `  endpoint: claude-code-main`,
    `  generated_at: <ISO 8601 timestamp>`,
    `---`,
    `\`\`\``,
    ``,
    `**\`sources.json\` top-level must include the same provenance block:**`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "provenance": { "tool": "research_compose", "phase": "compose", "model": "...", "endpoint": "claude-code-main", "generated_at": "..." },`,
    `  "sources": [ /* ... */ ]`,
    `}`,
    `\`\`\``,
    ``,
    `**Each \`aspects/<aspect-name>.json\` records its subagent's provenance:**`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "provenance": {`,
    `    "tool": "research_compose",`,
    `    "phase": "compose-aspect",`,
    `    "model": "<exact model id of THIS subagent>",`,
    `    "endpoint": "claude-code-subagent",`,
    `    "generated_at": "..."`,
    `  },`,
    `  "aspect": "...",`,
    `  "findings": [ /* ... */ ],`,
    `  "open_questions": [ ]`,
    `}`,
    `\`\`\``,
    ``,
    `**Honesty about model id matters more than precision.** "claude-opus-4" is`,
    `useless if you're actually claude-opus-4-7. Ask the operator for the exact`,
    `id rather than guessing. The operator's merge decision weighs evidence by`,
    `model — a finding from a frontier model carries different weight than the`,
    `same finding from a 7B local model.`,
    ``,
    `## Phase 4 — Verify`,
    ``,
    `Call \`research_verify\` with the staging dir's draft_id. It runs a`,
    `different-model cross-check against the configured`,
    `\`defaults.research_verify\` endpoint and writes \`verify.json\` with:`,
    ``,
    `- \`references_verified\` — overall source-quality assessment`,
    `- \`contested_claims[]\` — each weakly-supported or possibly-hallucinated claim`,
    `- \`hallucination_risk\` — low | medium | high`,
    `- \`recommendation\` — merge | revise | reject`,
    ``,
    `Verify is itself an LLM judgment. Do not trust it as the final answer.`,
    ``,
    `## Phase 5 — Resolve challenges`,
    ``,
    `Call \`research_resolve\` with the same draft_id. It reads verify.json,`,
    `returns a fan-out scaffold for one focused subagent per contested claim.`,
    `Each subagent goes to PRIMARY sources (rfc-editor.org, owasp.org, vendor`,
    `docs, peer-reviewed papers — NOT blogs) to confirm or deny the claim,`,
    `independent of what verify said. Output: \`resolutions.json\` with`,
    `verdicts (\`confirmed\` | \`denied\` | \`undetermined\`) + suggested revisions.`,
    ``,
    `Use a different model from verify, so the resolver isn't echoing the`,
    `verifier's biases.`,
    ``,
    `## Phase 6 — Operator review`,
    ``,
    `Only the operator moves a staged draft into the live KB. The operator`,
    `reads three artifacts together and decides:`,
    ``,
    `- \`draft.md\` — compose output`,
    `- \`verify.json\` — verifier's contested-claim list`,
    `- \`resolutions.json\` — primary-source confirmations / denials`,
    ``,
    `Do not modify \`<kb>/\` directly from this flow — the live KB is a trust`,
    `boundary. Do not auto-apply suggested_revision; the operator decides.`,
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

// ---------------------------------------------------------------------------
// mode=execute — MCP-driven panel fan-out
// ---------------------------------------------------------------------------

async function runExecute(
  deps: ServerDeps,
  parsed: ResearchComposeArgs,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof success<Record<string, unknown>>>> {
  if (!hasRole(deps.config, parsed.panel_role)) {
    throw new McpError(
      "E_VALIDATION",
      `mode=execute requires role '${parsed.panel_role}' configured under config.roles[] ` +
        `with [frontier, web_search] capabilities and at least one default slot. ` +
        `Either add the role or use mode=directive to drive the panel from the orchestrator.`,
    );
  }

  // Stage dir: timestamped slug. Topic gets sanitized to a stable suffix so
  // operators can find drafts by topic when multiple are in flight.
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .slice(0, 15);
  const topicSlug = parsed.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const draftId = `${ts}-${topicSlug}-${parsed.kind}`;
  const draftDir = join(kbDraftsDir(deps.homeDir), draftId);
  const aspectsDir = join(draftDir, "aspects");
  await mkdir(aspectsDir, { recursive: true });

  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);

  let panelResults;
  try {
    panelResults = await runPanel({
      config: deps.config,
      roleName: parsed.panel_role,
      buildMessages: (slotIdx, model) => {
        // Pair slots to aspects in order. If aspects > slots, the last slot
        // batches the tail (a config sin worth surfacing in summary, not
        // failing — small panels still produce useful output).
        const aspect = parsed.aspects[slotIdx] ?? parsed.aspects[parsed.aspects.length - 1];
        const today = new Date().toISOString().slice(0, 10);
        const system = [
          `You are research subagent ${slotIdx + 1} of ${panelResults?.length ?? "?"} for a KB ${parsed.kind}.`,
          `Today is ${today}. Your model is ${model.model.alias} (${model.model.model_id}).`,
          ``,
          `Topic: ${parsed.topic}`,
          `Your aspect: ${aspect}`,
          `Recency window: prefer sources published in the last ${parsed.recency_window_days} days.`,
          ...(parsed.recency_floor_iso
            ? [
                `UPDATE FLOW: the existing artifact was last refreshed on ${parsed.recency_floor_iso}.`,
                `Focus on changes since that date — new versions, deprecations, post-${parsed.recency_floor_iso}`,
                `releases, retracted claims. Carry forward stable material verbatim where the primary source still supports it.`,
              ]
            : []),
          ``,
          `You MUST use web search for any dated/numeric/named claim. Do NOT rely`,
          `on training memory for post-${today} facts; verify against primary sources.`,
          ``,
          `Output ONLY a JSON object matching this shape:`,
          `{`,
          `  "aspect": "${aspect}",`,
          `  "findings": [`,
          `    {`,
          `      "claim": "<one-sentence factual claim>",`,
          `      "source": {"url": "...", "title": "...", "published": "YYYY-MM-DD"},`,
          `      "quote": "<verbatim ≤50 words>",`,
          `      "confidence": "high" | "medium" | "low",`,
          `      "source_tier": "primary" | "official-docs" | "vendor-blog" | "personal-blog" | "aggregator"`,
          `    }`,
          `  ],`,
          `  "open_questions": ["..."]`,
          `}`,
          ``,
          `No prose outside the JSON. Tier-1/2 sources only for load-bearing claims;`,
          `tier-3+ stays at examples / illustrations.`,
        ].join("\n");
        const user = [`# Research aspect: ${aspect}`, ``, `Produce the JSON object now.`].join(
          "\n",
        );
        return [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
      },
      resolveApiKey: (model) => resolveAuthKey(model.endpoint, undefined).apiKey,
      signal: ctrl.signal,
      jsonResponse: true,
      temperature: 0.2,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  // Write per-slot output files. Filename includes slot + alias so an
  // operator can tell which model produced which aspect.
  const aspectPaths: string[] = [];
  for (const r of panelResults) {
    const filename = `aspect-${String(r.slot).padStart(2, "0")}-${r.model_alias}.json`;
    const p = join(aspectsDir, filename);
    // Wrap the LLM's raw output with provenance + slot metadata so the
    // assemble step has the routing info it needs.
    const wrapped = {
      provenance: {
        tool: "research_compose",
        phase: "compose-aspect",
        model: r.model_id,
        endpoint: r.endpoint,
        route: r.route,
        generated_at: new Date().toISOString(),
      },
      slot: r.slot,
      aspect: parsed.aspects[r.slot] ?? parsed.aspects[parsed.aspects.length - 1],
      raw: r.content,
    };
    await writeFile(p, JSON.stringify(wrapped, null, 2) + "\n", "utf8");
    aspectPaths.push(p);
  }

  return success<Record<string, unknown>>(
    aspectPaths,
    `research_compose: executed ${parsed.panel_role} (${panelResults.length} slot(s)) → ${draftDir}`,
    parsed.expand
      ? {
          content: {
            mode: "execute",
            draft_id: draftId,
            staging_dir: draftDir,
            aspect_paths: aspectPaths,
            panel: panelResults.map((r) => ({
              slot: r.slot,
              model_alias: r.model_alias,
              model_id: r.model_id,
              vendor: r.vendor,
              endpoint: r.endpoint,
              route: r.route,
            })),
            next_tool: "research_assemble",
            next_tool_args: {
              draft_id: draftId,
              kind: parsed.kind,
              topic: parsed.topic,
            },
          },
        }
      : {},
  );
}
