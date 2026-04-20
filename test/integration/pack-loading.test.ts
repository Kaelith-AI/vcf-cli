// End-to-end test for the KB plugin protocol: a user-registered pack
// shows up in primer_list alongside main-KB entries, with the right ID
// prefix and provenance field.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  content?: unknown;
  code?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("KB plugin protocol: third-party packs via config.kb.packs", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let packRoot: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-pack-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-packh-")));
    packRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-packk-")));
    kbRoot = join(home, ".vcf", "kb");

    // Main KB — one primer.
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await writeFile(
      join(kbRoot, "primers", "mcp.md"),
      [
        "---",
        "type: primer",
        "primer_name: mcp",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["mcp"]',
        "---",
        "Main-KB MCP primer.",
      ].join("\n"),
    );

    // Pack at <packRoot>/kb/ — one best-practice + one primer with a
    // colliding filename vs main-KB.
    await mkdir(join(packRoot, "kb", "primers"), { recursive: true });
    await mkdir(join(packRoot, "kb", "best-practices"), { recursive: true });
    await writeFile(
      join(packRoot, "kb", "primers", "mcp.md"),
      [
        "---",
        "type: primer",
        "primer_name: mcp-acme-flavor",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["mcp", "acme"]',
        "---",
        "Acme's MCP primer.",
      ].join("\n"),
    );
    await writeFile(
      join(packRoot, "kb", "best-practices", "agile.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: agile",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["process"]',
        "---",
        "Agile best practice.",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(packRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connectGlobal(packs: Array<{ name: string; root: string }>) {
    const config = ConfigSchema.parse({
      version: 1,
      workspace: {
        allowed_roots: [workRoot],
        ideas_dir: join(workRoot, "ideas"),
        specs_dir: join(workRoot, "specs"),
      },
      endpoints: [
        {
          name: "local-stub",
          provider: "local-stub",
          base_url: "http://127.0.0.1:1",
          trust_level: "local",
        },
      ],
      kb: { root: kbRoot, packs },
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client };
  }

  it("primer_list with no packs: only main-KB entries visible", async () => {
    const { client } = await connectGlobal([]);
    const env = parseResult(
      await client.callTool({ name: "primer_list", arguments: { expand: true } }),
    );
    expect(env.ok).toBe(true);
    const entries = (env.content as { entries: Array<{ id: string; pack?: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("primers/mcp");
    expect(entries[0]?.pack).toBeUndefined();
  });

  it("primer_list with one registered pack: pack entries appear with @prefix + pack field", async () => {
    const { client } = await connectGlobal([{ name: "acme", root: packRoot }]);
    const env = parseResult(
      await client.callTool({ name: "primer_list", arguments: { expand: true } }),
    );
    expect(env.ok).toBe(true);
    const entries = (env.content as { entries: Array<{ id: string; pack?: string }> }).entries;
    expect(entries).toHaveLength(3);

    const mainMcp = entries.find((e) => e.id === "primers/mcp");
    const packMcp = entries.find((e) => e.id === "@acme/primers/mcp");
    const agile = entries.find((e) => e.id === "@acme/best-practices/agile");

    expect(mainMcp?.pack).toBeUndefined();
    expect(packMcp?.pack).toBe("acme");
    expect(agile?.pack).toBe("acme");
  });

  it("tag filter on primer_list matches across main KB and packs", async () => {
    const { client } = await connectGlobal([{ name: "acme", root: packRoot }]);
    const env = parseResult(
      await client.callTool({
        name: "primer_list",
        arguments: { tags: ["mcp"], expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const entries = (env.content as { entries: Array<{ id: string }> }).entries;
    // Both the main-KB `primers/mcp` and the pack `@acme/primers/mcp` carry
    // the "mcp" tag; both should match.
    expect(entries.map((e) => e.id).sort()).toEqual(["@acme/primers/mcp", "primers/mcp"]);
  });

  it("pack_list surfaces each registered pack with an entry count", async () => {
    const { client } = await connectGlobal([{ name: "acme", root: packRoot }]);
    const env = parseResult(
      await client.callTool({ name: "pack_list", arguments: { expand: true } }),
    );
    expect(env.ok).toBe(true);
    const packs = (env.content as { packs: Array<{ name: string; entry_count: number }> }).packs;
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe("acme");
    // Pack has two files: primers/mcp.md + best-practices/agile.md.
    expect(packs[0]?.entry_count).toBe(2);
  });

  it("pack_list returns empty list when no packs are registered", async () => {
    const { client } = await connectGlobal([]);
    const env = parseResult(
      await client.callTool({ name: "pack_list", arguments: { expand: true } }),
    );
    expect(env.ok).toBe(true);
    const packs = (env.content as { packs: unknown[] }).packs;
    expect(packs).toEqual([]);
  });
});
