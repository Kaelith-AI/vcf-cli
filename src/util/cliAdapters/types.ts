// CLI-adapter shared types.
//
// CLI adapters are the kind=cli counterpart to llmClient.callChatCompletion.
// They take an array of ChatMessages, spawn a subprocess (claude / codex /
// gemini / ollama), feed the prompt in, and return the assistant's response.
//
// The adapter contract intentionally mirrors callChatCompletion's surface so
// the dispatcher can branch on `endpoint.kind` and hand back a single
// content string regardless of route. Token accounting is opaque for the
// CLI path (subscriptions burn invisible quota); the result returns
// {tokens: null} so audit logs can stay honest.

import type { ChatMessage } from "../llmClient.js";

export interface CliCallRequest {
  /** Conversation history. The adapter flattens to whatever the CLI accepts. */
  messages: ChatMessage[];
  /** Provider model id — passed through to the CLI via its model flag. */
  model: string;
  /** Lower = more deterministic. Adapter may ignore if the CLI doesn't expose it. */
  temperature?: number;
  /** Abort signal for cancellation. Adapter forwards to the spawned process. */
  signal?: AbortSignal;
  /** Static command + args from config.endpoints[].{cmd, args}. */
  cmd: string;
  staticArgs: string[];
  /** ephemeral spawns under ~/.vcf/cli-runs/<uuid>/; persistent reuses one dir. */
  workdirMode: "ephemeral" | "persistent";
}

export interface CliCallResult {
  /** Final assistant text. Whitespace-trimmed. */
  content: string;
  /** Always null for CLI adapters — subscription/login quota is opaque. */
  tokens: null;
  /** Adapter name (claude | codex | gemini | ollama) for audit + debug. */
  adapter: string;
}

export class CliError extends Error {
  readonly kind: "spawn-failed" | "exit-nonzero" | "parse-failed" | "canceled" | "not-implemented";
  readonly exitCode: number | null;
  readonly stderr: string | undefined;
  constructor(
    kind: CliError["kind"],
    message: string,
    detail?: { exitCode?: number | null; stderr?: string },
  ) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.exitCode = detail?.exitCode ?? null;
    this.stderr = detail?.stderr;
  }
}

export interface CliProbeResult {
  /** True when the cmd is on PATH and (best-effort) authenticated. */
  ok: boolean;
  /** Short reason when !ok (e.g. "command not found", "not logged in"). */
  detail?: string;
}

export interface CliAdapter {
  /** Stable name — matches endpoints[].provider taxonomy where possible. */
  readonly name: string;
  /**
   * Single-shot chat completion via the CLI subprocess. Throws CliError on
   * any spawn / parse / exit failure.
   */
  chatComplete(req: CliCallRequest): Promise<CliCallResult>;
  /**
   * Lightweight liveness check. Used by `vcf verify` (Workstream A9).
   * Should run quickly (`<cmd> --version` style); no LLM call.
   */
  probe(cmd: string): Promise<CliProbeResult>;
}
