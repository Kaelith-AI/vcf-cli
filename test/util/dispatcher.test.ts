// Dispatcher: kind-aware single-shot chat completion.
//
// Tests the routing + error mapping. The HTTP path uses an injected
// fetchImpl; the CLI path is exercised through the unknown-cmd defensive
// adapter (which throws synchronously without spawning) and through a
// disabled-endpoint + missing-cmd validation path. Real subprocess
// invocation is out of scope here — that lives in a separate integration
// test gated on real binaries.

import { describe, it, expect } from "vitest";
import { dispatchChatCompletion, endpointRoute } from "../../src/util/dispatcher.js";
import type { Endpoint } from "../../src/config/schema.js";

const apiEp: Endpoint = {
  name: "fake-api",
  provider: "openai-compatible",
  kind: "api",
  base_url: "https://example.invalid/v1",
  trust_level: "trusted",
  enabled: true,
  workdir_mode: "ephemeral",
};

const disabledEp: Endpoint = {
  ...apiEp,
  name: "off",
  enabled: false,
};

const cliEpUnknown: Endpoint = {
  name: "weird-cli",
  provider: "openai-compatible",
  kind: "cli",
  cmd: "definitely-not-a-real-cli-zzzz",
  trust_level: "local",
  enabled: true,
  workdir_mode: "ephemeral",
};

const cliEpNoCmd: Endpoint = {
  name: "broken-cli",
  provider: "openai-compatible",
  kind: "cli",
  trust_level: "local",
  enabled: true,
  workdir_mode: "ephemeral",
};

function fakeFetch(body: object, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("dispatchChatCompletion (api route)", () => {
  it("returns content for a successful HTTP call", async () => {
    const r = await dispatchChatCompletion({
      endpoint: apiEp,
      modelId: "test-model",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fakeFetch({
        choices: [{ message: { role: "assistant", content: "hello!" } }],
      }),
    });
    expect(r.route).toBe("api");
    expect(r.content).toBe("hello!");
    expect(r.tokens).toBeNull();
  });

  it("rejects when api endpoint has no base_url", async () => {
    const noBase = { ...apiEp, base_url: undefined };
    await expect(
      dispatchChatCompletion({
        endpoint: noBase,
        modelId: "x",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "E_VALIDATION" });
  });

  it("rejects calls to disabled endpoints", async () => {
    await expect(
      dispatchChatCompletion({
        endpoint: disabledEp,
        modelId: "x",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_DISABLED" });
  });
});

describe("dispatchChatCompletion (cli route)", () => {
  it("rejects cli endpoint missing cmd", async () => {
    await expect(
      dispatchChatCompletion({
        endpoint: cliEpNoCmd,
        modelId: "x",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "E_VALIDATION" });
  });

  it("returns clear error for unknown cli command", async () => {
    // The "unknown" adapter rejects with a plain Error that the dispatcher
    // currently lets bubble (it isn't a CliError). Assert the message
    // mentions the missing adapter so operators see a real diagnostic.
    await expect(
      dispatchChatCompletion({
        endpoint: cliEpUnknown,
        modelId: "x",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/no CLI adapter/);
  });
});

describe("endpointRoute", () => {
  it("reports api/cli", () => {
    expect(endpointRoute({ kind: "api" })).toBe("api");
    expect(endpointRoute({ kind: "cli" })).toBe("cli");
  });
});
