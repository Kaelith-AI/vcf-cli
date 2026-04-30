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
// This is a scaffold-returning tool (no direct LLM call) — like
// research_compose, the heavy lifting happens in the calling agent's
// subagent fan-out. So no defaults.research_resolve config slot is needed.
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
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { readJsonProvenance } from "../util/provenance.js";

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
          return success(paths, summary, parsed.expand ? { content } : {});
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
