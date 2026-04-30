// `vcf-mcp` binary entry.
//
// Responsibilities:
//  - parse CLI args (optional --scope override, optional --cwd)
//  - resolve scope from filesystem (walk-up for .vcf/project.db) unless
//    --scope explicitly overrides
//  - resolve config (VCF_CONFIG or ~/.vcf/config.yaml)
//  - open DBs (global always; project only when scope is project)
//  - hand off to createServer() and wire the stdio transport
//  - on SIGINT/SIGTERM, close transports and exit cleanly

import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config/loader.js";
import { resolveScope } from "./scope.js";
import { createServer } from "./server.js";
import { openGlobalDb } from "./db/global.js";
import { openProjectDb } from "./db/project.js";
import { VERSION } from "./version.js";
import { log } from "./logger.js";
import { resolveReporter } from "./telemetry/reporter.js";
import { recordConfigBoot } from "./util/configBoot.js";
import { loadSecretsEnv } from "./util/secretsEnv.js";
import { secretsEnvPath } from "./project/stateDir.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("vcf-mcp")
    .description("Vibe Coding Framework MCP server (stdio transport).")
    .version(VERSION)
    .option(
      "--scope <scope>",
      "explicit override: 'global' (idea/spec/catalog) or 'project' (full lifecycle). " +
        "When omitted, scope is auto-detected by walking up from cwd for .vcf/project.db.",
    )
    .option("--cwd <path>", "override working directory used for project-scope detection")
    .parse(process.argv);

  const opts = program.opts<{ scope?: string; cwd?: string }>();
  if (opts.scope !== undefined && opts.scope !== "global" && opts.scope !== "project") {
    process.stderr.write(
      `vcf-mcp: --scope must be "global" or "project" when supplied (got "${opts.scope}")\n`,
    );
    process.exit(2);
  }

  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();

  // Load ~/.vcf/secrets.env BEFORE config — config validation reads env vars
  // for endpoint auth (E_CONFIG_MISSING_ENV at non-local trust levels).
  // process.env still wins so explicit overrides keep working for testing.
  // The file is optional; absent file is fine.
  const secrets = loadSecretsEnv(secretsEnvPath());
  if (secrets.fileExists) {
    if (secrets.permissive) {
      process.stderr.write(
        `vcf-mcp: warning: ${secrets.path} mode is ${secrets.mode} — group/world readable. ` +
          `Run 'chmod 600 ${secrets.path}' to fix.\n`,
      );
    }
    if (secrets.invalid.length > 0) {
      process.stderr.write(
        `vcf-mcp: warning: ${secrets.invalid.length} malformed line(s) in ${secrets.path}: ` +
          `${secrets.invalid.slice(0, 5).join(", ")}\n`,
      );
    }
    log.info(
      {
        path: secrets.path,
        loaded_count: secrets.loaded.length,
        skipped_count: secrets.skipped.length,
        // Names are not secrets; values would be — only names logged.
        loaded: secrets.loaded,
      },
      "loaded secrets file",
    );
  }

  // Config resolution: VCF_CONFIG env > ~/.vcf/config.yaml.
  const configPath = process.env["VCF_CONFIG"] ?? resolvePath(homedir(), ".vcf", "config.yaml");
  const config = await loadConfig(configPath).catch((err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`vcf-mcp: config error [${err.code}]: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  });

  // Global DB must be open before scope resolution — auto-detect queries
  // the registry to find the project that owns cwd.
  const globalDbPath = resolvePath(homedir(), ".vcf", "vcf.db");
  const globalDb = openGlobalDb({ path: globalDbPath });

  // Followup #48 — capture a config-integrity boot snapshot. Non-fatal on
  // failure; the function catches its own IO/DB errors. When the sha256
  // differs from the previous boot's sha256 for this path, emit a single
  // stderr note so operators who run vcf-mcp interactively see the delta
  // without having to query the audit table. The MCP stdio transport is
  // on stdin/stdout; stderr is safe for human notes.
  const bootSnapshot = recordConfigBoot(globalDb, configPath, VERSION);
  if (
    bootSnapshot.prev_sha256 !== null &&
    bootSnapshot.sha256 !== null &&
    bootSnapshot.prev_sha256 !== bootSnapshot.sha256
  ) {
    const prev = bootSnapshot.prev_sha256.slice(0, 12);
    const curr = bootSnapshot.sha256.slice(0, 12);
    process.stderr.write(
      `vcf-mcp: config changed since last boot (${configPath}): ${prev} → ${curr}\n`,
    );
  }

  const resolved = resolveScope(
    opts.scope !== undefined
      ? { requested: opts.scope as "global" | "project", cwd, globalDb }
      : { cwd, globalDb },
  );

  // Install telemetry reporter per config (default off).
  const reporter = resolveReporter({
    enabled: config.telemetry.error_reporting_enabled,
    ...(config.telemetry.dsn !== undefined ? { dsn: config.telemetry.dsn } : {}),
  });
  process.on("uncaughtException", (err) => {
    reporter.capture({
      kind: "uncaught",
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
      ts: Date.now(),
    });
    log.fatal({ err }, "uncaught exception");
    process.exit(1);
  });

  // Guard against silent empty-DB recreation: if scope resolution placed us in
  // project scope (registry match) but the state-dir was deleted externally
  // between registration and now, openProjectDb would happily create a fresh
  // empty DB with no project row. That surfaces as confusing E_STATE_INVALID
  // errors on the first tool call. Fail fast with a clear message instead.
  if (resolved.projectDbPath && !existsSync(resolved.projectDbPath)) {
    process.stderr.write(
      `vcf-mcp: project '${resolved.projectSlug}' is registered (root=${resolved.projectRoot}) ` +
        `but its state DB is missing at ${resolved.projectDbPath}. ` +
        `Re-run 'vcf adopt ${resolved.projectRoot}' to heal.\n`,
    );
    process.exit(4);
  }
  const projectDb = resolved.projectDbPath
    ? openProjectDb({ path: resolved.projectDbPath })
    : undefined;

  const server = createServer({
    scope: resolved.scope,
    resolved,
    config,
    globalDb,
    ...(projectDb !== undefined ? { projectDb } : {}),
  });

  // Best-effort 90-day kb-drafts cleanup sweep on boot. Never blocks
  // startup; errors land in the logger.
  void (async () => {
    try {
      const { runKbDraftsCleanup } = await import("./util/kbDraftsCleanup.js");
      const result = await runKbDraftsCleanup({ liveKbRoot: config.kb.root });
      if (result.removed.length > 0 || result.trimmed.length > 0) {
        log.info(
          {
            examined: result.examined,
            removed: result.removed.length,
            trimmed: result.trimmed.length,
            errors: result.errors.length,
          },
          "vcf-mcp: kb-drafts cleanup sweep complete",
        );
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "vcf-mcp: kb-drafts cleanup failed (non-fatal)");
    }
  })();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ scope: resolved.scope, version: VERSION }, "vcf-mcp connected (stdio)");

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "vcf-mcp shutting down");
    try {
      await server.close();
    } catch (err) {
      log.warn({ err }, "server.close() raised");
    }
    try {
      globalDb.close();
      projectDb?.close();
    } catch {
      /* non-fatal */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`vcf-mcp: fatal: ${message}\n`);
  process.exit(1);
});
