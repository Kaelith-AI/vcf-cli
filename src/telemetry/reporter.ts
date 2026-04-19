// Opt-in error reporter (locked decision 2026-04-18).
//
// Default OFF. When user enables `telemetry.error_reporting_enabled` in
// their config, we capture uncaught exceptions and E_INTERNAL envelope
// failures. We never capture tool inputs/outputs, file contents, or config
// values. The redaction helper runs on all captured context before send.
//
// For MVP we ship a pluggable interface with a `NoopReporter` default and
// a `StderrReporter` for local debugging. A real Sentry backend lands in
// M13 once we have a DSN to test against — the plugin shape is stable so
// swapping reporters is non-breaking.

import { redact } from "../util/audit.js";

export interface ReporterEvent {
  kind: "uncaught" | "internal-error";
  message: string;
  stack?: string;
  tool?: string;
  scope?: string;
  ts: number;
}

export interface Reporter {
  capture(event: ReporterEvent): void;
}

/** Default: do nothing. Used when telemetry.error_reporting_enabled is false. */
export class NoopReporter implements Reporter {
  capture(_event: ReporterEvent): void {
    // no-op by design
  }
}

/**
 * Local-debug reporter: emit the event to stderr as a JSON line. Safe to
 * use anywhere; does not escape the local machine.
 */
export class StderrReporter implements Reporter {
  capture(event: ReporterEvent): void {
    const safe = redact({ ...event });
    process.stderr.write(JSON.stringify({ level: "error", telemetry: safe }) + "\n");
  }
}

export interface ResolveReporterOpts {
  enabled: boolean;
  dsn?: string | undefined;
}

/**
 * Pick the reporter implementation based on config. For MVP:
 * - disabled → Noop
 * - enabled with no DSN or a stub DSN → Stderr
 * - enabled with a real DSN → Stderr (real Sentry backend lands in M13)
 */
export function resolveReporter(opts: ResolveReporterOpts): Reporter {
  if (!opts.enabled) return new NoopReporter();
  return new StderrReporter();
}
