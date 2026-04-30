// `vcf` CLI entry — maintenance surface.
//
// Anything deterministic (init, reindex, verify, endpoint registration,
// admin queries, backup/restore, migrations) lives here. MCP tools are
// for LLM-in-the-loop paths; the CLI is for the operator who can run a
// command with flags.
//
// The command handlers themselves live in per-group modules under
// `src/cli/` (followup #44 — decomposition). This file only wires the
// commander surface and handles argv.

import { Command } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION, MCP_SPEC_VERSION } from "./version.js";
import { err } from "./cli/_shared.js";
import { runInit } from "./cli/init.js";
import { runReindex } from "./cli/reindex.js";
import { runHealth, runRegisterEndpoint, runStaleCheck, runVerify } from "./cli/verify.js";
import { runPackAdd, runPackList, runPackRemove } from "./cli/pack.js";
import {
  runAdopt,
  runProjectList,
  runProjectMove,
  runProjectRefresh,
  runProjectRegister,
  runProjectRelocate,
  runProjectRename,
  runProjectScan,
  runProjectSetRole,
  runProjectUnregister,
} from "./cli/project.js";
import { runLifecycleReport } from "./cli/lifecycle.js";
import { runInstallSkills, runUpdatePrimers } from "./cli/skills.js";
import { runStandardsInit } from "./cli/standards.js";
import { runEmbedKb } from "./cli/embed.js";
import { runAdminAudit, runAdminConfigHistory } from "./cli/admin.js";
import { runBackup, runRestore } from "./cli/backup.js";
import { runMigrate03 } from "./cli/migrate.js";
import { runTestTrends } from "./cli/testTrends.js";

// Backward-compat re-exports. `test/update-primers.test.ts` and
// `test/init-kb-seed.test.ts` import these from "../src/cli.js". Keep the
// public names stable across the decomposition so those tests don't have
// to churn their imports.
export { mergePrimerTree, seedKbIfMissing, resolveUpstreamKbRoot } from "./primers/merge.js";

// ---- command wiring --------------------------------------------------------

const program = new Command();
program
  .name("vcf")
  .description("Vibe Coding Framework CLI — maintenance surface for VCF-MCP.")
  .version(VERSION);

program
  .command("version")
  .description("Print the installed vcf version + MCP spec pin.")
  .action(() => {
    // stdout (not stderr) so shell pipelines and smoke tests that grep
    // version output work. Prefix matches the package + tap + bucket name
    // (vcf-cli) so downstream regex in the brew formula `test do` block
    // and the packaging/smoke-tests/ scripts all agree on one format.
    process.stdout.write(`vcf-cli ${VERSION} (MCP spec ${MCP_SPEC_VERSION})\n`);
  });

program
  .command("init")
  .description(
    "Seed ~/.vcf/config.yaml, write/merge user-level .mcp.json. Idempotent — re-run safe.",
  )
  .option("--telemetry", "enable opt-in error reporting without prompting")
  .option(
    "--no-telemetry",
    "disable opt-in error reporting without prompting (default when non-TTY)",
  )
  .action(async (opts: { telemetry?: boolean }) => {
    try {
      await runInit(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("reindex")
  .description(
    "Re-scan plans/ memory/ docs/ into the project's SQLite index. Pass --ideas to reconcile the global ideas table against the ideas_dir on disk.",
  )
  .option("--project <path>", "project root (defaults to current directory)")
  .option("--ideas", "reconcile global DB ideas table against workspace.ideas_dir on disk")
  .action(async (opts: { project?: string; ideas?: boolean }) => {
    try {
      await runReindex(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("verify")
  .description("Check config, allowed_roots, KB, endpoint env vars, git hooks.")
  .option("--format <fmt>", "text (default) | json", "text")
  .action(async (opts: { format?: string }) => {
    try {
      await runVerify(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("health")
  .description("Ping each configured endpoint and report reachability. Exits 9 if any unreachable.")
  .option("--format <fmt>", "text (default) | json", "text")
  .option("--timeout-ms <ms>", "per-endpoint HTTP timeout", (v) => parseInt(v, 10), 5000)
  .action(async (opts: { format?: string; timeoutMs?: number }) => {
    try {
      await runHealth(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("register-endpoint")
  .description("Append a new LLM endpoint block to ~/.vcf/config.yaml.")
  .requiredOption("--name <name>", "endpoint slug")
  .requiredOption("--provider <provider>", "openai-compatible | anthropic | gemini | local-stub")
  .requiredOption("--base-url <url>", "HTTPS base URL of the endpoint")
  .requiredOption("--trust-level <level>", "local | trusted | public")
  .option("--auth-env-var <var>", "env var holding the API key (SCREAMING_SNAKE_CASE)")
  .action(
    async (opts: {
      name: string;
      provider: string;
      baseUrl: string;
      trustLevel: string;
      authEnvVar?: string;
    }) => {
      try {
        await runRegisterEndpoint(opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

program
  .command("stale-check")
  .description("Flag KB entries past review.stale_primer_days old.")
  .option("--format <fmt>", "text (default) | json", "text")
  .action(async (opts: { format?: string }) => {
    try {
      await runStaleCheck(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

const pack = program
  .command("pack")
  .description("Manage third-party KB packs (community primer extensions).");

pack
  .command("add")
  .description("Register a KB pack directory under kb.packs in config.yaml.")
  .requiredOption("--name <slug>", "unique pack slug (lowercase alphanumeric + hyphen)")
  .requiredOption(
    "--path <absolute-path>",
    "absolute path to the pack root (directory containing kb/)",
  )
  .action(async (opts: { name: string; path: string }) => {
    try {
      await runPackAdd(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

pack
  .command("list")
  .description("List registered KB packs.")
  .action(async () => {
    try {
      await runPackList();
    } catch (e) {
      err((e as Error).message);
    }
  });

pack
  .command("remove")
  .description("Unregister a KB pack from config.yaml.")
  .argument("<name>", "pack slug to remove")
  .action(async (name: string) => {
    try {
      await runPackRemove(name);
    } catch (e) {
      err((e as Error).message);
    }
  });

const project = program
  .command("project")
  .description("Cross-project registry — projects tracked by portfolio_graph + project_list.");

project
  .command("register")
  .description("Add a pre-existing VCF project to the global registry.")
  .requiredOption("--path <absolute-path>", "absolute path to the project root")
  .option("--name <slug>", "override the project's stored name with this slug")
  .action(async (opts: { path: string; name?: string }) => {
    try {
      await runProjectRegister(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("list")
  .description("Show registered projects, state_cache, and last-seen timestamps.")
  .action(async () => {
    try {
      await runProjectList();
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("scan")
  .description(
    "Obsolete: runtime state no longer lives in-tree. Use `vcf adopt <path>` to register a project.",
  )
  .requiredOption("--root <absolute-path>", "(ignored; scan is a no-op)")
  .action(async (opts: { root: string }) => {
    try {
      await runProjectScan(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("unregister")
  .description("Drop a project from the registry (does not touch the project's files).")
  .argument("<name>", "registered project slug")
  .action(async (name: string) => {
    try {
      await runProjectUnregister(name);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("refresh")
  .description("Re-read state_cache from each registered project's project.db.")
  .action(async () => {
    try {
      await runProjectRefresh();
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("move")
  .description(
    "Copy (or move, with --move) a project's directory to a new location and re-point the registry + project.db root_path. Target must live inside workspace.allowed_roots.",
  )
  .argument("<slug>", "registered project slug")
  .argument("<new-path>", "absolute path to copy/move the project to")
  .option(
    "--move",
    "delete the source directory after copy+DB updates succeed (default: copy)",
    false,
  )
  .option("--force", "overwrite non-empty target", false)
  .action(async (slug: string, newPath: string, opts: { move: boolean; force: boolean }) => {
    try {
      await runProjectMove(slug, newPath, opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("rename")
  .description(
    "Rename a project's display name. The slug derived from the new name keys the state-dir under ~/.vcf/projects/, so this also renames the state-dir. root_path is NOT touched.",
  )
  .argument("<slug>", "current registered project slug")
  .argument("<new-name>", "new display name")
  .action(async (slug: string, newName: string) => {
    try {
      await runProjectRename(slug, newName);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("relocate")
  .description(
    "Re-point a project's registered root_path to a new directory WITHOUT moving files. Use when the project directory was moved externally. For an actual copy/move, use `vcf project move` instead.",
  )
  .argument("<slug>", "registered project slug")
  .argument("<new-path>", "absolute path to point root_path at (must already exist)")
  .action(async (slug: string, newPath: string) => {
    try {
      await runProjectRelocate(slug, newPath);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("set-role")
  .description(
    "Designate a project as PM (admin) — unlocks cross-project admin tools (project_move / project_rename / project_relocate) in that project's MCP sessions. Or revert to 'standard'.",
  )
  .argument("<slug>", "registered project slug")
  .argument("<role>", "'pm' or 'standard'")
  .action(async (slug: string, role: string) => {
    try {
      await runProjectSetRole(slug, role);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("adopt")
  .description(
    "Adopt an existing project directory into VCF tracking. Registers the root_path in the global registry and creates project.db under ~/.vcf/projects/<slug>/. Nothing is written into the project directory itself. Use when you want to run review or portfolio tools against a project not born in VCF.",
  )
  .argument("<path>", "absolute path to the existing project directory")
  .option("--name <name>", "human-readable project name (defaults to the directory basename)")
  .option(
    "--state <state>",
    "initial project.state (default: reviewing; one of draft|planning|building|testing|reviewing|shipping|shipped)",
  )
  .action(async (path: string, opts: { name?: string; state?: string }) => {
    try {
      await runAdopt({
        path,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.state !== undefined ? { state: opts.state } : {}),
      });
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("lifecycle-report")
  .description(
    "Emit a lifecycle snapshot for a project: audit, artifacts, reviews, decisions, responses, builds, lessons. Structured mode is deterministic (no LLM). Narrative mode fans per-section LLM calls to config.defaults.lifecycle_report.",
  )
  .option("--project <path>", "absolute path to the project (default: CWD)")
  .option("--mode <mode>", "structured | narrative (default: structured)")
  .option("--format <format>", "md | json | both (default: md)")
  .option("--frontier", "opt into public / frontier endpoints for narrative mode")
  .option(
    "--include <sections>",
    "comma-separated section list (project,audit,artifacts,reviews,decisions,responses,builds,lessons)",
  )
  .action(
    async (opts: {
      project?: string;
      mode?: string;
      format?: string;
      frontier?: boolean;
      include?: string;
    }) => {
      try {
        await runLifecycleReport(opts);
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
      }
    },
  );

program
  .command("install-skills")
  .description(
    "Install the shipped skill pack into an MCP client's skills directory. Supported clients: claude-code, codex, gemini.",
  )
  .argument("<client>", "target client (claude-code | codex | gemini)")
  .option(
    "--dest <path>",
    "skills directory (defaults: ~/.claude/skills, ~/.agents/skills, or ~/.gemini/commands per client)",
  )
  .action(async (client: string, opts: { dest?: string }) => {
    try {
      await runInstallSkills(client, opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("update-primers")
  .description(
    "Pull latest @kaelith-labs/kb into the user's KB root; warn+skip on conflicts (three-way merge is Phase 2).",
  )
  .action(async () => {
    try {
      await runUpdatePrimers();
    } catch (e) {
      err((e as Error).message);
    }
  });

const standards = program
  .command("standards")
  .description("Manage the per-user company-standards overlay under ~/.vcf/kb/standards/.");
standards
  .command("init")
  .description(
    "Seed ~/.vcf/kb/standards/<kind>.md from the shipped .example stubs. Idempotent — existing files are left alone. With no args, seeds all four (company-standards, design-system, brand, privacy).",
  )
  .argument("[kinds...]", "subset to seed: company-standards | design-system | brand | privacy")
  .action(async (kinds: string[]) => {
    try {
      await runStandardsInit({ kinds });
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("embed-kb")
  .description(
    "Precompute embedding vectors for primers/best-practices/lenses/standards. Requires a `config.embeddings` block. Idempotent: unchanged entries are skipped. Cache lives under ~/.vcf/embeddings/ unless overridden.",
  )
  .option("--only <kind>", "restrict to one kind (primer | best-practice | lens | standard)")
  .option("--force", "re-embed even when content hash matches the cached record", false)
  .action(async (opts: { only?: string; force?: boolean }) => {
    try {
      await runEmbedKb(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

const admin = program.command("admin").description("Read-only operator queries.");
admin
  .command("audit")
  .description("Query the global audit trail.")
  .option("--tool <name>")
  .option("--project <path>")
  .option("--since <iso-date>")
  .option("--format <fmt>", "table | json | csv", "table")
  .option(
    "--full",
    "include redacted inputs/outputs JSON (only populated when config.audit.full_payload_storage is true)",
    false,
  )
  .action(
    async (opts: {
      tool?: string;
      project?: string;
      since?: string;
      format: string;
      full?: boolean;
    }) => {
      try {
        await runAdminAudit(opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

admin
  .command("config-history")
  .description(
    "List recent vcf-mcp boot config snapshots (config integrity forensics, followup #48). " +
      "A sha256 delta between adjacent rows means the config file changed between those boots.",
  )
  .option("--path <path>", "filter to a specific config path")
  .option("--limit <n>", "cap rows returned (default 50, max 500)", (v) => parseInt(v, 10))
  .option("--format <fmt>", "table | json", "table")
  .action(async (opts: { path?: string; limit?: number; format: string }) => {
    try {
      await runAdminConfigHistory(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("backup")
  .description(
    "Bundle ~/.vcf state into a tar.gz for offline storage or machine transfer (followup #49).",
  )
  .option("--out <dir>", "destination directory (default: ~/backups/)")
  .option(
    "--include <subsets>",
    "comma-separated: projects | global | kb | all (default: all)",
    "all",
  )
  .option("--format <fmt>", "table | json", "table")
  .action(async (opts: { out?: string; include: string; format: string }) => {
    try {
      await runBackup(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("restore")
  .description(
    "Unpack a vcf backup tarball into ~/.vcf. Existing entries are skipped by default; pass --replace to overwrite.",
  )
  .argument("<archive>", "path to a vcf backup tarball (tar.gz)")
  .option("--dry-run", "print the plan without writing", false)
  .option("--replace", "overwrite entries already present at the target", false)
  .option("--format <fmt>", "table | json", "table")
  .action(
    async (archive: string, opts: { dryRun?: boolean; replace?: boolean; format: string }) => {
      try {
        await runRestore(archive, opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

const migrateCmd = program
  .command("migrate")
  .description("Version-to-version state migrations (followup #50).");
migrateCmd
  .command("0.3")
  .description(
    "Automate the 0.3 → 0.5 state-dir refactor: copy in-tree `<project>/.vcf/project.db` to `~/.vcf/projects/<slug>/`, rewrite root_path, upsert the registry, optionally move `.review-runs/` and delete the source.",
  )
  .option("--project <path>", "single project root (defaults to cwd)")
  .option("--all", "walk workspace.allowed_roots for every in-tree .vcf/project.db", false)
  .option("--name <slug>", "override slug (default: project row name → basename)")
  .option("--delete-source", "remove <project>/.vcf/ after a successful migration", false)
  .option("--dry-run", "report what would happen without writing", false)
  .option("--format <fmt>", "table | json", "table")
  .action(
    async (opts: {
      project?: string;
      all?: boolean;
      name?: string;
      deleteSource?: boolean;
      dryRun?: boolean;
      format: string;
    }) => {
      try {
        await runMigrate03(opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

program
  .command("test-trends")
  .description(
    "Query the cross-project test_runs table. Summarizes pass-rate, duration p95, last-seen per project (default). --format=runs prints raw rows; --format=json is machine-readable.",
  )
  .option("--project <path>", "filter to one project root")
  .option("--since <iso>", "include only runs started on/after this date")
  .option("--limit <n>", "cap raw rows scanned before aggregation (default 500, max 5000)", (v) =>
    parseInt(v, 10),
  )
  .option("--format <fmt>", "summary | runs | json (default: summary)", "summary")
  .action(async (opts: { project?: string; since?: string; limit?: number; format: string }) => {
    try {
      await runTestTrends(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

/**
 * Run the CLI command parser. Split out from the module-body `if` so the
 * SEA entry (src/sea-entry.ts) can call it unconditionally without the
 * import.meta.url comparison that doesn't work in SEA bundles.
 */
export function parseArgv(cmd: Command = program): void {
  cmd.parseAsync(process.argv).catch((e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
  });
}

export { program };

// Only parse argv when this file is run as the CLI entrypoint — otherwise
// importing it from a test (or another module) would trigger a spurious
// command parse against vitest's argv. `pathToFileURL` handles Windows
// drive-letter paths (C:\...) where a naïve `file://` prefix would break.
//
// argv[1] must be resolved through realpath first: Homebrew, Scoop, and
// npm all install the `vcf` binary as a symlink into a versioned
// Cellar / shim directory, so argv[1] is the symlink path while
// import.meta.url is the symlink *target*. Comparing the URLs naïvely
// fails and main() never runs — the binary silently exits 0 on every
// invocation. realpathSync canonicalizes both sides of the comparison.
const entryUrl = (() => {
  const argv1 = process.argv[1];
  if (!argv1 || typeof argv1 !== "string" || argv1 === "") return "";
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // Fallback if realpath fails (e.g. bundled single-file binary, SEA,
    // or missing node_modules). pathToFileURL throws on undefined/empty
    // too, so guard and return empty — the caller checks for equality,
    // and a SEA binary runs its main via src/sea-entry.ts anyway.
    try {
      return pathToFileURL(argv1).href;
    } catch {
      return "";
    }
  }
})();
if (import.meta.url === entryUrl) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
  });
}
