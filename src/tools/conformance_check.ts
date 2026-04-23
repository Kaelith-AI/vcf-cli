// conformance_check — project scope. Followup #13.
//
// Deterministic audit: read the plan's manifest + the decisions dir, then
// assert that reality matches what the paper trail promised. Does NOT call
// an LLM. Fast enough to run as a pre-commit or pre-merge check.
//
// What it checks:
//   - Every file the manifest claims will exist actually exists under
//     project_root.
//   - Every decision in plans/decisions/*.md with status=accepted has NOT
//     been marked superseded without an explicit superseded_by link in
//     another decision's frontmatter.
//   - Optional (off by default): flag manifest files that exist but are
//     empty (0 bytes) — usually a leftover placeholder.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { resolveOutputs } from "../util/outputs.js";

const ConformanceCheckInput = z
  .object({
    plan_name: z.string().min(1).max(256).optional(),
    flag_empty_files: z.boolean().default(false),
    expand: z.boolean().default(true),
  })
  .strict();

type ConformanceCheckArgs = z.infer<typeof ConformanceCheckInput>;

interface ConformanceFinding {
  severity: "blocker" | "warning" | "info";
  kind: "missing-file" | "empty-file" | "orphan-decision";
  path: string;
  message: string;
}

export function registerConformanceCheck(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "conformance_check",
    {
      title: "Conformance Check",
      description:
        "Deterministic audit that reads the plan's manifest + decisions and asserts reality matches. Flags manifest files that don't exist (blocker), decisions marked accepted but superseded without a link (warning), and optionally empty files (info). Fast, no LLM. Runs great as a pre-commit gate.",
      inputSchema: ConformanceCheckInput,
    },
    async (args: ConformanceCheckArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError(
              "E_STATE_INVALID",
              "conformance_check requires project scope",
            );
          }
          const parsed = ConformanceCheckInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const outputs = resolveOutputs(projectRoot, deps.config);
          const plansDir = outputs.plansDir;
          const decisionsDir = outputs.decisionsDir;

          const planName = parsed.plan_name ?? findNewestPlanName(plansDir);
          if (!planName) {
            throw new McpError(
              "E_NOT_FOUND",
              `no plan found under ${plansDir}. Pass plan_name explicitly, or run plan_save first.`,
            );
          }

          const manifestPath = join(plansDir, `${planName}-manifest.md`);
          if (!existsSync(manifestPath)) {
            throw new McpError(
              "E_NOT_FOUND",
              `manifest file ${manifestPath} does not exist — cannot audit`,
            );
          }

          const findings: ConformanceFinding[] = [];

          // Manifest claims → file existence.
          const manifestBody = readFileSync(manifestPath, "utf8");
          const claimed = extractManifestPaths(manifestBody);
          for (const rel of claimed) {
            const abs = join(projectRoot, rel);
            if (!existsSync(abs)) {
              findings.push({
                severity: "blocker",
                kind: "missing-file",
                path: rel,
                message: `manifest claims ${rel} but file does not exist under ${projectRoot}`,
              });
              continue;
            }
            if (parsed.flag_empty_files) {
              try {
                const s = statSync(abs);
                if (s.size === 0) {
                  findings.push({
                    severity: "info",
                    kind: "empty-file",
                    path: rel,
                    message: `${rel} exists but is 0 bytes — placeholder?`,
                  });
                }
              } catch {
                /* skip */
              }
            }
          }

          // Decisions: accepted → not silently superseded.
          const orphanDecisions = auditDecisions(decisionsDir);
          findings.push(...orphanDecisions);

          const verdict =
            findings.some((f) => f.severity === "blocker")
              ? "BLOCK"
              : findings.some((f) => f.severity === "warning")
                ? "NEEDS_WORK"
                : "PASS";

          const summary = `conformance_check: verdict=${verdict}, ${findings.length} finding(s) across ${claimed.length} manifest entries`;

          return success([manifestPath, decisionsDir], summary, {
            ...(parsed.expand
              ? {
                  content: {
                    plan_name: planName,
                    manifest_path: manifestPath,
                    decisions_dir: decisionsDir,
                    manifest_entry_count: claimed.length,
                    verdict,
                    findings,
                  },
                }
              : {
                  expand_hint: "Pass expand=true for the findings array.",
                }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "conformance_check",
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

/**
 * Extract file paths from a manifest body. Convention: manifest lines that
 * look like `- \`relative/path\`` or ` \`relative/path\` ` name files.
 * Tolerant — unknown lines are skipped. Duplicates deduped.
 */
function extractManifestPaths(body: string): string[] {
  const out = new Set<string>();
  // `<path>` anywhere in the line, where path contains a / and ends with a
  // recognizable file extension. Filters headings like `### Overview` that
  // happen to contain backticked tokens.
  const re = /`([a-zA-Z0-9_./\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|md|yaml|yml|json|toml|sql|sh|html|css|scss))`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const p = m[1];
    if (!p) continue;
    if (p.startsWith("./") || p.startsWith("/")) continue; // absolute / explicit-relative skip
    if (p.includes(" ")) continue;
    out.add(p);
  }
  return [...out];
}

function auditDecisions(decisionsDir: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  if (!existsSync(decisionsDir)) return findings;
  let entries: string[];
  try {
    entries = readdirSync(decisionsDir);
  } catch {
    return findings;
  }
  const accepted: Array<{ file: string; slug: string; supersededBy?: string }> = [];
  const allFrontmatter: Map<string, Record<string, string>> = new Map();
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = join(decisionsDir, name);
    let body: string;
    try {
      body = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(body);
    const slug = fm.slug ?? name.replace(/\.md$/, "");
    allFrontmatter.set(slug, fm);
    if (fm.status === "accepted") {
      accepted.push({
        file: relative(decisionsDir, full),
        slug,
        ...(fm.superseded_by ? { supersededBy: fm.superseded_by } : {}),
      });
    }
  }
  for (const d of accepted) {
    if (d.supersededBy && !allFrontmatter.has(d.supersededBy)) {
      findings.push({
        severity: "warning",
        kind: "orphan-decision",
        path: d.file,
        message: `decision '${d.slug}' is accepted but superseded_by='${d.supersededBy}' which has no decision file`,
      });
    }
  }
  return findings;
}

/** Minimal YAML frontmatter parser — only handles flat `key: value` lines. */
function parseFrontmatter(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body.startsWith("---")) return out;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return out;
  const block = body.slice(3, end);
  for (const line of block.split("\n")) {
    const m = /^([a-z_][a-z0-9_-]*):\s*(.*)$/i.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) {
      out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return out;
}

function findNewestPlanName(plansDir: string): string | null {
  try {
    const entries = readdirSync(plansDir);
    const candidates: Array<{ name: string; mtime: number }> = [];
    for (const n of entries) {
      const m = /^(.+)-manifest\.md$/.exec(n);
      if (!m || !m[1]) continue;
      try {
        const s = statSync(join(plansDir, n));
        candidates.push({ name: m[1], mtime: s.mtimeMs });
      } catch {
        /* skip */
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]!.name;
  } catch {
    return null;
  }
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { ConformanceCheckInput };
