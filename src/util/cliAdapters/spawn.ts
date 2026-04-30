// Shared subprocess helpers for CLI adapters.
//
// Each adapter calls `runCli` with its built argv + stdin payload. This
// module owns: spawn lifecycle, AbortSignal wiring, stdin write, stdout/
// stderr capture, exit-code handling, ephemeral workdir creation +
// cleanup. Per-CLI quirks (which flag to pass, how to parse stdout) stay
// in the per-adapter file.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./types.js";

export interface RunCliOptions {
  cmd: string;
  args: string[];
  /** Optional bytes piped to stdin. Adapter is responsible for encoding. */
  stdin?: string;
  signal?: AbortSignal;
  workdirMode: "ephemeral" | "persistent";
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a CLI process and capture stdout/stderr. Throws CliError on:
 *   - spawn failure (ENOENT, EACCES) — kind="spawn-failed"
 *   - non-zero exit code — kind="exit-nonzero" (with exitCode + stderr)
 *   - signal abort — kind="canceled"
 *
 * Workdir lifecycle:
 *   - ephemeral: creates `~/.vcf/cli-runs/<random>/`, removes on exit.
 *     Required when spawning concurrent calls of the same CLI (panels).
 *   - persistent: reuses `~/.vcf/cli-runs/persistent/`. Caller is responsible
 *     for not running parallel calls in this mode.
 */
export async function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const baseDir = join(homedir(), ".vcf", "cli-runs");
  await mkdir(baseDir, { recursive: true });
  const workdir =
    opts.workdirMode === "ephemeral"
      ? await mkdtemp(join(baseDir, "run-"))
      : join(baseDir, "persistent");
  if (opts.workdirMode === "persistent") {
    await mkdir(workdir, { recursive: true });
  }

  return new Promise<RunCliResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(opts.cmd, opts.args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      cleanup(workdir, opts.workdirMode);
      reject(
        new CliError("spawn-failed", `failed to spawn '${opts.cmd}': ${(e as Error).message}`),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let canceled = false;

    const onAbort = () => {
      canceled = true;
      child.kill("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      cleanup(workdir, opts.workdirMode);
      reject(new CliError("spawn-failed", `process error: ${e.message}`));
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      cleanup(workdir, opts.workdirMode);
      if (canceled) {
        reject(new CliError("canceled", `'${opts.cmd}' aborted by signal`));
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        reject(
          new CliError("exit-nonzero", `'${opts.cmd}' exited ${exitCode}: ${truncate(stderr)}`, {
            exitCode,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function cleanup(dir: string, mode: "ephemeral" | "persistent"): void {
  if (mode === "persistent") return;
  // Best-effort — don't reject the promise on cleanup failure.
  rm(dir, { recursive: true, force: true }).catch(() => {});
}

function truncate(s: string, max = 512): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
