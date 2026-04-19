// The canonical MCP tool output envelope.
//
// Success: { ok: true, paths, summary, expand_hint?, content? }
//   `content` is only included when the caller passed `expand=true` on the
//   tool input (schema enforces default false). This is the token-economy
//   contract: paths + summary by default, full content on demand.
//
// Failure: { ok: false, code, message, detail?, retryable }
//   Code is a stable string from ./errors.ts; message is human-readable;
//   detail is redacted and may be omitted; retryable tells the client
//   whether a re-call without user intervention might succeed.
//
// The SDK's wire format requires `content: [{ type: "text", text: ... }]`.
// Our structured payload is JSON-stringified into that single text element
// AND mirrored in `structuredContent` so clients that honor the 2025-11-25
// `outputSchema` feature get native typed access.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ERROR_CODES, type ErrorCode, isRetryable, toMcpError } from "./errors.js";

export interface SuccessPayload<TContent = unknown> {
  ok: true;
  paths: string[];
  summary: string;
  expand_hint?: string;
  content?: TContent;
}

export interface FailurePayload {
  ok: false;
  code: ErrorCode;
  message: string;
  detail?: unknown;
  retryable: boolean;
}

export type EnvelopePayload<TContent = unknown> = SuccessPayload<TContent> | FailurePayload;

/** Zod output schema mirroring the envelope. Used for every tool's `outputSchema`. */
export const EnvelopeOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      paths: z.array(z.string()),
      summary: z.string(),
      expand_hint: z.string().optional(),
      content: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]),
      message: z.string(),
      detail: z.unknown().optional(),
      retryable: z.boolean(),
    })
    .strict(),
]);

export interface SuccessOptions<TContent = unknown> {
  expand_hint?: string;
  content?: TContent;
}

/** Build a success envelope. */
export function success<TContent = unknown>(
  paths: string[],
  summary: string,
  opts: SuccessOptions<TContent> = {},
): SuccessPayload<TContent> {
  const out: SuccessPayload<TContent> = { ok: true, paths, summary };
  if (opts.expand_hint !== undefined) out.expand_hint = opts.expand_hint;
  if (opts.content !== undefined) out.content = opts.content;
  return out;
}

/** Build a failure envelope from an error code. */
export function failure(code: ErrorCode, message?: string, detail?: unknown): FailurePayload {
  const out: FailurePayload = {
    ok: false,
    code,
    message: message ?? ERROR_CODES[code].description,
    retryable: isRetryable(code),
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

/** Wrap a structured envelope payload into the SDK's CallToolResult wire shape. */
export function wrapResult<TContent = unknown>(payload: EnvelopePayload<TContent>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: payload.ok === false,
  };
}

/**
 * Convenience wrapper: run an async tool body, catch any error, translate it
 * into a failure envelope, and return the wrapped SDK result. Tool handlers
 * should use this instead of their own try/catch so the error-code surface
 * is uniform.
 */
export async function runTool<TContent = unknown>(
  body: () => Promise<EnvelopePayload<TContent>>,
): Promise<CallToolResult> {
  try {
    const payload = await body();
    return wrapResult(payload);
  } catch (err) {
    const mcp = toMcpError(err);
    return wrapResult(failure(mcp.code, mcp.message, mcp.detail));
  }
}
