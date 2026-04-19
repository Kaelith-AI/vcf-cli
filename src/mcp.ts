// `vcf-mcp` binary entry.
//
// Responsibilities:
//  - parse CLI args (--scope, optional --cwd)
//  - resolve config (VCF_CONFIG or ~/.vcf/config.yaml)
//  - open DBs (global always; project only when --scope=project)
//  - hand off to createServer() and wire the stdio transport
//  - on SIGINT/SIGTERM, close transports and exit cleanly

import { Command } from "commander";
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("vcf-mcp")
    .description("Vibe Coding Framework MCP server (stdio transport).")
    .version(VERSION)
    .requiredOption(
      "--scope <scope>",
      "launch scope: global (idea/spec/catalog) or project (full lifecycle)",
    )
    .option("--cwd <path>", "override working directory used for project-scope detection")
    .parse(process.argv);

  const opts = program.opts<{ scope: string; cwd?: string }>();
  if (opts.scope !== "global" && opts.scope !== "project") {
    process.stderr.write(`vcf-mcp: --scope must be "global" or "project" (got "${opts.scope}")\n`);
    process.exit(2);
  }

  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
  const resolved = resolveScope({ requested: opts.scope, cwd });

  // Config resolution: VCF_CONFIG env > ~/.vcf/config.yaml.
  const configPath = process.env["VCF_CONFIG"] ?? resolvePath(homedir(), ".vcf", "config.yaml");
  const config = await loadConfig(configPath).catch((err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`vcf-mcp: config error [${err.code}]: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  });

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

  // DB openers.
  const globalDbPath = resolvePath(homedir(), ".vcf", "vcf.db");
  const globalDb = openGlobalDb({ path: globalDbPath });
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
