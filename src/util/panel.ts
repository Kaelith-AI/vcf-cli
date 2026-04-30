// Panel-mode shared utilities.
//
// Multi-agent tools (research_compose, research_verify, research_resolve)
// expose a `mode` arg that switches between two ways of running a panel:
//
//   mode=execute   — the MCP tool resolves a panel role, fans out through
//                    the dispatcher in parallel, returns the joined results.
//                    One round-trip from the orchestrator's POV.
//
//   mode=directive — the MCP tool returns a PanelDirective: the resolved
//                    panel slots, the prompt for each, and an absolute
//                    expected_output_path the orchestrator should write to.
//                    The orchestrator (Claude Code, etc.) spawns each agent
//                    itself (Task tool / CLI / API) and feeds results back
//                    via the next pipeline step.
//
// The two modes share the same panel-resolution and prompt-building code —
// only the "run vs. describe" branch differs. This file owns:
//   - PanelMode schema (Zod enum)
//   - PanelDirective + PanelResult result shapes
//   - runPanel: parallel dispatch helper with vendor-diversity enforced
//     upstream by resolveRolePanel
//   - buildDirective: turn a panel + prompts into the orchestrator-facing
//     directive shape
//
// All consumers go through these helpers — no tool should hand-roll panel
// dispatch. Keeps the directive shape stable across tools so a single
// orchestrator skill can drive any of them.

import { z } from "zod";
import type { ChatMessage } from "./llmClient.js";
import { dispatchChatCompletion, type DispatchResult } from "./dispatcher.js";
import { resolveRolePanel, type ResolvedModel } from "./roleResolve.js";
import type { Config } from "../config/schema.js";

export const PanelModeSchema = z.enum(["execute", "directive"]).default("execute");
export type PanelMode = z.infer<typeof PanelModeSchema>;

/**
 * One slot in a directive-mode response. The orchestrator reads this and
 * spawns an agent of its choosing, writes the result to
 * `expected_output_path`, then calls the `next_tool` pointer.
 */
export interface PanelDirectiveSlot {
  slot: number;
  /** model_aliases[].alias name. */
  model_alias: string;
  /** Provider model id, e.g. claude-opus-4-7. */
  model_id: string;
  /** endpoints[].name the alias points at. */
  endpoint: string;
  /** Endpoint kind hint — orchestrator may use it to choose its spawn path. */
  endpoint_kind: "api" | "cli";
  /** Vendor for vendor-diversity guarantees (e.g. anthropic, openai, google). */
  vendor: string | undefined;
  /** Capability tags on the model. */
  tags: readonly string[];
  /** The prompt the agent should run with. Already includes recency floor + system. */
  messages: ChatMessage[];
  /** Absolute path the orchestrator should write the agent's output to. */
  expected_output_path: string;
}

/** Standard directive envelope. Stable shape across tools. */
export interface PanelDirective {
  mode: "directive";
  /** Where the orchestrator will write per-slot outputs. */
  staging_dir: string;
  /** Resolved panel slots. */
  panel: PanelDirectiveSlot[];
  /** What the orchestrator should call once all slots are written. */
  next_tool: string;
  next_tool_args: Record<string, unknown>;
  /** Operator-facing instructions; goes into the orchestrator's user-visible prompt. */
  instructions: string;
}

/** One slot's result from execute mode. */
export interface PanelResult {
  slot: number;
  model_alias: string;
  model_id: string;
  endpoint: string;
  endpoint_kind: "api" | "cli";
  vendor: string | undefined;
  /** Content the dispatcher returned. */
  content: string;
  /** Always null for cli route; see DispatchResult. */
  tokens: number | null;
  route: "api" | "cli";
}

export interface RunPanelOptions {
  config: Config;
  roleName: string;
  /**
   * Per-slot prompt builder. Receives the slot index + the resolved model
   * (so the prompt can mention the vendor / model id when useful) and
   * returns the messages to send. Caller is responsible for embedding
   * recency floors, expected output schemas, etc.
   */
  buildMessages: (slot: number, model: ResolvedModel) => ChatMessage[];
  signal?: AbortSignal;
  jsonResponse?: boolean;
  /**
   * Per-slot temperature override. Defaults to 0.2 — research/review work
   * is mostly deterministic synthesis; high-temperature creativity is the
   * wrong knob.
   */
  temperature?: number;
  /**
   * Resolve API keys + per-feature overrides. Caller passes the function
   * because the legacy resolveAuthKey + per-tool defaults shape lives
   * outside util/. The function receives the resolved model and returns
   * an apiKey (or undefined for keyless / cli endpoints).
   */
  resolveApiKey: (model: ResolvedModel) => string | undefined;
}

/**
 * Run a panel role's slots in parallel via the dispatcher. Returns one
 * PanelResult per slot, in slot order. Throws the first error encountered;
 * callers decide whether to retry or fall back. (Vendor-diversity is
 * enforced at config-load by RolesSchema + a defense-in-depth check in
 * resolveRolePanel — runPanel doesn't re-check.)
 */
export async function runPanel(opts: RunPanelOptions): Promise<PanelResult[]> {
  const slots = resolveRolePanel(opts.config, opts.roleName);
  const calls = slots.map((slot, i) =>
    runOne(slot, i, opts).then((dispatch) => ({
      slot: i,
      model_alias: slot.model.alias,
      model_id: slot.model.model_id,
      endpoint: slot.endpoint.name,
      endpoint_kind: slot.endpoint.kind,
      vendor: slot.model.vendor,
      content: dispatch.content,
      tokens: dispatch.tokens,
      route: dispatch.route,
    })),
  );
  return Promise.all(calls);
}

async function runOne(
  slot: ResolvedModel,
  slotIdx: number,
  opts: RunPanelOptions,
): Promise<DispatchResult> {
  const messages = opts.buildMessages(slotIdx, slot);
  return dispatchChatCompletion({
    endpoint: slot.endpoint,
    modelId: slot.model.model_id,
    messages,
    apiKey: opts.resolveApiKey(slot),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : { temperature: 0.2 }),
    ...(opts.jsonResponse !== undefined ? { jsonResponse: opts.jsonResponse } : {}),
    ...(slot.endpoint.provider_options
      ? { providerOptions: slot.endpoint.provider_options as Record<string, unknown> }
      : {}),
  });
}

export interface BuildDirectiveOptions {
  config: Config;
  roleName: string;
  staging_dir: string;
  buildMessages: (slot: number, model: ResolvedModel) => ChatMessage[];
  /** Path scheme: e.g. (slot, alias) => `${staging_dir}/aspect-${slot}-${alias}.json`. */
  outputPathFor: (slot: number, model: ResolvedModel) => string;
  next_tool: string;
  next_tool_args: Record<string, unknown>;
  instructions: string;
}

/**
 * Build the directive-mode envelope without spawning any agents. Mirrors
 * runPanel's slot resolution but stops short of dispatch — caller returns
 * the result envelope to the orchestrator, which is responsible for the
 * actual fan-out.
 */
export function buildDirective(opts: BuildDirectiveOptions): PanelDirective {
  const slots = resolveRolePanel(opts.config, opts.roleName);
  const panel: PanelDirectiveSlot[] = slots.map((slot, i) => ({
    slot: i,
    model_alias: slot.model.alias,
    model_id: slot.model.model_id,
    endpoint: slot.endpoint.name,
    endpoint_kind: slot.endpoint.kind,
    vendor: slot.model.vendor,
    tags: slot.model.tags,
    messages: opts.buildMessages(i, slot),
    expected_output_path: opts.outputPathFor(i, slot),
  }));
  return {
    mode: "directive",
    staging_dir: opts.staging_dir,
    panel,
    next_tool: opts.next_tool,
    next_tool_args: opts.next_tool_args,
    instructions: opts.instructions,
  };
}
