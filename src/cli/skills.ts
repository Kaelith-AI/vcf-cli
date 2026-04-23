// Followup #44 — `vcf install-skills` + `vcf update-primers` CLI handlers.

import { resolve as resolvePath, join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mergePrimerTree, resolveUpstreamKbRoot } from "../primers/merge.js";
import { DEFAULT_KB_ANCESTOR_ROOT, err, log, loadConfigOrExit } from "./_shared.js";

/**
 * Walk up from `start` until we find a directory containing `package.json`.
 * Works in both dev (src/cli/skills.ts → src → repo) and bundled dist
 * (dist/cli.js → dist → repo) — tsup flattens the dist tree so a
 * hardcoded `..` count would overshoot in one of the two layouts.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolvePath(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(start, "..", "..");
}

const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

type SkillLayout = "nested-md" | "flat-toml";
interface SkillClientSpec {
  defaultDest: () => string;
  layout: SkillLayout;
}

const SKILL_CLIENTS: Record<string, SkillClientSpec> = {
  "claude-code": {
    defaultDest: () => resolvePath(homedir(), ".claude", "skills"),
    layout: "nested-md",
  },
  codex: {
    defaultDest: () => resolvePath(homedir(), ".agents", "skills"),
    layout: "nested-md",
  },
  gemini: {
    defaultDest: () => resolvePath(homedir(), ".gemini", "commands"),
    layout: "flat-toml",
  },
};

export async function runInstallSkills(client: string, opts: { dest?: string }): Promise<void> {
  const spec = SKILL_CLIENTS[client];
  if (!spec) {
    err(`unknown client '${client}' — supported: ${Object.keys(SKILL_CLIENTS).join(", ")}`, 2);
  }
  // Skills ship alongside package.json under `skills/`. Both the dev
  // source tree and the flat bundled dist tree resolve through
  // findPackageRoot, so the same code works in either layout.
  const skillsRoot = resolvePath(PACKAGE_ROOT, "skills");
  const pkgSkillsDir = join(skillsRoot, client);
  if (!existsSync(pkgSkillsDir)) {
    err(`skill pack missing in package at ${pkgSkillsDir}`, 3);
  }
  const commonDir = join(skillsRoot, "common");
  const dest = opts.dest ?? spec.defaultDest();
  await mkdir(dest, { recursive: true });

  let installed = 0;
  let skipped = 0;

  // Client-specific pack (layout-native).
  const entries = await readdir(pkgSkillsDir);
  if (spec.layout === "nested-md") {
    for (const name of entries) {
      const src = join(pkgSkillsDir, name);
      const st = await stat(src);
      if (!st.isDirectory()) continue;
      const dstDir = join(dest, name);
      if (existsSync(dstDir)) {
        log(`${dstDir} exists — skipping (edit manually or remove to reinstall)`);
        skipped++;
        continue;
      }
      await mkdir(dstDir, { recursive: true });
      const skillFile = join(src, "SKILL.md");
      if (existsSync(skillFile)) {
        await copyFile(skillFile, join(dstDir, "SKILL.md"));
      }
      installed++;
    }
  } else {
    // flat-toml: each <name>.toml in pkg dir copies to <dest>/<name>.toml.
    for (const name of entries) {
      if (!name.endsWith(".toml")) continue;
      const src = join(pkgSkillsDir, name);
      const dst = join(dest, name);
      if (existsSync(dst)) {
        log(`${dst} exists — skipping (edit manually or remove to reinstall)`);
        skipped++;
        continue;
      }
      await copyFile(src, dst);
      installed++;
    }
  }

  // Common pack: shared source-of-truth markdown transformed per client layout.
  if (existsSync(commonDir)) {
    const commonEntries = await readdir(commonDir);
    for (const name of commonEntries) {
      if (!name.endsWith(".md")) continue;
      const base = name.slice(0, -3);
      const src = join(commonDir, name);
      const raw = await readFile(src, "utf8");
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        log(`common/${name} has no frontmatter — skipping`);
        skipped++;
        continue;
      }
      if (spec.layout === "nested-md") {
        const dstDir = join(dest, base);
        if (existsSync(dstDir)) {
          log(`${dstDir} exists — skipping (edit manually or remove to reinstall)`);
          skipped++;
          continue;
        }
        await mkdir(dstDir, { recursive: true });
        await writeFile(join(dstDir, "SKILL.md"), raw, "utf8");
        installed++;
      } else {
        const dst = join(dest, `${base}.toml`);
        if (existsSync(dst)) {
          log(`${dst} exists — skipping (edit manually or remove to reinstall)`);
          skipped++;
          continue;
        }
        await writeFile(dst, renderFlatToml(parsed.description, parsed.body), "utf8");
        installed++;
      }
    }
  }

  log(`install-skills: ${installed} installed, ${skipped} skipped at ${dest}`);
}

/**
 * Parse a minimal YAML-frontmatter markdown file: `--- ... --- <body>`.
 * Returns `{ description, body }` or null if no frontmatter is present.
 * Only supports the two fields the common skill pack uses (`name`,
 * `description`) — not a general YAML parser.
 */
function parseSkillFrontmatter(
  raw: string,
): { name: string; description: string; body: string } | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5);
  let name = "";
  let description = "";
  for (const line of fm.split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const key = m[1];
    let value = (m[2] ?? "").trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }
  return { name, description, body };
}

/**
 * Render a gemini-style flat-TOML skill entry. Uses triple-single-quoted
 * literal strings so embedded backticks / double-quotes / backslashes do
 * not need escaping.
 */
function renderFlatToml(description: string, body: string): string {
  const safeDescription = description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeBody = body.replace(/'''/g, "''\\'");
  return `description = "${safeDescription}"\n\nprompt = '''\n${safeBody.trimEnd()}\n'''\n`;
}

export async function runUpdatePrimers(): Promise<void> {
  const config = await loadConfigOrExit();
  const kbRoot = config.kb.root;
  const ancestorRoot = DEFAULT_KB_ANCESTOR_ROOT();
  const upstreamRoot = resolveUpstreamKbRoot();
  if (upstreamRoot === null) {
    err(
      "could not locate @kaelith-labs/kb package; ensure it's installed or the sibling repo is present",
      6,
    );
  }
  log(`update-primers: ${kbRoot} ← ${upstreamRoot} (ancestor: ${ancestorRoot})`);

  const report = await mergePrimerTree({ kbRoot, upstreamRoot, ancestorRoot });
  for (const o of report.outcomes) {
    if (o.kind === "conflict" || o.kind === "auto-merged") {
      process.stderr.write(
        `  [${o.kind.toUpperCase()}] ${o.rel}${o.note ? ` — ${o.note}` : ""}\n`,
      );
    }
  }
  const c = report.counts;
  log(
    `update-primers: ${c.added} added, ${c["fast-forward"]} fast-forward, ${c["auto-merged"]} auto-merged, ${c["local-only"]} kept-local, ${c["in-sync"]} in-sync, ${c.conflict} conflict(s)`,
  );
  if (c.conflict > 0) {
    process.exit(7);
  }
}
