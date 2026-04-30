// Followup #44 + #17 — `vcf test-trends` CLI handler.
//
// Reads the cross-project test_runs table populated by every test_execute
// call. Answers "how are tests trending across my portfolio over the
// last N days?" without having to open every project.db.

import { resolve as resolvePath } from "node:path";
import { openGlobalDb } from "../db/global.js";
import { err, log, vcfHomeDir } from "./_shared.js";

interface TestRunRow {
  id: number;
  project_root: string;
  command: string;
  args_json: string;
  cwd: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  canceled: number;
  passed: number;
}

interface TrendSummary {
  project_root: string;
  total_runs: number;
  passed: number;
  failed: number;
  pass_rate: number;
  last_run_at: number;
  median_duration_ms: number;
  p95_duration_ms: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx]!;
}

export async function runTestTrends(opts: {
  project?: string;
  since?: string;
  limit?: number;
  format: string;
}): Promise<void> {
  const globalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  try {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.project) {
      clauses.push("project_root = ?");
      params.push(resolvePath(opts.project));
    }
    if (opts.since) {
      const ts = Date.parse(opts.since);
      if (!Number.isFinite(ts)) err(`invalid --since: ${opts.since}`, 2);
      clauses.push("started_at >= ?");
      params.push(ts);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
    const rows = globalDb
      .prepare(
        `SELECT id, project_root, command, args_json, cwd, started_at, finished_at,
                duration_ms, exit_code, signal, timed_out, canceled, passed
           FROM test_runs ${where}
           ORDER BY started_at DESC
           LIMIT ${limit}`,
      )
      .all(...params) as unknown as TestRunRow[];

    if (opts.format === "runs") {
      if (rows.length === 0) {
        log("test-trends: no runs found in the window.");
        return;
      }
      for (const r of rows) {
        const ts = new Date(r.started_at).toISOString();
        const verdict = r.passed
          ? "PASS"
          : r.timed_out
            ? "TIMEOUT"
            : r.canceled
              ? "CANCELED"
              : "FAIL";
        process.stderr.write(
          `${ts}  ${verdict.padEnd(8)} ${r.command.padEnd(20)} ${r.duration_ms.toString().padStart(6)}ms  ${r.project_root}\n`,
        );
      }
      log(`test-trends: ${rows.length} run(s)`);
      return;
    }

    // Default mode: aggregate per project_root.
    const byProject = new Map<string, TestRunRow[]>();
    for (const r of rows) {
      let bucket = byProject.get(r.project_root);
      if (!bucket) {
        bucket = [];
        byProject.set(r.project_root, bucket);
      }
      bucket.push(r);
    }
    const summaries: TrendSummary[] = [];
    for (const [projectRoot, bucket] of byProject) {
      const durations = bucket.map((r) => r.duration_ms).sort((a, b) => a - b);
      const passedCount = bucket.filter((r) => r.passed === 1).length;
      summaries.push({
        project_root: projectRoot,
        total_runs: bucket.length,
        passed: passedCount,
        failed: bucket.length - passedCount,
        pass_rate: bucket.length > 0 ? passedCount / bucket.length : 0,
        last_run_at: Math.max(...bucket.map((r) => r.started_at)),
        median_duration_ms: percentile(durations, 0.5),
        p95_duration_ms: percentile(durations, 0.95),
      });
    }
    summaries.sort((a, b) => b.last_run_at - a.last_run_at);

    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(summaries, null, 2) + "\n");
      return;
    }
    if (summaries.length === 0) {
      log("test-trends: no runs found in the window.");
      return;
    }
    for (const s of summaries) {
      const pct = (s.pass_rate * 100).toFixed(1);
      const age = `${Math.floor((Date.now() - s.last_run_at) / 60_000)}m ago`;
      process.stderr.write(
        `  ${s.project_root}\n` +
          `    runs=${s.total_runs}  pass=${s.passed} fail=${s.failed}  pass_rate=${pct}%  median=${s.median_duration_ms}ms  p95=${s.p95_duration_ms}ms  last=${age}\n`,
      );
    }
    log(
      `test-trends: ${summaries.length} project(s), ${rows.length} run(s)${opts.since ? ` since ${opts.since}` : ""}`,
    );
  } finally {
    globalDb.close();
  }
}
