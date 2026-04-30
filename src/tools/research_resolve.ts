// research_resolve — project scope (PM only).
//
// Step 3 of the research pipeline:
//   compose → verify → RESOLVE → operator merge
//
// research_verify produces a list of contested claims, but verify is itself
// an LLM judgment — it can be wrong about what's wrong. research_resolve
// fans out one focused subagent per contested claim, each tasked with going
// to PRIMARY sources to confirm or deny that specific claim. Outputs a
// resolutions.json that the operator pairs with verify.json to decide what
// stays in the draft.
//
// Two modes:
//   mode=directive (default, back-compat) — return a scaffold prompt; the
//     calling agent runs subagents and writes the JSONs itself.
//   mode=execute — MCP resolves a singleton role and dispatches one LLM
//     call per claim in parallel via the dispatcher. Writes per-claim
//     resolutions + the aggregate file directly.
//
// Layering: reads ~/.vcf/kb-drafts/<draft_id>/{draft.md, verify.json},
// returns a prompt that walks the calling LLM through:
//   1. dispatch one subagent per contested_claim
//   2. each subagent writes resolutions/<claim_id>.json
//   3. fan-in into resolutions.json
//
// The operator's merge decision then has three artifacts to read:
//   draft.md (compose output) + verify.json (LLM judgment) +
//   resolutions.json (primary-source confirmations / denials).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { buildProvenance, readJsonProvenance, type Provenance } from "../util/provenance.js";
import { dispatchChatCompletion } from "../util/dispatcher.js";
import { resolveRole, hasRole } from "../util/roleResolve.js";
import { resolveAuthKey } from "../review/endpointResolve.js";
import type { ChatMessage } from "../util/llmClient.js";

const DraftIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "draft_id must be a safe directory name");

const ResearchResolveInput = z
  .object({
    draft_id: DraftIdSchema.describe(
      "the staging directory name under ~/.vcf/kb-drafts/ that already has a verify.json",
    ),
    severity_min: z
      .enum(["low", "medium", "high"])
      .default("low")
      .describe(
        "only resolve claims at or above this severity. Default 'low' resolves everything. Use 'medium' to skip nitpicks, 'high' to focus only on hallucinated specs / load-bearing claims.",
      ),
    /**
     * mode=directive (default, back-compat) — return the scaffold prompt;
     *   the calling agent dispatches per-claim subagents and writes the
     *   JSONs itself.
     * mode=execute — MCP resolves the configured singleton role
     *   (default: research_primary) and dispatches one LLM call PER
     *   contested claim in parallel via the dispatcher. Writes
     *   resolutions/<claim_id>.json per claim + the aggregate
     *   resolutions.json. Use when the operator wants resolve to run
     *   end-to-end without round-tripping through the orchestrator.
     */
    mode: z.enum(["directive", "execute"]).default("directive"),
    /**
     * Singleton role used in mode=execute. Should resolve to a different
     * model from research_verify's role to avoid same-model confirmation
     * bias. Defaults to research_primary; operators add a dedicated
     * resolve role if their verifier already uses research_primary.
     */
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("research_primary"),
    /** Per-claim timeout. The whole call is bounded by this — slow
     *  claims abort along with all in-flight peers. */
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(15 * 60_000)
      .default(300_000),
    expand: z.boolean().default(true),
  })
  .strict();

type ResearchResolveArgs = z.infer<typeof ResearchResolveInput>;

interface ContestedClaim {
  id: string;
  claim: string;
  reason: string;
  severity: "low" | "medium" | "high";
}

interface VerifyJsonShape {
  contested_claims?: ContestedClaim[];
  recommendation?: string;
  hallucination_risk?: string;
}

const SEVERITY_ORDER: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function registerResearchResolve(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "research_resolve",
    {
      title: "Resolve Contested Claims via Primary-Source Re-Investigation",
      description:
        "Read a verify.json and return a fan-out prompt: one subagent per contested claim, each tasked with confirming or denying it against primary sources (rfc-editor.org, owasp.org, vendor docs, peer-reviewed studies — not blog posts). Calling agent writes resolutions.json. Pair with verify.json so the operator merge decision sees both LLM judgment and re-checked evidence.",
      inputSchema: ResearchResolveInput.shape,
    },
    async (args: ResearchResolveArgs) => {
      return runTool(
        async () => {
          const parsed = ResearchResolveInput.parse(args);

          const draftDir = join(kbDraftsDir(deps.homeDir), parsed.draft_id);
          if (!existsSync(draftDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `kb-drafts directory '${parsed.draft_id}' not found at ${draftDir}`,
            );
          }
          const verifyPath = join(draftDir, "verify.json");
          if (!existsSync(verifyPath)) {
            throw new McpError(
              "E_STATE_INVALID",
              `verify.json missing in ${draftDir} — run research_verify first`,
            );
          }

          // Hard validator: verify.json must carry a provenance block from
          // the verify phase. Without it the operator can't tell which
          // model produced the contested-claim list, which makes resolve's
          // job (re-checking that list against primary sources) incoherent.
          const { provenance: verifyProvenance, raw: verifyRaw } = await readJsonProvenance(
            verifyPath,
            { expectedPhase: "verify" },
          );
          const verifyJson = verifyRaw as unknown as VerifyJsonShape;

          const allClaims = Array.isArray(verifyJson.contested_claims)
            ? verifyJson.contested_claims
            : [];
          const minRank = SEVERITY_ORDER[parsed.severity_min];
          const filtered = allClaims.filter((c) => {
            const sev = c.severity ?? "medium";
            return SEVERITY_ORDER[sev] >= minRank;
          });

          const draftPath = join(draftDir, "draft.md");
          if (filtered.length > 0 && !existsSync(draftPath)) {
            throw new McpError(
              "E_STATE_INVALID",
              `draft.md missing in ${draftDir} — staging is incomplete`,
            );
          }

          // mode=execute: resolve a singleton role and dispatch one LLM
          // call per contested claim in parallel. Writes per-claim files
          // + the aggregate. Skips entirely when nothing to resolve so
          // the empty-claims summary stays consistent with directive mode.
          if (parsed.mode === "execute" && filtered.length > 0) {
            return await runExecute(deps, parsed, {
              draftDir,
              draftPath,
              verifyPath,
              verifyProvenance,
              filtered,
              totalClaims: allClaims.length,
            });
          }

          interface ResolveContent {
            draft_id: string;
            draft_path: string;
            verify_path: string;
            total_contested_claims: number;
            claims_to_resolve: number;
            severity_min: "low" | "medium" | "high";
            claims: ContestedClaim[];
            verify_model: string;
            scaffolding_prompt: string | null;
          }

          const summary =
            filtered.length === 0
              ? `research_resolve: nothing to resolve — ${
                  allClaims.length === 0
                    ? "verify.json has no contested_claims"
                    : `${allClaims.length} claim(s) but none at severity >= ${parsed.severity_min}`
                }.`
              : `research_resolve: scaffold for ${filtered.length}/${allClaims.length} contested ` +
                `claim(s) (severity_min=${parsed.severity_min}) on ${parsed.draft_id} ` +
                `[verify by ${verifyProvenance.model}]`;

          const content: ResolveContent = {
            draft_id: parsed.draft_id,
            draft_path: draftPath,
            verify_path: verifyPath,
            total_contested_claims: allClaims.length,
            claims_to_resolve: filtered.length,
            severity_min: parsed.severity_min,
            claims: filtered,
            verify_model: verifyProvenance.model,
            scaffolding_prompt:
              filtered.length === 0
                ? null
                : buildResolvePrompt(parsed.draft_id, filtered, verifyProvenance.model),
          };

          const paths = filtered.length === 0 ? [verifyPath] : [verifyPath, draftPath];
          return success<Record<string, unknown>>(
            paths,
            summary,
            parsed.expand ? { content: content as unknown as Record<string, unknown> } : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "research_resolve",
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

function buildResolvePrompt(
  draftId: string,
  claims: ContestedClaim[],
  verifyModel: string,
): string {
  const claimsBlock = claims
    .map(
      (c, i) =>
        `${i + 1}. **id=${c.id}** (severity=${c.severity})\n` +
        `   - Claim: ${c.claim}\n` +
        `   - Why contested: ${c.reason}`,
    )
    .join("\n\n");

  return [
    `# Research resolve — ${claims.length} contested claim(s) on ${draftId}`,
    ``,
    `\`research_verify\` flagged ${claims.length} claim(s) in this draft as questionable.`,
    `Verify is itself an LLM judgment and can be wrong about what's wrong. Your job:`,
    `dispatch one focused subagent per contested claim. Each subagent goes to PRIMARY`,
    `sources to confirm or deny that specific claim — independent of what verify said,`,
    `independent of what compose said.`,
    ``,
    `## Contested claims`,
    ``,
    claimsBlock,
    ``,
    `## Phase 1 — Fan out (one subagent per claim, parallel)`,
    ``,
    `Dispatch ${claims.length} subagent(s) in parallel. Each one investigates exactly`,
    `one claim. Give each subagent:`,
    ``,
    `- The contested claim text (verbatim, from above)`,
    `- The verifier's reason for flagging it`,
    `- Read access to \`~/.vcf/kb-drafts/${draftId}/draft.md\` and \`sources.json\` so`,
    `  it can see the full context the claim was made in`,
    ``,
    `### Subagent's hard rules`,
    ``,
    `**Primary sources only.** Acceptable:`,
    `  - RFCs from rfc-editor.org (verify exact RFC number, title, status, date)`,
    `  - W3C / IETF specs at their canonical URLs`,
    `  - OWASP project pages on owasp.org (verify list version + year)`,
    `  - Peer-reviewed papers (DOI / journal / conference proceedings)`,
    `  - Vendor's own documentation site (NOT their marketing blog)`,
    `  - Well-known project's official docs (postgres.org, kubernetes.io, etc.)`,
    ``,
    `**Not acceptable** (these are what got flagged in the first place):`,
    `  - Vendor marketing blogs citing self-generated statistics`,
    `  - Personal Medium posts citing specific multipliers without methodology`,
    `  - Conference talk slides without an accompanying paper`,
    `  - Aggregator sites (the original source must be reachable)`,
    ``,
    `**For statistics specifically:** the source must show methodology — sample size,`,
    `survey design, year. Without that, the stat is denied even if a vendor blog`,
    `repeats it.`,
    ``,
    `**For RFCs / specs:** verify the exact number / version exists at the canonical`,
    `URL. If rfc-editor.org doesn't have it, the claim is denied (and the original`,
    `RFC number was hallucinated).`,
    ``,
    `### Subagent output (one JSON file per claim)`,
    ``,
    `Each subagent writes to \`~/.vcf/kb-drafts/${draftId}/resolutions/<claim_id>.json\`:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "provenance": {`,
    `    "tool": "research_resolve",`,
    `    "phase": "resolve-claim",`,
    `    "model": "<exact model id of the subagent doing this — e.g.`,
    `              claude-opus-4-7, claude-sonnet-4-6, gpt-5.4, etc.>",`,
    `    "endpoint": "claude-code-subagent",`,
    `    "generated_at": "<ISO 8601 timestamp>"`,
    `  },`,
    `  "id": "<the contested claim id>",`,
    `  "claim": "<verbatim claim text>",`,
    `  "verdict": "confirmed" | "denied" | "undetermined",`,
    `  "evidence": [`,
    `    {`,
    `      "url": "<primary source URL>",`,
    `      "title": "<page title>",`,
    `      "publisher": "<rfc-editor.org | owasp.org | journal name | …>",`,
    `      "quote": "<verbatim supporting passage, ≤80 words>",`,
    `      "supports": "confirms" | "denies" | "neither"`,
    `    }`,
    `  ],`,
    `  "rationale": "<one-paragraph explanation tying the evidence to the verdict>",`,
    `  "suggested_revision": "<if denied: how the draft text should be reworded.`,
    `                         if confirmed: null. if undetermined: caveat to add to the draft>"`,
    `}`,
    `\`\`\``,
    ``,
    `**Provenance is mandatory.** Each subagent MUST honestly record its own`,
    `model id (the model running the subagent — not what verify used, not what`,
    `compose used). The operator reads this to weigh evidence: a "denied" verdict`,
    `from claude-opus matters differently than the same verdict from a 7B local`,
    `model. If you don't know your exact model id, ask the operator before`,
    `proceeding rather than guessing.`,
    ``,
    `**Verdict rubric:**`,
    `  - \`confirmed\` — primary source clearly supports the claim AS STATED in the draft.`,
    `  - \`denied\` — primary source contradicts the claim, OR no primary source exists`,
    `    despite reasonable search effort (e.g., the cited RFC number doesn't exist).`,
    `  - \`undetermined\` — claim is plausible but no primary source either way; the`,
    `    draft should soften the wording, not assert it as fact.`,
    ``,
    `## Phase 2 — Fan in`,
    ``,
    `After all subagents return, write the aggregated file:`,
    ``,
    `\`~/.vcf/kb-drafts/${draftId}/resolutions.json\`:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "provenance": {`,
    `    "tool": "research_resolve",`,
    `    "phase": "resolve",`,
    `    "model": "<exact model id of the ORCHESTRATOR — the agent that`,
    `              dispatched the subagents and wrote this aggregate file>",`,
    `    "endpoint": "claude-code-main",`,
    `    "generated_at": "<ISO 8601 timestamp>"`,
    `  },`,
    `  "upstream_provenance": {`,
    `    "tool": "research_verify",`,
    `    "phase": "verify",`,
    `    "model": "${verifyModel}",`,
    `    "endpoint": "<copy from verify.json>",`,
    `    "generated_at": "<copy from verify.json>"`,
    `  },`,
    `  "draft_id": "${draftId}",`,
    `  "claims_resolved": ${claims.length},`,
    `  "summary": {`,
    `    "confirmed": <count>,`,
    `    "denied": <count>,`,
    `    "undetermined": <count>`,
    `  },`,
    `  "resolutions": [ /* the per-claim JSON objects from Phase 1, each with its own provenance block */ ]`,
    `}`,
    `\`\`\``,
    ``,
    `## Phase 3 — Operator review`,
    ``,
    `STOP after writing resolutions.json. Do not modify draft.md. Do not promote into`,
    `the live KB. Surface the three artifacts to the operator:`,
    ``,
    `  - \`draft.md\` — compose output`,
    `  - \`verify.json\` — verifier's contested-claim list`,
    `  - \`resolutions.json\` — primary-source confirmations / denials`,
    ``,
    `The operator decides what stays, what's reworded per \`suggested_revision\`, and`,
    `what's cut. The merge into live KB is operator-only — never automatic.`,
    ``,
    `## Guardrails`,
    ``,
    `- **Different model from verify (which ran \`${verifyModel}\`).** Same model`,
    `  agreeing with itself is not independent confirmation. Pick a different`,
    `  family — if verify was Gemini, use Claude / GPT / local; if verify was`,
    `  Claude, use Gemini / GPT / local; etc.`,
    `- **One subagent per claim.** Don't bundle. Bundling lets a subagent skip the`,
    `  hard ones.`,
    `- **No web fetches without redaction context.** If your subagent's research turns`,
    `  up secrets / PII in cached pages, it must redact before writing the quote field.`,
    `- **Cite or deny.** A subagent that can't find a primary source returns \`denied\``,
    `  or \`undetermined\` — never \`confirmed\` based on "general knowledge."`,
  ].join("\n");
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { ResearchResolveInput };

// ---------------------------------------------------------------------------
// mode=execute — per-claim parallel dispatch
// ---------------------------------------------------------------------------

interface ExecuteContext {
  draftDir: string;
  draftPath: string;
  verifyPath: string;
  verifyProvenance: Provenance;
  filtered: ContestedClaim[];
  totalClaims: number;
}

interface Resolution {
  id: string;
  claim: string;
  verdict: "confirmed" | "denied" | "undetermined";
  evidence: ResolutionEvidence[];
  rationale: string;
  suggested_revision: string | null;
}

interface ResolutionEvidence {
  url: string;
  title: string;
  publisher: string;
  quote: string;
  supports: "confirms" | "denies" | "neither";
}

interface ResolutionFile extends Resolution {
  provenance: Provenance;
  upstream_provenance: Provenance;
  /** Wall-clock seconds for THIS claim's call. */
  resolve_seconds: number;
}

async function runExecute(
  deps: ServerDeps,
  parsed: ResearchResolveArgs,
  ctx: ExecuteContext,
): Promise<ReturnType<typeof success<Record<string, unknown>>>> {
  if (!hasRole(deps.config, parsed.role)) {
    throw new McpError(
      "E_VALIDATION",
      `mode=execute requires role '${parsed.role}' configured under config.roles[]. ` +
        `Add the role (singleton, requires [frontier, web_search]) or use mode=directive ` +
        `to drive resolution from the orchestrator.`,
    );
  }
  const resolved = resolveRole(deps.config, parsed.role);

  // Same-model warning: if resolve uses the same model as verify, the result
  // is confirmation bias rather than independent re-checking. Don't fail —
  // the operator's config wins; surface in the audit + summary instead.
  const sameModelAsVerify = resolved.modelId === ctx.verifyProvenance.model;

  const draft = await readFile(ctx.draftPath, "utf8");
  const sourcesPath = join(ctx.draftDir, "sources.json");
  let sources = "{}";
  if (existsSync(sourcesPath)) {
    sources = await readFile(sourcesPath, "utf8");
  }

  const apiKey = resolveAuthKey(resolved.endpoint, undefined).apiKey;
  const todayIso = new Date().toISOString().slice(0, 10);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);

  // Per-claim parallel dispatch. Promise.all → fail-fast on the first
  // claim's error. The aborted controller cancels in-flight peers so
  // we don't waste cycles on calls that will be discarded.
  const t0 = Date.now();
  const dispatches = ctx.filtered.map(async (claim) => {
    const claimT0 = Date.now();
    const messages = composeResolveMessages({
      claim,
      draft,
      sources,
      todayIso,
      verifyModel: ctx.verifyProvenance.model,
    });
    const redactedMessages = redact(messages) as ChatMessage[];
    const result = await dispatchChatCompletion({
      endpoint: resolved.endpoint,
      modelId: resolved.modelId,
      messages: redactedMessages,
      apiKey,
      signal: ctrl.signal,
      temperature: 0.1,
      jsonResponse: true,
      ...(resolved.endpoint.provider_options
        ? {
            providerOptions: resolved.endpoint.provider_options as Record<string, unknown>,
          }
        : {}),
    });
    const verdict = parseResolution(result.content, claim);
    const seconds = Math.round((Date.now() - claimT0) / 100) / 10;
    return { claim, verdict, seconds };
  });

  let dispatchResults: Array<{
    claim: ContestedClaim;
    verdict: Resolution;
    seconds: number;
  }>;
  try {
    dispatchResults = await Promise.all(dispatches);
  } finally {
    clearTimeout(timer);
  }
  const totalElapsed = Math.round((Date.now() - t0) / 100) / 10;

  // Build per-claim files + collect for the aggregate.
  const resolutionsDir = join(ctx.draftDir, "resolutions");
  await mkdir(resolutionsDir, { recursive: true });
  const claimPaths: string[] = [];
  const perClaimFiles: ResolutionFile[] = [];
  for (const { claim, verdict, seconds } of dispatchResults) {
    const claimProvenance = buildProvenance({
      tool: "research_resolve",
      phase: "resolve-claim",
      model: resolved.modelId,
      endpoint: resolved.endpoint.name,
    });
    const file: ResolutionFile = {
      provenance: claimProvenance,
      upstream_provenance: ctx.verifyProvenance,
      resolve_seconds: seconds,
      ...verdict,
    };
    const safeId = claim.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const claimPath = join(resolutionsDir, `${safeId}.json`);
    await writeFile(claimPath, JSON.stringify(file, null, 2) + "\n", "utf8");
    claimPaths.push(claimPath);
    perClaimFiles.push(file);
  }

  // Counts surface in summary + audit.
  const counts = perClaimFiles.reduce(
    (acc, r) => {
      acc[r.verdict] += 1;
      return acc;
    },
    { confirmed: 0, denied: 0, undetermined: 0 },
  );

  // Aggregate file. Provenance.model = the dispatched model (every per-
  // claim call used the same singleton role, so one model speaks for the
  // whole aggregate).
  const aggregate = {
    provenance: buildProvenance({
      tool: "research_resolve",
      phase: "resolve",
      model: resolved.modelId,
      endpoint: resolved.endpoint.name,
    }),
    upstream_provenance: ctx.verifyProvenance,
    draft_id: parsed.draft_id,
    role: parsed.role,
    same_model_as_verify: sameModelAsVerify,
    claims_resolved: perClaimFiles.length,
    severity_min: parsed.severity_min,
    total_seconds: totalElapsed,
    summary: counts,
    resolutions: perClaimFiles,
  };
  const aggregatePath = join(ctx.draftDir, "resolutions.json");
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2) + "\n", "utf8");

  const sameModelNote = sameModelAsVerify
    ? ` [WARN: resolve model == verify model '${ctx.verifyProvenance.model}' — confirmation bias risk]`
    : "";
  return success<Record<string, unknown>>(
    [aggregatePath, ...claimPaths],
    `research_resolve: executed ${parsed.role} (${resolved.modelId}) → ` +
      `${counts.confirmed} confirmed / ${counts.denied} denied / ${counts.undetermined} undetermined ` +
      `(${perClaimFiles.length}/${ctx.totalClaims} claim(s), ${totalElapsed}s)${sameModelNote}`,
    parsed.expand
      ? {
          content: {
            mode: "execute",
            draft_id: parsed.draft_id,
            role: parsed.role,
            model_id: resolved.modelId,
            endpoint: resolved.endpoint.name,
            same_model_as_verify: sameModelAsVerify,
            resolutions_path: aggregatePath,
            per_claim_paths: claimPaths,
            summary: counts,
            total_seconds: totalElapsed,
          },
        }
      : {},
  );
}

function composeResolveMessages(opts: {
  claim: ContestedClaim;
  draft: string;
  sources: string;
  todayIso: string;
  verifyModel: string;
}): ChatMessage[] {
  const system = [
    `You are resolving ONE contested claim from a KB draft. A verifier (${opts.verifyModel})`,
    `flagged this claim as questionable. Your job: confirm or deny it against PRIMARY`,
    `sources, independent of what the verifier said and independent of what the original`,
    `composer wrote.`,
    ``,
    `Today is ${opts.todayIso}. You MUST web-search for any dated, numeric, or named claim.`,
    `Do NOT rely on training memory for post-${opts.todayIso} facts; check the source URL.`,
    ``,
    `# The claim`,
    ``,
    `id: ${opts.claim.id}`,
    `severity: ${opts.claim.severity}`,
    `claim text: ${opts.claim.claim}`,
    `verifier's reason for flagging it: ${opts.claim.reason}`,
    ``,
    `# Hard rules — what counts as evidence`,
    ``,
    `Acceptable primary sources:`,
    `  - RFCs from rfc-editor.org (verify exact RFC number AND publication date — LLMs`,
    `    hallucinate RFC numbers regularly).`,
    `  - W3C / IETF / WHATWG specs at canonical URLs.`,
    `  - OWASP project pages on owasp.org (verify exact list version + year).`,
    `  - Peer-reviewed papers (DOI / journal / ACM / IEEE / USENIX).`,
    `  - The project's own canonical docs site (postgres.org, kubernetes.io, etc.) — NOT`,
    `    their /blog/ subtree.`,
    ``,
    `Not acceptable (these are what got flagged in the first place):`,
    `  - Vendor marketing blogs citing self-generated statistics without methodology.`,
    `  - Personal Medium posts citing specific multipliers / percentages.`,
    `  - Aggregator round-ups (follow through to the original).`,
    `  - Conference-talk slides without an accompanying paper.`,
    ``,
    `For statistics: the source must show methodology — sample size, survey design, year.`,
    `Without methodology, the stat is denied even if a vendor blog repeats it.`,
    ``,
    `# Verdict rubric`,
    ``,
    `  - confirmed:    primary source clearly supports the claim AS STATED in the draft.`,
    `  - denied:       primary source contradicts the claim, OR no primary source exists`,
    `                  despite reasonable search effort (e.g. cited RFC number doesn't exist).`,
    `  - undetermined: claim is plausible but no primary source either way; the draft`,
    `                  should soften the wording, not assert it as fact.`,
    ``,
    `# Output`,
    ``,
    `Output ONLY a JSON object matching this shape (no prose outside the JSON):`,
    ``,
    `{`,
    `  "id": "${opts.claim.id}",`,
    `  "claim": "<verbatim claim text>",`,
    `  "verdict": "confirmed" | "denied" | "undetermined",`,
    `  "evidence": [`,
    `    {`,
    `      "url": "<primary source URL>",`,
    `      "title": "<page title>",`,
    `      "publisher": "<rfc-editor.org | owasp.org | journal name | ...>",`,
    `      "quote": "<verbatim supporting passage, ≤80 words>",`,
    `      "supports": "confirms" | "denies" | "neither"`,
    `    }`,
    `  ],`,
    `  "rationale": "<one paragraph tying evidence to verdict>",`,
    `  "suggested_revision": "<if denied: how to reword. if confirmed: null. if undetermined: caveat to add>"`,
    `}`,
  ].join("\n");

  const user = [
    `# Draft (full text)`,
    ``,
    "```markdown",
    opts.draft,
    "```",
    ``,
    `# Sources file`,
    ``,
    "```json",
    opts.sources,
    "```",
    ``,
    `Resolve the claim above. Output the JSON verdict only.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseResolution(content: string, claim: ContestedClaim): Resolution {
  const trimmed = stripJsonFence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      id: claim.id,
      claim: claim.claim,
      verdict: "undetermined",
      evidence: [],
      rationale: `Resolver returned non-JSON response. Raw: ${trimmed.slice(0, 500)}`,
      suggested_revision: null,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new McpError("E_INTERNAL", "resolver response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = isOneOf(obj["verdict"], ["confirmed", "denied", "undetermined"])
    ? (obj["verdict"] as Resolution["verdict"])
    : "undetermined";
  const evidence: ResolutionEvidence[] = [];
  const evRaw = Array.isArray(obj["evidence"]) ? obj["evidence"] : [];
  for (const e of evRaw) {
    if (typeof e !== "object" || e === null) continue;
    const eo = e as Record<string, unknown>;
    const supports = isOneOf(eo["supports"], ["confirms", "denies", "neither"])
      ? (eo["supports"] as ResolutionEvidence["supports"])
      : "neither";
    evidence.push({
      url: typeof eo["url"] === "string" ? eo["url"] : "",
      title: typeof eo["title"] === "string" ? eo["title"] : "",
      publisher: typeof eo["publisher"] === "string" ? eo["publisher"] : "",
      quote: typeof eo["quote"] === "string" ? eo["quote"] : "",
      supports,
    });
  }
  const suggested = obj["suggested_revision"];
  return {
    id: typeof obj["id"] === "string" ? obj["id"] : claim.id,
    claim: typeof obj["claim"] === "string" ? obj["claim"] : claim.claim,
    verdict,
    evidence,
    rationale: typeof obj["rationale"] === "string" ? obj["rationale"] : "",
    suggested_revision: typeof suggested === "string" && suggested.length > 0 ? suggested : null,
  };
}

function stripJsonFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const firstNl = t.indexOf("\n");
    if (firstNl > 0) t = t.slice(firstNl + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// Test-only export for parser unit tests. Not part of the registered tool surface.
export { composeResolveMessages, parseResolution, runExecute };
