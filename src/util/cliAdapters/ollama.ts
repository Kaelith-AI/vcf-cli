// Ollama CLI adapter.
//
// Invokes `ollama run <model>` with the prompt on stdin. Output is plain
// text (no JSON envelope), so the adapter trims trailing whitespace and
// returns it directly. Auth is irrelevant — Ollama is local.
//
// For most workflows the OpenAI-compatible HTTP endpoint (kind=api,
// base_url=http://127.0.0.1:11434/v1) is preferred — JSON shape, token
// counts, structured streaming. The CLI adapter exists for parity with
// the harness CLIs and for environments where the HTTP server isn't bound.

import type { CliAdapter, CliCallRequest, CliCallResult, CliProbeResult } from "./types.js";
import type { CliError } from "./types.js";
import { runCli } from "./spawn.js";

export const ollamaAdapter: CliAdapter = {
  name: "ollama",

  async chatComplete(req: CliCallRequest): Promise<CliCallResult> {
    const prompt = flattenMessages(req.messages);
    const args = ["run", req.model, ...req.staticArgs];
    const result = await runCli({
      cmd: req.cmd,
      args,
      stdin: prompt,
      ...(req.signal ? { signal: req.signal } : {}),
      workdirMode: req.workdirMode,
    });
    return {
      content: result.stdout.trim(),
      tokens: null,
      adapter: "ollama",
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
      return { ok: false, detail: err.message };
    }
  },
};

function flattenMessages(messages: CliCallRequest["messages"]): string {
  // Ollama's bare `run` mode takes a single prompt; we mirror Claude's role
  // tagging so multi-turn conversations stay parseable.
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[SYSTEM]\n${m.content}`);
    else if (m.role === "user") parts.push(`[USER]\n${m.content}`);
    else if (m.role === "assistant") parts.push(`[ASSISTANT]\n${m.content}`);
  }
  return parts.join("\n\n");
}
