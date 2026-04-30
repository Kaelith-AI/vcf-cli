// Company-standards pass for ship_audit.
//
// Reads ~/.vcf/kb/standards/company-standards.md, parses the YAML
// frontmatter, and runs every declared check in `checks:`. All checks are
// deterministic (binary pass/fail). Subjective / prose-review rules do not
// belong here — the reviewer tools own those.
//
// Supported checks:
//   license_header: "Apache-2.0" | "<literal header>"
//   required_files: ["LICENSE", "CHANGELOG.md", ...]
//   branch_prefix: ["feat", "fix", ...]
//   commit_style: "conventional"
//
// Scope windows (commit_style):
//   on a non-default branch  -> commits since diverged from main/master
//   on the default branch    -> commits since last tag
//   default branch, no tags  -> last 100 commits
// The pass reports which window it used so the user can see what was checked.

import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

export type Status = "ok" | "warning" | "blocker";
export interface Finding {
  file: string;
  line?: number | undefined;
  severity: Status;
  detail: string;
}
export interface PassResult {
  name: string;
  status: Status;
  findings: Finding[];
  notes?: string;
}

// --- frontmatter parsing ---------------------------------------------------

interface ChecksBlock {
  license_header?: string;
  required_files?: string[];
  branch_prefix?: string[];
  commit_style?: string;
}

function extractFrontmatter(body: string): Record<string, unknown> | null {
  if (!body.startsWith("---")) return null;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = body.slice(3, end).trim();
  try {
    const parsed = parseYaml(block);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readChecks(fm: Record<string, unknown>): ChecksBlock | null {
  const raw = fm["checks"];
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: ChecksBlock = {};
  if (typeof obj["license_header"] === "string") out.license_header = obj["license_header"];
  if (Array.isArray(obj["required_files"])) {
    out.required_files = obj["required_files"].filter((v): v is string => typeof v === "string");
  }
  if (Array.isArray(obj["branch_prefix"])) {
    out.branch_prefix = obj["branch_prefix"].filter((v): v is string => typeof v === "string");
  }
  if (typeof obj["commit_style"] === "string") out.commit_style = obj["commit_style"];
  return out;
}

// --- individual checks ------------------------------------------------------

const HEADER_SCAN_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
]);

async function licenseHeaderCheck(value: string, files: string[]): Promise<Finding[]> {
  // SPDX short-id vs literal string. An all-caps-allowed identifier with
  // dots/dashes is treated as SPDX; otherwise the literal must appear as-is.
  const isSpdx = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value);
  const headerRe = isSpdx
    ? new RegExp(`SPDX-License-Identifier:\\s*${value.replace(/[.+*?^$()|[\]{}\\]/g, "\\$&")}`)
    : null;
  const literal = isSpdx ? null : value;
  const findings: Finding[] = [];
  for (const file of files) {
    const dot = file.lastIndexOf(".");
    const ext = dot >= 0 ? file.slice(dot) : "";
    if (!HEADER_SCAN_EXT.has(ext)) continue;
    const body = await safeRead(file);
    if (!body) continue;
    const head = body.split("\n").slice(0, 20).join("\n");
    const ok = headerRe ? headerRe.test(head) : head.includes(literal!);
    if (!ok) {
      findings.push({
        file,
        severity: "blocker",
        detail: `missing license header (expected ${isSpdx ? `SPDX-License-Identifier: ${value}` : `literal "${value.slice(0, 40)}${value.length > 40 ? "…" : ""}"`} in first 20 lines)`,
      });
      if (findings.length >= 50) break;
    }
  }
  return findings;
}

async function requiredFilesCheck(paths: string[], root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rel of paths) {
    const abs = join(root, rel);
    const exists = await stat(abs)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) {
      findings.push({
        file: abs,
        severity: "blocker",
        detail: `required file missing: ${rel}`,
      });
    }
  }
  return findings;
}

function branchPrefixCheck(prefixes: string[], root: string): Finding[] {
  const branch = gitCurrentBranch(root);
  if (branch === null) {
    return [
      {
        file: root,
        severity: "blocker",
        detail: "branch_prefix check declared but HEAD is detached or not a git repo",
      },
    ];
  }
  const defaultBranch = gitDefaultBranch(root);
  // Default branch (main/master) is exempt — branch-prefix applies to topic branches.
  if (branch === defaultBranch) return [];
  const matched = prefixes.some((p) => branch.startsWith(`${p}/`) || branch.startsWith(`${p}-`));
  if (matched) return [];
  return [
    {
      file: root,
      severity: "blocker",
      detail: `branch '${branch}' does not match any configured prefix (${prefixes.join(", ")})`,
    },
  ];
}

const CONVENTIONAL_RE =
  /^(?:revert: )?(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([\w./-]+\))?!?: .+/;

interface CommitWindow {
  commits: Array<{ sha: string; subject: string }>;
  source: string;
}

function commitStyleCheck(value: string, root: string): { findings: Finding[]; notes: string } {
  if (value !== "conventional") {
    return {
      findings: [
        {
          file: root,
          severity: "blocker",
          detail: `unsupported commit_style value: ${value} (only "conventional" is implemented)`,
        },
      ],
      notes: "",
    };
  }
  const window = resolveCommitWindow(root);
  if (!window) {
    return {
      findings: [
        {
          file: root,
          severity: "blocker",
          detail: "commit_style check declared but project is not a git repository",
        },
      ],
      notes: "",
    };
  }
  const findings: Finding[] = [];
  for (const c of window.commits) {
    if (!CONVENTIONAL_RE.test(c.subject)) {
      findings.push({
        file: root,
        severity: "blocker",
        detail: `non-conventional commit ${c.sha.slice(0, 8)}: ${c.subject.slice(0, 120)}`,
      });
      if (findings.length >= 40) break;
    }
  }
  return {
    findings,
    notes: `commit_style window: ${window.source} (${window.commits.length} commit(s) checked)`,
  };
}

// --- git helpers -----------------------------------------------------------

function gitRun(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status === 0 && typeof r.stdout === "string") {
    return { ok: true, out: r.stdout.trim() };
  }
  return { ok: false, out: "" };
}

function gitIsRepo(root: string): boolean {
  return existsSync(join(root, ".git")) || gitRun(["rev-parse", "--git-dir"], root).ok;
}

function gitCurrentBranch(root: string): string | null {
  if (!gitIsRepo(root)) return null;
  const r = gitRun(["symbolic-ref", "--short", "HEAD"], root);
  return r.ok && r.out ? r.out : null;
}

function gitDefaultBranch(root: string): string {
  // Try `main` then `master`. If neither exists, fall back to `main` as the
  // assumed default — the branch_prefix check only exempts the actual current
  // branch when it matches, so guessing wrong just means no exemption.
  for (const name of ["main", "master"]) {
    if (gitRun(["rev-parse", "--verify", `refs/heads/${name}`], root).ok) return name;
  }
  return "main";
}

function resolveCommitWindow(root: string): CommitWindow | null {
  if (!gitIsRepo(root)) return null;
  const branch = gitCurrentBranch(root);
  const defaultBranch = gitDefaultBranch(root);

  const parseCommits = (raw: string): Array<{ sha: string; subject: string }> => {
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .map((line) => {
        const idx = line.indexOf(" ");
        if (idx < 0) return null;
        return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
      })
      .filter((c): c is { sha: string; subject: string } => c !== null);
  };

  // On a non-default branch: commits since diverged from the default.
  if (branch && branch !== defaultBranch) {
    const r = gitRun(["log", "--no-merges", "--pretty=%H %s", `${defaultBranch}..HEAD`], root);
    if (r.ok) {
      return {
        commits: parseCommits(r.out),
        source: `since diverged from ${defaultBranch}`,
      };
    }
    // Default branch doesn't exist locally — fall through to last-tag.
  }

  // On default branch (or default missing): since last tag.
  const tagR = gitRun(["describe", "--tags", "--abbrev=0"], root);
  if (tagR.ok && tagR.out) {
    const logR = gitRun(["log", "--no-merges", "--pretty=%H %s", `${tagR.out}..HEAD`], root);
    if (logR.ok) {
      return {
        commits: parseCommits(logR.out),
        source: `since tag ${tagR.out}`,
      };
    }
  }

  // No tags: last 100 commits.
  const capR = gitRun(["log", "--no-merges", "--pretty=%H %s", "-n", "100"], root);
  if (capR.ok) {
    return {
      commits: parseCommits(capR.out),
      source: "last 100 commits (no tags found)",
    };
  }
  return null;
}

// --- orchestrator -----------------------------------------------------------

export async function companyStandardsPass(opts: {
  kbRoot: string;
  projectRoot: string;
  sourceFiles: string[];
}): Promise<PassResult> {
  const standardsPath = join(opts.kbRoot, "standards", "company-standards.md");
  let body: string;
  try {
    body = await readFile(standardsPath, "utf8");
  } catch {
    return {
      name: "company-standards",
      status: "ok",
      findings: [],
      notes: `no ${relative(opts.kbRoot, standardsPath) || standardsPath}; run 'vcf standards init' to configure`,
    };
  }
  const fm = extractFrontmatter(body);
  if (!fm) {
    return {
      name: "company-standards",
      status: "ok",
      findings: [],
      notes: "company-standards.md has no YAML frontmatter; add a `checks:` block to enable checks",
    };
  }
  const checks = readChecks(fm);
  if (!checks || Object.keys(checks).length === 0) {
    return {
      name: "company-standards",
      status: "ok",
      findings: [],
      notes: "company-standards.md has no `checks:` block; nothing to enforce",
    };
  }

  const findings: Finding[] = [];
  const notes: string[] = [];

  if (checks.license_header) {
    const f = await licenseHeaderCheck(checks.license_header, opts.sourceFiles);
    findings.push(...f);
    notes.push(`license_header: ${f.length === 0 ? "ok" : `${f.length} file(s) missing header`}`);
  }
  if (checks.required_files && checks.required_files.length > 0) {
    const f = await requiredFilesCheck(checks.required_files, opts.projectRoot);
    findings.push(...f);
    notes.push(`required_files: ${f.length === 0 ? "ok" : `${f.length} missing`}`);
  }
  if (checks.branch_prefix && checks.branch_prefix.length > 0) {
    const f = branchPrefixCheck(checks.branch_prefix, opts.projectRoot);
    findings.push(...f);
    notes.push(`branch_prefix: ${f.length === 0 ? "ok" : "mismatch"}`);
  }
  if (checks.commit_style) {
    const { findings: f, notes: n } = commitStyleCheck(checks.commit_style, opts.projectRoot);
    findings.push(...f);
    notes.push(
      `commit_style: ${f.length === 0 ? "ok" : `${f.length} non-conventional`}${n ? ` — ${n}` : ""}`,
    );
  }

  return {
    name: "company-standards",
    status: findings.some((f) => f.severity === "blocker")
      ? "blocker"
      : findings.length > 0
        ? "warning"
        : "ok",
    findings,
    notes: notes.join("; "),
  };
}

async function safeRead(p: string): Promise<string | null> {
  try {
    const st = await stat(p);
    if (st.size > 2 * 1024 * 1024) return null;
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}
