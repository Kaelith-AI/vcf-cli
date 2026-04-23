// vibe_check — project scope. Followup #14.
//
// Static-analysis pass looking for vibe-coding anti-patterns: orphaned
// TODO/HACK/FIXME without ticket references, silent-catch patterns,
// `as any` casts, `@ts-ignore`, empty catch blocks, and await-in-forEach.
// Pure regex + file-walk; no LLM, no tsc AST, no eslint plugin — intentional
// floor so the check stays fast enough to run as a pre-commit gate.
//
// Configurable rule set: pass `rules` to enable a subset, or `paths` to
// scope the scan. Default scans every src-like dir under project_root.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const RuleKey = z.enum([
  "todo-without-ref",
  "silent-catch",
  "as-any",
  "ts-ignore",
  "empty-catch",
  "await-in-foreach",
]);

const VibeCheckInput = z
  .object({
    paths: z
      .array(z.string().min(1).max(512))
      .max(32)
      .default(["src"])
      .describe("directories (relative to project_root) to scan"),
    rules: z.array(RuleKey).max(16).optional().describe("enable only these rules; omit for all"),
    max_findings: z.number().int().positive().max(5000).default(500),
    expand: z.boolean().default(true),
  })
  .strict();

type VibeCheckArgs = z.infer<typeof VibeCheckInput>;

interface VibeCheckRule {
  key: z.infer<typeof RuleKey>;
  severity: "blocker" | "warning" | "info";
  pattern: RegExp;
  message: string;
}

const RULES: readonly VibeCheckRule[] = [
  {
    key: "todo-without-ref",
    severity: "info",
    // TODO/HACK/FIXME/XXX that isn't followed by a ticket marker like
    // (#123), (PROJ-123), or a date stub (2026-04-XX).
    pattern:
      /\/\/\s*(TODO|HACK|FIXME|XXX)\b(?!.*(?:#\d|\([A-Z]+-\d|\d{4}-\d{2}-\d{2}|\(user-|\(operator-))/,
    message: "TODO/HACK/FIXME without a ticket or date reference",
  },
  {
    key: "silent-catch",
    severity: "warning",
    pattern: /\.catch\s*\(\s*(?:\(\)|_[a-z0-9_]*)\s*=>\s*\{\s*\}\s*\)/i,
    message: ".catch(() => {}) silently swallows rejections",
  },
  {
    key: "as-any",
    severity: "warning",
    pattern: /\bas\s+any\b/,
    message: "`as any` cast escapes the type system",
  },
  {
    key: "ts-ignore",
    severity: "warning",
    pattern: /@ts-(ignore|nocheck)/,
    message: "@ts-ignore/@ts-nocheck suppresses a real error — prefer @ts-expect-error",
  },
  {
    key: "empty-catch",
    severity: "warning",
    // Matches `} catch (e) {}` or `} catch {}` — empty handler body.
    pattern: /}\s*catch\s*(?:\([^)]*\)\s*)?\{\s*\}/,
    message: "empty catch block — handle or re-throw the error",
  },
  {
    key: "await-in-foreach",
    severity: "warning",
    // `x.forEach(async ...)` schedules all promises simultaneously and
    // never awaits them. Almost always a bug.
    pattern: /\.forEach\s*\(\s*async\b/,
    message: "await inside .forEach() — use for-of or Promise.all",
  },
];

const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  ".git",
  ".vcf",
]);

interface VibeCheckFinding {
  rule: string;
  severity: string;
  path: string;
  line: number;
  snippet: string;
  message: string;
}

export function registerVibeCheck(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "vibe_check",
    {
      title: "Vibe Check",
      description:
        "Static-analysis sweep for vibe-coding anti-patterns: bare TODO/HACK/FIXME, silent .catch(() => {}), `as any`, @ts-ignore, empty catch blocks, await-in-forEach. Pure regex + file-walk; no LLM. Fast enough for pre-commit. Pass `rules` to scope; default runs all.",
      inputSchema: VibeCheckInput,
    },
    async (args: VibeCheckArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "vibe_check requires project scope");
          }
          const parsed = VibeCheckInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const activeRules = parsed.rules
            ? RULES.filter((r) => parsed.rules!.includes(r.key))
            : RULES;

          const findings: VibeCheckFinding[] = [];
          for (const rel of parsed.paths) {
            const full = join(projectRoot, rel);
            if (!existsSync(full)) continue;
            scan(full, projectRoot, activeRules, findings, parsed.max_findings);
            if (findings.length >= parsed.max_findings) break;
          }

          const byRule: Record<string, number> = {};
          const bySeverity: Record<string, number> = {};
          for (const f of findings) {
            byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
            bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
          }

          const verdict =
            findings.some((f) => f.severity === "blocker")
              ? "BLOCK"
              : findings.some((f) => f.severity === "warning")
                ? "NEEDS_WORK"
                : "PASS";

          const summary = `vibe_check: verdict=${verdict}, ${findings.length} finding(s) across ${parsed.paths.length} dir(s)`;

          return success([], summary, {
            ...(parsed.expand
              ? {
                  content: {
                    verdict,
                    by_rule: byRule,
                    by_severity: bySeverity,
                    findings: findings.slice(0, parsed.max_findings),
                    truncated: findings.length >= parsed.max_findings,
                  },
                }
              : {
                  expand_hint: "Pass expand=true for the findings array.",
                }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "vibe_check",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function scan(
  dir: string,
  projectRoot: string,
  rules: readonly VibeCheckRule[],
  out: VibeCheckFinding[],
  cap: number,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      scan(full, projectRoot, rules, out, cap);
      if (out.length >= cap) return;
    } else if (s.isFile()) {
      if (!SCAN_EXTENSIONS.some((e) => name.endsWith(e))) continue;
      let body: string;
      try {
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = relative(projectRoot, full);
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        for (const rule of rules) {
          if (rule.pattern.test(line)) {
            out.push({
              rule: rule.key,
              severity: rule.severity,
              path: rel,
              line: i + 1,
              snippet: line.trim().slice(0, 240),
              message: rule.message,
            });
            if (out.length >= cap) return;
          }
        }
      }
    }
  }
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { VibeCheckInput, RULES };
