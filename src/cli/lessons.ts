// Followup #44 + #42 — `vcf lessons reconcile` CLI handler.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { openGlobalDb } from "../db/global.js";
import { openProjectDb } from "../db/project.js";
import { projectDbPath } from "../project/stateDir.js";
import { findProjectForCwd } from "../util/projectRegistry.js";
import { reconcileLessons } from "../project/lessonsReconcile.js";
import { getGlobalLessonsDb } from "../db/globalLessons.js";
import { loadConfig } from "../config/loader.js";
import { err, log, vcfHomeDir } from "./_shared.js";

export async function runLessonsReconcile(opts: {
  project?: string;
  all?: boolean;
  limit?: number;
  format: string;
}): Promise<void> {
  const globalDbPath = resolvePath(vcfHomeDir(), ".vcf", "vcf.db");
  const globalDb = openGlobalDb({ path: globalDbPath });

  // Resolve the lessons-DB path from config (honors VCF_CONFIG + null).
  const configPath =
    process.env["VCF_CONFIG"] ?? resolvePath(vcfHomeDir(), ".vcf", "config.yaml");
  let lessonsDb: ReturnType<typeof getGlobalLessonsDb> = null;
  let configPathForMessage = "(default)";
  if (existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      lessonsDb = getGlobalLessonsDb(config.lessons.global_db_path);
      configPathForMessage = configPath;
    } catch (e) {
      err(`unable to load config at ${configPath}: ${(e as Error).message}`);
      return;
    }
  } else {
    lessonsDb = getGlobalLessonsDb(undefined);
  }
  if (lessonsDb === null) {
    err(
      `lessons reconcile: mirror disabled by config (${configPathForMessage}: lessons.global_db_path = null). Re-enable it first.`,
    );
    globalDb.close();
    return;
  }

  interface ProjectTarget {
    slug: string;
    root: string;
    dbPath: string;
  }
  const targets: ProjectTarget[] = [];
  if (opts.all) {
    const rows = globalDb
      .prepare("SELECT name, root_path FROM projects ORDER BY name")
      .all() as Array<{ name: string; root_path: string }>;
    for (const r of rows) {
      targets.push({ slug: r.name, root: r.root_path, dbPath: projectDbPath(r.name) });
    }
  } else {
    const target = resolvePath(opts.project ?? process.cwd());
    const project = findProjectForCwd(globalDb, target);
    if (!project) {
      err(
        `no registered VCF project at or above ${target} — run 'vcf init' or 'vcf adopt' first`,
        2,
      );
      globalDb.close();
      return;
    }
    targets.push({
      slug: project.name,
      root: project.root_path,
      dbPath: projectDbPath(project.name),
    });
  }
  globalDb.close();

  interface Report {
    slug: string;
    root: string;
    attempted: number;
    mirrored: number;
    already_present: number;
    failed: number;
    failures: Array<{ lesson_id: number; error: string }>;
    error?: string;
  }
  const reports: Report[] = [];
  for (const t of targets) {
    if (!existsSync(t.dbPath)) {
      reports.push({
        slug: t.slug,
        root: t.root,
        attempted: 0,
        mirrored: 0,
        already_present: 0,
        failed: 0,
        failures: [],
        error: `project.db missing at ${t.dbPath}`,
      });
      continue;
    }
    const projectDb = openProjectDb({ path: t.dbPath });
    try {
      const reconcileOpts: Parameters<typeof reconcileLessons>[0] = {
        projectDb,
        projectRoot: t.root,
        globalDb: lessonsDb,
      };
      if (opts.limit !== undefined && Number.isFinite(opts.limit)) {
        reconcileOpts.limit = opts.limit;
      }
      const result = reconcileLessons(reconcileOpts);
      reports.push({ slug: t.slug, root: t.root, ...result });
    } catch (e) {
      reports.push({
        slug: t.slug,
        root: t.root,
        attempted: 0,
        mirrored: 0,
        already_present: 0,
        failed: 0,
        failures: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      projectDb.close();
    }
  }

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
    return;
  }
  for (const r of reports) {
    if (r.error) {
      process.stderr.write(`${r.slug}  ERROR: ${r.error}  (root=${r.root})\n`);
      continue;
    }
    process.stderr.write(
      `${r.slug}  attempted=${r.attempted}  mirrored=${r.mirrored}  already_present=${r.already_present}  failed=${r.failed}  (root=${r.root})\n`,
    );
    for (const f of r.failures) {
      process.stderr.write(`  lesson #${f.lesson_id}: ${f.error}\n`);
    }
  }
  const totalMirrored = reports.reduce((n, r) => n + r.mirrored, 0);
  const totalPresent = reports.reduce((n, r) => n + r.already_present, 0);
  const totalFailed = reports.reduce((n, r) => n + r.failed, 0);
  log(
    `lessons reconcile: ${reports.length} project(s); mirrored=${totalMirrored}, already_present=${totalPresent}, failed=${totalFailed}.`,
  );
}
