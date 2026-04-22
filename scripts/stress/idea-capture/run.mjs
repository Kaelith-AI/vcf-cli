#!/usr/bin/env node
// Stress harness for idea_capture.
//
// Spawns vcf-mcp against a temp config (so the real ideas_dir stays clean),
// walks every case in cases.mjs, records the envelope, and emits a report.
// Haiku quality review happens out-of-band (the caller batches the report
// entries into subagent prompts).
//
// Usage:
//   node scripts/stress/idea-capture/run.mjs [--limit N]

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import cases from "./cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const limitFlag = args.indexOf("--limit");
const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : cases.length;

// ---- temp workspace so we don't pollute ~/.vcf or ~/vcf/ideas --------------

const stressRoot = mkdtempSync(join(tmpdir(), "vcf-stress-ic-"));
const ideasDir = join(stressRoot, "ideas");
const specsDir = join(stressRoot, "specs");
const configPath = join(stressRoot, "config.yaml");
mkdirSync(ideasDir, { recursive: true });
mkdirSync(specsDir, { recursive: true });

writeFileSync(
  configPath,
  [
    "version: 1",
    "workspace:",
    `  allowed_roots: [${JSON.stringify(stressRoot)}]`,
    `  ideas_dir: ${JSON.stringify(ideasDir)}`,
    `  specs_dir: ${JSON.stringify(specsDir)}`,
    "endpoints:",
    "  - name: local-ollama",
    "    provider: openai-compatible",
    "    base_url: http://127.0.0.1:11434/v1",
    "    trust_level: local",
    "kb:",
    `  root: ${JSON.stringify(join(homedir(), ".vcf", "kb"))}`,
    "  packs: []",
    "telemetry:",
    "  error_reporting_enabled: false",
    "audit:",
    "  full_payload_storage: true",
    "",
  ].join("\n"),
);

// Use a private global-DB so audit rows from the stress run don't mingle with
// the user's real audit trail.
const globalDbDir = join(stressRoot, ".vcf-home", ".vcf");
mkdirSync(globalDbDir, { recursive: true });

// ---- spawn vcf-mcp ---------------------------------------------------------

const child = spawn("vcf-mcp", ["--scope", "global"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VCF_CONFIG: configPath,
    HOME: join(stressRoot, ".vcf-home"),
  },
});

let stderrBuf = "";
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

// Simple JSON-RPC-over-stdio client. Each line on stdout is a JSON-RPC message.

let nextId = 1;
const pending = new Map();
let stdoutLeftover = "";

child.stdout.on("data", (chunk) => {
  stdoutLeftover += chunk.toString();
  let nl;
  while ((nl = stdoutLeftover.indexOf("\n")) >= 0) {
    const line = stdoutLeftover.slice(0, nl).trim();
    stdoutLeftover = stdoutLeftover.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Not a JSON line (pino diagnostic spew) — ignore.
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(line);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for reply to ${method} #${id}`));
      }
    }, 30_000);
  });
}

// ---- run -------------------------------------------------------------------

const started = Date.now();
const report = {
  started_at: new Date(started).toISOString(),
  config_path: configPath,
  total_cases: Math.min(limit, cases.length),
  results: [],
  totals: {
    by_category: {},
    ok_count: 0,
    error_count: 0,
    expected_error_got_ok: 0,
    expected_ok_got_error: 0,
    parse_failures: 0,
  },
};

async function main() {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "stress-ic", version: "0" },
  });
  // MCP requires the initialized notification after receiving the initialize
  // response. Some servers gate tool calls on it.
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const effective = cases.slice(0, limit);
  let i = 0;
  for (const c of effective) {
    i++;
    process.stdout.write(`  [${i}/${effective.length}] ${c.category} — case ${c.id}\r`);

    let envelope;
    let transport_error;
    try {
      const reply = await request("tools/call", {
        name: "idea_capture",
        arguments: c.args,
      });

      if (reply.error) {
        // Protocol-level rejection (usually InputValidationError on a wrong-shape arg).
        envelope = {
          ok: false,
          code: reply.error.code ?? "E_PROTOCOL_ERROR",
          message: reply.error.message,
        };
      } else {
        const raw = reply.result?.content?.[0]?.text;
        try {
          envelope =
            typeof raw === "string" ? JSON.parse(raw) : { ok: false, code: "E_NO_CONTENT" };
        } catch (e) {
          envelope = { ok: false, code: "E_PARSE_FAIL", message: String(e) };
          report.totals.parse_failures++;
        }
      }
    } catch (e) {
      transport_error = String(e);
      envelope = { ok: false, code: "E_TRANSPORT", message: transport_error };
    }

    const okActual = envelope.ok === true;
    const okExpected = c.expect === "ok";
    if (okActual && okExpected) report.totals.ok_count++;
    if (!okActual && !okExpected) report.totals.error_count++;
    if (!okActual && okExpected) report.totals.expected_ok_got_error++;
    if (okActual && !okExpected) report.totals.expected_error_got_ok++;
    report.totals.by_category[c.category] ??= { ok: 0, err: 0, mismatches: 0 };
    const bucket = report.totals.by_category[c.category];
    if (okActual === okExpected) {
      okActual ? bucket.ok++ : bucket.err++;
    } else {
      bucket.mismatches++;
    }

    report.results.push({
      id: c.id,
      category: c.category,
      expect: c.expect,
      notes: c.notes ?? null,
      args: c.args,
      envelope,
      ...(transport_error ? { transport_error } : {}),
    });
  }

  process.stdout.write("\n");

  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started;

  const ts = new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "").slice(0, 15);
  const reportPath = join(__dirname, `report-${ts}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const summaryPath = join(__dirname, `report-${ts}.md`);
  writeFileSync(summaryPath, renderMarkdownSummary(report, reportPath));

  console.log("");
  console.log(`Report JSON:     ${reportPath}`);
  console.log(`Report Markdown: ${summaryPath}`);
  console.log(`Duration:        ${report.duration_ms} ms`);
  console.log(
    `Totals:          ok=${report.totals.ok_count} expected-errors=${report.totals.error_count} mismatches=${report.totals.expected_ok_got_error + report.totals.expected_error_got_ok}`,
  );
  for (const [cat, b] of Object.entries(report.totals.by_category)) {
    console.log(`  ${cat.padEnd(18)} ok=${b.ok} err=${b.err} mismatches=${b.mismatches}`);
  }

  child.stdin.end();
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 500);

  // Leave stressRoot on disk for post-mortem — user can rm -rf it or re-use.
  console.log(`\nTemp workspace kept at: ${stressRoot}`);
}

function renderMarkdownSummary(report, reportJsonPath) {
  const lines = [];
  lines.push(`# idea_capture stress report`);
  lines.push("");
  lines.push(`- Started: ${report.started_at}`);
  lines.push(`- Finished: ${report.finished_at}`);
  lines.push(`- Duration: ${report.duration_ms} ms`);
  lines.push(`- Cases: ${report.total_cases}`);
  lines.push(`- Config: ${report.config_path}`);
  lines.push(`- Full JSON: ${reportJsonPath}`);
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`- Happy path (expect ok, got ok): **${report.totals.ok_count}**`);
  lines.push(`- Correctly rejected (expect error, got error): **${report.totals.error_count}**`);
  lines.push(
    `- **Expected ok, got error** (regression risk): **${report.totals.expected_ok_got_error}**`,
  );
  lines.push(
    `- **Expected error, got ok** (silent acceptance): **${report.totals.expected_error_got_ok}**`,
  );
  lines.push(`- Parse failures: ${report.totals.parse_failures}`);
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| category | ok | err (expected) | mismatches |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [cat, b] of Object.entries(report.totals.by_category)) {
    lines.push(`| ${cat} | ${b.ok} | ${b.err} | ${b.mismatches} |`);
  }
  lines.push("");
  lines.push("## Mismatches (top 40)");
  lines.push("");
  const mismatches = report.results.filter((r) => (r.envelope.ok === true) !== (r.expect === "ok"));
  if (mismatches.length === 0) {
    lines.push("_none_");
  } else {
    for (const m of mismatches.slice(0, 40)) {
      lines.push(`- **#${m.id} [${m.category}] expect=${m.expect} got ok=${m.envelope.ok}**`);
      if (m.notes) lines.push(`  - notes: ${m.notes}`);
      lines.push(`  - code: \`${m.envelope.code ?? "-"}\``);
      if (m.envelope.message) lines.push(`  - message: ${m.envelope.message.slice(0, 200)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error("harness fatal:", e);
  console.error("vcf-mcp stderr tail:\n" + stderrBuf.slice(-2000));
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
