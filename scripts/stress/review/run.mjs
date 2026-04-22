#!/usr/bin/env node
// 27-stage dual-model review of vcf-cli.
//
// Structure: 3 review types × 9 stages each. For each stage we run the
// reviewer TWICE — once with local Gemma 4 31b (via Ollama direct), once
// with frontier GPT-5.4 (via LiteLLM → OpenRouter). Both verdicts are
// recorded side-by-side so the user can judge agreement/disagreement.
//
// Stage-entry rules are bypassed with force=true after stage 1 because
// we don't gate the second model's run on the first model's verdict.
//
// Diff reference: v0.3.2 (the last release) — everything touched after
// that tag is the surface under review. Perfect for the pre-0.4 dogfood.
//
// Requirements:
//   - project must be adopted at PROJECT_ROOT below
//   - $LITELLM_MASTER_KEY must be set in the environment (for GPT-5.4)
//   - Ollama must be reachable at 127.0.0.1:11434 (for Gemma 4 31b)

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- configuration ---------------------------------------------------------

const PROJECT_ROOT = "/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli";
const DIFF_REF = "v0.3.2";

const REVIEW_TYPES = ["code", "security", "production"];
const STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const MODELS = [
  {
    label: "qwen3-coder-30b",
    endpoint: "local-ollama",
    model_id: "qwen3-coder:30b",
    timeout_ms: 300_000, // cold load + long context
  },
  {
    label: "gpt-5.4",
    endpoint: "litellm",
    model_id: "CLIProxyAPI/gpt-5.4",
    timeout_ms: 180_000,
  },
];

const CONFIG_PATH = "/home/kaelith/.vcf/config.yaml";

// ---- spawn project-scope vcf-mcp ------------------------------------------

const child = spawn("vcf-mcp", ["--scope", "project"], {
  cwd: PROJECT_ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VCF_CONFIG: CONFIG_PATH,
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

// ---- main loop ------------------------------------------------------------

async function main() {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "stress-review", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const startedAt = Date.now();
  const report = {
    started_at: new Date(startedAt).toISOString(),
    project_root: PROJECT_ROOT,
    diff_ref: DIFF_REF,
    models: MODELS.map((m) => ({ label: m.label, endpoint: m.endpoint, model_id: m.model_id })),
    stages: [],
  };

  const flushReport = () => {
    const ts = new Date(startedAt)
      .toISOString()
      .replace(/[:.]/g, "")
      .replace(/-/g, "")
      .slice(0, 15);
    const outJson = join(__dirname, `report-${ts}.json`);
    const outMd = join(__dirname, `report-${ts}.md`);
    writeFileSync(outJson, JSON.stringify(report, null, 2));
    writeFileSync(outMd, renderMarkdown(report));
    return { outJson, outMd };
  };

  let overallMismatches = 0;

  for (const type of REVIEW_TYPES) {
    for (const stage of STAGES) {
      const stageRecord = { type, stage, per_model: {}, disagreement: null };
      for (const model of MODELS) {
        const label = `${type}/stage-${stage}/${model.label}`;
        const stageStartedAt = Date.now();
        process.stdout.write(`[${new Date().toISOString()}] ${label} … preparing\n`);

        let prep;
        try {
          const reply = await request("tools/call", {
            name: "review_prepare",
            arguments: {
              type,
              stage,
              force: true, // skip the prior-PASS gate; we're running both models per stage
              diff_ref: DIFF_REF,
              expand: true,
            },
          });
          prep = parseEnv(reply);
        } catch (e) {
          prep = { ok: false, code: "E_TRANSPORT", message: String(e) };
        }

        if (!prep.ok) {
          process.stdout.write(
            `[${new Date().toISOString()}] ${label} prepare FAILED: ${prep.code} ${prep.message ?? ""}\n`,
          );
          stageRecord.per_model[model.label] = { phase: "prepare", error: prep };
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
        if (!exec.ok) {
          process.stdout.write(
            `[${new Date().toISOString()}] ${label} execute FAILED: ${exec.code} ${(exec.message ?? "").slice(0, 120)} (${durationMs} ms)\n`,
          );
          stageRecord.per_model[model.label] = {
            phase: "execute",
            run_id: runId,
            duration_ms: durationMs,
            error: exec,
          };
          flushReport();
          continue;
        }

        const content = exec.content ?? {};
        process.stdout.write(
          `[${new Date().toISOString()}] ${label} verdict=${content.verdict} (${durationMs} ms)\n`,
        );
        stageRecord.per_model[model.label] = {
          run_id: runId,
          duration_ms: durationMs,
          verdict: content.verdict,
          report_path: content.report_path,
          endpoint: content.endpoint,
          model_id: content.model_id,
          carry_forward: content.carry_forward,
        };
        flushReport();
      }

      // Disagreement detection.
      const verdicts = Object.values(stageRecord.per_model)
        .map((m) => m.verdict)
        .filter(Boolean);
      if (verdicts.length === 2 && verdicts[0] !== verdicts[1]) {
        stageRecord.disagreement = `${MODELS[0].label}=${stageRecord.per_model[MODELS[0].label]?.verdict} ≠ ${MODELS[1].label}=${stageRecord.per_model[MODELS[1].label]?.verdict}`;
        overallMismatches++;
      }

      report.stages.push(stageRecord);
      flushReport();
    }
  }

  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - startedAt;
  report.disagreement_count = overallMismatches;

  const { outJson, outMd } = flushReport();

  console.log("");
  console.log(`Report JSON: ${outJson}`);
  console.log(`Report MD:   ${outMd}`);
  console.log(`Duration:    ${report.duration_ms} ms`);
  console.log(`Disagreements: ${overallMismatches} / ${report.stages.length} stages`);

  child.stdin.end();
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 500);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Dual-model review of vcf-cli`);
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
  lines.push(`| type | stage | ${cols.join(" | ")} | disagreement |`);
  lines.push(`| --- | ---: | ${cols.map(() => "---").join(" | ")} | --- |`);
  for (const s of report.stages) {
    const row = [s.type, String(s.stage)];
    for (const col of cols) {
      const rec = s.per_model[col];
      if (!rec) row.push("—");
      else if (rec.error) row.push(`❌ ${rec.error.code}`);
      else row.push(rec.verdict ?? "?");
    }
    row.push(s.disagreement ? `⚠ ${s.disagreement}` : "");
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  if (typeof report.disagreement_count === "number") {
    lines.push(`**Total disagreements: ${report.disagreement_count} / ${report.stages.length}**`);
    lines.push("");
  }
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
