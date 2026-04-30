// ship_release — project scope.
//
// Plan/confirm path for cutting a GitHub release. Two-call contract:
//
//   1. First call (no confirm_token): returns a plan — the exact
//      `gh release create` command line, a preview of the release notes,
//      the tag, and a single-use confirm_token with a 60s TTL.
//   2. Second call (confirm_token = <the token from call 1>): actually
//      shells out to `gh release create`. The token is validated with
//      timing-safe comparison, consumed, and refused on reuse.
//
// Destructive: creates a tag on the remote and publishes a release. Pins
// the repo to whatever ref `gh` resolves; the caller is responsible for
// making sure HEAD is clean and pushed.
//
// Non-negotiable: an LLM calling this tool ONCE does not ship anything.
// The plan comes back, the user sees it, the user (or the skill wrapping
// this tool) approves, and only then does the second call execute.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn as realSpawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import type { ServerDeps } from "../server.js";

// Indirection so the positive-path integration test can stub gh without
// hitting a real install. vi.mock on `node:child_process` can't override
// across test files when `isolate: false` is set in vitest.config.ts
// (the module cache is shared), so we expose a small setter/resetter
// instead. Production always runs with the real spawn.
type SpawnFn = (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
let spawnImpl: SpawnFn = realSpawn as SpawnFn;
export function __setShipReleaseSpawnImpl(impl: SpawnFn): void {
  spawnImpl = impl;
}
export function __resetShipReleaseSpawnImpl(): void {
  spawnImpl = realSpawn as SpawnFn;
}
import { runTool, success } from "../envelope.js";
import { writeAudit, redact } from "../util/audit.js";
import { McpError } from "../errors.js";
import { createConfirmTokenStore, type ConfirmTokenStore } from "../util/confirmToken.js";
import { setProjectState } from "../util/projectRegistry.js";

// One store per server process — tokens evaporate on restart, which is
// the intended behavior (a new process = new key = invalidate outstanding
// tokens). TTL is driven by config.ship.confirm_ttl_minutes (default 60 min).
let store: ConfirmTokenStore | null = null;
let storeTtlMs: number | null = null;
function getStore(ttlMs: number): ConfirmTokenStore {
  if (store === null || storeTtlMs !== ttlMs) {
    store = createConfirmTokenStore({ ttlMs });
    storeTtlMs = ttlMs;
  }
  return store;
}

const ShipReleaseInput = z
  .object({
    tag: z
      .string()
      .regex(/^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/)
      .describe("semver tag with leading 'v' (e.g. v1.2.3 or v0.0.1-alpha.0)"),
    title: z.string().max(256).optional(),
    notes: z.string().max(20_000).optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
    target: z
      .string()
      .max(128)
      .optional()
      .describe("target branch or full commit SHA (default: remote HEAD)"),
    generate_notes: z
      .boolean()
      .default(true)
      .describe("ask gh to auto-generate notes from commits since last tag"),
    confirm_token: z
      .string()
      .optional()
      .describe("token returned by the prior plan call; omit to request a new plan"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(60_000)
      .describe("kill the gh subprocess if it runs longer than this (ms, default 60s)"),
    expand: z.boolean().default(true),
  })
  .strict();

type Args = z.infer<typeof ShipReleaseInput>;

export function registerShipRelease(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "ship_release",
    {
      title: "Cut a GitHub Release (plan/confirm)",
      description:
        "Plan or execute `gh release create`. Call once without confirm_token to receive the exact command + single-use token (TTL configurable via config.ship.confirm_ttl_minutes, default 60m). Call again with the token to execute. The server refuses to run twice on the same token and refuses a mismatched input payload.",
      inputSchema: ShipReleaseInput.shape,
    },
    async (args: Args) => {
      // Captured during body execution; read by onComplete so per-path audit
      // shape (plan vs confirm+execute) is preserved without two audit calls.
      let auditBundle: { content?: unknown; result_code?: string } = {};
      // Set when version_check fires a soft-warning (strict_chain=false path).
      let versionWarn: string | null = null;
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "ship_release requires project scope");
          }
          const parsed = ShipReleaseInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          // Strict-chain enforcement (followup #25 items 5+6).
          // When config.ship.strict_chain=true, ship_release requires:
          //   (a) a passing ship_audit row within the window
          //   (b) a successful ship_build row within the window
          //   (c) the tag is semver-newer than the last recorded release
          // When config.ship.version_check=true (even without strict_chain),
          // semver-order is checked and a warning is emitted (hard gate only
          // when strict_chain is also true).
          const shipCfg = deps.config.ship;
          if (shipCfg.strict_chain || shipCfg.version_check) {
            const windowMs = (shipCfg.strict_chain_window_minutes ?? 60) * 60_000;
            const cutoffTs = Date.now() - windowMs;
            if (shipCfg.strict_chain) {
              // Check for a recent passing ship_audit row.
              const auditRow = deps.globalDb
                .prepare(
                  `SELECT id FROM audit
                   WHERE tool = 'ship_audit' AND result_code = 'ok'
                     AND project_root = ? AND ts >= ?
                   ORDER BY ts DESC LIMIT 1`,
                )
                .get(projectRoot, cutoffTs) as { id: number } | undefined;
              if (!auditRow) {
                throw new McpError(
                  "E_STATE_INVALID",
                  `ship.strict_chain is on: no passing ship_audit found for this project within the last ${shipCfg.strict_chain_window_minutes} minutes. Run ship_audit first.`,
                );
              }
              // Check for a recent successful ship_build row.
              const buildRow = deps.projectDb
                .prepare(
                  `SELECT id FROM builds
                   WHERE target LIKE 'ship:%' AND status = 'success'
                     AND finished_at >= ?
                   ORDER BY finished_at DESC LIMIT 1`,
                )
                .get(cutoffTs) as { id: number } | undefined;
              if (!buildRow) {
                throw new McpError(
                  "E_STATE_INVALID",
                  `ship.strict_chain is on: no successful ship_build found within the last ${shipCfg.strict_chain_window_minutes} minutes. Run ship_build first.`,
                );
              }
            }
            // Version-continuity check (item 6).
            if (shipCfg.version_check || shipCfg.strict_chain) {
              const lastRelease = deps.projectDb
                .prepare(
                  `SELECT target FROM builds
                   WHERE target LIKE 'ship_release:%' AND status = 'success'
                   ORDER BY finished_at DESC LIMIT 1`,
                )
                .get() as { target: string } | undefined;
              if (lastRelease) {
                const lastTag = lastRelease.target.replace(/^ship_release:/, "");
                if (!isSemverNewer(parsed.tag, lastTag)) {
                  const msg = `version-continuity: tag ${parsed.tag} is not semver-newer than the last release ${lastTag}`;
                  if (shipCfg.strict_chain) {
                    throw new McpError("E_VALIDATION", msg);
                  } else {
                    // soft-warn: surface in the summary but don't block
                    versionWarn = msg;
                  }
                }
              }
            }
          }

          // The plan payload the confirm_token binds to. We strip confirm_token
          // + expand so the user can toggle verbosity / pass the token back
          // without invalidating the plan.
          const planPayload = {
            tag: parsed.tag,
            title: parsed.title ?? null,
            notes: parsed.notes ?? null,
            draft: parsed.draft,
            prerelease: parsed.prerelease,
            target: parsed.target ?? null,
            generate_notes: parsed.generate_notes,
            project_root: readProjectRoot(deps),
          };
          const cmd = buildGhArgs(parsed, projectRoot);

          // Plan-only call.
          const confirmTtlMs = (deps.config.ship?.confirm_ttl_minutes ?? 60) * 60_000;
          if (parsed.confirm_token === undefined) {
            const token = getStore(confirmTtlMs).issue(planPayload);
            const ttlMinutes = deps.config.ship?.confirm_ttl_minutes ?? 60;
            auditBundle = {
              content: { ...planPayload, confirm_token: "<redacted>" },
              result_code: "ok",
            };
            const payload = success<unknown>(
              [projectRoot],
              `ship_release plan: \`gh release create ${cmd.args.join(" ")}\` in ${projectRoot}. Single-use confirm_token issued (TTL ${ttlMinutes}m).`,
              parsed.expand
                ? {
                    content: {
                      plan: planPayload,
                      command: { name: "gh", args: cmd.args, cwd: projectRoot },
                      confirm_token: token,
                      notes_source: parsed.generate_notes
                        ? "gh --generate-notes"
                        : parsed.notes
                          ? "caller-provided"
                          : "(empty)",
                    },
                  }
                : {},
            );
            return payload;
          }

          // Confirm call — validate the token or refuse.
          try {
            getStore(confirmTtlMs).consume(parsed.confirm_token, planPayload);
          } catch (err) {
            throw err instanceof McpError
              ? err
              : new McpError("E_CONFIRM_REQUIRED", (err as Error).message);
          }

          // Execute. Timeout is enforced in-process: if gh doesn't close
          // within parsed.timeout_ms we SIGTERM it and resolve with
          // exit_code: null + timed_out: true. Prevents a hung gh (e.g.
          // auth prompt on CI, network stall) from leaking the handler.
          const result = await new Promise<{
            exit_code: number | null;
            stdout_tail: string;
            stderr_tail: string;
            duration_ms: number;
            timed_out: boolean;
          }>((resolve) => {
            const startedAt = Date.now();
            let stdoutBuf = "";
            let stderrBuf = "";
            let settled = false;
            const child = spawnImpl(cmd.command, cmd.args, {
              cwd: projectRoot,
              stdio: ["ignore", "pipe", "pipe"],
            });
            const TAIL = 16 * 1024;
            const timer = setTimeout(() => {
              if (settled) return;
              stderrBuf += `\n[timeout] gh killed after ${parsed.timeout_ms}ms\n`;
              try {
                child.kill("SIGTERM");
              } catch {
                /* child may have already exited */
              }
              settled = true;
              resolve({
                exit_code: null,
                stdout_tail: stdoutBuf,
                stderr_tail: stderrBuf,
                duration_ms: Date.now() - startedAt,
                timed_out: true,
              });
            }, parsed.timeout_ms);
            // stdio: "pipe" guarantees these streams exist at runtime, but
            // the SpawnFn type only promises `Readable | null`. Non-null
            // assert since the nullable branch is unreachable here.
            child.stdout!.on("data", (c: Buffer) => {
              stdoutBuf += c.toString("utf8");
              if (stdoutBuf.length > TAIL) stdoutBuf = stdoutBuf.slice(stdoutBuf.length - TAIL);
            });
            child.stderr!.on("data", (c: Buffer) => {
              stderrBuf += c.toString("utf8");
              if (stderrBuf.length > TAIL) stderrBuf = stderrBuf.slice(stderrBuf.length - TAIL);
            });
            child.on("error", (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              stderrBuf += `\n[spawn error] ${(err as Error).message}\n`;
              resolve({
                exit_code: null,
                stdout_tail: stdoutBuf,
                stderr_tail: stderrBuf,
                duration_ms: Date.now() - startedAt,
                timed_out: false,
              });
            });
            child.on("close", (code) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({
                exit_code: code,
                stdout_tail: stdoutBuf,
                stderr_tail: stderrBuf,
                duration_ms: Date.now() - startedAt,
                timed_out: false,
              });
            });
          });

          const passed = result.exit_code === 0;
          const summary = passed
            ? `ship_release: ${parsed.tag} created (${result.duration_ms}ms).${versionWarn ? ` [WARNING: ${versionWarn}]` : ""}`
            : `ship_release: gh exited ${result.exit_code ?? "null"} — release NOT created.${versionWarn ? ` [WARNING: ${versionWarn}]` : ""}`;

          // Run stdout/stderr through the secret redactor before surfacing
          // them in the envelope or the audit row. `gh` output can include
          // repo URLs, commit SHAs, occasional API-key shaped strings in
          // error messages; the redactor is the same pass that scrubs
          // outbound LLM payloads. Closes the security/stage-7 finding
          // from the 2026-04-21 dogfood review.
          const stdoutRedacted = redact(result.stdout_tail) as string;
          const stderrRedacted = redact(result.stderr_tail) as string;
          const resultSafe = {
            ...result,
            stdout_tail: stdoutRedacted,
            stderr_tail: stderrRedacted,
          };

          // Record as a build row so portfolio_status picks it up.
          deps.projectDb
            .prepare(
              `INSERT INTO builds (target, started_at, finished_at, status, output_path)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              `ship_release:${parsed.tag}`,
              Date.now() - result.duration_ms,
              Date.now(),
              passed ? "success" : "failed",
              null,
            );

          // Close followup #25 ship item: on a successful release, transition
          // project.state to 'shipped' so portfolio queries can distinguish
          // shipped from reviewing. Mirror into the global registry cache.
          if (passed) {
            const now = Date.now();
            deps.projectDb
              .prepare("UPDATE project SET state = 'shipped', updated_at = ? WHERE id = 1")
              .run(now);
            try {
              setProjectState(deps.globalDb, projectRoot, "shipped");
            } catch {
              /* non-fatal — registry is a convenience */
            }
          }

          const payload = success<unknown>(
            [projectRoot],
            summary,
            parsed.expand ? { content: resultSafe } : {},
          );
          auditBundle = {
            // Tails go into audit already-redacted (via resultSafe). The
            // previous `<redacted>` placeholder lost the signal entirely; now
            // operators can read sanitized output post-hoc.
            content: resultSafe,
            result_code: passed ? "ok" : "E_INTERNAL",
          };
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "ship_release",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs:
              auditBundle.content !== undefined
                ? { ...payload, content: auditBundle.content }
                : payload,
            result_code: auditBundle.result_code ?? (payload.ok ? "ok" : payload.code),
          });
        },
      );
    },
  );
}

/**
 * Returns true when `tag` is strictly semver-newer than `prior`.
 * Both must be v-prefixed semver strings (e.g. "v1.2.3", "v0.1.0-alpha.0").
 * Pre-release identifiers follow the semver.org precedence rules.
 * Returns true when comparison is indeterminate (malformed input) to avoid
 * false-blocking on unusual tag formats.
 */
export function isSemverNewer(tag: string, prior: string): boolean {
  const parse = (t: string): [number, number, number, string] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(t);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
  };
  const a = parse(tag);
  const b = parse(prior);
  if (!a || !b) return true; // indeterminate → allow
  for (let i = 0; i < 3; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  // Same numeric portion: pre-release < release per semver.
  const aPre = a[3];
  const bPre = b[3];
  if (aPre === "" && bPre !== "") return true; // release > pre-release
  if (aPre !== "" && bPre === "") return false; // pre-release < release
  if (aPre === bPre) return false; // identical tag — not strictly newer
  // Both have pre-release; lexicographic comparison is a reasonable
  // approximation for same-numeric-version pre-releases.
  return aPre > bPre;
}

function buildGhArgs(parsed: Args, _projectRoot: string): { command: "gh"; args: string[] } {
  const args: string[] = ["release", "create", parsed.tag];
  if (parsed.title !== undefined) args.push("--title", parsed.title);
  if (parsed.notes !== undefined) args.push("--notes", parsed.notes);
  if (parsed.draft) args.push("--draft");
  if (parsed.prerelease) args.push("--prerelease");
  if (parsed.target !== undefined) args.push("--target", parsed.target);
  if (parsed.generate_notes && parsed.notes === undefined) args.push("--generate-notes");
  return { command: "gh", args };
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

/** Test-only: reset the in-memory token store. */
export function __resetShipReleaseStoreForTests(): void {
  store = null;
  storeTtlMs = null;
}
