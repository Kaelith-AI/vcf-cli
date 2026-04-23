// Followup #44 — `vcf reindex` CLI handler.
//
// Walks plans/memory/docs markdown under the target project root and
// upserts artifact rows into the project state-dir DB. Classification
// uses path suffix/dir probes only — fast and deterministic.

import { resolve as resolvePath, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openGlobalDb } from "../db/global.js";
import { openProjectDb } from "../db/project.js";
import { projectDbPath } from "../project/stateDir.js";
import { findProjectForCwd } from "../util/projectRegistry.js";
import { err, log, vcfHomeDir } from "./_shared.js";

export async function runReindex(opts: { project?: string }): Promise<void> {
  const target = resolvePath(opts.project ?? process.cwd());
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  const project = findProjectForCwd(globalDb, target);
  globalDb.close();
  if (!project) {
    err(
      `no registered VCF project at or above ${target} — run 'vcf init' or 'vcf adopt' first`,
      2,
    );
  }
  const dbPath = projectDbPath(project!.name);
  if (!existsSync(dbPath)) {
    err(`project.db missing at ${dbPath} — re-run 'vcf adopt' to heal`, 2);
  }
  const db = openProjectDb({ path: dbPath });

  const toIndex = ["plans", "memory", "docs"];
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile() && name.endsWith(".md")) {
        const body = await readFile(full, "utf8");
        const hash = "sha256:" + createHash("sha256").update(body).digest("hex");
        const kind = classifyKind(full);
        db.prepare(
          `INSERT INTO artifacts (path, kind, frontmatter_json, mtime, hash)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             kind = excluded.kind,
             mtime = excluded.mtime,
             hash = excluded.hash`,
        ).run(full, kind, "{}", st.mtimeMs, hash);
        count++;
      }
    }
  }
  for (const sub of toIndex) await walk(join(target, sub));
  db.close();
  log(`reindex complete: ${count} artifact(s) upserted under ${target}`);
}

/**
 * Classify a path into an artifact kind from filename + directory probes.
 * Exported so other tools (lifecycle_report, reindex automation) can
 * reproduce the convention without duplicating rules.
 */
export function classifyKind(filePath: string): string {
  // Normalize backslashes to forward-slashes so the directory-probe checks
  // below behave identically on Windows (path.sep='\\') and POSIX.
  const p = filePath.replace(/\\/g, "/");
  if (p.includes("/plans/decisions/")) return "decision";
  if (p.endsWith("-plan.md")) return "plan";
  if (p.endsWith("-todo.md")) return "todo";
  if (p.endsWith("-manifest.md")) return "manifest";
  if (p.endsWith("-spec.md")) return "spec";
  if (p.includes("/memory/daily-logs/")) return "daily-log";
  if (p.includes("/plans/reviews/")) return "review-report";
  return "doc";
}
