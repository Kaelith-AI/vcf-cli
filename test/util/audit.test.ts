import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGlobalDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import {
  writeAudit,
  hashPayload,
  redact,
  setFullAuditMode,
  isFullAuditMode,
} from "../../src/util/audit.js";

describe("redact", () => {
  it("redacts AWS access keys", () => {
    const out = redact({ key: "AKIAIOSFODNN7EXAMPLE" });
    expect((out as { key: string }).key).toBe("[AWS_ACCESS_KEY]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv";
    expect(redact(jwt)).toBe("[JWT]");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEv...stuff...==\n-----END PRIVATE KEY-----";
    expect(redact(pem)).toBe("[PRIVATE_KEY]");
  });

  it("redacts .env-style assignments", () => {
    const result = redact({ note: 'API_KEY="abcdef12345"' }) as { note: string };
    expect(result.note).toContain("API_KEY=[REDACTED]");
  });

  it("redacts GitHub classic PATs (ghp_), OAuth (gho_), server-to-server (ghs_)", () => {
    const samples = [
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "gho_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "ghs_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      "ghr_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    ];
    for (const t of samples) {
      const out = redact(`token is ${t} trailing`) as string;
      expect(out).toContain("[REDACTED:github-token]");
      expect(out).not.toContain(t);
    }
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    const t = "github_pat_11ABCDEFG0123456789abcdef_XYZzyxwvutsrqponmlkjihgfedcba987654321";
    const out = redact(t);
    expect(out).toBe("[REDACTED:github-pat]");
  });

  it("redacts Stripe live + test keys (sk/rk/pk × live/test)", () => {
    const samples = [
      "sk_live_abcdefghijklmnopqrstuvwx",
      "sk_test_abcdefghijklmnopqrstuvwx",
      "rk_live_abcdefghijklmnopqrstuvwx",
      "pk_test_abcdefghijklmnopqrstuvwx",
    ];
    for (const t of samples) {
      const out = redact(`key=${t}`) as string;
      // Either the specific marker or the generic env-var [REDACTED]; both
      // are acceptable — the load-bearing behavior is that the raw value
      // disappears.
      expect(out).not.toContain(t);
    }
  });

  it("redacts bare Stripe keys outside env assignments to the specific marker", () => {
    const out = redact("our key is sk_live_ZZZZZZZZZZZZZZZZZZZZZZZZ in docs");
    expect(out).toContain("[REDACTED:stripe-key]");
    expect(out).not.toContain("sk_live_Z");
  });

  it("redacts Slack tokens (xoxb-, xoxp-, etc.)", () => {
    const samples = [
      "xoxb-1234567890-0987654321098-AbCdEfGhIjKlMnOpQrStUvWx",
      "xoxp-1234567890-abc-def-ghi",
      "xoxa-2-0123456789",
    ];
    for (const t of samples) {
      const out = redact(t);
      expect(out).toBe("[REDACTED:slack-token]");
    }
  });

  it("redacts Slack webhook URLs", () => {
    const url = "https://hooks.slack.com/services/T01234567/B01234567/abcdefghijklmnopqrstuvwx";
    expect(redact(url)).toBe("[REDACTED:slack-webhook]");
  });

  it("redacts Google API keys (AIza prefix + 35 chars)", () => {
    const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123_-a";
    expect(redact(key)).toBe("[REDACTED:google-api-key]");
    // 39 chars surrounded by text
    const withContext = redact(`config key=${key} more text`) as string;
    expect(withContext).toContain("[REDACTED:google-api-key]");
    expect(withContext).not.toContain(key);
  });

  it("walks arrays and objects recursively", () => {
    const out = redact({
      nested: [
        { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv" },
      ],
    }) as { nested: Array<{ token: string }> };
    expect(out.nested[0].token).toBe("[JWT]");
  });
});

describe("hashPayload", () => {
  it("hashes null to a deterministic sha256", () => {
    const h = hashPayload(null);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(hashPayload(null));
  });

  it("is stable across key ordering", () => {
    const a = hashPayload({ a: 1, b: 2 });
    const b = hashPayload({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("redacts before hashing — two JWT inputs hash equal", () => {
    const h1 = hashPayload({
      t: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv",
    });
    const h2 = hashPayload({
      t: "eyJhbGciOiJIUzI1NiJ9.eyJkaWZmZXJlbnQifQ.xyz1234567890qrstuvwxyzABCDEFG",
    });
    expect(h1).toBe(h2);
  });
});

describe("writeAudit", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-audit-")));
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("appends a row with hashed payloads", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    writeAudit(db, {
      tool: "idea_capture",
      scope: "global",
      inputs: { content: "hello" },
      outputs: { ok: true, paths: ["/abs/ideas/x.md"] },
      result_code: "ok",
    });
    const row = db
      .prepare("SELECT tool, inputs_hash, outputs_hash, result_code FROM audit")
      .get() as {
      tool: string;
      inputs_hash: string;
      outputs_hash: string;
      result_code: string;
    };
    expect(row.tool).toBe("idea_capture");
    expect(row.inputs_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.outputs_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.result_code).toBe("ok");
    db.close();
  });

  it("two identical payloads produce identical hashes", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    const entry = {
      tool: "idea_capture",
      scope: "global" as const,
      inputs: { content: "identical" },
      outputs: { ok: true },
      result_code: "ok",
    };
    writeAudit(db, entry);
    writeAudit(db, entry);
    const rows = db.prepare("SELECT inputs_hash FROM audit ORDER BY id").all() as {
      inputs_hash: string;
    }[];
    expect(rows[0].inputs_hash).toBe(rows[1].inputs_hash);
    db.close();
  });

  it("leaves inputs_json + outputs_json NULL when full-audit mode is off (default)", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    setFullAuditMode(false);
    expect(isFullAuditMode()).toBe(false);
    writeAudit(db, {
      tool: "idea_capture",
      scope: "global",
      inputs: { content: "hi" },
      outputs: { ok: true },
      result_code: "ok",
    });
    const row = db.prepare("SELECT inputs_json, outputs_json FROM audit").get() as {
      inputs_json: string | null;
      outputs_json: string | null;
    };
    expect(row.inputs_json).toBeNull();
    expect(row.outputs_json).toBeNull();
    db.close();
  });

  it("writes redacted JSON to inputs_json + outputs_json when full-audit mode is on", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    setFullAuditMode(true);
    try {
      writeAudit(db, {
        tool: "idea_capture",
        scope: "global",
        inputs: { content: "hello", token: "AKIAIOSFODNN7EXAMPLE" },
        outputs: { ok: true, paths: ["/abs/ideas/x.md"] },
        result_code: "ok",
      });
      const row = db.prepare("SELECT inputs_json, outputs_json FROM audit").get() as {
        inputs_json: string;
        outputs_json: string;
      };
      expect(row.inputs_json).toBeTruthy();
      expect(row.outputs_json).toBeTruthy();
      // Secrets were redacted before storage.
      expect(row.inputs_json).toContain("[AWS_ACCESS_KEY]");
      expect(row.inputs_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
      // Keys survived — it's canonical JSON.
      expect(row.inputs_json).toContain("content");
      expect(row.outputs_json).toContain("/abs/ideas/x.md");
    } finally {
      setFullAuditMode(false); // don't leak to other tests
    }
    db.close();
  });
});
