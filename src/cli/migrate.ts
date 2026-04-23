// Followup #44 + #50 — `vcf migrate 0.3` CLI handler.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { openGlobalDb } from "../db/global.js";
import { loadConfig } from "../config/loader.js";
import {
  discoverLegacyProjects,
  migrateProject03to05,
} from "../project/migrate03.js";
import { log, vcfHomeDir } from "./_shared.js";

export async function runMigrate03(opts: {
  project?: string;
  all?: boolean;
  name?: string;
  deleteSource?: boolean;
  dryRun?: boolean;
  format: string;
}): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });

  let sources: string[] = [];
  if (opts.all) {
    const configPath =
      process.env["VCF_CONFIG"] ?? resolvePath(vcfHomeDir(), ".vcf", "config.yaml");
    let searchRoots: string[] = [];
    if (existsSync(configPath)) {
      try {
        const config = await loadConfig(configPath);
        searchRoots = config.workspace.allowed_roots;
      } catch {
        // Fall through with an empty list; the emitted report notes none found.
      }
    }
    sources = discoverLegacyProjects(searchRoots);
  } else if (opts.project) {
    sources = [resolvePath(opts.project)];
  } else {
    sources = [process.cwd()];
  }

  interface Report {
    sourcePath: string;
    outcome: string;
    slug?: string;
    state_db_path?: string;
    review_runs_moved?: number;
    deleted_source?: boolean;
    note?: string;
    error?: string;
  }
  const reports: Report[] = [];
  for (const src of sources) {
    try {
      const migrateInput: Parameters<typeof migrateProject03to05>[0] = {
        sourcePath: src,
        globalDb,
        homeDir: vcfHomeDir(),
      };
      if (opts.name !== undefined) migrateInput.name = opts.name;
      if (opts.deleteSource) migrateInput.deleteSource = true;
      if (opts.dryRun) migrateInput.dryRun = true;
      const result = migrateProject03to05(migrateInput);
      const rpt: Report = {
        sourcePath: src,
        outcome: result.outcome,
        slug: result.slug,
        state_db_path: result.stateDbPath,
        review_runs_moved: result.reviewRunsMoved,
        deleted_source: result.deletedSource,
      };
      if (result.note) rpt.note = result.note;
      reports.push(rpt);
    } catch (e) {
      reports.push({
        sourcePath: src,
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  globalDb.close();

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
    return;
  }

  if (reports.length === 0) {
    log("migrate 0.3: no legacy project.db files found");
    return;
  }
  for (const r of reports) {
    if (r.outcome === "error") {
      process.stderr.write(`ERROR  ${r.sourcePath}: ${r.error}\n`);
    } else {
      process.stderr.write(
        `${r.outcome.padEnd(26)} ${r.slug ?? ""}  ${r.sourcePath}\n` +
          `  -> ${r.state_db_path ?? ""}` +
          (r.review_runs_moved ? `  (runs moved: ${r.review_runs_moved})` : "") +
          (r.deleted_source ? "  (source .vcf/ deleted)" : "") +
          (r.note ? `\n  note: ${r.note}` : "") +
          "\n",
      );
    }
  }
  const ok = reports.filter((r) => r.outcome === "migrated").length;
  const already = reports.filter((r) => r.outcome === "already-migrated").length;
  const conflicts = reports.filter((r) => r.outcome === "conflict-existing-state-dir").length;
  const errors = reports.filter((r) => r.outcome === "error").length;
  log(
    `migrate 0.3: ${ok} migrated, ${already} already-migrated, ${conflicts} conflict(s), ${errors} error(s).`,
  );
}
