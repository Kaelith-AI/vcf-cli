// Followup #44 — `vcf reindex` CLI handler.
//
// Walks plans/memory/docs markdown under the target project root and
// upserts artifact rows into the project state-dir DB. Classification
// uses path suffix/dir probes only — fast and deterministic.
//
// Followup #25 item 1 — `vcf reindex --ideas`:
// Reconciles the global DB ideas table against the files that exist on
// disk under config.workspace.ideas_dir. Adds rows for files that exist
// but aren't indexed; deletes rows whose file is gone.

import { resolve as resolvePath, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openGlobalDb } from "../db/global.js";
import { openProjectDb } from "../db/project.js";
import { projectDbPath } from "../project/stateDir.js";
import { findProjectForCwd } from "../util/projectRegistry.js";
import { err, log, vcfHomeDir } from "./_shared.js";
import { loadConfig } from "../config/loader.js";

export async function runReindex(opts: { project?: string; ideas?: boolean }): Promise<void> {
  if (opts.ideas) {
    await runReindexIdeas();
    return;
  }

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
 * Reconcile the global DB ideas table against the ideas_dir on disk.
 * - Files that exist on disk but have no row → insert a stub row.
 * - Rows whose file is gone → delete the orphaned row.
 */
async function runReindexIdeas(): Promise<void> {
  const configPath = resolvePath(vcfHomeDir(), ".vcf", "config.yaml");
  if (!existsSync(configPath)) {
    err(`config.yaml not found at ${configPath} — run 'vcf init' first`, 2);
  }
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    err(`failed to load config: ${(e as Error).message}`, 2);
    return;
  }

  const ideasDir = config!.workspace.ideas_dir;
  const globalDbPath = resolvePath(vcfHomeDir(), ".vcf", "vcf.db");
  const globalDb = openGlobalDb({ path: globalDbPath });

  // Walk ideas_dir to collect every .md file on disk.
  const onDisk = new Set<string>();
  async function walkIdeas(dir: string): Promise<void> {
    let entries: string[];
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
        await walkIdeas(full);
      } else if (st.isFile() && name.endsWith(".md")) {
        onDisk.add(full);
      }
    }
  }
  if (existsSync(ideasDir)) {
    await walkIdeas(ideasDir);
  }

  // Fetch all indexed paths from the DB.
  const indexed = globalDb
    .prepare("SELECT path, slug FROM ideas")
    .all() as Array<{ path: string; slug: string }>;
  const indexedPaths = new Set(indexed.map((r) => r.path));

  // Delete orphaned rows (file gone).
  let deleted = 0;
  for (const row of indexed) {
    if (!onDisk.has(row.path)) {
      globalDb.prepare("DELETE FROM ideas WHERE path = ?").run(row.path);
      deleted++;
    }
  }

  // Insert missing rows (file exists but not indexed).
  let added = 0;
  for (const filePath of onDisk) {
    if (!indexedPaths.has(filePath)) {
      // Derive a slug from the filename: strip dir + .md extension.
      const fname = filePath.split("/").at(-1) ?? filePath;
      const slug = fname.replace(/\.md$/, "");
      // Read frontmatter for tags if available; fall back to empty.
      let frontmatterJson = "{}";
      let tags = "[]";
      try {
        const body = await readFile(filePath, "utf8");
        const fm = extractIdeasFrontmatter(body);
        if (fm) {
          frontmatterJson = JSON.stringify(fm);
          if (Array.isArray(fm["tags"])) {
            tags = JSON.stringify(fm["tags"]);
          }
        }
      } catch {
        /* non-fatal */
      }
      const fileStat = await stat(filePath).catch(() => null);
      const createdAt = fileStat?.mtimeMs ?? Date.now();
      globalDb
        .prepare(
          `INSERT INTO ideas (path, slug, tags, created_at, frontmatter_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(filePath, slug, tags, createdAt, frontmatterJson);
      added++;
    }
  }

  globalDb.close();
  log(
    `reindex ideas: ${added} added, ${deleted} orphaned rows removed, ${onDisk.size} files on disk in ${ideasDir}`,
  );
}

/** Minimal frontmatter extractor for idea files. */
function extractIdeasFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = raw.slice(3, end).trim();
  const obj: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      obj[key] =
        inner.length === 0
          ? []
          : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    obj[key] = value.replace(/^["']|["']$/g, "");
  }
  return obj;
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
