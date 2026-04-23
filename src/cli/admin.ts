// Followup #44 + #48 — `vcf admin audit` / `vcf admin config-history` CLI handlers.

import { resolve as resolvePath } from "node:path";
import { openGlobalDb } from "../db/global.js";
import { listConfigBoots } from "../util/configBoot.js";
import { csvEscape, log, vcfHomeDir } from "./_shared.js";

export async function runAdminAudit(opts: {
  tool?: string;
  project?: string;
  since?: string;
  format: string;
  full?: boolean;
}): Promise<void> {
  // Open writable: the global DB may not exist yet on first CLI run.
  // node:sqlite's readOnly mode refuses to create missing files, so we
  // accept the tiny cost of creating an empty DB here (migrations are
  // idempotent).
  const globalDb = openGlobalDb({
    path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db"),
  });
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.tool) {
    clauses.push("tool = ?");
    params.push(opts.tool);
  }
  if (opts.project) {
    clauses.push("project_root = ?");
    params.push(resolvePath(opts.project));
  }
  if (opts.since) {
    const ts = Date.parse(opts.since);
    if (Number.isFinite(ts)) {
      clauses.push("ts >= ?");
      params.push(ts);
    }
  }
  const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
  const extra = opts.full ? ", inputs_json, outputs_json" : "";
  const rows = globalDb
    .prepare(
      `SELECT id, ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, endpoint, result_code${extra}
       FROM audit ${where} ORDER BY ts DESC LIMIT 500`,
    )
    .all(...params) as Array<{
    id: number;
    ts: number;
    tool: string;
    scope: string;
    project_root: string | null;
    client_id: string | null;
    inputs_hash: string;
    outputs_hash: string;
    endpoint: string | null;
    result_code: string;
    inputs_json?: string | null;
    outputs_json?: string | null;
  }>;

  if (opts.format === "json") {
    // stdout so `vcf admin audit --format json | jq` works. The CLI is not
    // the MCP stdio transport (that's src/mcp.ts).
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (opts.format === "csv") {
    const header = opts.full
      ? "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code,inputs_json,outputs_json\n"
      : "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code\n";
    process.stdout.write(header);
    for (const r of rows) {
      const base = [
        r.id,
        r.ts,
        r.tool,
        r.scope,
        r.project_root ?? "",
        r.client_id ?? "",
        r.inputs_hash,
        r.outputs_hash,
        r.endpoint ?? "",
        r.result_code,
      ];
      const full = opts.full
        ? [csvEscape(r.inputs_json ?? ""), csvEscape(r.outputs_json ?? "")]
        : [];
      process.stdout.write([...base, ...full].join(",") + "\n");
    }
  } else {
    // table
    for (const r of rows) {
      process.stderr.write(
        `${new Date(r.ts).toISOString()}  ${r.scope.padEnd(7)} ${r.tool.padEnd(26)} ${r.result_code.padEnd(16)} ${r.project_root ?? "-"}\n`,
      );
      if (opts.full && (r.inputs_json || r.outputs_json)) {
        process.stderr.write(`  inputs:  ${r.inputs_json ?? "(null)"}\n`);
        process.stderr.write(`  outputs: ${r.outputs_json ?? "(null)"}\n`);
      }
    }
    log(
      `admin audit: ${rows.length} row(s)${opts.full ? " (--full: includes redacted payloads when available)" : ""}`,
    );
  }
  globalDb.close();
}

export async function runAdminConfigHistory(opts: {
  path?: string;
  limit?: number;
  format: string;
}): Promise<void> {
  const globalDb = openGlobalDb({
    path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db"),
  });
  try {
    const listOpts: { path?: string; limit?: number } = {};
    if (opts.path !== undefined) listOpts.path = opts.path;
    if (opts.limit !== undefined && Number.isFinite(opts.limit)) listOpts.limit = opts.limit;
    const rows = listConfigBoots(globalDb, listOpts);

    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }

    if (rows.length === 0) {
      log("admin config-history: no boot rows recorded yet.");
      return;
    }
    for (const r of rows) {
      const ts = new Date(r.ts).toISOString();
      const sha = r.sha256 ? r.sha256.slice(0, 12) : "(missing)";
      const prev = r.prev_sha256 ? r.prev_sha256.slice(0, 12) : "(none)";
      const changed = r.prev_sha256 !== null && r.sha256 !== null && r.prev_sha256 !== r.sha256;
      const delta = changed ? " ← CHANGED" : "";
      process.stderr.write(
        `${ts}  pid=${r.pid}  v${r.vcf_version}  sha=${sha}  prev=${prev}${delta}\n  path=${r.config_path}\n`,
      );
    }
    log(`admin config-history: ${rows.length} row(s)`);
  } finally {
    globalDb.close();
  }
}
