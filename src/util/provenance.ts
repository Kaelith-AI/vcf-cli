// Provenance — uniform shape recording which model produced an artifact.
//
// Every LLM-generated artifact in VCF carries a `provenance` block. For
// direct LLM calls (review_execute, research_verify, lifecycle_report,
// charter_check), VCF builds and writes provenance from its own state.
// For scaffold-returning tools (research_compose, research_resolve, etc.),
// the calling agent must write provenance — the prompt requires it and
// the next downstream tool refuses to operate without it.
//
// Stored two ways:
//   - JSON files (verify.json, resolutions.json, ...) — top-level field
//   - Markdown files (draft.md, review report, lifecycle-report.md) — YAML
//     frontmatter under a `provenance:` key
//
// The shape is the same across both carriers. Validators in this module
// throw McpError(E_VALIDATION) on missing or malformed provenance, with
// a "regenerate the upstream artifact" hint in the message.

import { readFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { McpError } from "../errors.js";

export interface Provenance {
  /** Exact tool that produced the artifact (e.g., "research_verify"). */
  tool: string;
  /** Logical pipeline phase (e.g., "compose", "verify", "resolve"). */
  phase: string;
  /** Exact model id (e.g., "CLIProxyAPI/gemini-3.1-pro-preview"). */
  model: string;
  /**
   * Endpoint name for direct LLM calls (e.g., "litellm", "local-ollama").
   * For scaffold-returning tools where the calling agent makes the call,
   * use one of: "claude-code-subagent", "claude-code-main", "codex",
   * "gemini-cli", "manual" — the descriptor of HOW the LLM was invoked,
   * since there's no VCF-side endpoint.
   */
  endpoint: string;
  /** ISO 8601 timestamp the artifact was produced. */
  generated_at: string;
  /** True when primary endpoint failed and backup was used. Only set on direct calls. */
  fallback_used?: boolean;
}

/**
 * Build a provenance block for a direct VCF LLM call. The caller has
 * everything from its own state at this point.
 */
export function buildProvenance(opts: {
  tool: string;
  phase: string;
  model: string;
  endpoint: string;
  fallback_used?: boolean;
  /** Override generated_at — defaults to now(). Use for deterministic tests. */
  generatedAt?: Date;
}): Provenance {
  const p: Provenance = {
    tool: opts.tool,
    phase: opts.phase,
    model: opts.model,
    endpoint: opts.endpoint,
    generated_at: (opts.generatedAt ?? new Date()).toISOString(),
  };
  if (opts.fallback_used !== undefined) p.fallback_used = opts.fallback_used;
  return p;
}

/**
 * Validate that an object contains a well-formed provenance block.
 * Throws McpError("E_VALIDATION") if missing or malformed. The error
 * message names the artifact and tells the operator to regenerate it.
 */
export function requireProvenance(
  value: unknown,
  context: { artifact: string; expectedPhase?: string | string[] },
): Provenance {
  if (typeof value !== "object" || value === null) {
    throw new McpError(
      "E_VALIDATION",
      `${context.artifact} is missing a provenance block. ` +
        `Regenerate the upstream artifact with a tool that records provenance.`,
    );
  }
  const obj = value as Record<string, unknown>;
  const required: Array<keyof Provenance> = ["tool", "phase", "model", "endpoint", "generated_at"];
  const missing: string[] = [];
  for (const k of required) {
    if (typeof obj[k] !== "string" || (obj[k] as string).trim() === "") {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    throw new McpError(
      "E_VALIDATION",
      `${context.artifact} provenance is missing or malformed fields: ${missing.join(", ")}. ` +
        `Regenerate the upstream artifact with a tool that records provenance.`,
    );
  }
  if (context.expectedPhase !== undefined) {
    const allowed = Array.isArray(context.expectedPhase)
      ? context.expectedPhase
      : [context.expectedPhase];
    if (!allowed.includes(obj["phase"] as string)) {
      throw new McpError(
        "E_VALIDATION",
        `${context.artifact} has provenance.phase='${obj["phase"]}' but expected one of [${allowed.join(", ")}]. ` +
          `Wrong upstream artifact?`,
      );
    }
  }
  const out: Provenance = {
    tool: obj["tool"] as string,
    phase: obj["phase"] as string,
    model: obj["model"] as string,
    endpoint: obj["endpoint"] as string,
    generated_at: obj["generated_at"] as string,
  };
  if (typeof obj["fallback_used"] === "boolean") {
    out.fallback_used = obj["fallback_used"];
  }
  return out;
}

/**
 * Read a JSON artifact's top-level `provenance` field. Throws on missing
 * file, malformed JSON, or missing/malformed provenance block.
 */
export async function readJsonProvenance(
  filePath: string,
  context: { expectedPhase?: string | string[] },
): Promise<{ provenance: Provenance; raw: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpError("E_NOT_FOUND", `cannot read ${filePath}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpError("E_VALIDATION", `${filePath} is not valid JSON: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new McpError("E_VALIDATION", `${filePath} top-level value is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const ctx: { artifact: string; expectedPhase?: string | string[] } = { artifact: filePath };
  if (context.expectedPhase !== undefined) ctx.expectedPhase = context.expectedPhase;
  const provenance = requireProvenance(obj["provenance"], ctx);
  return { provenance, raw: obj };
}

/**
 * Read a markdown file's YAML frontmatter and require a `provenance` key.
 * Returns the parsed Provenance plus the body without frontmatter so the
 * caller can re-serialize without duplicating the parse.
 */
export async function readMarkdownProvenance(
  filePath: string,
  context: { expectedPhase?: string | string[] },
): Promise<{ provenance: Provenance; frontmatter: Record<string, unknown>; body: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpError("E_NOT_FOUND", `cannot read ${filePath}: ${msg}`);
  }
  if (!raw.startsWith("---")) {
    throw new McpError(
      "E_VALIDATION",
      `${filePath} has no YAML frontmatter. Provenance is required at the top under 'provenance:'.`,
    );
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    throw new McpError("E_VALIDATION", `${filePath} has an unterminated YAML frontmatter block.`);
  }
  const block = raw.slice(3, end).trim();
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(block);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new McpError("E_VALIDATION", `${filePath} frontmatter is not valid YAML: ${msg}`);
  }
  if (typeof frontmatter !== "object" || frontmatter === null) {
    throw new McpError("E_VALIDATION", `${filePath} frontmatter is not a YAML object`);
  }
  const fm = frontmatter as Record<string, unknown>;
  const ctx: { artifact: string; expectedPhase?: string | string[] } = { artifact: filePath };
  if (context.expectedPhase !== undefined) ctx.expectedPhase = context.expectedPhase;
  const provenance = requireProvenance(fm["provenance"], ctx);
  // Body starts AFTER the closing fence. `\n---` matched at index `end`;
  // skip the fence and the following newline if present.
  let bodyStart = end + 4; // length of "\n---"
  if (raw[bodyStart] === "\n") bodyStart++;
  const body = raw.slice(bodyStart);
  return { provenance, frontmatter: fm, body };
}

/**
 * Serialize a Provenance into a YAML object suitable for nesting under a
 * `provenance:` key in markdown frontmatter. Use this when a tool builds
 * a fresh markdown artifact and needs to write the frontmatter block.
 */
export function provenanceToYaml(p: Provenance): string {
  // Stringify just the provenance object body, indent by two spaces per
  // line so it nests cleanly under `provenance:` in the parent block.
  const yaml = stringifyYaml({ provenance: p });
  return yaml.trimEnd();
}
