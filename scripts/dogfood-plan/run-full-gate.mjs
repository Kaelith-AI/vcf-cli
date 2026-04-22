#!/usr/bin/env node
// Run a full N-stage review gate (code/security/production, 1..9) against
// the current HEAD vs HEAD~1 diff. Sequential, fail-fast on non-PASS.
//
// Usage:
//   node run-full-gate.mjs <type> <startStage> <endStage> [endpoint] [model_id] [diff_ref]
//
// Defaults: endpoint=local-ollama, model_id=qwen3-coder:30b, diff_ref=HEAD~1..HEAD.
// The optional trailing args enable dual-model (qwen+gpt) 27-stage runs for
// the 0.5.0 release gate without forking the harness.

import { spawn } from "node:child_process";

const PROJECT_ROOT = "/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli";
const CONFIG_PATH = "/home/kaelith/.vcf/config.yaml";

function callMcp(args, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("vcf-mcp", ["--scope", "project"], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, VCF_CONFIG: CONFIG_PATH },
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    let buf = "";
    let nextId = 1;
    const pending = new Map();
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
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
    const send = (method, params, tm = timeoutMs) => {
      const id = nextId++;
      return new Promise((r, j) => {
        pending.set(id, { resolve: r });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        const t = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            j(new Error(`timeout ${tm}ms on ${method}#${id}`));
          }
        }, tm);
        t.unref?.();
      });
    };

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "full-gate", version: "0" },
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
        );
        const reply = await send("tools/call", args);
        const raw = reply.result?.content?.[0]?.text;
        const envelope = raw ? JSON.parse(raw) : { ok: false, code: "E_NO_CONTENT" };
        resolve(envelope);
      } catch (e) {
        reject(new Error(`${e.message}\nstderr: ${stderr.slice(-800)}`));
      } finally {
        try {
          child.stdin.end();
          setTimeout(() => child.kill(), 200);
        } catch {}
      }
    })();
  });
}

async function runStage(type, stage, endpoint, modelId, diffRef) {
  process.stderr.write(`\n[${type} stage ${stage} @${modelId}] preparing...\n`);
  const prep = await callMcp({
    name: "review_prepare",
    arguments: { type, stage, diff_ref: diffRef },
  });
  if (!prep.ok) {
    return { stage, ok: false, step: "prepare", error: prep };
  }
  const runId = prep.paths[0].split("/").pop();
  process.stderr.write(`[${type} stage ${stage} @${modelId}] executing ${runId}...\n`);
  const exec = await callMcp(
    {
      name: "review_execute",
      arguments: {
        run_id: runId,
        endpoint,
        model_id: modelId,
        timeout_ms: 600_000,
      },
    },
    900_000,
  );
  if (!exec.ok) {
    return { stage, ok: false, step: "execute", error: exec, run_id: runId };
  }
  return {
    stage,
    ok: true,
    run_id: runId,
    model_id: modelId,
    endpoint,
    verdict: exec.summary,
    report_path: exec.paths[0],
    overlay: exec.content?.overlay,
    carry_forward: exec.content?.carry_forward,
  };
}

async function main() {
  const [type, startStr, endStr, endpointArg, modelArg, diffArg] = process.argv.slice(2);
  if (!type || !startStr || !endStr) {
    console.error(
      "usage: run-full-gate.mjs <type> <startStage> <endStage> [endpoint] [model_id] [diff_ref]",
    );
    process.exit(2);
  }
  const endpoint = endpointArg ?? "local-ollama";
  const modelId = modelArg ?? "qwen3-coder:30b";
  const diffRef = diffArg ?? "HEAD~1..HEAD";
  const start = Number(startStr);
  const end = Number(endStr);
  const results = [];
  for (let s = start; s <= end; s++) {
    const r = await runStage(type, s, endpoint, modelId, diffRef);
    results.push(r);
    if (!r.ok) {
      process.stderr.write(`\n${type} stage ${s} FAILED at ${r.step}: ${JSON.stringify(r.error).slice(0, 400)}\n`);
      break;
    }
    process.stderr.write(`[${type} stage ${s} @${modelId}] ${r.verdict}\n`);
    // Stop only on verdict. Non-info entries in carry_forward are the
    // ACCEPTED-RISK mechanism — a PASS with carried warnings is a
    // legitimate outcome ("we're moving forward; the residual stays
    // visible to the next reviewer"). Early harness treated carry_forward
    // non-info as a halt signal; that misread the protocol and caused
    // PASS stages to abort the run.
    if (!r.verdict.includes("PASS")) {
      process.stderr.write(`[${type} stage ${s} @${modelId}] non-PASS — stopping\n`);
      break;
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
