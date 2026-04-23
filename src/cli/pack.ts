// Followup #44 — `vcf pack (add / list / remove)` CLI handlers.
//
// Manage third-party KB packs — community primer/best-practice/lens
// extensions that live alongside the main @kaelith-labs/kb content.
// Each pack is a directory with a `kb/` subtree mirroring the main KB
// layout. Pack entries load with IDs prefixed `@<name>/...` so they
// can never shadow main-KB files.
//
// These commands splice into `kb.packs:` in config.yaml (same pattern as
// register-endpoint). No MCP equivalent — registration is a deterministic
// operator action, not an LLM path.

import { resolve as resolvePath } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../config/loader.js";
import { err, log, loadConfigOrExit, DEFAULT_CONFIG_PATH } from "./_shared.js";

export async function runPackAdd(opts: { name: string; path: string }): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path} — run 'vcf init' first`, 2);
  }
  const absRoot = resolvePath(opts.path);
  if (/^\s{2}packs:\s*$/m.test(body)) {
    const entry = [`    - name: ${opts.name}`, `      root: ${absRoot}`].join("\n");
    const updated = body.replace(/^(\s{2}packs:\s*\n)/m, `$1${entry}\n`);
    if (updated === body) err("could not splice into kb.packs block; edit manually", 4);
    await writeFile(`${path}.bak`, body, "utf8");
    await writeFile(path, updated, "utf8");
  } else if (/^kb:\s*$/m.test(body)) {
    const kbStart = body.search(/^kb:\s*$/m);
    const lines = body.split("\n");
    let lineIdx = 0;
    let charIdx = 0;
    while (charIdx < kbStart) {
      charIdx += lines[lineIdx]!.length + 1;
      lineIdx++;
    }
    let endIdx = lineIdx + 1;
    while (endIdx < lines.length) {
      const l = lines[endIdx]!;
      if (l.length > 0 && !l.startsWith(" ") && !l.startsWith("\t")) break;
      endIdx++;
    }
    const insertion = ["  packs:", `    - name: ${opts.name}`, `      root: ${absRoot}`];
    lines.splice(endIdx, 0, ...insertion);
    const updated = lines.join("\n");
    await writeFile(`${path}.bak`, body, "utf8");
    await writeFile(path, updated, "utf8");
  } else {
    err("config.yaml has no 'kb:' key — edit the file manually", 4);
  }
  log(`registered KB pack '${opts.name}' → ${absRoot} (backup at ${path}.bak)`);
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}

export async function runPackList(): Promise<void> {
  const config = await loadConfigOrExit();
  if (config.kb.packs.length === 0) {
    log("no KB packs registered");
    return;
  }
  for (const p of config.kb.packs) {
    process.stderr.write(`  ${p.name.padEnd(24)}  ${p.root}\n`);
  }
  log(`${config.kb.packs.length} pack(s) registered`);
}

export async function runPackRemove(name: string): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path}`, 2);
  }
  const pattern = new RegExp(
    `^\\s{4}- name:\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n\\s{6}root:[^\\n]*\\n`,
    "m",
  );
  if (!pattern.test(body)) {
    err(`pack '${name}' not found in ${path}`, 2);
  }
  const updated = body.replace(pattern, "");
  await writeFile(`${path}.bak`, body, "utf8");
  await writeFile(path, updated, "utf8");
  log(`removed KB pack '${name}' (backup at ${path}.bak)`);
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}
