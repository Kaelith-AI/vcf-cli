// Followup #48 — config integrity forensics.
//
// On every `vcf-mcp` boot, capture (path, ctime, mtime, size, sha256) of
// the resolved config file and persist it to the global `config_boots`
// table. Combined with `vcf admin config-history`, the operator can spot a
// post-hoc config swap (re-pointed `base_url`, changed `auth_env_var`) by
// diffing sha256 between boots.
//
// This is a forensic tool, not a gate. VCF explicitly does not attempt to
// prevent an attacker with write access to `~/.vcf/config.yaml` from
// tampering; the value here is discoverability after the fact.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface ConfigBootSnapshot {
  ts: number;
  config_path: string;
  exists_on_disk: boolean;
  ctime_ms: number | null;
  mtime_ms: number | null;
  size_bytes: number | null;
  sha256: string | null;
  prev_sha256: string | null;
  pid: number;
  vcf_version: string;
}

/**
 * Capture + persist a boot snapshot for the given config path.
 *
 * Returns the snapshot (including the previous sha256 for this path if
 * any) so the caller can surface a change to stderr. The function catches
 * its own IO errors — a missing config file isn't fatal (the server has
 * already loaded something, possibly via VCF_CONFIG), and a transient DB
 * failure shouldn't block the MCP handshake.
 */
export function recordConfigBoot(
  globalDb: DatabaseSync,
  configPath: string,
  vcfVersion: string,
): ConfigBootSnapshot {
  const ts = Date.now();
  let exists = false;
  let ctimeMs: number | null = null;
  let mtimeMs: number | null = null;
  let sizeBytes: number | null = null;
  let sha256: string | null = null;

  try {
    const stat = statSync(configPath);
    exists = true;
    ctimeMs = Math.floor(stat.ctimeMs);
    mtimeMs = Math.floor(stat.mtimeMs);
    sizeBytes = stat.size;
    try {
      const bytes = readFileSync(configPath);
      sha256 = createHash("sha256").update(bytes).digest("hex");
    } catch {
      // unreadable; fall through with sha256=null
    }
  } catch {
    // absent or inaccessible — record the absence, still useful in the log
  }

  const prevRow = globalDb
    .prepare("SELECT sha256 FROM config_boots WHERE config_path = ? ORDER BY ts DESC LIMIT 1")
    .get(configPath) as { sha256: string | null } | undefined;
  const prevSha = prevRow?.sha256 ?? null;

  try {
    globalDb
      .prepare(
        `INSERT INTO config_boots
           (ts, config_path, exists_on_disk, ctime_ms, mtime_ms, size_bytes, sha256, prev_sha256, pid, vcf_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        configPath,
        exists ? 1 : 0,
        ctimeMs,
        mtimeMs,
        sizeBytes,
        sha256,
        prevSha,
        process.pid,
        vcfVersion,
      );
  } catch {
    // non-fatal — the boot succeeds even if the forensic row fails
  }

  return {
    ts,
    config_path: configPath,
    exists_on_disk: exists,
    ctime_ms: ctimeMs,
    mtime_ms: mtimeMs,
    size_bytes: sizeBytes,
    sha256,
    prev_sha256: prevSha,
    pid: process.pid,
    vcf_version: vcfVersion,
  };
}

/**
 * Query recent config-boot rows. Result is ordered newest-first. Used by
 * `vcf admin config-history`.
 */
export function listConfigBoots(
  globalDb: DatabaseSync,
  opts: { path?: string; limit?: number } = {},
): ConfigBootSnapshot[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.path) {
    clauses.push("config_path = ?");
    params.push(opts.path);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const rows = globalDb
    .prepare(
      `SELECT ts, config_path, exists_on_disk, ctime_ms, mtime_ms, size_bytes,
              sha256, prev_sha256, pid, vcf_version
         FROM config_boots ${where}
         ORDER BY ts DESC
         LIMIT ${limit}`,
    )
    .all(...params) as Array<{
    ts: number;
    config_path: string;
    exists_on_disk: number;
    ctime_ms: number | null;
    mtime_ms: number | null;
    size_bytes: number | null;
    sha256: string | null;
    prev_sha256: string | null;
    pid: number;
    vcf_version: string;
  }>;
  return rows.map((r) => ({
    ts: r.ts,
    config_path: r.config_path,
    exists_on_disk: r.exists_on_disk === 1,
    ctime_ms: r.ctime_ms,
    mtime_ms: r.mtime_ms,
    size_bytes: r.size_bytes,
    sha256: r.sha256,
    prev_sha256: r.prev_sha256,
    pid: r.pid,
    vcf_version: r.vcf_version,
  }));
}
