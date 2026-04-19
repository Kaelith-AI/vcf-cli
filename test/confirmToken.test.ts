import { describe, it, expect } from "vitest";
import { createConfirmTokenStore } from "../src/util/confirmToken.js";
import { McpError } from "../src/errors.js";

describe("ConfirmTokenStore", () => {
  it("accepts a freshly-issued token", () => {
    const store = createConfirmTokenStore();
    const input = { target: "/abs/demo", tag: "v1.0" };
    const token = store.issue(input);
    expect(() => store.consume(token, input)).not.toThrow();
  });

  it("rejects a second consumption (single-use)", () => {
    const store = createConfirmTokenStore();
    const input = { x: 1 };
    const token = store.issue(input);
    store.consume(token, input);
    expect(() => store.consume(token, input)).toThrow(McpError);
  });

  it("rejects when the input differs", () => {
    const store = createConfirmTokenStore();
    const token = store.issue({ target: "/a" });
    expect(() => store.consume(token, { target: "/b" })).toThrow(McpError);
  });

  it("rejects an expired token (TTL=1ms)", async () => {
    const store = createConfirmTokenStore({ ttlMs: 1 });
    const token = store.issue({ x: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(() => store.consume(token, { x: 1 })).toThrow(McpError);
  });

  it("rejects a malformed token string", () => {
    const store = createConfirmTokenStore();
    expect(() => store.consume("bogus", { x: 1 })).toThrow(McpError);
  });
});
