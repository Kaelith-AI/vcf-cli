#!/usr/bin/env node
// #33 — Model matrix review fixture.
//
// Generalization of scripts/stress/review/run.mjs: run the 27-stage review
// (3 types × 9 stages) against N models instead of 2, and produce a matrix
// report showing agreement clusters + outliers.
//
// Configure MODELS below with (label, endpoint, model_id, timeout_ms,
// overlay?). Labels must be unique. overlay is optional — when set, the
// reviewer_type.<overlay>.md variant is loaded (via review_prepare's
// existing resolution path) if present in the KB.
//
// Requirements:
//   - project adopted at PROJECT_ROOT
//   - env vars required by each configured endpoint (LITELLM_MASTER_KEY,
//     OLLAMA_HOST, etc.) per config.yaml
//
// Runs SEQUENTIALLY. With 6 models × 27 stages and average 30s-120s per
// stage, plan for a 90-360 minute wall-clock run. Fine for an overnight
// dogfood pass; wire a subagent layer later if you need parallelism.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- configuration ---------------------------------------------------------

const PROJECT_ROOT = "/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli";
const DIFF_REF = process.env.VCF_MATRIX_DIFF_REF ?? "v0.6.2";
const CONFIG_PATH = process.env.VCF_CONFIG ?? "/home/kaelith/.vcf/config.yaml";

const REVIEW_TYPES = (process.env.VCF_MATRIX_TYPES ?? "code,security,production")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STAGES = (process.env.VCF_MATRIX_STAGES ?? "1,2,3,4,5,6,7,8,9")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

// Candidate grid per followup #33. Trim to what your config actually
// exposes. Labels appear as column headers in the matrix report.
const MODELS = [
  { label: "gpt-5.4", endpoint: "litellm", model_id: "CLIProxyAPI/gpt-5.4", timeout_ms: 180_000 },
  {
    label: "claude-opus-4-7",
    endpoint: "litellm",
    model_id: "CLIProxyAPI/claude-opus-4-7",
    timeout_ms: 240_000,
  },
  {
    label: "gemini-2.5-pro",
    endpoint: "litellm",
    model_id: "CLIProxyAPI/gemini-2.5-pro",
    timeout_ms: 240_000,
  },
  {
    label: "qwen3-coder-30b",
    endpoint: "local-ollama",
    model_id: "qwen3-coder:30b",
    timeout_ms: 360_000,
  },
  { label: "gemma4-31b", endpoint: "local-ollama", model_id: "gemma4:31b", timeout_ms: 360_000 },
  { label: "qwen3-32b", endpoint: "local-ollama", model_id: "qwen3:32b", timeout_ms: 360_000 },
];

// ---- spawn project-scope vcf-mcp ------------------------------------------

const child = spawn("vcf-mcp", ["--scope", "project"], {
  cwd: PROJECT_ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, VCF_CONFIG: CONFIG_PATH },
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
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function request(method, params, timeoutMs = 600_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const t = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${timeoutMs}ms waiting for ${method} #${id}`));
      }
    }, timeoutMs);
    t.unref?.();
  });
}

function parseEnv(reply) {
  if (reply.error) return { ok: false, code: "E_PROTOCOL_ERROR", message: reply.error.message };
  const raw = reply.result?.content?.[0]?.text;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : { ok: false, code: "E_NO_CONTENT" };
  } catch (e) {
    return { ok: false, code: "E_PARSE_FAIL", message: String(e) };
  }
}

// ---- findings fingerprint (for disagreement clustering) --------------------

function findingFingerprint(content) {
  // Fingerprint = sorted tuples of (severity, file:line) from findings[].
  // Two models that return the same fingerprint "saw the same things" even
  // if verbatim prose differs. Cheap, deterministic, useful for clustering.
  const findings = Array.isArray(content?.findings) ? content.findings : [];
  const seen = findings.map((f) => {
    const loc = f.file ? `${f.file}:${f.line ?? "?"}` : "?";
    return `${f.severity ?? "?"}@${loc}`;
  });
  seen.sort();
  return seen;
}

// ---- main loop ------------------------------------------------------------

async function main() {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "review-matrix", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const startedAt = Date.now();
  const report = {
    started_at: new Date(startedAt).toISOString(),
    project_root: PROJECT_ROOT,
    diff_ref: DIFF_REF,
    types: REVIEW_TYPES,
    stages: STAGES,
    models: MODELS.map((m) => ({ label: m.label, endpoint: m.endpoint, model_id: m.model_id })),
    runs: [],
    summary: { total: 0, completed: 0, failed: 0, disagreements: 0 },
  };

  const ts = new Date(startedAt).toISOString().replace(/[:.]/g, "").replace(/-/g, "").slice(0, 15);
  const outJson = join(__dirname, `matrix-${ts}.json`);
  const outMd = join(__dirname, `matrix-${ts}.md`);
  const flush = () => {
    writeFileSync(outJson, JSON.stringify(report, null, 2));
    writeFileSync(outMd, renderMarkdown(report));
  };

  for (const type of REVIEW_TYPES) {
    for (const stage of STAGES) {
      const stageRow = { type, stage, per_model: {}, clusters: null, outliers: [] };
      for (const model of MODELS) {
        const label = `${type}/stage-${stage}/${model.label}`;
        const stageStartedAt = Date.now();
        process.stdout.write(`[${new Date().toISOString()}] ${label} … preparing\n`);

        let prep;
        try {
          const reply = await request("tools/call", {
            name: "review_prepare",
            arguments: { type, stage, force: true, diff_ref: DIFF_REF, expand: true },
          });
          prep = parseEnv(reply);
        } catch (e) {
          prep = { ok: false, code: "E_TRANSPORT", message: String(e) };
        }
        if (!prep.ok) {
          stageRow.per_model[model.label] = { phase: "prepare", error: prep };
          report.summary.failed++;
          flush();
          continue;
        }

        const runId = prep.content?.run_id;
        process.stdout.write(
          `[${new Date().toISOString()}] ${label} executing (run_id=${runId})…\n`,
        );

        let exec;
        try {
          const reply = await request(
            "tools/call",
            {
              name: "review_execute",
              arguments: {
                run_id: runId,
                endpoint: model.endpoint,
                model_id: model.model_id,
                timeout_ms: model.timeout_ms,
                expand: true,
              },
            },
            model.timeout_ms + 30_000,
          );
          exec = parseEnv(reply);
        } catch (e) {
          exec = { ok: false, code: "E_TRANSPORT", message: String(e) };
        }
        const durationMs = Date.now() - stageStartedAt;
        report.summary.total++;
        if (!exec.ok) {
          process.stdout.write(
            `[${new Date().toISOString()}] ${label} FAILED: ${exec.code} (${durationMs} ms)\n`,
          );
          stageRow.per_model[model.label] = {
            phase: "execute",
            run_id: runId,
            duration_ms: durationMs,
            error: exec,
          };
          report.summary.failed++;
          flush();
          continue;
        }
        const content = exec.content ?? {};
        const fingerprint = findingFingerprint(content);
        process.stdout.write(
          `[${new Date().toISOString()}] ${label} verdict=${content.verdict} findings=${fingerprint.length} (${durationMs} ms)\n`,
        );
        stageRow.per_model[model.label] = {
          run_id: runId,
          duration_ms: durationMs,
          verdict: content.verdict,
          finding_count: fingerprint.length,
          finding_fingerprint: fingerprint,
          report_path: content.report_path,
        };
        report.summary.completed++;
        flush();
      }

      // Cluster by verdict.
      const verdicts = {};
      for (const [label, rec] of Object.entries(stageRow.per_model)) {
        if (!rec.verdict) continue;
        (verdicts[rec.verdict] ??= []).push(label);
      }
      stageRow.clusters = verdicts;
      const totalVerdicts = Object.values(verdicts).reduce((n, arr) => n + arr.length, 0);
      if (totalVerdicts > 0) {
        const maxCluster = Math.max(...Object.values(verdicts).map((arr) => arr.length));
        if (maxCluster < totalVerdicts) {
          report.summary.disagreements++;
          // Outliers = labels not in the majority cluster.
          const majority = Object.entries(verdicts).find(([, arr]) => arr.length === maxCluster)[0];
          for (const [label, rec] of Object.entries(stageRow.per_model)) {
            if (rec.verdict && rec.verdict !== majority) {
              stageRow.outliers.push({ model: label, verdict: rec.verdict });
            }
          }
        }
      }

      report.runs.push(stageRow);
      flush();
    }
  }

  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - startedAt;
  flush();

  console.log("");
  console.log(`Matrix JSON: ${outJson}`);
  console.log(`Matrix MD:   ${outMd}`);
  console.log(`Total:       ${report.summary.total}`);
  console.log(`Completed:   ${report.summary.completed}`);
  console.log(`Failed:      ${report.summary.failed}`);
  console.log(`Disagreements: ${report.summary.disagreements} / ${report.runs.length} stages`);

  child.stdin.end();
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 500);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Model matrix review of vcf-cli`);
  lines.push("");
  lines.push(`- Project: ${report.project_root}`);
  lines.push(`- Diff ref: \`${report.diff_ref}\``);
  lines.push(`- Started: ${report.started_at}`);
  if (report.finished_at) lines.push(`- Finished: ${report.finished_at}`);
  if (report.duration_ms) lines.push(`- Duration: ${(report.duration_ms / 1000).toFixed(1)} s`);
  lines.push(`- Models:`);
  for (const m of report.models) {
    lines.push(`  - **${m.label}** — ${m.endpoint} / \`${m.model_id}\``);
  }
  lines.push("");
  lines.push("## Verdict matrix");
  lines.push("");
  const cols = report.models.map((m) => m.label);
  lines.push(`| type | stage | ${cols.join(" | ")} | outliers |`);
  lines.push(`| --- | ---: | ${cols.map(() => "---").join(" | ")} | --- |`);
  for (const r of report.runs) {
    const row = [r.type, String(r.stage)];
    for (const col of cols) {
      const rec = r.per_model[col];
      if (!rec) row.push("—");
      else if (rec.error) row.push(`❌ ${rec.error.code}`);
      else row.push(rec.verdict ?? "?");
    }
    row.push(
      r.outliers && r.outliers.length > 0
        ? r.outliers.map((o) => `${o.model}=${o.verdict}`).join(", ")
        : "",
    );
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  if (report.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(`- Total runs attempted: ${report.summary.total}`);
    lines.push(`- Completed: ${report.summary.completed}`);
    lines.push(`- Failed: ${report.summary.failed}`);
    lines.push(
      `- Stages with disagreement: ${report.summary.disagreements} / ${report.runs.length}`,
    );
  }
  lines.push("");
  lines.push("## Finding fingerprints (agreement clustering)");
  lines.push("");
  lines.push(
    "Fingerprints are sorted `<severity>@<file>:<line>` tuples from each model's findings[].",
  );
  lines.push(
    "Two models with the same fingerprint saw the same things (regardless of verbatim prose).",
  );
  lines.push("");
  for (const r of report.runs) {
    const fps = Object.entries(r.per_model).filter(([, rec]) => rec?.finding_fingerprint);
    if (fps.length === 0) continue;
    lines.push(`### ${r.type} / stage ${r.stage}`);
    lines.push("");
    for (const [label, rec] of fps) {
      const fp = rec.finding_fingerprint;
      lines.push(
        `- **${label}** — verdict=${rec.verdict}, ${fp.length} finding(s): ${fp.length > 0 ? fp.slice(0, 8).join(", ") + (fp.length > 8 ? " …" : "") : "∅"}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((e) => {
  console.error("matrix fatal:", e);
  console.error("vcf-mcp stderr tail:\n" + stderrBuf.slice(-2000));
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
