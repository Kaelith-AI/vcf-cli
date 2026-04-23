// Followup #44 — `vcf init` CLI handler.
//
// First-run onboarding: seed ~/.vcf/config.yaml, seed ~/.vcf/kb/ from the
// @kaelith-labs/kb package, and merge a vcf block into ~/.mcp.json so the
// user's MCP client sees the server on next start.

import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { seedKbIfMissing } from "../primers/merge.js";
import { DEFAULT_KB_ANCESTOR_ROOT, DEFAULT_KB_ROOT, log } from "./_shared.js";

export async function runInit(opts: { telemetry?: boolean } = {}): Promise<void> {
  const cfgDir = resolvePath(homedir(), ".vcf");
  const cfgPath = resolvePath(cfgDir, "config.yaml");
  const userMcpJsonPath = resolvePath(homedir(), ".mcp.json");

  await mkdir(cfgDir, { recursive: true });

  if (existsSync(cfgPath)) {
    log(`${cfgPath} already exists — leaving in place.`);
  } else {
    // Precedence: explicit flag > interactive prompt > default-false.
    // Non-TTY (CI, piped stdin) defaults to false without prompting so
    // automation never hangs on `vcf init`.
    let telemetryEnabled: boolean;
    if (opts.telemetry !== undefined) {
      telemetryEnabled = opts.telemetry;
    } else if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const telemetryInput = await rl.question(
        "Enable opt-in error reporting? Captures only uncaught exceptions + E_INTERNAL failures. Never tool inputs/outputs. [y/N] ",
      );
      rl.close();
      telemetryEnabled = /^y(es)?$/i.test(telemetryInput.trim());
    } else {
      telemetryEnabled = false;
    }

    const workspaceRoot = resolvePath(homedir(), "vcf");
    const seed = [
      "# VCF-MCP config. See docs/STABILITY.md for the schema contract.",
      "# Edit with care — loader validates on every run and refuses invalid files.",
      "version: 1",
      "",
      "workspace:",
      "  allowed_roots:",
      `    - ${workspaceRoot}`,
      `    - ${homedir()}/projects`,
      `  ideas_dir: ${workspaceRoot}/ideas`,
      `  specs_dir: ${workspaceRoot}/specs`,
      "",
      "endpoints:",
      "  # Seed entry: a local Ollama. Replace or extend with your own endpoints.",
      "  # `vcf register-endpoint` appends new blocks safely.",
      "  - name: local-ollama",
      "    provider: openai-compatible",
      "    base_url: http://127.0.0.1:11434/v1",
      "    trust_level: local",
      "",
      "kb:",
      `  root: ${homedir()}/.vcf/kb`,
      "  # Third-party primer packs. `vcf pack add --name <slug> --path <abs>` splices in.",
      "  packs: []",
      "",
      "review:",
      "  # Add categories here (e.g. accessibility, performance) and drop matching",
      "  # stage files under kb/review-system/<name>/ — no code change required.",
      '  categories: ["code", "security", "production"]',
      "  auto_advance_on_pass: true",
      "  stale_primer_days: 180",
      "",
      "telemetry:",
      `  error_reporting_enabled: ${telemetryEnabled ? "true" : "false"}`,
      "",
      "audit:",
      "  # Set to true to also store redacted JSON of each tool call's inputs/outputs",
      "  # (columns added to the audit table). Hashes are always written regardless.",
      "  full_payload_storage: false",
      "",
      "# Optional: embedding-based primer selection. Requires `vcf embed-kb` to populate.",
      "# Uncomment + point `endpoint` at one of the endpoints above.",
      "# embeddings:",
      "#   endpoint: local-ollama",
      "#   model: nomic-embed-text",
      "#   blend_weight: 0.5",
      "",
      "# Optional: per-step model/endpoint defaults. Each entry overrides the",
      "# legacy model_aliases fallback for one tool without forcing per-call args.",
      "# Resolution order at call time: explicit arg → defaults.<tool> → legacy.",
      "# defaults:",
      "#   review: { endpoint: local-ollama, model: gemma-4-12b }",
      "#   lifecycle_report: { endpoint: local-ollama, model: gemma-4-12b }",
      "#   retrospective: { endpoint: local-ollama, model: gemma-4-12b }",
      "#   research: { endpoint: local-ollama, model: gemma-4-12b }",
      "#   research_verify: { endpoint: local-ollama, model: gemma-4-12b }",
      "#   stress_test: { endpoint: local-ollama, model: gemma-4-12b }",
      "",
      "# Optional: relocate any project-tree artifact kind. Values are",
      "# relative to the registered project_root by default; absolute paths",
      "# pass through. Omit to accept defaults (shown below).",
      "# outputs:",
      "#   plans_dir: plans",
      "#   decisions_dir: plans/decisions",
      "#   reviews_dir: plans/reviews",
      "#   response_log_path: plans/reviews/response-log.md",
      "#   lifecycle_report_dir: plans",
      "#   memory_dir: memory/daily-logs",
      "#   docs_dir: docs",
      "#   skills_dir: skills",
      "#   backups_dir: backups",
      "",
    ].join("\n");
    await writeFile(cfgPath, seed, "utf8");
    log(`wrote ${cfgPath}`);
  }

  // Seed the KB on first run. Every KB-reading tool (spec_suggest_primers,
  // build_context, plan_context, primer_list, review_prepare, ...) degrades
  // silently to an empty list when ~/.vcf/kb is missing, so a fresh install
  // would look "working" while returning empty results. Seeding here closes
  // that onboarding hole. Idempotent — skipped if the dir exists.
  await seedKbIfMissing(DEFAULT_KB_ROOT(), DEFAULT_KB_ANCESTOR_ROOT(), log);

  // User-level .mcp.json auto-wire. No --scope flag: the server auto-detects
  // project vs global by walking up from cwd and matching against the
  // global registry (~/.vcf/vcf.db). When a client launches from a
  // non-project dir, this falls through to global; when launched from a
  // registered project root, the full lifecycle tool surface comes up
  // automatically.
  const globalBlock = {
    command: "npx",
    args: ["-y", "@kaelith-labs/cli", "vcf-mcp"],
    env: { VCF_CONFIG: `${homedir()}/.vcf/config.yaml` },
  };
  if (existsSync(userMcpJsonPath)) {
    const raw = await readFile(userMcpJsonPath, "utf8");
    let parsed: { mcpServers?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      log(`${userMcpJsonPath} is not valid JSON — leaving alone.`);
      return;
    }
    if (!parsed.mcpServers) parsed.mcpServers = {};
    if (!parsed.mcpServers["vcf"]) {
      parsed.mcpServers["vcf"] = globalBlock;
      await writeFile(userMcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      log(`merged vcf block into ${userMcpJsonPath}`);
    } else {
      log(`${userMcpJsonPath} already has a "vcf" block — skipping.`);
    }
  } else {
    await writeFile(
      userMcpJsonPath,
      JSON.stringify({ mcpServers: { vcf: globalBlock } }, null, 2) + "\n",
      "utf8",
    );
    log(`wrote ${userMcpJsonPath}`);
  }
  log("init complete.");
}
