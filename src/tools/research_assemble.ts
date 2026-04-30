// research_assemble — global scope.
//
// New tool (B2 in Workstream B). Closes the missing step between the 3-agent
// build panel (research_compose / orchestrator-driven) and the verifier:
//
//   compose → ASSEMBLE → verify → resolve → operator merge
//
// Reads the per-aspect JSONs from `~/.vcf/kb-drafts/<draft_id>/aspects/`
// (each emitted by one slot of the build panel) and produces a single
// draft.md + sources.json with a unified provenance block.
//
// Two modes (panel-mode shared schema):
//   mode=execute   — MCP calls the configured kb_finalize role via the
//                    dispatcher, parses the structured output, writes
//                    draft.md + sources.json itself.
//   mode=directive — MCP returns the assembly prompt + expected output
//                    paths. Orchestrator runs the call and writes the
//                    files. Same shape as research_verify's directive
//                    mode. Useful when the orchestrator wants to drive
//                    the assemble through its harness's web search (e.g.
//                    to chase down a citation that needs to land in
//                    sources.json).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { kbDraftsDir } from "../project/stateDir.js";
import { PanelModeSchema } from "../util/panel.js";
import { resolveRole } from "../util/roleResolve.js";
import { dispatchChatCompletion } from "../util/dispatcher.js";
import { resolveAuthKey } from "../review/endpointResolve.js";
import { buildProvenance } from "../util/provenance.js";
import type { ChatMessage } from "../util/llmClient.js";

const DraftIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "draft_id must be a safe directory name");

const ResearchAssembleInput = z
  .object({
    draft_id: DraftIdSchema.describe(
      "staging dir under ~/.vcf/kb-drafts/ containing aspects/*.json from the compose-phase build panel",
    ),
    kind: z
      .enum(["primer", "best-practice", "review-stage", "reviewer", "standard", "lens"])
      .describe("KB entry kind the draft will land as"),
    topic: z.string().min(1).max(256),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("kb_finalize")
      .describe("role name to use for execute mode (default 'kb_finalize')"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000)
      .default(180_000),
    mode: PanelModeSchema,
    expand: z.boolean().default(false),
  })
  .strict();

type ResearchAssembleArgs = z.infer<typeof ResearchAssembleInput>;

export function registerResearchAssemble(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "research_assemble",
    {
      title: "Assemble Compose-Phase Aspects Into a Single Draft",
      description:
        "Read per-aspect JSONs from ~/.vcf/kb-drafts/<draft_id>/aspects/ and merge them into draft.md + sources.json with provenance. mode=execute calls the configured kb_finalize role via the dispatcher; mode=directive returns the prompt for the orchestrator to run.",
      inputSchema: ResearchAssembleInput.shape,
    },
    async (args: ResearchAssembleArgs, extra: { signal?: AbortSignal } | undefined) => {
      let auditOutputs: unknown = undefined;
      return runTool(
        async () => {
          const parsed = ResearchAssembleInput.parse(args);
          const draftDir = join(kbDraftsDir(deps.homeDir), parsed.draft_id);
          if (!existsSync(draftDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `kb-drafts directory '${parsed.draft_id}' not found at ${draftDir}`,
            );
          }
          const aspectsDir = join(draftDir, "aspects");
          if (!existsSync(aspectsDir)) {
            throw new McpError(
              "E_NOT_FOUND",
              `aspects/ subdir missing in ${draftDir} — run the compose build panel first`,
            );
          }

          // Read every aspect-*.json. Order by filename so the assembled
          // draft is reproducible across runs.
          const entries = (await readdir(aspectsDir)).filter((f) => f.endsWith(".json")).sort();
          if (entries.length === 0) {
            throw new McpError(
              "E_NOT_FOUND",
              `no aspect-*.json files in ${aspectsDir} — compose build panel produced no output`,
            );
          }
          const aspectPayloads: { filename: string; body: string }[] = [];
          for (const f of entries) {
            const body = await readFile(join(aspectsDir, f), "utf8");
            aspectPayloads.push({ filename: f, body });
          }

          const draftPath = join(draftDir, "draft.md");
          const sourcesPath = join(draftDir, "sources.json");
          const messages = composeAssembleMessages({
            kind: parsed.kind,
            topic: parsed.topic,
            aspects: aspectPayloads,
          });

          if (parsed.mode === "directive") {
            auditOutputs = {
              ok: true,
              mode: "directive",
              draft_id: parsed.draft_id,
              expected_outputs: { draft_path: draftPath, sources_path: sourcesPath },
              aspect_count: entries.length,
            };
            return success<Record<string, unknown>>(
              [draftPath, sourcesPath],
              `research_assemble: directive emitted for '${parsed.draft_id}' (${entries.length} aspect(s)) — orchestrator runs assembly, writes draft.md + sources.json`,
              parsed.expand
                ? {
                    content: {
                      mode: "directive",
                      draft_id: parsed.draft_id,
                      staging_dir: draftDir,
                      expected_outputs: {
                        draft_path: draftPath,
                        sources_path: sourcesPath,
                      },
                      messages,
                      aspect_files: entries.map((f) => join(aspectsDir, f)),
                      next_tool: "research_verify",
                      next_tool_args: { draft_id: parsed.draft_id },
                      instructions:
                        "Run a frontier-tier assembler. Merge the aspect JSONs into one cohesive " +
                        `${parsed.kind} draft. Write the markdown body to draft_path. Write a ` +
                        "sources.json next to it consolidating every cited source from the aspects " +
                        "(deduplicated, with stable ids). Both files MUST carry a provenance block " +
                        "(tool=research_assemble, phase=assemble, model=<your model id>, " +
                        "endpoint=<your endpoint>, generated_at=<ISO 8601>). Then call research_verify.",
                    },
                  }
                : {},
            );
          }

          // mode=execute: resolve the role, dispatch, parse the LLM's two-file
          // output (draft markdown + sources JSON, separated by a sentinel
          // marker), write both files with provenance.
          const resolved = resolveRole(deps.config, parsed.role);
          const { apiKey } = resolveAuthKey(resolved.endpoint, undefined);

          const ctrl = new AbortController();
          const onAbort = (): void => ctrl.abort();
          extra?.signal?.addEventListener("abort", onAbort);
          const timer = setTimeout(() => ctrl.abort(), parsed.timeout_ms);

          let dispatch;
          try {
            dispatch = await dispatchChatCompletion({
              endpoint: resolved.endpoint,
              modelId: resolved.modelId,
              messages,
              ...(apiKey !== undefined ? { apiKey } : {}),
              temperature: 0.1,
              signal: ctrl.signal,
              ...(resolved.endpoint.provider_options
                ? {
                    providerOptions: resolved.endpoint.provider_options as Record<string, unknown>,
                  }
                : {}),
            });
          } finally {
            clearTimeout(timer);
            extra?.signal?.removeEventListener("abort", onAbort);
          }

          const split = splitDraftAndSources(dispatch.content);
          if (!split) {
            throw new McpError(
              "E_INTERNAL",
              `research_assemble: LLM output missing required '<<<SOURCES_JSON>>>' separator. ` +
                `Raw output (first 500 chars): ${dispatch.content.slice(0, 500)}`,
            );
          }
          const provenance = buildProvenance({
            tool: "research_assemble",
            phase: "assemble",
            model: resolved.modelId,
            endpoint: resolved.endpoint.name,
          });

          // Inject provenance into the markdown frontmatter and the JSON top-level.
          const finalMd = injectMarkdownProvenance(split.draftMd, provenance);
          const finalJson = injectJsonProvenance(split.sourcesJson, provenance);
          await writeFile(draftPath, finalMd, "utf8");
          await writeFile(sourcesPath, finalJson, "utf8");

          auditOutputs = {
            ok: true,
            mode: "execute",
            draft_id: parsed.draft_id,
            draft_path: draftPath,
            sources_path: sourcesPath,
            aspect_count: entries.length,
            route: dispatch.route,
          };
          return success<Record<string, unknown>>(
            [draftPath, sourcesPath],
            `research_assemble: executed via ${resolved.endpoint.name}/${resolved.modelId} (${entries.length} aspect(s)) → ${draftPath}`,
            parsed.expand
              ? {
                  content: {
                    mode: "execute",
                    draft_id: parsed.draft_id,
                    draft_path: draftPath,
                    sources_path: sourcesPath,
                    aspect_count: entries.length,
                    route: dispatch.route,
                    provenance,
                  },
                }
              : {},
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "research_assemble",
            scope: "global",
            project_root: null,
            inputs: { draft_id: args.draft_id, mode: args.mode, role: args.role, kind: args.kind },
            outputs: auditOutputs ?? payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function composeAssembleMessages(opts: {
  kind: string;
  topic: string;
  aspects: { filename: string; body: string }[];
}): ChatMessage[] {
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    `You are assembling a single KB ${opts.kind} draft from ${opts.aspects.length} aspect reports`,
    `produced by parallel research subagents. Today is ${today}.`,
    ``,
    `Your job:`,
    `  1. Synthesize the per-aspect findings into ONE cohesive markdown body.`,
    `  2. Resolve contradictions by preferring tier-1/tier-2 sources (primary,`,
    `     official-docs) over tier-3+ (vendor-blog, personal-blog, aggregator).`,
    `     If still in conflict, surface both and label which source supports each.`,
    `  3. Carry every source through to a consolidated sources.json with stable`,
    `     numeric ids (1..N). Footnote-link claims in the markdown back to those ids.`,
    `  4. Drop any claim that lost its source during deduplication.`,
    ``,
    `Output format — TWO sections separated by an exact sentinel line:`,
    ``,
    `  <draft.md content here, including YAML frontmatter — `,
    `   topic, kind=${opts.kind}, tags, lens, etc. Provenance will be injected by`,
    `   the calling tool — do NOT add a provenance: block yourself.>`,
    ``,
    `<<<SOURCES_JSON>>>`,
    ``,
    `  {`,
    `    "sources": [`,
    `      {"id": 1, "url": "...", "title": "...", "tier": "primary", "published": "YYYY-MM-DD"},`,
    `      ...`,
    `    ]`,
    `  }`,
    ``,
    `No prose outside those two sections. The sentinel line must be exactly`,
    `\`<<<SOURCES_JSON>>>\` on its own line.`,
  ].join("\n");

  const user = [
    `# Topic`,
    ``,
    opts.topic,
    ``,
    `# Aspect reports (${opts.aspects.length} total)`,
    ``,
    ...opts.aspects.flatMap((a) => [`## ${a.filename}`, ``, "```json", a.body, "```", ""]),
    `Assemble the draft + sources.json now. Output draft.md content first,`,
    `then a line with exactly \`<<<SOURCES_JSON>>>\`, then the sources JSON.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const SOURCES_SENTINEL = "<<<SOURCES_JSON>>>";

function splitDraftAndSources(raw: string): { draftMd: string; sourcesJson: string } | null {
  const idx = raw.indexOf(SOURCES_SENTINEL);
  if (idx < 0) return null;
  let draftMd = raw.slice(0, idx).trim();
  let sourcesJson = raw.slice(idx + SOURCES_SENTINEL.length).trim();
  // Strip a leading code fence if present.
  if (sourcesJson.startsWith("```")) {
    const nl = sourcesJson.indexOf("\n");
    if (nl > 0) sourcesJson = sourcesJson.slice(nl + 1);
    if (sourcesJson.endsWith("```")) sourcesJson = sourcesJson.slice(0, -3).trim();
  }
  if (draftMd.startsWith("```")) {
    const nl = draftMd.indexOf("\n");
    if (nl > 0) draftMd = draftMd.slice(nl + 1);
    if (draftMd.endsWith("```")) draftMd = draftMd.slice(0, -3).trim();
  }
  return { draftMd, sourcesJson };
}

function injectMarkdownProvenance(
  md: string,
  provenance: ReturnType<typeof buildProvenance>,
): string {
  const yaml = [
    `provenance:`,
    `  tool: ${provenance.tool}`,
    `  phase: ${provenance.phase}`,
    `  model: ${provenance.model}`,
    `  endpoint: ${provenance.endpoint}`,
    `  generated_at: ${provenance.generated_at}`,
  ].join("\n");

  const trimmed = md.trim();
  if (trimmed.startsWith("---")) {
    // Insert provenance into the existing frontmatter just before the closing `---`.
    const closingIdx = trimmed.indexOf("\n---", 4);
    if (closingIdx > 0) {
      return trimmed.slice(0, closingIdx) + "\n" + yaml + trimmed.slice(closingIdx) + "\n";
    }
  }
  // No frontmatter — wrap one.
  return `---\n${yaml}\n---\n\n${trimmed}\n`;
}

function injectJsonProvenance(raw: string, provenance: ReturnType<typeof buildProvenance>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // LLM emitted bad JSON — wrap as a defensive payload so the operator
    // still has something to inspect.
    return JSON.stringify({ provenance, raw }, null, 2) + "\n";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify({ provenance, sources: parsed }, null, 2) + "\n";
  }
  const merged = { provenance, ...(parsed as Record<string, unknown>) };
  return JSON.stringify(merged, null, 2) + "\n";
}
