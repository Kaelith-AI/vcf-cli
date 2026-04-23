// Followup #44 + #27 — `vcf lifecycle-report` CLI handler.

import { resolve as resolvePath, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { openGlobalDb } from "../db/global.js";
import { openProjectDb } from "../db/project.js";
import { projectDbPath } from "../project/stateDir.js";
import { findProjectForCwd } from "../util/projectRegistry.js";
import { err, log, loadConfigOrExit, vcfHomeDir } from "./_shared.js";

export async function runLifecycleReport(opts: {
  project?: string;
  mode?: string;
  format?: string;
  frontier?: boolean;
  include?: string;
}): Promise<void> {
  const target = resolvePath(opts.project ?? process.cwd());
  const config = await loadConfigOrExit();
  const globalDbPath = join(vcfHomeDir(), ".vcf", "vcf.db");
  const globalDb = openGlobalDb({ path: globalDbPath });
  const project = findProjectForCwd(globalDb, target);
  if (!project) {
    globalDb.close();
    err(
      `no registered VCF project at or above ${target} — run 'vcf init' or 'vcf adopt' first`,
      2,
    );
  }
  const dbPath = projectDbPath(project!.name);
  if (!existsSync(dbPath)) {
    globalDb.close();
    err(`project.db missing at ${dbPath} — re-run 'vcf adopt' to heal`, 2);
  }
  const projectDb = openProjectDb({ path: dbPath });

  const mode = (opts.mode ?? "structured") as "structured" | "narrative";
  const format = (opts.format ?? "md") as "md" | "json" | "both";
  const include = opts.include
    ? (opts.include.split(",").map((s) => s.trim()) as ReadonlyArray<string>)
    : undefined;

  const { buildStructuredReport, renderStructuredMarkdown, runNarrativeCore, LifecycleReportInput } =
    await import("../tools/lifecycle_report.js");
  const { LIFECYCLE_SECTION_ORDER } = await import("../schemas/lifecycle-report.schema.js");

  const resolvedInclude =
    (include as (typeof LIFECYCLE_SECTION_ORDER)[number][] | undefined) ??
    [...LIFECYCLE_SECTION_ORDER];

  const report = buildStructuredReport({
    projectDb,
    globalDb,
    projectRoot: target,
    include: resolvedInclude,
    auditRowCap: config.report.audit_rows_per_section,
    recentCap: config.report.recent_rows_per_section,
  });

  const outDir = join(target, "plans");
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "lifecycle-report.json");
  const mdPath = join(outDir, "lifecycle-report.md");

  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  let rendered: string;
  if (mode === "narrative") {
    const parsed = LifecycleReportInput.parse({
      mode,
      format,
      allow_public_endpoint: opts.frontier === true,
    });
    const nr = await runNarrativeCore({ config, parsed, report });
    rendered = nr.markdown;
    log(`narrative generated via ${nr.modelId}@${nr.endpoint}`);
  } else {
    rendered = renderStructuredMarkdown(report, {
      jsonPath,
      includedSections: resolvedInclude,
    });
  }
  await writeFile(mdPath, rendered, "utf8");

  projectDb.close();
  globalDb.close();

  if (format === "json") {
    log(`wrote ${jsonPath}`);
  } else if (format === "both") {
    log(`wrote ${mdPath}`);
    log(`wrote ${jsonPath}`);
  } else {
    log(`wrote ${mdPath}`);
  }
}
