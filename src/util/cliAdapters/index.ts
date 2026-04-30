// CLI adapter registry — dispatcher entry point.
//
// Resolution: cmd basename → adapter. The cmd name in
// config.endpoints[].cmd determines which adapter handles the call. New
// adapters register here; the dispatcher (Workstream A8) calls
// `selectCliAdapter(endpoint).chatComplete(req)` without knowing which
// CLI is on the other side.

import { basename } from "node:path";
import type { CliAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { ollamaAdapter } from "./ollama.js";
import { codexAdapter, geminiAdapter } from "./stubs.js";

export type { CliAdapter, CliCallRequest, CliCallResult, CliProbeResult } from "./types.js";
export { CliError } from "./types.js";

const REGISTRY: Record<string, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

/**
 * Pick the adapter for a given CLI cmd path. Falls back to a defensive
 * "unknown CLI" adapter that throws — never silently uses a wrong shape.
 *
 * Allowed cmd names: claude, codex, gemini, ollama. Adapters compare on
 * basename so absolute paths (`/usr/local/bin/claude`) work.
 */
export function selectCliAdapter(cmd: string): CliAdapter {
  const name = basename(cmd).toLowerCase();
  const adapter = REGISTRY[name];
  if (adapter) return adapter;
  return {
    name: `unknown:${name}`,
    async chatComplete() {
      const known = Object.keys(REGISTRY).join(", ");
      throw new Error(
        `no CLI adapter registered for '${name}' (known: ${known}); add an adapter under src/util/cliAdapters/`,
      );
    },
    async probe() {
      return { ok: false, detail: `unknown CLI '${name}' (no adapter)` };
    },
  };
}

/** Listed for debug surfaces (vcf verify, model_list). */
export function listAdapterNames(): string[] {
  return Object.keys(REGISTRY);
}
