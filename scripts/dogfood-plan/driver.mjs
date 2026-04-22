#!/usr/bin/env node
// Dogfood driver for the plan flow against the adopted vcf-cli project.
// Session's MCP surface didn't populate the vcf tool schemas — drive the
// server via stdio JSON-RPC the same way scripts/stress/review/run.mjs does.
//
// Usage: node driver.mjs <command> [args-json]
//   commands:
//     list            — tools/list
//     call <name> <args-json>
//     spec-save-from-file <path-to-spec.md>
//     plan-context <plan-name> <spec-path>
//     plan-save-from-files <plan-name> <plan-md> <todo-md> <manifest-md>
//     raw <method> <params-json>
//
// Prints the parsed content envelope to stdout.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PROJECT_ROOT = "/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli";
const CONFIG_PATH = "/home/kaelith/.vcf/config.yaml";

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
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  }
});

function request(method, params, timeoutMs = 120_000) {
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

async function main() {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "dogfood-plan", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const [cmd, ...rest] = process.argv.slice(2);

  let result;
  try {
    if (cmd === "list") {
      result = await request("tools/list", {});
      console.log(JSON.stringify(result.result?.tools?.map((t) => t.name).sort() ?? result, null, 2));
    } else if (cmd === "call") {
      const [name, argsJson = "{}"] = rest;
      const reply = await request("tools/call", { name, arguments: JSON.parse(argsJson) });
      console.log(JSON.stringify(parseEnv(reply), null, 2));
    } else if (cmd === "spec-save-from-file") {
      const [specFile] = rest;
      const content = readFileSync(specFile, "utf8");
      const reply = await request("tools/call", {
        name: "spec_save",
        arguments: { content, expand: true },
      });
      console.log(JSON.stringify(parseEnv(reply), null, 2));
    } else if (cmd === "plan-context") {
      const [name, specPath] = rest;
      const reply = await request("tools/call", {
        name: "plan_context",
        arguments: { name, spec_path: specPath, expand: true, limit_primers: 12 },
      });
      console.log(JSON.stringify(parseEnv(reply), null, 2));
    } else if (cmd === "plan-save-from-files") {
      const [name, planPath, todoPath, manifestPath] = rest;
      const plan = readFileSync(planPath, "utf8");
      const todo = readFileSync(todoPath, "utf8");
      const manifest = readFileSync(manifestPath, "utf8");
      const reply = await request("tools/call", {
        name: "plan_save",
        arguments: { name, plan, todo, manifest, expand: true, force: true },
      });
      console.log(JSON.stringify(parseEnv(reply), null, 2));
    } else if (cmd === "raw") {
      const [method, paramsJson = "{}"] = rest;
      const reply = await request(method, JSON.parse(paramsJson));
      console.log(JSON.stringify(reply, null, 2));
    } else {
      console.error(`usage: driver.mjs list | call | spec-save-from-file | plan-context | plan-save-from-files | raw`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`driver error: ${e.message}`);
    console.error("stderr tail:\n" + stderrBuf.slice(-2000));
    process.exit(1);
  }

  child.stdin.end();
  setTimeout(() => {
    try { child.kill(); } catch {}
  }, 200);
}

main();
