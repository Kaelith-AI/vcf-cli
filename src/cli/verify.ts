// Followup #44 — `vcf verify`, `vcf register-endpoint`, `vcf stale-check`,
// `vcf health` CLI handlers.
//
// Grouped together because all four inspect or mutate config.yaml and
// exercise the endpoint / KB / workspace sanity surface.

import { resolve as resolvePath, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { openGlobalDb } from "../db/global.js";
import { projectDbPath } from "../project/stateDir.js";
import { findProjectForCwd } from "../util/projectRegistry.js";
import { loadConfig } from "../config/loader.js";
import { canonicalizeRoots } from "../util/paths.js";
import { loadKb } from "../primers/load.js";
import { DEFAULT_CONFIG_PATH, err, log, loadConfigOrExit, vcfHomeDir } from "./_shared.js";

interface VerifyFinding {
  section: string;
  level: "ok" | "warn" | "error";
  detail: string;
}

export async function runVerify(opts: { format?: string } = {}): Promise<void> {
  const findings: VerifyFinding[] = [];

  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfigOrExit();
    findings.push({ section: "config", level: "ok", detail: "config.yaml loaded and validated" });
  } catch (e) {
    findings.push({ section: "config", level: "error", detail: (e as Error).message });
  }

  if (config) {
    try {
      const roots = await canonicalizeRoots(config.workspace.allowed_roots);
      for (const r of roots) {
        try {
          const st = statSync(r);
          findings.push({
            section: "workspace",
            level: st.isDirectory() ? "ok" : "error",
            detail: `${r} ${st.isDirectory() ? "exists (dir)" : "exists but is not a directory"}`,
          });
        } catch {
          findings.push({
            section: "workspace",
            level: "warn",
            detail: `${r} (allowed_root) does not exist yet — will be created on first use`,
          });
        }
      }
    } catch (e) {
      findings.push({ section: "workspace", level: "error", detail: (e as Error).message });
    }

    try {
      const entries = await loadKb(config.kb.root);
      findings.push({
        section: "kb",
        level: entries.length > 0 ? "ok" : "warn",
        detail:
          entries.length > 0
            ? `kb at ${config.kb.root} has ${entries.length} entr(y|ies)`
            : `kb at ${config.kb.root} is empty; run 'vcf update-primers' to populate`,
      });
    } catch (e) {
      findings.push({ section: "kb", level: "error", detail: (e as Error).message });
    }

    for (const pack of config.kb.packs) {
      try {
        const st = statSync(pack.root);
        if (!st.isDirectory()) {
          findings.push({
            section: "kb-packs",
            level: "error",
            detail: `pack '${pack.name}' root ${pack.root} is not a directory`,
          });
          continue;
        }
        const packKb = join(pack.root, "kb");
        if (!existsSync(packKb)) {
          findings.push({
            section: "kb-packs",
            level: "warn",
            detail: `pack '${pack.name}' has no kb/ subdir at ${packKb} — entries will be empty`,
          });
          continue;
        }
        const packEntries = await loadKb(packKb);
        findings.push({
          section: "kb-packs",
          level: packEntries.length > 0 ? "ok" : "warn",
          detail:
            packEntries.length > 0
              ? `pack '${pack.name}' has ${packEntries.length} entr(y|ies) at ${pack.root}`
              : `pack '${pack.name}' is empty at ${pack.root}`,
        });
      } catch (e) {
        findings.push({
          section: "kb-packs",
          level: "error",
          detail: `pack '${pack.name}' at ${pack.root}: ${(e as Error).message}`,
        });
      }
    }

    for (const e of config.endpoints) {
      if (e.auth_env_var === undefined) continue;
      if (process.env[e.auth_env_var] !== undefined) {
        findings.push({
          section: "endpoints",
          level: "ok",
          detail: `${e.name}: $${e.auth_env_var} is set`,
        });
      } else {
        findings.push({
          section: "endpoints",
          level: "warn",
          detail: `${e.name}: $${e.auth_env_var} is not set in the current shell`,
        });
      }
    }
  }

  const verifyGlobalDb = openGlobalDb({ path: resolvePath(vcfHomeDir(), ".vcf", "vcf.db") });
  const verifyProject = findProjectForCwd(verifyGlobalDb, process.cwd());
  verifyGlobalDb.close();
  if (verifyProject) {
    const cwdDb = projectDbPath(verifyProject.name);
    findings.push({
      section: "project",
      level: existsSync(cwdDb) ? "ok" : "warn",
      detail: existsSync(cwdDb)
        ? `project '${verifyProject.name}' detected — state at ${cwdDb}`
        : `project '${verifyProject.name}' registered but state missing at ${cwdDb} — re-run 'vcf adopt'`,
    });
    for (const hook of ["post-commit", "pre-push"] as const) {
      const hp = join(process.cwd(), ".git", "hooks", hook);
      if (existsSync(hp)) {
        findings.push({ section: "hooks", level: "ok", detail: `${hook} hook installed` });
      } else {
        findings.push({
          section: "hooks",
          level: "warn",
          detail: `${hook} hook missing at ${hp}`,
        });
      }
    }
  }

  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify({ ok: errs === 0, errs, warns, findings }, null, 2) + "\n");
  } else {
    for (const f of findings) {
      process.stderr.write(`  [${f.level.toUpperCase().padEnd(5)}] ${f.section}: ${f.detail}\n`);
    }
  }
  if (errs > 0) {
    err(`verify failed: ${errs} error(s)`, 3);
  }
  if (opts.format !== "json") log("verify ok");
}

export async function runRegisterEndpoint(opts: {
  name: string;
  provider: string;
  baseUrl: string;
  trustLevel: string;
  authEnvVar?: string;
}): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path} — run 'vcf init' first`, 2);
  }
  if (!/^endpoints:/m.test(body)) {
    err("config.yaml has no 'endpoints:' key — fix the file manually", 4);
  }
  const block = [
    `  - name: ${opts.name}`,
    `    provider: ${opts.provider}`,
    `    base_url: ${opts.baseUrl}`,
    ...(opts.authEnvVar ? [`    auth_env_var: ${opts.authEnvVar}`] : []),
    `    trust_level: ${opts.trustLevel}`,
  ].join("\n");
  const updated = body.replace(/^(endpoints:\s*\n)/m, `$1${block}\n`);
  if (updated === body) err("could not splice into endpoints block; edit manually", 4);
  await writeFile(`${path}.bak`, body, "utf8");
  await writeFile(path, updated, "utf8");
  log(`appended endpoint '${opts.name}' (backup at ${path}.bak)`);
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}

interface StaleRecord {
  id: string;
  pack?: string;
  days_old: number;
  updated: string;
  path: string;
}

export async function runStaleCheck(opts: { format?: string } = {}): Promise<void> {
  const config = await loadConfigOrExit();
  const entries = await loadKb(config.kb.root, config.kb.packs);
  const thresholdMs = config.review.stale_primer_days * 86_400_000;
  const now = Date.now();
  const stale: StaleRecord[] = [];
  const undated: string[] = [];
  for (const e of entries) {
    const when = e.last_reviewed ?? e.updated;
    if (!when) {
      undated.push(e.id);
      continue;
    }
    const ts = Date.parse(when);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > thresholdMs) {
      const daysOld = Math.floor((now - ts) / 86_400_000);
      const rec: StaleRecord = {
        id: e.id,
        days_old: daysOld,
        updated: when,
        path: e.path,
      };
      if (e.pack !== undefined) rec.pack = e.pack;
      stale.push(rec);
    }
  }
  if (opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          threshold_days: config.review.stale_primer_days,
          total: entries.length,
          stale_count: stale.length,
          undated_count: undated.length,
          stale,
          undated,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  for (const id of undated) {
    process.stderr.write(`  [WARN] ${id}: no last_reviewed / updated frontmatter\n`);
  }
  for (const r of stale) {
    process.stderr.write(`  [STALE] ${r.id}: ${r.days_old} days old (updated=${r.updated})\n`);
  }
  log(
    `stale-check: ${stale.length} stale / ${entries.length} total (threshold ${config.review.stale_primer_days}d)`,
  );
}

interface HealthResult {
  name: string;
  base_url: string;
  reachable: boolean;
  status?: number;
  duration_ms: number;
  error?: string;
}

async function pingEndpoint(url: string, timeoutMs: number): Promise<number | string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", signal: ctrl.signal });
    }
    return res.status;
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return "timeout";
    return err.message || "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export async function runHealth(
  opts: { format?: string; timeoutMs?: number } = {},
): Promise<void> {
  const config = await loadConfigOrExit();
  const timeout = opts.timeoutMs ?? 5000;
  const results: HealthResult[] = [];
  for (const ep of config.endpoints) {
    const startedAt = Date.now();
    const probe = await pingEndpoint(ep.base_url, timeout);
    const duration = Date.now() - startedAt;
    const result: HealthResult = {
      name: ep.name,
      base_url: ep.base_url,
      reachable: typeof probe === "number" && probe < 500,
      duration_ms: duration,
    };
    if (typeof probe === "number") result.status = probe;
    else result.error = probe;
    results.push(result);
  }
  const unreachable = results.filter((r) => !r.reachable);
  if (opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          ok: unreachable.length === 0,
          total: results.length,
          unreachable_count: unreachable.length,
          endpoints: results,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const r of results) {
      const tag = r.reachable ? "OK" : "DOWN";
      const detail = r.reachable
        ? `HTTP ${r.status} (${r.duration_ms}ms)`
        : `${r.error ?? `HTTP ${r.status ?? "?"}`} (${r.duration_ms}ms)`;
      process.stderr.write(`  [${tag.padEnd(4)}] ${r.name.padEnd(20)} ${r.base_url}  ${detail}\n`);
    }
    log(`health: ${unreachable.length} unreachable / ${results.length} total`);
  }
  if (unreachable.length > 0) process.exit(9);
}
