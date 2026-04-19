import { describe, it, expect } from "vitest";
import { success, failure, wrapResult } from "../src/envelope.js";
import { McpError } from "../src/errors.js";

describe("envelope helpers", () => {
  it("success builds the expected shape", () => {
    const s = success(["/a/b.md"], "did a thing", { expand_hint: "pass expand=true" });
    expect(s.ok).toBe(true);
    expect(s.paths).toEqual(["/a/b.md"]);
    expect(s.summary).toBe("did a thing");
    expect(s.expand_hint).toBe("pass expand=true");
    expect("content" in s).toBe(false);
  });

  it("success with content omits expand_hint when both provided", () => {
    const s = success(["/a"], "ok", { content: { hi: 1 } });
    expect(s.content).toEqual({ hi: 1 });
  });

  it("failure fills retryable per code table", () => {
    const f = failure("E_CANCELED", "canceled");
    expect(f.ok).toBe(false);
    expect(f.code).toBe("E_CANCELED");
    expect(f.retryable).toBe(true);

    const f2 = failure("E_SCOPE_DENIED");
    expect(f2.retryable).toBe(false);
    expect(f2.message.length).toBeGreaterThan(0);
  });

  it("wrapResult encodes into SDK wire format", () => {
    const r = wrapResult(success(["/x"], "ok"));
    expect(r.content?.[0]?.type).toBe("text");
    const parsed = JSON.parse((r.content![0] as { text: string }).text);
    expect(parsed.ok).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toBeDefined();
  });

  it("wrapResult sets isError=true for failures", () => {
    const r = wrapResult(failure("E_NOT_FOUND"));
    expect(r.isError).toBe(true);
  });

  it("McpError.retryable matches code table", () => {
    expect(new McpError("E_CANCELED").retryable).toBe(true);
    expect(new McpError("E_VALIDATION").retryable).toBe(false);
  });
});
