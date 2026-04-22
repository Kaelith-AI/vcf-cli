// review_execute — project scope.
//
// Run a server-side review pass by calling a configured endpoint with the
// disposable workspace contents, parsing a structured verdict out of the
// response, and persisting it via the same path `review_submit` uses.
//
// This is the "local-LLM review backend" path (spec § 5 / Phase-2 backlog).
// The endpoint is any OpenAI-compatible HTTP surface — Ollama's /v1,
// OpenRouter, OpenAI itself, a CLIProxyAPI gateway, a LiteLLM proxy, etc.
// The server never knows about native Anthropic / Gemini / OAuth flows in
// this tool; those live in future adapters or client-side skills.
//
// Non-negotiables wired in:
//   - API keys resolve from env at call time (config has the env-var *name*)
//   - Redaction runs on outgoing messages — always, not just public endpoints
//   - Audit row records run_id / endpoint / model / outcome but never the
//     prompt, the response body, or the API key
//   - Cancellation via the MCP SDK signal propagates to the HTTP call
//   - Trust-level gate: review_execute refuses endpoints with
//     trust_level='public' by default (opt-in via `allow_public_endpoint`)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { callChatCompletion, LlmError, type ChatMessage } from "../util/llmClient.js";
import {
  persistReviewSubmission,
  VERDICTS,
  type Finding,
  type ReviewRunRow,
  type Submission,
  type Severity,
} from "../review/submitCore.js";
import { CARRY_FORWARD_SECTIONS, type CarryForwardSection } from "../review/carryForward.js";
import { readOverlayBundle, type OverlayBundle, type ReviewType } from "../review/overlays.js";

const ReviewExecuteInput = z
  .object({
    run_id: z.string().min(3).max(128),
    endpoint: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe("endpoint name; falls back to config.defaults.review.endpoint when omitted"),
    model_id: z.string().min(1).max(128).optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(180_000),
    allow_public_endpoint: z
      .boolean()
      .default(false)
      .describe("opt in to review_execute against trust_level='public' endpoints"),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerReviewExecute(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_execute",
    {
      title: "Execute Review via Endpoint",
      description:
        "Run a server-side review pass for an existing run_id by calling a configured OpenAI-compatible endpoint (Ollama, OpenRouter, CLIProxyAPI, OpenAI, LiteLLM, …). Parses a structured verdict + findings + carry-forward from the response and persists the same way review_submit does.",
      inputSchema: ReviewExecuteInput.shape,
    },
    async (
      args: z.infer<typeof ReviewExecuteInput>,
      extra: { signal?: AbortSignal } | undefined,
    ) => {
      // Captured during body; onComplete reads these so the audit never
      // contains the full LLM prompt or response body.
      let auditInputs: unknown = args;
      let auditOutputs: unknown = undefined;
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "review_execute requires project scope");
          }
          const parsed = ReviewExecuteInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const run = deps.projectDb
            .prepare(
              `SELECT id, type, stage, status, carry_forward_json FROM review_runs WHERE id = ?`,
            )
            .get(parsed.run_id) as ReviewRunRow | undefined;
          if (!run) {
            throw new McpError("E_NOT_FOUND", `review run "${parsed.run_id}" does not exist`);
          }

          // Endpoint resolution: explicit arg → config.defaults.review.endpoint.
          const endpointFromDefaults = parsed.endpoint === undefined;
          const endpointName = parsed.endpoint ?? deps.config.defaults?.review?.endpoint;
          if (!endpointName) {
            throw new McpError(
              "E_VALIDATION",
              "endpoint not provided and config.defaults.review.endpoint is unset",
            );
          }
          const endpoint = deps.config.endpoints.find((e) => e.name === endpointName);
          if (!endpoint) {
            throw new McpError(
              "E_VALIDATION",
              `endpoint '${endpointName}' not in config.endpoints[]`,
            );
          }
          // Public endpoints always gate. Silent-default routing to any
          // non-local endpoint (including trust_level='trusted') also gates:
          // the typical abuse path is config drift on defaults.review.endpoint
          // that quietly sends review bundles off-host. Explicitly passing the
          // endpoint is the consent signal that bypasses the defaults gate
          // (public still gates regardless — trust_level='public' is the hard
          // ceiling).
          if (endpoint.trust_level === "public" && !parsed.allow_public_endpoint) {
            throw new McpError(
              "E_STATE_INVALID",
              `endpoint '${endpoint.name}' has trust_level='public'; pass allow_public_endpoint=true to override`,
            );
          }
          if (
            endpointFromDefaults &&
            endpoint.trust_level !== "local" &&
            !parsed.allow_public_endpoint
          ) {
            throw new McpError(
              "E_STATE_INVALID",
              `endpoint '${endpoint.name}' resolved from config.defaults.review.endpoint has ` +
                `trust_level='${endpoint.trust_level}'; either pass endpoint explicitly to ` +
                `acknowledge the off-host route or set allow_public_endpoint=true`,
            );
          }

          // Resolve API key at call time from env (config has the *name*).
          let apiKey: string | undefined;
          if (endpoint.auth_env_var) {
            apiKey = process.env[endpoint.auth_env_var];
            if (!apiKey && endpoint.trust_level !== "local") {
              throw new McpError(
                "E_CONFIG_MISSING_ENV",
                `env var ${endpoint.auth_env_var} is unset; endpoint '${endpoint.name}' needs it`,
              );
            }
          }

          // Compose the prompt from the run workspace (written by review_prepare).
          const runDir = join(root, ".review-runs", run.id);
          if (!existsSync(runDir)) {
            throw new McpError(
              "E_STATE_INVALID",
              `run directory ${runDir} missing — call review_prepare first`,
            );
          }
          const modelId =
            parsed.model_id ?? deps.config.defaults?.review?.model ?? pickModelId(deps, run.type);

          // Per-model overlay resolution (#32). Load the base reviewer role
          // and the most specific overlay available (family > trust-level >
          // base). The overlay is appended to the system prompt so its
          // calibration corrections are the last thing the model sees.
          //
          // Resolve against the prepared run-dir snapshot — NOT the live KB.
          // review_prepare copies every `reviewer-<type>*.md` variant into
          // the run dir so the overlay chosen here reflects the KB state AT
          // PREPARE TIME, not whatever it's been edited to since. Keeps the
          // prepare→execute contract honest: same run_id, same prompt,
          // regardless of KB edits between the two calls.
          const overlay = await readOverlayBundle({
            kbRoot: deps.config.kb.root,
            reviewersDir: runDir,
            reviewType: run.type as ReviewType,
            modelId,
            trustLevel: endpoint.trust_level,
          });

          const messages = await composeMessages(runDir, run, overlay);
          // Always redact outgoing content — secrets should not leave the box
          // even to a local endpoint the operator might later aim elsewhere.
          const redactedMessages = redact(messages) as ChatMessage[];

          // Cancellation: honor the MCP-provided signal + local timeout.
          const ctrl = new AbortController();
          const mcpSignal = extra?.signal;
          const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);
          const onAbort = (): void => ctrl.abort();
          mcpSignal?.addEventListener("abort", onAbort);
          // Per-endpoint provider_options (config.yaml's endpoint block).
          // Set to e.g. {num_ctx: 131072, num_predict: 8192} for Ollama
          // endpoints so prompts aren't silently truncated at 2048 tokens
          // (followup #34). Skipped when unset, so non-Ollama endpoints
          // (OpenAI, OpenRouter, CLIProxyAPI) don't receive a body key they
          // neither need nor validate — closes the security/stage-7 finding
          // from the 2026-04-21 dogfood review.
          const providerOptions = endpoint.provider_options as Record<string, unknown> | undefined;
          let content: string;
          try {
            content = await callChatCompletion({
              baseUrl: endpoint.base_url,
              apiKey,
              model: modelId,
              messages: redactedMessages,
              temperature: 0.1,
              jsonResponse: true,
              ...(providerOptions ? { providerOptions } : {}),
              signal: ctrl.signal,
            });
          } catch (e) {
            if (e instanceof LlmError) {
              if (e.kind === "canceled") {
                throw new McpError("E_CANCELED", e.message);
              }
              if (e.kind === "unreachable") {
                throw new McpError("E_ENDPOINT_UNREACHABLE", e.message);
              }
              throw new McpError(
                "E_INTERNAL",
                `endpoint '${endpoint.name}' returned an error response`,
                e.message,
              );
            }
            throw e;
          } finally {
            clearTimeout(timer);
            mcpSignal?.removeEventListener("abort", onAbort);
          }

          // Parse structured verdict from the response.
          const submission = parseSubmission(content);

          const { reportPath, merged } = await persistReviewSubmission({
            projectDb: deps.projectDb,
            allowedRoots: deps.config.workspace.allowed_roots,
            projectRoot: root,
            run,
            submission,
          });

          // Audit shape: deliberately omit message content + response body.
          auditInputs = {
            run_id: parsed.run_id,
            endpoint: endpoint.name,
            model_id: modelId,
            timeout_ms: parsed.timeout_ms,
          };
          auditOutputs = {
            ok: true,
            verdict: submission.verdict,
            finding_count: submission.findings.length,
            report_path: reportPath,
          };

          return success(
            [reportPath],
            `review_execute: ${run.type} stage ${run.stage} verdict=${submission.verdict} (endpoint=${endpoint.name}, model=${modelId}, overlay=${overlay.overlayMatch}).`,
            parsed.expand
              ? {
                  content: {
                    run_id: run.id,
                    report_path: reportPath,
                    verdict: submission.verdict,
                    endpoint: endpoint.name,
                    model_id: modelId,
                    overlay: {
                      match: overlay.overlayMatch,
                      family: overlay.family,
                      path: overlay.overlayPath,
                    },
                    carry_forward: merged,
                  },
                }
              : { expand_hint: "Call review_execute with expand=true for the content payload." },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "review_execute",
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function composeMessages(
  runDir: string,
  run: ReviewRunRow,
  overlay?: OverlayBundle,
): Promise<ChatMessage[]> {
  const stageText = await readIf(join(runDir, `stage-${run.stage}.${run.type}.md`));
  // The run dir's copy of reviewer-<type>.md is the prepare-time snapshot;
  // the resolved overlay from the KB is authoritative when the caller
  // passes one. Prefer the KB-resolved base so Phase-2 overlays land even
  // on pre-existing run directories prepared before the resolver shipped.
  const reviewerText = overlay?.base ?? (await readIf(join(runDir, `reviewer-${run.type}.md`)));
  const carryForwardText = await readIf(join(runDir, "carry-forward.yaml"));
  const decisionsText = await readIf(join(runDir, "decisions.snapshot.md"));
  const responseLogText = await readIf(join(runDir, "response-log.snapshot.md"));
  const diffText = await readIf(join(runDir, "scoped-diff.patch"));

  const systemParts: string[] = [];
  if (reviewerText) systemParts.push(reviewerText);
  if (overlay?.overlay) {
    systemParts.push(
      `## Model-family calibration overlay (${overlay.overlayMatch}, family=${overlay.family ?? "unknown"})\n\n${overlay.overlay}`,
    );
  }
  systemParts.push(
    [
      "",
      "## Required response format",
      "",
      "Respond with a **single JSON object** (no prose, no markdown fences).",
      "Shape:",
      "```",
      "{",
      '  "verdict": "PASS" | "NEEDS_WORK" | "BLOCK",',
      '  "summary": "<4-4000 chars>",',
      '  "findings": [',
      '    { "file": "path/to/file", "line": 42, "severity": "info"|"warning"|"blocker",',
      '      "description": "<4-4000 chars>", "required_change": "<optional, <=4000 chars>" }',
      "  ],",
      '  "carry_forward": [',
      '    { "section": "architecture"|"verification"|"security"|"compliance"|"supportability"|"release_confidence",',
      '      "severity": "info"|"warning"|"blocker", "text": "<4-2000 chars>" }',
      "  ]",
      "}",
      "```",
      "Obey every hard rule in this overlay. Cite file:line in every finding. On architectural compromise, return BLOCK rather than line-picking.",
    ].join("\n"),
  );
  const system = systemParts.join("\n\n").trim();

  const userParts: string[] = [];
  if (stageText) userParts.push("# Stage definition\n\n" + stageText);
  if (carryForwardText)
    userParts.push("# Inherited carry-forward\n\n```yaml\n" + carryForwardText.trim() + "\n```");
  if (diffText && !diffText.startsWith("(empty diff)"))
    userParts.push("# Scoped diff\n\n```diff\n" + diffText + "\n```");
  if (decisionsText) userParts.push("# Decision log snapshot\n\n" + decisionsText);
  if (responseLogText) userParts.push("# Response log snapshot\n\n" + responseLogText);
  const user = userParts.join("\n\n---\n\n").trim();

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function readIf(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function pickModelId(deps: ServerDeps, reviewType: string): string {
  // Prefer a model_alias whose prefer_for includes `reviewer-<type>`.
  const preferred = `reviewer-${reviewType}`;
  for (const alias of deps.config.model_aliases) {
    if (alias.prefer_for.includes(preferred)) return alias.model_id;
  }
  for (const alias of deps.config.model_aliases) {
    if (alias.prefer_for.includes("reviewer")) return alias.model_id;
  }
  // Fallback: first alias, else a sensible OpenAI-compatible default.
  const first = deps.config.model_aliases[0];
  return first?.model_id ?? "gpt-4o-mini";
}

function parseSubmission(raw: string): Submission {
  const body = extractJsonObject(raw);
  if (body === null) {
    throw new McpError("E_VALIDATION", "endpoint response did not contain a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new McpError("E_VALIDATION", "endpoint response JSON parse failed");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new McpError("E_VALIDATION", "endpoint response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw new McpError("E_VALIDATION", `verdict must be one of ${VERDICTS.join("|")}`);
  }
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  if (summary.length < 4 || summary.length > 4_000) {
    throw new McpError("E_VALIDATION", "summary must be 4-4000 chars");
  }

  const findings: Finding[] = [];
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of rawFindings) {
    if (typeof f !== "object" || f === null) continue;
    const fr = f as Record<string, unknown>;
    const sev = fr.severity;
    if (sev !== "info" && sev !== "warning" && sev !== "blocker") continue;
    const desc = typeof fr.description === "string" ? fr.description : "";
    if (desc.length < 4 || desc.length > 4_000) continue;
    const finding: Finding = {
      severity: sev as Severity,
      description: desc,
    };
    if (typeof fr.file === "string") finding.file = fr.file.slice(0, 512);
    if (typeof fr.line === "number" && fr.line >= 0) finding.line = Math.floor(fr.line);
    if (typeof fr.required_change === "string" && fr.required_change.length <= 4_000)
      finding.required_change = fr.required_change;
    findings.push(finding);
    if (findings.length >= 200) break;
  }

  const carry: Submission["carry_forward"] = [];
  const rawCarry = Array.isArray(obj.carry_forward) ? obj.carry_forward : [];
  for (const c of rawCarry) {
    if (typeof c !== "object" || c === null) continue;
    const cr = c as Record<string, unknown>;
    const section = cr.section;
    if (!(CARRY_FORWARD_SECTIONS as readonly string[]).includes(section as string)) continue;
    const sev = cr.severity;
    if (sev !== "info" && sev !== "warning" && sev !== "blocker") continue;
    const text = typeof cr.text === "string" ? cr.text : "";
    if (text.length < 4 || text.length > 2_000) continue;
    carry.push({ section: section as CarryForwardSection, severity: sev as Severity, text });
    if (carry.length >= 120) break;
  }

  return {
    verdict: verdict as Submission["verdict"],
    summary,
    findings,
    carry_forward: carry,
  };
}

/** Pulls a balanced JSON object out of arbitrary LLM output. */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return raw.slice(first, last + 1);
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
