import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKb, loadKbCached, clearKbCache } from "../../src/primers/load.js";

describe("loadKb", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-kb-")));
    await mkdir(join(root, "primers"), { recursive: true });
    await mkdir(join(root, "best-practices"), { recursive: true });
    await mkdir(join(root, "unknown"), { recursive: true });

    await writeFile(
      join(root, "primers", "a.md"),
      [
        "---",
        "type: primer",
        "primer_name: a",
        "category: tools",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["typescript", "cli"]',
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    await writeFile(
      join(root, "best-practices", "b.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: b",
        "category: ai",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    await writeFile(join(root, "unknown", "x.md"), "no frontmatter here");
    await writeFile(join(root, "primers", "no-fm.md"), "not frontmatter");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    clearKbCache();
  });

  it("loads entries from known kind dirs only", async () => {
    const entries = await loadKb(root);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["best-practices/b", "primers/a"]);
  });

  it("parses inline list tags", async () => {
    const entries = await loadKb(root);
    const a = entries.find((e) => e.id === "primers/a");
    expect(a?.tags).toEqual(["typescript", "cli"]);
  });

  it("cached loader returns the same array on repeat calls", async () => {
    clearKbCache();
    const first = await loadKbCached(root);
    const second = await loadKbCached(root);
    expect(second).toBe(first);
  });

  it("cached loader returns empty array for a missing KB root (non-fatal)", async () => {
    clearKbCache();
    const entries = await loadKbCached("/nonexistent/kb/root/xyz");
    expect(entries).toEqual([]);
  });
});

describe("loadKb with packs", () => {
  let main: string;
  let pack1: string;
  let pack2: string;

  beforeAll(async () => {
    main = await realpath(await mkdtemp(join(tmpdir(), "vcf-kb-main-")));
    pack1 = await realpath(await mkdtemp(join(tmpdir(), "vcf-kb-p1-")));
    pack2 = await realpath(await mkdtemp(join(tmpdir(), "vcf-kb-p2-")));

    // Main KB: one primer called "mcp".
    await mkdir(join(main, "primers"), { recursive: true });
    await writeFile(
      join(main, "primers", "mcp.md"),
      ["---", "type: primer", "primer_name: mcp", "version: 1", "---"].join("\n"),
    );

    // Pack 1 at <pack1>/kb/ — one primer with colliding filename "mcp".
    await mkdir(join(pack1, "kb", "primers"), { recursive: true });
    await writeFile(
      join(pack1, "kb", "primers", "mcp.md"),
      ["---", "type: primer", "primer_name: mcp-acme", "version: 1", "---"].join("\n"),
    );

    // Pack 2 at <pack2>/kb/ — one best-practice.
    await mkdir(join(pack2, "kb", "best-practices"), { recursive: true });
    await writeFile(
      join(pack2, "kb", "best-practices", "agile.md"),
      ["---", "type: best-practices", "best_practice_name: agile", "version: 1", "---"].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(main, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(pack1, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(pack2, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    clearKbCache();
  });

  it("main KB entries keep bare IDs; pack entries get @<name>/ prefix", async () => {
    const entries = await loadKb(main, [
      { name: "acme", root: pack1 },
      { name: "agile-co", root: pack2 },
    ]);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["@acme/primers/mcp", "@agile-co/best-practices/agile", "primers/mcp"]);
  });

  it("pack entries carry the pack field; main-KB entries don't", async () => {
    const entries = await loadKb(main, [{ name: "acme", root: pack1 }]);
    const mainMcp = entries.find((e) => e.id === "primers/mcp");
    const packMcp = entries.find((e) => e.id === "@acme/primers/mcp");
    expect(mainMcp?.pack).toBeUndefined();
    expect(packMcp?.pack).toBe("acme");
  });

  it("same filename in a pack does not shadow the main-KB entry", async () => {
    const entries = await loadKb(main, [{ name: "acme", root: pack1 }]);
    const mcp = entries.filter((e) => e.name === "mcp" || e.name === "mcp-acme");
    // Both exist, with distinct IDs.
    expect(mcp).toHaveLength(2);
    expect(new Set(mcp.map((e) => e.id))).toEqual(new Set(["primers/mcp", "@acme/primers/mcp"]));
  });

  it("cache key includes pack registration — re-loading with different packs returns different entries", async () => {
    clearKbCache();
    const withoutPacks = await loadKbCached(main);
    const withPacks = await loadKbCached(main, [{ name: "acme", root: pack1 }]);
    expect(withoutPacks).not.toBe(withPacks);
    expect(withoutPacks).toHaveLength(1);
    expect(withPacks).toHaveLength(2);
  });

  it("missing pack directory is tolerated — main KB still loads", async () => {
    const entries = await loadKb(main, [{ name: "ghost", root: "/does/not/exist/xyz" }]);
    // Main KB entry still present; no pack entry; no throw.
    expect(entries.map((e) => e.id)).toEqual(["primers/mcp"]);
  });
});
