#!/usr/bin/env node
// Stress harness for spec_template + spec_save.
//
// Uses the same stdio-JSON-RPC pattern as idea-capture/run.mjs. Writes to a
// temp workspace so the real specs_dir stays clean. Seeds a known idea first
// so the spec_template idea_ref case can resolve.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import cases from "./cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- temp workspace --------------------------------------------------------
const stressRoot = mkdtempSync(join(tmpdir(), "vcf-stress-spec-"));
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
    "telemetry: { error_reporting_enabled: false }",
    "audit: { full_payload_storage: true }",
    "",
  ].join("\n"),
);

const globalDbDir = join(stressRoot, ".vcf-home", ".vcf");
mkdirSync(globalDbDir, { recursive: true });

// ---- spawn ----------------------------------------------------------------
const child = spawn("vcf-mcp", ["--scope", "global"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VCF_CONFIG: configPath,
    HOME: join(stressRoot, ".vcf-home"),
  },
});

let stderrBuf = "";
child.stderr.on("data", (c) => (stderrBuf += c.toString()));

let nextId = 1;
const pending = new Map();
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} #${id}`));
      }
    }, 60_000);
  });
}

async function main() {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "stress-spec", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Seed idea for the idea_ref case.
  const seed = await request("tools/call", {
    name: "idea_capture",
    arguments: {
      content:
        "harness seed idea: referenced by the spec_template stress case to exercise the idea_ref code path.",
      title: "harness seed idea",
      tags: ["stress-seed"],
    },
  });
  const seedRaw = seed.result?.content?.[0]?.text;
  try {
    const seedEnv = JSON.parse(seedRaw ?? "{}");
    if (!seedEnv.ok) {
      console.error("SEED FAILED:", seedEnv);
    }
  } catch {}

  const started = Date.now();
  const report = {
    started_at: new Date(started).toISOString(),
    config_path: configPath,
    total_cases: cases.length,
    results: [],
    totals: {
      by_tool: {},
      by_category: {},
      ok_count: 0,
      error_count: 0,
      expected_error_got_ok: 0,
      expected_ok_got_error: 0,
    },
  };

  let i = 0;
  for (const c of cases) {
    i++;
    process.stdout.write(`  [${i}/${cases.length}] ${c.tool} ${c.category} — case ${c.id}\r`);

    let envelope;
    let transport_error;
    try {
      const reply = await request("tools/call", { name: c.tool, arguments: c.args });
      if (reply.error) {
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

    report.totals.by_tool[c.tool] ??= { ok: 0, err: 0, mismatches: 0 };
    report.totals.by_category[c.category] ??= { ok: 0, err: 0, mismatches: 0 };
    const toolBucket = report.totals.by_tool[c.tool];
    const catBucket = report.totals.by_category[c.category];
    if (okActual === okExpected) {
      okActual ? toolBucket.ok++ : toolBucket.err++;
      okActual ? catBucket.ok++ : catBucket.err++;
    } else {
      toolBucket.mismatches++;
      catBucket.mismatches++;
    }

    // Don't store giant content bodies in the report — truncate.
    const argsSnapshot = { ...c.args };
    if (typeof argsSnapshot.content === "string" && argsSnapshot.content.length > 500) {
      argsSnapshot.content =
        argsSnapshot.content.slice(0, 300) +
        `…[truncated, total ${argsSnapshot.content.length} chars]`;
    }

    report.results.push({
      id: c.id,
      tool: c.tool,
      category: c.category,
      expect: c.expect,
      notes: c.notes ?? null,
      args: argsSnapshot,
      envelope,
      ...(transport_error ? { transport_error } : {}),
    });
  }

  process.stdout.write("\n");
  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started;

  const ts = new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "").slice(0, 15);
  const reportPath = join(__dirname, `report-${ts}.json`);
  const summaryPath = join(__dirname, `report-${ts}.md`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(summaryPath, renderMarkdown(report, reportPath));

  console.log("");
  console.log(`Report JSON:     ${reportPath}`);
  console.log(`Report Markdown: ${summaryPath}`);
  console.log(`Duration:        ${report.duration_ms} ms`);
  console.log(
    `Totals:          ok=${report.totals.ok_count} expected-errors=${report.totals.error_count} mismatches=${report.totals.expected_ok_got_error + report.totals.expected_error_got_ok}`,
  );
  for (const [t, b] of Object.entries(report.totals.by_tool)) {
    console.log(`  ${t.padEnd(16)} ok=${b.ok} err=${b.err} mismatches=${b.mismatches}`);
  }
  console.log(`\nTemp workspace: ${stressRoot}`);

  child.stdin.end();
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 500);
}

function renderMarkdown(report, reportJsonPath) {
  const lines = [];
  lines.push(`# spec stress report`);
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
  lines.push("");
  lines.push("## By tool");
  lines.push("");
  lines.push("| tool | ok | err (expected) | mismatches |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [t, b] of Object.entries(report.totals.by_tool)) {
    lines.push(`| ${t} | ${b.ok} | ${b.err} | ${b.mismatches} |`);
  }
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| category | ok | err (expected) | mismatches |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [c, b] of Object.entries(report.totals.by_category)) {
    lines.push(`| ${c} | ${b.ok} | ${b.err} | ${b.mismatches} |`);
  }
  lines.push("");
  lines.push("## Mismatches");
  lines.push("");
  const mm = report.results.filter((r) => (r.envelope.ok === true) !== (r.expect === "ok"));
  if (mm.length === 0) lines.push("_none_");
  else
    for (const m of mm.slice(0, 40)) {
      lines.push(
        `- **#${m.id} [${m.tool} / ${m.category}] expect=${m.expect} got ok=${m.envelope.ok}**`,
      );
      if (m.notes) lines.push(`  - notes: ${m.notes}`);
      lines.push(`  - code: \`${m.envelope.code ?? "-"}\``);
      if (m.envelope.message)
        lines.push(`  - message: ${String(m.envelope.message).slice(0, 220)}`);
    }
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error("harness fatal:", e);
  console.error("vcf-mcp stderr tail:\n" + stderrBuf.slice(-1500));
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
