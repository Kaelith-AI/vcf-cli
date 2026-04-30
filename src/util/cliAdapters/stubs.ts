// Stub adapters for CLIs we haven't fully integrated yet (codex, gemini).
//
// The interface is in place so the dispatcher can route by name without
// losing types. Calling chatComplete throws CliError(kind="not-implemented")
// with a clear message pointing at the workstream item that will fill it
// in. probe() returns ok:false for the same reason — `vcf verify` should
// flag these endpoints as unsupported until the real implementation lands.
//
// When a stub is replaced by a real adapter, swap the export in
// ./index.ts and delete the corresponding entry here.

import type { CliAdapter, CliCallRequest, CliCallResult, CliProbeResult } from "./types.js";
import { CliError } from "./types.js";

function makeStub(name: string): CliAdapter {
  return {
    name,
    async chatComplete(_req: CliCallRequest): Promise<CliCallResult> {
      throw new CliError(
        "not-implemented",
        `CLI adapter '${name}' is stubbed; real integration arrives with Workstream A7 follow-up`,
      );
    },
    async probe(_cmd: string): Promise<CliProbeResult> {
      return { ok: false, detail: `adapter '${name}' not yet implemented` };
    },
  };
}

export const codexAdapter = makeStub("codex");
export const geminiAdapter = makeStub("gemini");
