// Followup #45 — endpoint + model + trust-level resolution for review_execute.
//
// The "which endpoint do we call, with which model, and is the operator
// authorized to route there?" layer. Separated from review_execute.ts so
// future consolidation with lifecycle_report / research_* (both of which
// route through equivalent gates) has a single contact surface.

import { McpError } from "../errors.js";
import type { Config } from "../config/schema.js";

type EndpointEntry = Config["endpoints"][number];

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
  endpoint: EndpointEntry;
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
export function resolveReviewEndpoint(
  input: ResolveReviewEndpointInput,
): ResolvedReviewEndpoint {
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
  const endpoint = config.endpoints.find((e) => e.name === endpointName);
  if (!endpoint) {
    throw new McpError(
      "E_VALIDATION",
      `endpoint '${endpointName}' not in config.endpoints[]`,
    );
  }

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
