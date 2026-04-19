// Plan/confirm helper for destructive tools.
//
// A destructive tool (ship_release, file_delete, repo_force_push) returns a
// *plan* on first call, including a `confirm_token` that the client must
// echo back on the second call to actually execute. The token is an HMAC
// over the canonical input + issue timestamp + nonce; it has a 60-second
// TTL and is single-use.
//
// The HMAC key is derived from config (a user-supplied `confirm_secret`)
// or — for MVP — a per-process random key stored in memory. Rotating the
// key invalidates outstanding tokens, which is the intended property.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { McpError } from "../errors.js";

const DEFAULT_TTL_MS = 60_000;

function canonical(input: unknown): string {
  if (input === null || input === undefined) return "null";
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return "[" + input.map(canonical).join(",") + "]";
  if (typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonical((input as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return "null";
}

export interface ConfirmTokenStore {
  issue(input: unknown): string;
  consume(token: string, input: unknown): void; // throws E_CONFIRM_REQUIRED on failure
}

export function createConfirmTokenStore(opts: { ttlMs?: number } = {}): ConfirmTokenStore {
  const key = randomBytes(32);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  // Seen nonces — single-use enforcement.
  const used = new Set<string>();

  function sign(payload: string): string {
    return createHmac("sha256", key).update(payload).digest("hex");
  }

  return {
    issue(input: unknown): string {
      const ts = Date.now();
      const nonce = randomBytes(16).toString("hex");
      const body = `${ts}.${nonce}.${canonical(input)}`;
      const sig = sign(body);
      return `${ts}.${nonce}.${sig}`;
    },
    consume(token: string, input: unknown): void {
      const parts = token.split(".");
      if (parts.length !== 3) throw new McpError("E_CONFIRM_REQUIRED", "malformed confirm_token");
      const [tsStr, nonce, sig] = parts as [string, string, string];
      const ts = Number.parseInt(tsStr, 10);
      if (!Number.isFinite(ts)) throw new McpError("E_CONFIRM_REQUIRED", "malformed confirm_token");
      if (Date.now() - ts > ttl) throw new McpError("E_CONFIRM_REQUIRED", "confirm_token expired");
      if (used.has(nonce)) throw new McpError("E_CONFIRM_REQUIRED", "confirm_token already used");
      const expected = sign(`${tsStr}.${nonce}.${canonical(input)}`);
      const aBuf = Buffer.from(expected, "hex");
      const bBuf = Buffer.from(sig, "hex");
      if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
        throw new McpError("E_CONFIRM_REQUIRED", "confirm_token signature mismatch");
      }
      used.add(nonce);
    },
  };
}
