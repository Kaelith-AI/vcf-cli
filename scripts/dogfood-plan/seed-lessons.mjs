#!/usr/bin/env node
// Seed the project lessons DB from a JSON array. Each entry is fed through
// lesson_log_add over the MCP stdio transport so audit + redaction + dual-
// write (project DB + global lessons mirror) all run the same way they do
// for an interactive LLM call. Idempotent at the tool layer — duplicate
// titles on the same scope will be accepted; the spec doesn't dedupe.
//
// Usage: node seed-lessons.mjs <lessons.json>
//
// The JSON file must be an array of objects with the lesson_log_add shape:
//   { title, observation, scope?, stage?, tags?, actionable_takeaway?, context? }
// Paths are resolved relative to process.cwd().

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_ROOT = "/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli";
const CONFIG_PATH = "/home/kaelith/.vcf/config.yaml";

function rpcCall(child, method, params, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const id = rpcCall.nextId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const t = setTimeout(() => {
      rpcCall.pending.delete(id);
      reject(new Error(`timeout ${timeoutMs}ms on ${method}#${id}`));
    }, timeoutMs);
    t.unref?.();
    rpcCall.pending.set(id, {
      resolve: (msg) => {
        clearTimeout(t);
        resolve(msg);
      },
    });
    child.stdin.write(req + "\n");
  });
}
rpcCall.nextId = 1;
rpcCall.pending = new Map();

function startServer() {
  const child = spawn("vcf-mcp", ["--scope", "project"], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VCF_CONFIG: CONFIG_PATH },
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  child.on("error", (e) => {
    process.stderr.write(`spawn error: ${e.message}\n`);
  });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && rpcCall.pending.has(msg.id)) {
          rpcCall.pending.get(msg.id).resolve(msg);
          rpcCall.pending.delete(msg.id);
        }
      } catch {
        // Server may emit non-JSON log lines on stdout in some transports;
        // ignore them silently (protocol framing is line-per-message JSON).
      }
    }
  });
  return { child, getStderrTail: () => stderr.slice(-1500) };
}

async function main() {
  const [lessonsPath] = process.argv.slice(2);
  if (!lessonsPath) {
    console.error("usage: seed-lessons.mjs <lessons.json>");
    process.exit(2);
  }
  const absPath = resolve(process.cwd(), lessonsPath);
  const entries = JSON.parse(readFileSync(absPath, "utf8"));
  if (!Array.isArray(entries)) {
    console.error("lessons file must be a JSON array");
    process.exit(2);
  }

  const { child, getStderrTail } = startServer();
  const results = [];
  try {
    await rpcCall(child, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "seed-lessons", version: "0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const reply = await rpcCall(
        child,
        "tools/call",
        { name: "lesson_log_add", arguments: e },
        60_000,
      );
      const raw = reply.result?.content?.[0]?.text;
      const env = raw ? JSON.parse(raw) : { ok: false, code: "E_NO_CONTENT" };
      results.push({ index: i, title: e.title, ok: env.ok, code: env.code, paths: env.paths });
      if (!env.ok) {
        process.stderr.write(
          `[${i}] FAIL ${e.title}: ${env.code} ${JSON.stringify(env).slice(0, 400)}\n`,
        );
        break;
      }
      process.stderr.write(`[${i}] ok  ${e.title}\n`);
    }
  } catch (err) {
    process.stderr.write(`fatal: ${err.message}\nstderr tail:\n${getStderrTail()}\n`);
    process.exitCode = 1;
  } finally {
    try {
      child.stdin.end();
      setTimeout(() => child.kill(), 200);
    } catch {
      /* best-effort cleanup */
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main();
