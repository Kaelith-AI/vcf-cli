// Followup #45 — prompt composition + submission parsing for review_execute.
//
// What the LLM sees (composeMessages) and what we accept back
// (parseSubmission) live here so review_execute.ts can focus on the
// orchestration path (endpoint resolve, cancellation, persistence, audit).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpError } from "../errors.js";
import { CARRY_FORWARD_SECTIONS, type CarryForwardSection } from "./carryForward.js";
import type { OverlayBundle } from "./overlays.js";
import type { ChatMessage } from "../util/llmClient.js";
import {
  VERDICTS,
  type Finding,
  type ReviewRunRow,
  type Severity,
  type Submission,
} from "./submitCore.js";

/**
 * Read every prepare-time artifact under `runDir` and render the
 * system + user messages the reviewer model is invoked with. An explicit
 * `overlay` wins over the run-dir's reviewer snapshot — that's the path
 * the Phase-2 per-model resolver uses.
 */
export async function composeMessages(
  runDir: string,
  run: ReviewRunRow,
  overlay?: OverlayBundle,
): Promise<ChatMessage[]> {
  const stageText = await readIf(join(runDir, `stage-${run.stage}.${run.type}.md`));
  // The run dir's copy of reviewer-<type>.md is the prepare-time snapshot;
  // the resolved overlay from the KB is authoritative when the caller
  // passes one. Prefer the KB-resolved base so Phase-2 overlays land even
  // on pre-existing run directories prepared before the resolver shipped.
  const reviewerText = overlay?.base ?? (await readIf(join(runDir, `reviewer-${run.type}.md`)));
  const carryForwardText = await readIf(join(runDir, "carry-forward.yaml"));
  const decisionsText = await readIf(join(runDir, "decisions.snapshot.md"));
  const responseLogText = await readIf(join(runDir, "response-log.snapshot.md"));
  const diffText = await readIf(join(runDir, "scoped-diff.patch"));

  const systemParts: string[] = [];
  if (reviewerText) systemParts.push(reviewerText);
  if (overlay?.overlay) {
    systemParts.push(
      `## Model-family calibration overlay (${overlay.overlayMatch}, family=${overlay.family ?? "unknown"})\n\n${overlay.overlay}`,
    );
  }
  systemParts.push(
    [
      "",
      "## Required response format",
      "",
      "Respond with a **single JSON object** (no prose, no markdown fences).",
      "Shape:",
      "```",
      "{",
      '  "verdict": "PASS" | "NEEDS_WORK" | "BLOCK",',
      '  "summary": "<4-4000 chars>",',
      '  "findings": [',
      '    { "file": "path/to/file", "line": 42, "severity": "info"|"warning"|"blocker",',
      '      "description": "<4-4000 chars>", "required_change": "<optional, <=4000 chars>" }',
      "  ],",
      '  "carry_forward": [',
      '    { "section": "architecture"|"verification"|"security"|"compliance"|"supportability"|"release_confidence",',
      '      "severity": "info"|"warning"|"blocker", "text": "<4-2000 chars>" }',
      "  ]",
      "}",
      "```",
      "Obey every hard rule in this overlay. Cite file:line in every finding. On architectural compromise, return BLOCK rather than line-picking.",
    ].join("\n"),
  );
  const system = systemParts.join("\n\n").trim();

  const userParts: string[] = [];
  if (stageText) userParts.push("# Stage definition\n\n" + stageText);
  if (carryForwardText)
    userParts.push("# Inherited carry-forward\n\n```yaml\n" + carryForwardText.trim() + "\n```");
  if (diffText && !diffText.startsWith("(empty diff)"))
    userParts.push("# Scoped diff\n\n```diff\n" + diffText + "\n```");
  if (decisionsText) userParts.push("# Decision log snapshot\n\n" + decisionsText);
  if (responseLogText) userParts.push("# Response log snapshot\n\n" + responseLogText);
  const user = userParts.join("\n\n---\n\n").trim();

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function readIf(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse the reviewer endpoint's raw text into a {@link Submission}. Throws
 * `McpError` with `E_VALIDATION` on any shape/enum violation — the outer
 * envelope translates that into the standard envelope error code.
 */
export function parseSubmission(raw: string): Submission {
  const body = extractJsonObject(raw);
  if (body === null) {
    throw new McpError("E_VALIDATION", "endpoint response did not contain a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new McpError("E_VALIDATION", "endpoint response JSON parse failed");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new McpError("E_VALIDATION", "endpoint response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw new McpError("E_VALIDATION", `verdict must be one of ${VERDICTS.join("|")}`);
  }
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  if (summary.length < 4 || summary.length > 4_000) {
    throw new McpError("E_VALIDATION", "summary must be 4-4000 chars");
  }

  const findings: Finding[] = [];
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of rawFindings) {
    if (typeof f !== "object" || f === null) continue;
    const fr = f as Record<string, unknown>;
    const sev = fr.severity;
    if (sev !== "info" && sev !== "warning" && sev !== "blocker") continue;
    const desc = typeof fr.description === "string" ? fr.description : "";
    if (desc.length < 4 || desc.length > 4_000) continue;
    const finding: Finding = {
      severity: sev as Severity,
      description: desc,
    };
    if (typeof fr.file === "string") finding.file = fr.file.slice(0, 512);
    if (typeof fr.line === "number" && fr.line >= 0) finding.line = Math.floor(fr.line);
    if (typeof fr.required_change === "string" && fr.required_change.length <= 4_000)
      finding.required_change = fr.required_change;
    findings.push(finding);
    if (findings.length >= 200) break;
  }

  const carry: Submission["carry_forward"] = [];
  const rawCarry = Array.isArray(obj.carry_forward) ? obj.carry_forward : [];
  for (const c of rawCarry) {
    if (typeof c !== "object" || c === null) continue;
    const cr = c as Record<string, unknown>;
    const section = cr.section;
    if (!(CARRY_FORWARD_SECTIONS as readonly string[]).includes(section as string)) continue;
    const sev = cr.severity;
    if (sev !== "info" && sev !== "warning" && sev !== "blocker") continue;
    const text = typeof cr.text === "string" ? cr.text : "";
    if (text.length < 4 || text.length > 2_000) continue;
    carry.push({ section: section as CarryForwardSection, severity: sev as Severity, text });
    if (carry.length >= 120) break;
  }

  return {
    verdict: verdict as Submission["verdict"],
    summary,
    findings,
    carry_forward: carry,
  };
}

/** Pulls a balanced JSON object out of arbitrary LLM output. */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return raw.slice(first, last + 1);
}
