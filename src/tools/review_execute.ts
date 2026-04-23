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
//
// Layering (followup #45):
//   - src/review/prompt.ts           — composeMessages, parseSubmission
//   - src/review/endpointResolve.ts  — endpoint + model + trust gate
//   - this file                      — orchestration: resolve → compose →
//                                      LLM call → parse → persist → audit

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { callChatCompletion, LlmError, type ChatMessage } from "../util/llmClient.js";
import { persistReviewSubmission, type ReviewRunRow } from "../review/submitCore.js";
import { resolveOutputs } from "../util/outputs.js";
import { readOverlayBundle, type ReviewType } from "../review/overlays.js";
import { projectRunsDir } from "../project/stateDir.js";
import { composeMessages, parseSubmission } from "../review/prompt.js";
import { resolveReviewEndpoint } from "../review/endpointResolve.js";

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

          const resolvedEp = resolveReviewEndpoint({
            config: deps.config,
            parsed,
            reviewType: run.type,
          });
          const { endpoint, modelId, apiKey } = resolvedEp;

          // Compose the prompt from the run workspace (written by review_prepare).
          const slug = deps.resolved.projectSlug;
          if (!slug) {
            throw new McpError(
              "E_STATE_INVALID",
              "review_execute requires a resolved project slug (project scope)",
            );
          }
          const runDir = join(projectRunsDir(slug, deps.homeDir), run.id);
          if (!existsSync(runDir)) {
            throw new McpError(
              "E_STATE_INVALID",
              `run directory ${runDir} missing — call review_prepare first`,
            );
          }

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

          const outputs = resolveOutputs(root, deps.config);
          const { reportPath, merged } = await persistReviewSubmission({
            projectDb: deps.projectDb,
            allowedRoots: deps.config.workspace.allowed_roots,
            reviewsDir: outputs.reviewsDir,
            runDir,
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

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
