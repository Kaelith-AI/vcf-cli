// Stable error-code table + typed McpError.
//
// Every tool that returns `ok: false` uses a code from here. Clients branch
// on `code`, never on `message`. The `retryable` hint tells the client
// whether a re-call without user intervention has any chance of succeeding.
//
// Adding a code is a minor-version bump. Changing the *semantics* of an
// existing code is a major bump.

export const ERROR_CODES = {
  E_SCOPE_DENIED: { retryable: false, description: "path or action outside the configured scope" },
  E_SCOPE_EMPTY: { retryable: false, description: "no allowed_roots configured" },
  E_SCOPE_CONFIG: { retryable: false, description: "allowed_roots entries must be absolute" },
  E_CONFIG_MISSING_ENV: { retryable: false, description: "required env var was not set" },
  E_CONFIG_READ: { retryable: true, description: "could not read config file" },
  E_CONFIG_PARSE: { retryable: false, description: "config.yaml is not valid YAML" },
  E_CONFIG_VALIDATION: { retryable: false, description: "config.yaml failed schema validation" },
  E_PATH_NOT_ABSOLUTE: { retryable: false, description: "path must be absolute" },
  E_PATH_INVALID: { retryable: false, description: "path argument is not a valid string" },
  E_PATH_ENCODED_ESCAPE: { retryable: false, description: "url-encoded traversal rejected" },
  E_NOT_FOUND: { retryable: false, description: "requested resource does not exist" },
  E_ALREADY_EXISTS: { retryable: false, description: "resource already exists" },
  E_STATE_INVALID: {
    retryable: false,
    description: "current project / tool state forbids this action",
  },
  E_VALIDATION: { retryable: false, description: "input failed schema validation" },
  E_CANCELED: { retryable: true, description: "tool run canceled by the client" },
  E_ENDPOINT_UNREACHABLE: { retryable: true, description: "configured endpoint did not respond" },
  E_UNWRITABLE: { retryable: false, description: "target path is not writable" },
  E_CONFIRM_REQUIRED: {
    retryable: true,
    description: "destructive action needs a valid confirm_token",
  },
  E_INTERNAL: { retryable: false, description: "unexpected internal error" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}

export class McpError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message?: string, detail?: unknown) {
    super(message ?? ERROR_CODES[code].description);
    this.name = "McpError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

/** Translate a thrown value (any shape) into an McpError. */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  // Errors from config/paths modules already carry a stable `code` string;
  // pass them through as-is when possible.
  if (err && typeof err === "object" && "code" in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === "string" && raw in ERROR_CODES) {
      return new McpError(
        raw as ErrorCode,
        (err as { message?: string }).message,
        (err as { detail?: unknown }).detail,
      );
    }
  }
  return new McpError("E_INTERNAL", err instanceof Error ? err.message : String(err));
}
