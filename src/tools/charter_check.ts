// charter_check — project scope.
//
// Phase G-A: LLM-driven audit that reads the charter artifact and the
// project's accepted decision log entries, then asks the configured build
// endpoint whether any charter constraints or design decisions have been
// deviated from. Returns a PASS / NEEDS_REVIEW / BLOCK verdict.
//
// Verdict meanings:
//   PASS         — no uncovered drift found
//   NEEDS_REVIEW — covered drift present (has a decision log entry); verify intentional
//   BLOCK        — uncovered drift found; must be resolved before shipping

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { assertApiEndpoint } from "../util/endpointKind.js";
import { resolveOutputs } from "../util/outputs.js";
import { McpError } from "../errors.js";
import { callChatCompletionWithFallback, LlmError, type ChatMessage } from "../util/llmClient.js";
import { buildBackupRequest, resolveAuthKey } from "../review/endpointResolve.js";
import { redact } from "../util/audit.js";

const CharterCheckInput = z
  .object({
    plan_name: z.string().min(1).max(128),
    expand: z.boolean().default(false),
  })
  .strict();

type CharterCheckArgs = z.infer<typeof CharterCheckInput>;

interface DecisionRow {
  slug: string;
  path: string;
  created_at: number;
}

interface Finding {
  constraint: string;
  covered: boolean;
  decision_slug: string | null;
  detail: string;
}

interface LlmVerdict {
  verdict: "PASS" | "NEEDS_REVIEW" | "BLOCK";
  findings: Finding[];
  summary: string;
}

export function registerCharterCheck(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "charter_check",
    {
      title: "Charter Drift Check",
      description:
        "Read the charter artifact and accepted decision log, then call the configured build endpoint to identify deviations from charter constraints and design decisions. Returns PASS (no uncovered drift), NEEDS_REVIEW (covered drift — verify intentional), or BLOCK (uncovered drift found).",
      inputSchema: CharterCheckInput.shape,
    },
    async (args: CharterCheckArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "charter_check requires project scope");
          }
          const parsed = CharterCheckInput.parse(args);
          const root = readProjectRoot(deps);
          if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

          const outputs = resolveOutputs(root, deps.config);
          const charterPath = join(outputs.plansDir, `${parsed.plan_name}-charter.md`);

          if (!existsSync(charterPath)) {
            throw new McpError(
              "E_NOT_FOUND",
              `Charter file not found: ${charterPath}. This plan was created before Phase G (no charter artifact). Run plan_save with a charter field to create one.`,
            );
          }

          const charterContent = await readFile(charterPath, "utf8");

          // Read accepted decisions from the project DB.
          const decisions = deps.projectDb
            .prepare("SELECT slug, path, created_at FROM decisions ORDER BY created_at ASC")
            .all() as unknown as DecisionRow[];

          // Read decision file bodies for context.
          const decisionSummaries: string[] = [];
          for (const d of decisions) {
            if (existsSync(d.path)) {
              try {
                const body = await readFile(d.path, "utf8");
                decisionSummaries.push(`### ${d.slug}\n${body.slice(0, 1000)}`);
              } catch {
                decisionSummaries.push(`### ${d.slug}\n(file unreadable)`);
              }
            } else {
              decisionSummaries.push(`### ${d.slug}\n(file missing)`);
            }
          }

          // Build the LLM prompt.
          const prompt = buildCharterCheckPrompt(charterContent, decisionSummaries);

          // Attempt LLM call via the configured charter_check endpoint.
          // Propagates config errors and cancellations; degrades to
          // NEEDS_REVIEW on transient LLM failures so the tool remains
          // useful as a prompt generator even when the endpoint is down.
          let verdict: LlmVerdict;
          try {
            verdict = await callCharterCheckLlm(deps, prompt);
          } catch (err) {
            if (err instanceof McpError && err.code === "E_CANCELED") throw err;
            if (err instanceof LlmError && err.kind === "canceled") {
              throw new McpError("E_CANCELED", err.message);
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            verdict = {
              verdict: "NEEDS_REVIEW",
              findings: [],
              summary: `LLM call failed (${errMsg}). Manual review required. Charter path: ${charterPath}. Decision count: ${decisions.length}.`,
            };
          }

          return success(
            [charterPath],
            `charter_check: verdict=${verdict.verdict}, ${verdict.findings.length} finding(s). ${decisions.length} decision(s) in log.`,
            parsed.expand
              ? {
                  content: {
                    plan_name: parsed.plan_name,
                    charter_path: charterPath,
                    decision_count: decisions.length,
                    verdict: verdict.verdict,
                    findings: verdict.findings,
                    llm_summary: verdict.summary,
                  },
                }
              : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "charter_check",
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

function buildCharterCheckPrompt(charter: string, decisionSummaries: string[]): string {
  const decisionsBlock =
    decisionSummaries.length > 0
      ? decisionSummaries.join("\n\n")
      : "(No decision log entries found)";

  return [
    `You are auditing a software project's charter for constraint drift.`,
    ``,
    `## Charter`,
    ``,
    charter,
    ``,
    `## Accepted Decision Log Entries`,
    ``,
    decisionsBlock,
    ``,
    `## Your Task`,
    ``,
    `Identify which charter constraints or design decisions have been deviated from`,
    `in the current project. For each deviation:`,
    ``,
    `1. Name the specific charter constraint or design decision being deviated from.`,
    `2. Note whether it is covered by an accepted decision log entry (COVERED) or`,
    `   appears to be uncovered drift (UNCOVERED).`,
    `3. Provide a brief explanation.`,
    ``,
    `Then give a final verdict:`,
    `- PASS — no uncovered drift found`,
    `- NEEDS_REVIEW — covered drift present; verify it was intentional`,
    `- BLOCK — uncovered drift found; must be resolved before shipping`,
    ``,
    `Respond in this exact JSON format:`,
    `{`,
    `  "verdict": "PASS" | "NEEDS_REVIEW" | "BLOCK",`,
    `  "findings": [`,
    `    {`,
    `      "constraint": "<name of the charter constraint or decision>",`,
    `      "covered": true | false,`,
    `      "decision_slug": "<slug if covered, null if not>",`,
    `      "detail": "<brief explanation>"`,
    `    }`,
    `  ],`,
    `  "summary": "<one-sentence overall assessment>"`,
    `}`,
    ``,
    `If there are no deviations, return an empty findings array and verdict PASS.`,
  ].join("\n");
}

async function callCharterCheckLlm(deps: ServerDeps, prompt: string): Promise<LlmVerdict> {
  const ccDefaults = deps.config.defaults?.charter_check;
  if (!ccDefaults?.endpoint) {
    throw new McpError("E_VALIDATION", "defaults.charter_check.endpoint is not configured");
  }
  const endpointName = ccDefaults.endpoint;
  const endpointRaw = deps.config.endpoints.find((e) => e.name === endpointName);
  if (!endpointRaw) {
    throw new McpError("E_VALIDATION", `endpoint '${endpointName}' not found in config.endpoints`);
  }
  if (!endpointRaw.enabled) {
    throw new McpError(
      "E_ENDPOINT_DISABLED",
      `endpoint '${endpointRaw.name}' is disabled (set enabled=true in config.endpoints)`,
    );
  }
  const endpoint = assertApiEndpoint(endpointRaw);
  const modelId = ccDefaults.model;
  if (!modelId) {
    throw new McpError("E_VALIDATION", "defaults.charter_check.model is not configured");
  }

  const { apiKey, envVarName, source } = resolveAuthKey(endpoint, ccDefaults.key);
  if (!apiKey && envVarName && endpoint.trust_level !== "local") {
    throw new McpError(
      "E_CONFIG_MISSING_ENV",
      `env var ${envVarName} is unset (referenced via ${source === "feature" ? "defaults.charter_check.key" : `endpoints[${endpoint.name}].auth_env_var`}); endpoint '${endpoint.name}' needs it`,
    );
  }

  const messages = redact([{ role: "user", content: prompt }] as ChatMessage[]) as ChatMessage[];

  const primaryReq = {
    baseUrl: endpoint.base_url,
    apiKey,
    model: modelId,
    messages,
    temperature: 0,
    jsonResponse: true,
  };
  const backupReq = buildBackupRequest(deps.config, "charter_check", primaryReq);
  const { content } = await callChatCompletionWithFallback(primaryReq, backupReq);

  // Parse JSON — strip markdown fences if present.
  const jsonText = content
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    return JSON.parse(jsonText) as LlmVerdict;
  } catch {
    return {
      verdict: "NEEDS_REVIEW",
      findings: [],
      summary: `LLM response was not valid JSON. Raw: ${content.slice(0, 500)}`,
    };
  }
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
