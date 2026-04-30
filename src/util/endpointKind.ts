// Endpoint-kind narrowing helpers.
//
// `EndpointSchema` makes `base_url` optional because CLI-kind endpoints don't
// have one. Every call site that builds a `ChatCompletionRequest` only ever
// runs against API-kind endpoints, but the type system can't see that without
// a narrowing helper. `assertApiEndpoint` is the contract: throw at the API
// call boundary if a CLI endpoint slipped through, and hand back a type whose
// base_url is guaranteed non-undefined.
//
// CLI endpoints never reach `chatCompletion()` — they're dispatched through
// the CLI adapter layer (src/util/cliAdapters/*). The dispatcher branches on
// `endpoint.kind`; this helper just enforces the API-side contract.

import { McpError } from "../errors.js";
import type { Endpoint } from "../config/schema.js";

export type ApiEndpoint = Endpoint & { kind: "api"; base_url: string };

/**
 * Narrow an Endpoint to the API-kind shape (with `base_url` guaranteed).
 * Throws E_VALIDATION if the endpoint is CLI-kind, since CLI endpoints must
 * be dispatched through the CLI adapter, not the HTTP chat-completion path.
 */
export function assertApiEndpoint(ep: Endpoint): ApiEndpoint {
  if (ep.kind !== "api") {
    throw new McpError(
      "E_VALIDATION",
      `endpoint '${ep.name}' has kind='${ep.kind}'; this call site requires kind='api'`,
    );
  }
  if (!ep.base_url) {
    // Defense in depth — superRefine in schema.ts blocks this at config load,
    // but if someone mutates a config object in tests, surface the fault.
    throw new McpError(
      "E_VALIDATION",
      `API endpoint '${ep.name}' has no base_url (config validation should have caught this)`,
    );
  }
  return ep as ApiEndpoint;
}
