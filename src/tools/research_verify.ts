// research_verify — project scope (PM only).
//
// Followup #29c: the verification half of the research_compose pipeline.
//
// Reads a staged KB draft from `~/.vcf/kb-drafts/<draft_id>/`, calls a
// configured LLM endpoint with the draft + sources, and asks for a
// structured verdict: which claims are weakly supported, which look
// hallucinated, and whether the draft is ready to merge.
//
// The verifier should be a different model from the composer — same-model
// verify is confirmation bias, not verification. The verify model can also
// be wrong; `research_resolve` exists to actively pursue the contested
// claims this tool surfaces. So this is step 2 of a 3-step pipeline:
//   compose → verify → resolve → operator merge.
//
// Routing follows the same shape as review_execute:
//   - defaults.research_verify.endpoint + .model (overridable via args)
//   - defaults.research_verify.backup_endpoint + .backup_model (auto-retry)
//   - trust-level gate: public endpoints require allow_public_endpoint=true
//
// Output: `~/.vcf/kb-drafts/<draft_id>/verify.json` with a stable shape
// that `research_resolve` consumes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { assertApiEndpoint, type ApiEndpoint } from "../util/endpointKind.js";
import { callChatCompletionWithFallback, LlmError, type ChatMessage } from "../util/llmClient.js";
import { buildBackupRequest, resolveAuthKey } from "../review/endpointResolve.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { buildProvenance, readMarkdownProvenance, type Provenance } from "../util/provenance.js";
import { PanelModeSchema } from "../util/panel.js";

const DraftIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "draft_id must be a safe directory name");

const ResearchVerifyInput = z
  .object({
    draft_id: DraftIdSchema.describe(
      "the staging directory name under ~/.vcf/kb-drafts/ (e.g. '20260428T224750-backend-best-practice')",
    ),
    endpoint: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe("override defaults.research_verify.endpoint"),
    model_id: z.string().min(1).max(128).optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(180_000),
    allow_public_endpoint: z.boolean().default(false),
    expand: z.boolean().default(false),
    /**
     * mode=execute (default): MCP calls the verify endpoint directly via the
     *   dispatcher. Single-model path. Returns verify.json populated.
     *
     * mode=directive: MCP returns the verifier prompt + expected output path
     *   and stops there. The calling agent (Claude Code, etc.) runs the
     *   verification itself — useful when the orchestrator can leverage its
     *   harness's web-search tool to actually fetch dated/numeric/named
     *   claims instead of judging them from training memory. Orchestrator
     *   writes the verdict to expected_output_path; subsequent
     *   research_resolve consumes it.
     */
    mode: PanelModeSchema,
  })
  .strict();

type ResearchVerifyArgs = z.infer<typeof ResearchVerifyInput>;

interface ContestedClaim {
  /** Stable identifier — the footnote number from sources.json or a synthetic id. */
  id: string;
  /** Short description of what the claim is, in the verifier's words. */
  claim: string;
  /** Why the verifier flagged it. */
  reason: string;
  /** Severity hint: low | medium | high. */
  severity: "low" | "medium" | "high";
}

interface VerifyVerdict {
  references_verified: string;
  contested_claims: ContestedClaim[];
  hallucination_risk: "low" | "medium" | "high";
  recommendation: "merge" | "revise" | "reject";
  notes: string;
}

interface VerifyJson extends VerifyVerdict {
  /** Provenance of THIS verify pass (which model produced verify.json). */
  provenance: Provenance;
  /** Provenance of the upstream draft.md (which model composed it). */
  upstream_provenance: Provenance;
  verify_seconds: number;
  primary_attempted: string;
}

export function registerResearchVerify(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "research_verify",
    {
      title: "Verify a Staged KB Draft via Different-Model Cross-Check",
      description:
        "Read a staged KB draft (~/.vcf/kb-drafts/<draft_id>/) and call the configured verify endpoint to flag weakly-supported claims, possible hallucinations, and overall hallucination risk. Writes verify.json. Verify-pass output is itself an LLM judgment — pair with research_resolve to actively confirm or deny contested claims before merging.",
      inputSchema: ResearchVerifyInput.shape,
    },
    async (args: ResearchVerifyArgs, extra: { signal?: AbortSignal } | undefined) => {
      let auditInputs: unknown = args;
      let auditOutputs: unknown = undefined;
      return runTool(
        async () => {
          const parsed = ResearchVerifyInput.parse(args);

          const draftDir = join(kbDraftsDir(deps.homeDir), parsed.draft_id);
          if (!existsSync(draftDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `kb-drafts directory '${parsed.draft_id}' not found at ${draftDir}`,
            );
          }
          const draftPath = join(draftDir, "draft.md");
          const sourcesPath = join(draftDir, "sources.json");
          if (!existsSync(draftPath)) {
            throw new McpError(
              "E_NOT_FOUND",
              `draft.md missing in ${draftDir} — run research_compose's stage step first`,
            );
          }
          if (!existsSync(sourcesPath)) {
            throw new McpError(
              "E_NOT_FOUND",
              `sources.json missing in ${draftDir} — research_compose stage step is incomplete`,
            );
          }

          const { endpoint, modelId, apiKey } = resolveVerifyEndpoint(deps, parsed);

          // Validator gate: refuse to verify a draft.md without provenance.
          // The whole point of verify is "do I trust this?" — and you can't
          // answer that without knowing which model authored it.
          const draftRead = await readMarkdownProvenance(draftPath, {
            expectedPhase: "compose",
          });
          const upstreamProvenance = draftRead.provenance;

          const draft = await readFile(draftPath, "utf8");
          const sources = await readFile(sourcesPath, "utf8");

          const todayIso = new Date().toISOString().slice(0, 10);
          const messages = composeVerifyMessages(draft, sources, todayIso);
          const verifyPath = join(draftDir, "verify.json");

          // mode=directive: return prompt + expected output path, skip dispatch.
          // Orchestrator (Claude Code / Codex / Gemini CLI) is responsible for
          // running the verification with its own web-search tool. Closes the
          // temporal-bias hole because the orchestrator actively fetches the
          // primary source before flagging instead of judging from training memory.
          if (parsed.mode === "directive") {
            auditInputs = {
              draft_id: parsed.draft_id,
              mode: "directive",
            };
            auditOutputs = {
              ok: true,
              mode: "directive",
              expected_output_path: verifyPath,
              upstream_compose_model: upstreamProvenance.model,
            };
            return success<Record<string, unknown>>(
              [verifyPath],
              `research_verify: directive emitted for '${parsed.draft_id}' — orchestrator runs verifier, writes to ${verifyPath}`,
              parsed.expand
                ? {
                    content: {
                      mode: "directive",
                      draft_id: parsed.draft_id,
                      staging_dir: draftDir,
                      expected_output_path: verifyPath,
                      messages,
                      upstream_provenance: upstreamProvenance,
                      next_tool: "research_resolve",
                      next_tool_args: { draft_id: parsed.draft_id },
                      instructions:
                        "Run a frontier-tier verifier with web-search ENABLED. " +
                        "For every dated, numeric, or named claim in the draft, fetch " +
                        "the primary source URL and verify VERBATIM before flagging. " +
                        "Write the resulting JSON verdict (matching the schema in the " +
                        "system prompt) to expected_output_path. Then call research_resolve.",
                    },
                  }
                : {},
            );
          }

          const redactedMessages = redact(messages) as ChatMessage[];

          const ctrl = new AbortController();
          const mcpSignal = extra?.signal;
          const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);
          const onAbort = (): void => ctrl.abort();
          mcpSignal?.addEventListener("abort", onAbort);

          const providerOptions = endpoint.provider_options as Record<string, unknown> | undefined;
          const primaryReq = {
            baseUrl: endpoint.base_url,
            apiKey,
            model: modelId,
            messages: redactedMessages,
            temperature: 0.1,
            jsonResponse: true,
            ...(providerOptions ? { providerOptions } : {}),
            signal: ctrl.signal,
          };
          const backupReq = buildBackupRequest(deps.config, "research_verify", primaryReq);

          const t0 = Date.now();
          let content: string;
          let usedBackup = false;
          try {
            ({ content, usedBackup } = await callChatCompletionWithFallback(primaryReq, backupReq));
          } catch (e) {
            if (e instanceof LlmError) {
              if (e.kind === "canceled") throw new McpError("E_CANCELED", e.message);
              if (e.kind === "unreachable") {
                throw new McpError("E_ENDPOINT_UNREACHABLE", e.message);
              }
              throw new McpError(
                "E_INTERNAL",
                `verify endpoint '${endpoint.name}' returned an error response`,
                e.message,
              );
            }
            throw e;
          } finally {
            clearTimeout(timer);
            mcpSignal?.removeEventListener("abort", onAbort);
          }
          const elapsed = (Date.now() - t0) / 1000;

          const verdict = parseVerifyVerdict(content);

          const usedEndpoint = usedBackup
            ? (findBackupEndpointName(deps, "research_verify") ?? endpoint.name)
            : endpoint.name;
          const usedModel = usedBackup
            ? (deps.config.defaults?.research_verify?.backup_model ?? modelId)
            : modelId;

          const provenance = buildProvenance({
            tool: "research_verify",
            phase: "verify",
            model: usedModel,
            endpoint: usedEndpoint,
            fallback_used: usedBackup,
          });

          const verifyJson: VerifyJson = {
            provenance,
            upstream_provenance: upstreamProvenance,
            verify_seconds: Math.round(elapsed * 10) / 10,
            primary_attempted: `${endpoint.name}/${modelId}`,
            ...verdict,
          };

          await writeFile(verifyPath, JSON.stringify(verifyJson, null, 2) + "\n", "utf8");

          auditInputs = {
            draft_id: parsed.draft_id,
            endpoint: endpoint.name,
            model_id: modelId,
            timeout_ms: parsed.timeout_ms,
          };
          auditOutputs = {
            ok: true,
            recommendation: verifyJson.recommendation,
            hallucination_risk: verifyJson.hallucination_risk,
            contested_claims_count: verifyJson.contested_claims.length,
            fallback_used: verifyJson.provenance.fallback_used ?? false,
            verify_path: verifyPath,
            upstream_compose_model: upstreamProvenance.model,
          };

          const backupNote = usedBackup ? " [primary failed — used backup]" : "";
          return success<Record<string, unknown>>(
            [verifyPath],
            `research_verify: ${parsed.draft_id} → ${verifyJson.recommendation} ` +
              `(risk=${verifyJson.hallucination_risk}, ${verifyJson.contested_claims.length} contested ` +
              `claim(s), endpoint=${usedEndpoint}, model=${usedModel}${backupNote})`,
            parsed.expand
              ? {
                  content: {
                    draft_id: parsed.draft_id,
                    verify_path: verifyPath,
                    recommendation: verifyJson.recommendation,
                    hallucination_risk: verifyJson.hallucination_risk,
                    contested_claims: verifyJson.contested_claims,
                    notes: verifyJson.notes,
                    references_verified: verifyJson.references_verified,
                    provenance: verifyJson.provenance,
                    upstream_provenance: verifyJson.upstream_provenance,
                  },
                }
              : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "research_verify",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: auditInputs,
            outputs: auditOutputs ?? payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function resolveVerifyEndpoint(
  deps: ServerDeps,
  parsed: ResearchVerifyArgs,
): { endpoint: ApiEndpoint; modelId: string; apiKey: string | undefined } {
  const endpointFromDefaults = parsed.endpoint === undefined;
  const endpointName = parsed.endpoint ?? deps.config.defaults?.research_verify?.endpoint;
  if (!endpointName) {
    throw new McpError(
      "E_VALIDATION",
      "endpoint not provided and config.defaults.research_verify.endpoint is unset",
    );
  }
  const endpointRaw = deps.config.endpoints.find((e) => e.name === endpointName);
  if (!endpointRaw) {
    throw new McpError("E_VALIDATION", `endpoint '${endpointName}' not in config.endpoints[]`);
  }
  if (!endpointRaw.enabled) {
    throw new McpError(
      "E_ENDPOINT_DISABLED",
      `endpoint '${endpointRaw.name}' is disabled (set enabled=true in config.endpoints)`,
    );
  }
  const endpoint = assertApiEndpoint(endpointRaw);
  const allowPublic = parsed.allow_public_endpoint === true;
  if (endpoint.trust_level === "public" && !allowPublic) {
    throw new McpError(
      "E_STATE_INVALID",
      `endpoint '${endpoint.name}' has trust_level='public'; pass allow_public_endpoint=true to override`,
    );
  }
  if (endpointFromDefaults && endpoint.trust_level !== "local" && !allowPublic) {
    throw new McpError(
      "E_STATE_INVALID",
      `endpoint '${endpoint.name}' resolved from config.defaults.research_verify.endpoint has ` +
        `trust_level='${endpoint.trust_level}'; either pass endpoint explicitly or set ` +
        `allow_public_endpoint=true`,
    );
  }
  const { apiKey, envVarName, source } = resolveAuthKey(
    endpoint,
    deps.config.defaults?.research_verify?.key,
  );
  if (!apiKey && envVarName && endpoint.trust_level !== "local") {
    throw new McpError(
      "E_CONFIG_MISSING_ENV",
      `env var ${envVarName} is unset (referenced via ${source === "feature" ? "defaults.research_verify.key" : `endpoints[${endpoint.name}].auth_env_var`}); endpoint '${endpoint.name}' needs it`,
    );
  }
  const modelId = parsed.model_id ?? deps.config.defaults?.research_verify?.model;
  if (!modelId) {
    throw new McpError(
      "E_VALIDATION",
      "model_id not provided and config.defaults.research_verify.model is unset",
    );
  }
  return { endpoint, modelId, apiKey };
}

function findBackupEndpointName(deps: ServerDeps, toolKey: "research_verify"): string | null {
  const name = deps.config.defaults?.[toolKey]?.backup_endpoint;
  if (!name) return null;
  const ep = deps.config.endpoints.find((e) => e.name === name);
  return ep?.name ?? null;
}

function composeVerifyMessages(draft: string, sources: string, todayIso: string): ChatMessage[] {
  const system = [
    `You are a senior research verifier. The user will give you a draft KB best-practice`,
    `entry plus its sources list. Your job: assess source credibility, spot likely`,
    `hallucinations, flag claims that lack solid primary support, and recommend whether`,
    `the draft is ready to merge.`,
    ``,
    `# IMPORTANT: temporal context`,
    ``,
    `Today's date is ${todayIso}. Your training cutoff predates much of the material`,
    `you'll encounter — versions, papers, and standards released since your cutoff are`,
    `NOT hallucinations just because you don't recognize them. Specifically:`,
    `  - Do NOT flag a claim as fabricated solely because the named version, paper,`,
    `    or release post-dates your training. Check the source URL instead.`,
    `  - Do NOT label sources "future-dated" — anything dated on or before ${todayIso}`,
    `    is past or present, regardless of when you were trained.`,
    `  - For ANY dated, numeric, or named claim (RFC numbers, OWASP version years,`,
    `    statistics like "49% reduction", named releases like "Constitutional Classifiers",`,
    `    framework versions like "Preparedness Framework v2"), you MUST web-search the`,
    `    primary source URL provided in the draft's footnote BEFORE flagging it as`,
    `    contested. If the source URL confirms the claim verbatim, the claim is`,
    `    confirmed — even if the topic is unfamiliar to you.`,
    `  - Only flag a claim as contested when (a) you searched the primary source and`,
    `    it does NOT support the claim, OR (b) the draft cites a weak source (vendor`,
    `    blog with no methodology, personal Medium post, marketing page) and the`,
    `    claim is load-bearing.`,
    ``,
    `Source rubric. Strong evidence: official specs (RFCs from rfc-editor.org, IETF,`,
    `W3C), OWASP project pages on owasp.org, peer-reviewed studies, primary documentation`,
    `from the project itself (anthropic.com/news/, openai.com/index/, modelcontextprotocol.io,`,
    `etc.), vendor docs (not blog posts). Weak evidence: vendor blog posts citing`,
    `self-generated statistics ("89% of teams" without methodology), conference talks`,
    `without published papers, personal Medium posts citing specific multipliers, marketing`,
    `pages.`,
    ``,
    `Genuine hallucination patterns (still flag these):`,
    `  - RFC numbers, IETF draft IDs, W3C spec versions that DON'T resolve when looked up`,
    `    on rfc-editor.org / ietf.org / w3.org.`,
    `  - Specific percentage statistics with no source or with a source that doesn't`,
    `    contain the number.`,
    `  - URLs that 404 or point to unrelated pages.`,
    `  - Spec/release version numbers contradicted by the primary source page.`,
    ``,
    `Respond with ONLY a JSON object matching this schema:`,
    `{`,
    `  "references_verified": "<one-paragraph assessment of overall source quality>",`,
    `  "contested_claims": [`,
    `    {`,
    `      "id": "<footnote number from the draft, e.g. '2', '13', or 'unsourced-1' for`,
    `             claims with no footnote>",`,
    `      "claim": "<short description of the claim in your own words>",`,
    `      "reason": "<why this is contested — vendor blog, hallucinated spec, etc.>",`,
    `      "severity": "low" | "medium" | "high"`,
    `    }`,
    `  ],`,
    `  "hallucination_risk": "low" | "medium" | "high",`,
    `  "recommendation": "merge" | "revise" | "reject",`,
    `  "notes": "<one-paragraph operator-facing summary; what to do next>"`,
    `}`,
    ``,
    `No prose outside the JSON. Severity rubric: high = hallucinated spec/standard or`,
    `load-bearing claim with no source, medium = unverified statistic from weak source,`,
    `low = minor wording / weak-but-not-load-bearing source.`,
  ].join("\n");

  const user = [
    `# Draft to verify`,
    ``,
    "```markdown",
    draft,
    "```",
    ``,
    `# Sources file`,
    ``,
    "```json",
    sources,
    "```",
    ``,
    `Verify the draft. Output the JSON verdict only.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseVerifyVerdict(content: string): VerifyVerdict {
  const trimmed = stripJsonFence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      references_verified: "",
      contested_claims: [],
      hallucination_risk: "high",
      recommendation: "revise",
      notes: `Verifier returned non-JSON response. Raw: ${trimmed.slice(0, 500)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new McpError("E_INTERNAL", "verify response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const recommendation = isOneOf(obj["recommendation"], ["merge", "revise", "reject"])
    ? (obj["recommendation"] as VerifyVerdict["recommendation"])
    : "revise";
  const risk = isOneOf(obj["hallucination_risk"], ["low", "medium", "high"])
    ? (obj["hallucination_risk"] as VerifyVerdict["hallucination_risk"])
    : "high";

  const claimsRaw = Array.isArray(obj["contested_claims"]) ? obj["contested_claims"] : [];
  const claims: ContestedClaim[] = [];
  for (const c of claimsRaw) {
    if (typeof c !== "object" || c === null) continue;
    const co = c as Record<string, unknown>;
    const id = typeof co["id"] === "string" ? co["id"] : `unsourced-${claims.length + 1}`;
    const claim = typeof co["claim"] === "string" ? co["claim"] : "";
    const reason = typeof co["reason"] === "string" ? co["reason"] : "";
    const severity = isOneOf(co["severity"], ["low", "medium", "high"])
      ? (co["severity"] as ContestedClaim["severity"])
      : "medium";
    if (!claim) continue;
    claims.push({ id, claim, reason, severity });
  }

  return {
    references_verified:
      typeof obj["references_verified"] === "string" ? obj["references_verified"] : "",
    contested_claims: claims,
    hallucination_risk: risk,
    recommendation,
    notes: typeof obj["notes"] === "string" ? obj["notes"] : "",
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

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { ResearchVerifyInput };
