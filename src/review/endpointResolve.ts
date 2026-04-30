// Followup #45 — endpoint + model + trust-level resolution for review_execute.
//
// The "which endpoint do we call, with which model, and is the operator
// authorized to route there?" layer. Separated from review_execute.ts so
// future consolidation with lifecycle_report / research_* (both of which
// route through equivalent gates) has a single contact surface.

import { McpError } from "../errors.js";
import type { Config } from "../config/schema.js";
import type { ChatCompletionRequest } from "../util/llmClient.js";
import { assertApiEndpoint, type ApiEndpoint } from "../util/endpointKind.js";

type EndpointEntry = Config["endpoints"][number];

/**
 * Resolve the API key for an LLM call. Resolution order:
 *   1. Per-feature override (`defaults.<tool>.key` or `.backup_key`) — env var name
 *   2. Endpoint-level default (`endpoints[].auth_env_var`) — env var name
 *
 * Both forms name an env var; values are read from `process.env`, which
 * vcf-mcp populates at boot from ~/.vcf/secrets.env (operator-controlled
 * dotenv file) and any explicit env vars in the parent shell.
 *
 * Returns undefined when neither source provides a key. Callers decide
 * whether that's an error (non-local endpoints) or fine (local Ollama
 * with no auth required). Trust-level enforcement lives in the caller
 * because the appropriate error code differs across resolve paths.
 */
export function resolveAuthKey(
  endpoint: EndpointEntry,
  perFeatureKeyName: string | undefined,
): {
  apiKey: string | undefined;
  envVarName: string | undefined;
  source: "feature" | "endpoint" | "none";
} {
  if (perFeatureKeyName) {
    return {
      apiKey: process.env[perFeatureKeyName],
      envVarName: perFeatureKeyName,
      source: "feature",
    };
  }
  if (endpoint.auth_env_var) {
    return {
      apiKey: process.env[endpoint.auth_env_var],
      envVarName: endpoint.auth_env_var,
      source: "endpoint",
    };
  }
  return { apiKey: undefined, envVarName: undefined, source: "none" };
}

export interface ResolveReviewEndpointInput {
  config: Config;
  /** Parsed args — endpoint, model_id, allow_public_endpoint. */
  parsed: {
    endpoint?: string | undefined;
    model_id?: string | undefined;
    allow_public_endpoint?: boolean | undefined;
  };
  /** The review's type (code | security | production | ...). Used for alias routing. */
  reviewType: string;
}

export interface ResolvedReviewEndpoint {
  /**
   * Resolved endpoint, narrowed to API-kind. CLI-kind endpoints are rejected
   * by `resolveReviewEndpoint` because review_execute drives the HTTP
   * chat-completion path, not the CLI-adapter path. CLI-driven review will
   * arrive in Workstream A8 (kind-aware dispatcher).
   */
  endpoint: ApiEndpoint;
  modelId: string;
  /** True when the endpoint was taken from config.defaults.review.endpoint, not the explicit arg. */
  endpointFromDefaults: boolean;
  /**
   * Resolved API key from env at call time. Undefined only when the
   * endpoint is trust_level='local' and has no auth_env_var configured.
   * Non-local endpoints with a missing env var throw before this struct
   * is constructed.
   */
  apiKey?: string;
}

/**
 * Resolve an endpoint + model for a review_execute call and enforce the
 * trust-level gates:
 *   - trust_level='public' — always gated; requires allow_public_endpoint=true
 *   - defaults-routing to non-local — gated; either pass endpoint explicitly
 *     (explicit consent) or pass allow_public_endpoint=true
 *   - non-local endpoints require auth_env_var → env resolution
 *
 * Throws McpError on any validation failure. Never logs or surfaces the
 * resolved API key.
 */
export function resolveReviewEndpoint(input: ResolveReviewEndpointInput): ResolvedReviewEndpoint {
  const { config, parsed, reviewType } = input;

  // Endpoint resolution: explicit arg → config.defaults.review.endpoint.
  const endpointFromDefaults = parsed.endpoint === undefined;
  const endpointName = parsed.endpoint ?? config.defaults?.review?.endpoint;
  if (!endpointName) {
    throw new McpError(
      "E_VALIDATION",
      "endpoint not provided and config.defaults.review.endpoint is unset",
    );
  }
  const endpointRaw = config.endpoints.find((e) => e.name === endpointName);
  if (!endpointRaw) {
    throw new McpError("E_VALIDATION", `endpoint '${endpointName}' not in config.endpoints[]`);
  }
  if (!endpointRaw.enabled) {
    throw new McpError(
      "E_ENDPOINT_DISABLED",
      `endpoint '${endpointRaw.name}' is disabled (set enabled=true in config.endpoints)`,
    );
  }
  // review_execute uses the HTTP chat-completion path; CLI endpoints route
  // through the dispatcher (Workstream A8). Reject loudly here so the error
  // surfaces at endpoint-resolution time, not deep inside the LLM client.
  const endpoint = assertApiEndpoint(endpointRaw);

  // Public endpoints always gate. Silent-default routing to any non-local
  // endpoint (including trust_level='trusted') also gates: the typical
  // abuse path is config drift on defaults.review.endpoint that quietly
  // sends review bundles off-host. Explicitly passing the endpoint is the
  // consent signal that bypasses the defaults gate (public still gates
  // regardless — trust_level='public' is the hard ceiling).
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
      `endpoint '${endpoint.name}' resolved from config.defaults.review.endpoint has ` +
        `trust_level='${endpoint.trust_level}'; either pass endpoint explicitly to ` +
        `acknowledge the off-host route or set allow_public_endpoint=true`,
    );
  }

  // Resolve API key: per-feature `defaults.review.key` first, endpoint's
  // `auth_env_var` as fallback. Both name an env var; values come from
  // process.env (typically populated at boot from ~/.vcf/secrets.env).
  const { apiKey, envVarName, source } = resolveAuthKey(endpoint, config.defaults?.review?.key);
  if (!apiKey && envVarName && endpoint.trust_level !== "local") {
    throw new McpError(
      "E_CONFIG_MISSING_ENV",
      `env var ${envVarName} is unset (referenced via ${source === "feature" ? "defaults.review.key" : `endpoints[${endpoint.name}].auth_env_var`}); endpoint '${endpoint.name}' needs it`,
    );
  }

  const modelId =
    parsed.model_id ?? config.defaults?.review?.model ?? pickModelId(config, reviewType);

  const resolved: ResolvedReviewEndpoint = {
    endpoint,
    modelId,
    endpointFromDefaults,
  };
  if (apiKey !== undefined) resolved.apiKey = apiKey;
  return resolved;
}

/**
 * Build a backup ChatCompletionRequest from config.defaults.<tool>.backup_endpoint
 * and backup_model. Returns undefined when no backup is configured or the
 * backup_endpoint name doesn't resolve (misconfigured — superRefine catches
 * this at config load, so missing here means stale in-memory config).
 *
 * All fields are inherited from `primaryReq` except baseUrl, apiKey, model,
 * and providerOptions, which come from the backup endpoint's config. This
 * means messages, temperature, jsonResponse, and signal carry through
 * unchanged — only the routing changes.
 */
export function buildBackupRequest(
  config: Config,
  toolKey: keyof NonNullable<Config["defaults"]>,
  primaryReq: ChatCompletionRequest,
): ChatCompletionRequest | undefined {
  const entry = config.defaults?.[toolKey];
  if (!entry?.backup_endpoint) return undefined;
  const bEpRaw = config.endpoints.find((e) => e.name === entry.backup_endpoint);
  if (!bEpRaw) return undefined;
  // CLI-kind backup endpoints aren't valid for the HTTP chat-completion
  // path. Treat them as "no usable backup" rather than throwing — this
  // keeps the legacy review-execute fallback chain forgiving.
  if (bEpRaw.kind !== "api") return undefined;
  const bEp = assertApiEndpoint(bEpRaw);
  // Backup auth: per-feature `defaults.<tool>.backup_key` first, backup
  // endpoint's `auth_env_var` as fallback. Same resolution as primary so
  // operators can configure auth at either level consistently.
  const { apiKey } = resolveAuthKey(bEp, entry.backup_key);
  const providerOptions = bEp.provider_options as Record<string, unknown> | undefined;
  const req: ChatCompletionRequest = {
    ...primaryReq,
    baseUrl: bEp.base_url,
    apiKey,
    model: entry.backup_model ?? primaryReq.model,
  };
  if (providerOptions) {
    req.providerOptions = providerOptions;
  } else {
    delete req.providerOptions;
  }
  return req;
}

/**
 * Legacy model-alias routing: prefer an alias whose `prefer_for` includes
 * `reviewer-<type>`, then any alias with `reviewer`, then the first alias,
 * finally a sensible OpenAI-compatible default name.
 */
export function pickModelId(config: Config, reviewType: string): string {
  const preferred = `reviewer-${reviewType}`;
  for (const alias of config.model_aliases) {
    if (alias.prefer_for.includes(preferred)) return alias.model_id;
  }
  for (const alias of config.model_aliases) {
    if (alias.prefer_for.includes("reviewer")) return alias.model_id;
  }
  const first = config.model_aliases[0];
  return first?.model_id ?? "gpt-4o-mini";
}
