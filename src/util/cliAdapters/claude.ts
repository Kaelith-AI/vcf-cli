// Claude Code CLI adapter.
//
// Invokes the `claude` binary (Claude Code) in non-interactive mode. The
// harness handles auth (logged-in subscription session) and includes web
// search as a built-in tool, which is why role declarations for research/
// review tag the harness models with `[harness, web_search]`.
//
// Invocation shape:
//   claude --print --output-format json --model <id> -- <prompt>
//
// The flattened messages are sent as a single prompt: system messages
// concatenated as a `[SYSTEM]` preamble, then the most recent user message
// as the body. Conversation history (assistant turns) is interleaved with
// `[ASSISTANT]` markers — this mirrors what the harness sees when a fresh
// invocation re-reads a conversation file. Plenty of CLI parameter
// engineering happens here; the contract for callers is: messages in,
// content out.

import type { CliAdapter, CliCallRequest, CliCallResult, CliProbeResult } from "./types.js";
import { CliError } from "./types.js";
import { runCli } from "./spawn.js";

export const claudeAdapter: CliAdapter = {
  name: "claude",

  async chatComplete(req: CliCallRequest): Promise<CliCallResult> {
    const prompt = flattenMessages(req.messages);
    const args = [...req.staticArgs];
    // Defaults if caller didn't supply them via staticArgs.
    if (!args.includes("--print") && !args.includes("-p")) args.push("--print");
    if (!args.includes("--output-format")) args.push("--output-format", "json");
    if (req.model && !hasFlag(args, "--model")) args.push("--model", req.model);
    args.push("--", prompt);

    const result = await runCli({
      cmd: req.cmd,
      args,
      ...(req.signal ? { signal: req.signal } : {}),
      workdirMode: req.workdirMode,
    });

    let content: string;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      // Claude Code's `--output-format json` emits an object with a `result`
      // field (string). Defensive: accept `content` as a fallback for older
      // versions / future renames.
      const obj = parsed as Record<string, unknown>;
      const candidate = obj.result ?? obj.content ?? obj.text;
      if (typeof candidate !== "string") {
        throw new Error(
          `claude --output-format json: missing string field 'result' (keys: ${Object.keys(obj).join(", ")})`,
        );
      }
      content = candidate;
    } catch (e) {
      throw new CliError("parse-failed", `failed to parse claude output: ${(e as Error).message}`, {
        stderr: result.stderr,
      });
    }

    return {
      content: content.trim(),
      tokens: null,
      adapter: "claude",
    };
  },

  async probe(cmd: string): Promise<CliProbeResult> {
    try {
      const r = await runCli({
        cmd,
        args: ["--version"],
        workdirMode: "ephemeral",
      });
      return { ok: true, detail: r.stdout.trim() };
    } catch (e) {
      const err = e as CliError;
      if (err.kind === "spawn-failed") {
        return { ok: false, detail: `not on PATH: ${err.message}` };
      }
      return { ok: false, detail: err.message };
    }
  },
};

function flattenMessages(messages: CliCallRequest["messages"]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[SYSTEM]\n${m.content}`);
    else if (m.role === "user") parts.push(`[USER]\n${m.content}`);
    else if (m.role === "assistant") parts.push(`[ASSISTANT]\n${m.content}`);
  }
  return parts.join("\n\n");
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
