// Shared cancellation helper.
//
// Every long-running tool (test_execute, ship_build, review_prepare when
// it scans a big diff) takes an AbortSignal from the SDK and emits
// progress notifications in bounded steps. This helper gives a uniform
// way to check for cancellation and to throw the right error code.

import { McpError } from "../errors.js";

/** Throw E_CANCELED if the signal is aborted. Call at progress boundaries. */
export function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McpError("E_CANCELED");
}

export interface ProgressOpts {
  signal?: AbortSignal | undefined;
  sendNotification?: (method: string, params: unknown) => Promise<void> | void;
  progressToken?: string | number | undefined;
}

/**
 * Emit a progress notification — no-op if the client didn't provide a
 * progressToken (which means it didn't subscribe).
 */
export async function emitProgress(
  opts: ProgressOpts,
  progress: number,
  total: number,
  message?: string,
): Promise<void> {
  throwIfCanceled(opts.signal);
  if (!opts.sendNotification || opts.progressToken === undefined) return;
  await opts.sendNotification("notifications/progress", {
    progressToken: opts.progressToken,
    progress,
    total,
    ...(message !== undefined ? { message } : {}),
  });
}
