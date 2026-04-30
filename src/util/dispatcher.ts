// Kind-aware chat-completion dispatcher.
//
// Single entry point for the new pipelines (research, KB-review, gate-review).
// Branches on `endpoint.kind`:
//   - kind=api → util/llmClient.callChatCompletion (HTTP)
//   - kind=cli → util/cliAdapters/selectCliAdapter (subprocess)
//
// Returns a unified shape regardless of route. Tokens are null for CLI
// because subscription/login quota is opaque (audit logs surface this
// honestly per Workstream A11).
//
// Existing callers (review_execute, research_verify, lifecycle_report,
// charter_check, test_stress, spec_suggest_primers, embed) continue using
// `callChatCompletion` directly with `assertApiEndpoint` — no migration
// required. The dispatcher is for new pipelines that intentionally route
// through both paths.

import type { Endpoint, ModelAlias } from "../config/schema.js";
import { McpError } from "../errors.js";
import { callChatCompletion, LlmError, type ChatMessage } from "./llmClient.js";
import { selectCliAdapter, CliError } from "./cliAdapters/index.js";

export interface DispatchRequest {
  /** The endpoint to call. Dispatcher reads `kind` and routes accordingly. */
  endpoint: Endpoint;
  /** Provider model id (model_aliases[].model_id, NOT the alias name). */
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  /** API-only: request JSON-mode hint (CLI ignores). */
  jsonResponse?: boolean;
  /** API-only: env-resolved API key (resolved at call time, never persisted). */
  apiKey?: string | undefined;
  /** API-only: provider_options merged into request body (e.g. Ollama num_ctx). */
  providerOptions?: Record<string, unknown> | undefined;
  /** Test injection — only honored for kind=api. */
  fetchImpl?: typeof fetch;
}

export interface DispatchResult {
  content: string;
  /**
   * Total tokens used by the call when known. Always null for CLI routes
   * (subscription/login quota is invisible to the caller).
   */
  tokens: number | null;
  /** Which route handled the call — useful for audit + debug surfaces. */
  route: "api" | "cli";
  /** CLI adapter name when route="cli"; undefined for api. */
  adapter?: string;
}

/**
 * Single-shot dispatch. Throws McpError on:
 *   - E_VALIDATION when endpoint.kind is set but its required fields are missing
 *   - E_ENDPOINT_UNREACHABLE on api transport / cli spawn failures
 *   - E_CANCELED on signal abort
 *   - E_INTERNAL on parse / unknown failures
 */
export async function dispatchChatCompletion(req: DispatchRequest): Promise<DispatchResult> {
  if (!req.endpoint.enabled) {
    throw new McpError("E_ENDPOINT_DISABLED", `endpoint '${req.endpoint.name}' is disabled`);
  }

  if (req.endpoint.kind === "api") {
    if (!req.endpoint.base_url) {
      throw new McpError("E_VALIDATION", `api endpoint '${req.endpoint.name}' is missing base_url`);
    }
    try {
      const apiReq = {
        baseUrl: req.endpoint.base_url,
        apiKey: req.apiKey,
        model: req.modelId,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(req.jsonResponse !== undefined ? { jsonResponse: req.jsonResponse } : {}),
        ...(req.providerOptions !== undefined ? { providerOptions: req.providerOptions } : {}),
        ...(req.fetchImpl !== undefined ? { fetchImpl: req.fetchImpl } : {}),
      };
      const content = await callChatCompletion(apiReq);
      // Token usage isn't returned by the current llmClient surface
      // (callChatCompletion returns just content). Future work: thread
      // `usage.total_tokens` through. For now report null and let A11
      // (audit tokens=null for cli) cover the parity.
      return { content, tokens: null, route: "api" };
    } catch (e) {
      if (e instanceof LlmError) {
        if (e.kind === "canceled") throw new McpError("E_CANCELED", e.message);
        if (e.kind === "unreachable") throw new McpError("E_ENDPOINT_UNREACHABLE", e.message);
        throw new McpError(
          "E_INTERNAL",
          `endpoint '${req.endpoint.name}' returned ${e.kind}: ${e.message}`,
        );
      }
      throw e;
    }
  }

  if (req.endpoint.kind === "cli") {
    if (!req.endpoint.cmd) {
      throw new McpError("E_VALIDATION", `cli endpoint '${req.endpoint.name}' is missing cmd`);
    }
    const adapter = selectCliAdapter(req.endpoint.cmd);
    try {
      const result = await adapter.chatComplete({
        messages: req.messages,
        model: req.modelId,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        cmd: req.endpoint.cmd,
        staticArgs: req.endpoint.args ?? [],
        workdirMode: req.endpoint.workdir_mode,
      });
      const out: DispatchResult = {
        content: result.content,
        tokens: null,
        route: "cli",
        adapter: result.adapter,
      };
      return out;
    } catch (e) {
      if (e instanceof CliError) {
        if (e.kind === "canceled") throw new McpError("E_CANCELED", e.message);
        if (e.kind === "spawn-failed") {
          throw new McpError(
            "E_CLI_NOT_FOUND",
            `cli '${req.endpoint.cmd}' could not start: ${e.message}`,
          );
        }
        if (e.kind === "not-implemented") {
          throw new McpError("E_INTERNAL", e.message);
        }
        // exit-nonzero / parse-failed → bubble as endpoint-unreachable so
        // the caller's retry/backup logic kicks in the same as for HTTP.
        throw new McpError("E_ENDPOINT_UNREACHABLE", `cli '${req.endpoint.cmd}': ${e.message}`);
      }
      throw e;
    }
  }

  // Exhaustiveness guard — kind is "api" | "cli", so this is unreachable
  // unless the schema gains a third kind without updating the dispatcher.
  const exhaustive: never = req.endpoint.kind;
  throw new McpError("E_INTERNAL", `unknown endpoint kind: ${String(exhaustive)}`);
}

/**
 * Resolve the route a given endpoint will take, without making the call.
 * Useful for audit logging + surfaces that want to render the route in
 * advance (`vcf health`, `model_list`).
 */
export function endpointRoute(endpoint: Pick<Endpoint, "kind">): "api" | "cli" {
  return endpoint.kind;
}

/** Re-export the model + endpoint typedef for callers building DispatchRequests. */
export type { Endpoint, ModelAlias };
