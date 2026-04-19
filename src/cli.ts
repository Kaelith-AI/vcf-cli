// `vcf` CLI entry.
//
// Maintenance surface — anything deterministic (reindex, verify, endpoint
// registration, audit dump, init) lives here, never on MCP. M3 ships
// `vcf init` only; `reindex`, `verify`, `register-endpoint`,
// `update-primers`, `stale-check`, `admin audit` arrive in M10.

import { Command } from "commander";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { VERSION, MCP_SPEC_VERSION } from "./version.js";

async function runInit(): Promise<void> {
  const cfgDir = resolvePath(homedir(), ".vcf");
  const cfgPath = resolvePath(cfgDir, "config.yaml");
  const userMcpJsonPath = resolvePath(homedir(), ".mcp.json");

  await mkdir(cfgDir, { recursive: true });

  if (existsSync(cfgPath)) {
    process.stderr.write(`vcf: ${cfgPath} already exists — leaving in place.\n`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const telemetry = await rl.question(
      "Enable opt-in error reporting? Captures only uncaught exceptions + E_INTERNAL failures. Never tool inputs/outputs. [y/N] ",
    );
    rl.close();
    const telemetryEnabled = /^y(es)?$/i.test(telemetry.trim());

    const workspaceRoot = resolvePath(homedir(), "vcf");
    const seedConfig = [
      "version: 1",
      "workspace:",
      `  allowed_roots:`,
      `    - ${workspaceRoot}`,
      `    - ${homedir()}/projects`,
      `  ideas_dir: ${workspaceRoot}/ideas`,
      `  specs_dir: ${workspaceRoot}/specs`,
      "endpoints:",
      "  - name: local-ollama",
      "    provider: openai-compatible",
      "    base_url: http://127.0.0.1:11434/v1",
      "    trust_level: local",
      "kb:",
      `  root: ${homedir()}/.vcf/kb`,
      `telemetry:`,
      `  error_reporting_enabled: ${telemetryEnabled ? "true" : "false"}`,
      "",
    ].join("\n");
    await writeFile(cfgPath, seedConfig, "utf8");
    process.stderr.write(`vcf: wrote ${cfgPath}\n`);
  }

  // User-level .mcp.json auto-wire for --scope global.
  const globalBlock = {
    command: "npx",
    args: ["-y", "@vcf/cli", "vcf-mcp", "--scope", "global"],
    env: { VCF_CONFIG: `${homedir()}/.vcf/config.yaml` },
  };
  if (existsSync(userMcpJsonPath)) {
    const raw = await readFile(userMcpJsonPath, "utf8");
    let parsed: { mcpServers?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      process.stderr.write(`vcf: ${userMcpJsonPath} is not valid JSON — leaving alone.\n`);
      return;
    }
    if (!parsed.mcpServers) parsed.mcpServers = {};
    if (!parsed.mcpServers["vcf"]) {
      parsed.mcpServers["vcf"] = globalBlock;
      await writeFile(userMcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      process.stderr.write(`vcf: merged vcf block into ${userMcpJsonPath}\n`);
    } else {
      process.stderr.write(`vcf: ${userMcpJsonPath} already has a "vcf" block — skipping.\n`);
    }
  } else {
    await writeFile(
      userMcpJsonPath,
      JSON.stringify({ mcpServers: { vcf: globalBlock } }, null, 2) + "\n",
      "utf8",
    );
    process.stderr.write(`vcf: wrote ${userMcpJsonPath}\n`);
  }
  process.stderr.write("vcf: init complete.\n");
}

const program = new Command();
program
  .name("vcf")
  .description("Vibe Coding Framework CLI — maintenance surface for VCF-MCP.")
  .version(VERSION);

program
  .command("version")
  .description("Print the installed vcf version + MCP spec pin.")
  .action(() => {
    process.stderr.write(`vcf ${VERSION} (MCP spec ${MCP_SPEC_VERSION})\n`);
  });

program
  .command("init")
  .description(
    "Seed ~/.vcf/config.yaml, write/merge user-level .mcp.json. Idempotent — re-run safe.",
  )
  .action(async () => {
    try {
      await runInit();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`vcf init: ${msg}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`vcf: fatal: ${msg}\n`);
  process.exit(1);
});
