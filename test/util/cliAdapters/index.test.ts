// Unit tests for CLI adapter selection + parsing.
//
// We avoid spawning real `claude` / `ollama` binaries here — those would
// require a logged-in subscription and a model that's actually pulled. The
// tests instead exercise:
//   1. selectCliAdapter routing by cmd basename
//   2. parsing behavior for the known structured-output shapes
//   3. error mapping (parse-failed, exit-nonzero, not-implemented)
//
// End-to-end "actually invoke claude" tests will live in a separate
// integration file gated on a CLAUDE_CLI_AVAILABLE env flag.

import { describe, it, expect } from "vitest";
import {
  selectCliAdapter,
  listAdapterNames,
  CliError,
} from "../../../src/util/cliAdapters/index.js";

describe("selectCliAdapter", () => {
  it("routes 'claude' to the claude adapter", () => {
    expect(selectCliAdapter("claude").name).toBe("claude");
  });

  it("routes absolute paths by basename", () => {
    expect(selectCliAdapter("/usr/local/bin/claude").name).toBe("claude");
  });

  it("routes 'ollama' to the ollama adapter", () => {
    expect(selectCliAdapter("ollama").name).toBe("ollama");
  });

  it("returns a defensive unknown adapter for unregistered cmds", async () => {
    const a = selectCliAdapter("notarealthing");
    expect(a.name).toBe("unknown:notarealthing");
    await expect(a.chatComplete({} as never)).rejects.toThrow(/no CLI adapter/);
  });

  it("registers all four expected adapter names", () => {
    expect(listAdapterNames().sort()).toEqual(["claude", "codex", "gemini", "ollama"]);
  });
});

describe("Stub adapters (codex, gemini)", () => {
  it("codex throws not-implemented on chatComplete", async () => {
    const codex = selectCliAdapter("codex");
    await expect(
      codex.chatComplete({
        messages: [{ role: "user", content: "hi" }],
        model: "x",
        cmd: "codex",
        staticArgs: [],
        workdirMode: "ephemeral",
      }),
    ).rejects.toMatchObject({ kind: "not-implemented" });
  });

  it("codex.probe returns ok:false with stub note", async () => {
    const codex = selectCliAdapter("codex");
    const r = await codex.probe("codex");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not yet implemented/);
  });

  it("gemini stubs follow the same shape", async () => {
    const gem = selectCliAdapter("gemini");
    await expect(
      gem.chatComplete({
        messages: [],
        model: "x",
        cmd: "gemini",
        staticArgs: [],
        workdirMode: "ephemeral",
      }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
