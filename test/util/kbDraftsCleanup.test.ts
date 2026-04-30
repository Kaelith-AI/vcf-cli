// Tests for the 90-day kb-drafts cleanup sweep.
//
// Tests use a temp VCF_HOME so we never touch the real ~/.vcf/ tree.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKbDraftsCleanup } from "../../src/util/kbDraftsCleanup.js";

let home: string;
let kbDraftsRoot: string;
let liveKbRoot: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vcf-cleanup-"));
  kbDraftsRoot = join(home, ".vcf", "kb-drafts");
  liveKbRoot = join(home, ".vcf", "kb");
  await mkdir(kbDraftsRoot, { recursive: true });
  await mkdir(liveKbRoot, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function makeDraft(name: string, ageDays: number, files: Record<string, string>) {
  const dir = join(kbDraftsRoot, name);
  await mkdir(join(dir, "aspects"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  // backdate
  const past = new Date(Date.now() - ageDays * 86_400_000);
  await utimes(dir, past, past);
}

describe("runKbDraftsCleanup", () => {
  it("removes un-shipped drafts older than threshold", async () => {
    await makeDraft("20250101T000000Z-old-topic-best-practice", 100, {
      "draft.md": "# old",
    });
    const r = await runKbDraftsCleanup({ home });
    expect(r.examined).toBe(1);
    expect(r.removed).toHaveLength(1);
    expect(existsSync(join(kbDraftsRoot, "20250101T000000Z-old-topic-best-practice"))).toBe(false);
  });

  it("preserves young drafts even if not shipped", async () => {
    await makeDraft("20260420T000000Z-recent-topic-best-practice", 5, {
      "draft.md": "# recent",
    });
    const r = await runKbDraftsCleanup({ home });
    expect(r.examined).toBe(1);
    expect(r.removed).toHaveLength(0);
    expect(existsSync(join(kbDraftsRoot, "20260420T000000Z-recent-topic-best-practice"))).toBe(
      true,
    );
  });

  it("trims (rather than removes) shipped drafts older than threshold", async () => {
    await makeDraft("20250101T000000Z-shipped-topic-best-practice", 100, {
      "draft.md": "# shipped",
      "sources.json": '{"sources":[]}',
      "verify.json": '{"contested_claims":[]}',
      "resolutions.json": '{"resolutions":[]}',
      "aspects/aspect-00-opus.json": '{"slot":0}',
    });
    // Create a live KB file with the slug
    await mkdir(join(liveKbRoot, "best-practices"), { recursive: true });
    await writeFile(join(liveKbRoot, "best-practices", "shipped-topic.md"), "# live", "utf8");

    const r = await runKbDraftsCleanup({ home, liveKbRoot });
    expect(r.examined).toBe(1);
    expect(r.removed).toHaveLength(0);
    expect(r.trimmed).toHaveLength(1);

    const dir = join(kbDraftsRoot, "20250101T000000Z-shipped-topic-best-practice");
    expect(existsSync(dir)).toBe(true);
    // resolutions.json kept
    expect(existsSync(join(dir, "resolutions.json"))).toBe(true);
    // raw dumps pruned
    expect(existsSync(join(dir, "aspects"))).toBe(false);
    expect(existsSync(join(dir, "verify.json"))).toBe(false);
    expect(existsSync(join(dir, "draft.md"))).toBe(false);
    // marker file present
    expect(existsSync(join(dir, "TRIMMED.md"))).toBe(true);
  });

  it("is idempotent — running twice on a trimmed draft is a noop", async () => {
    await makeDraft("20250101T000000Z-shipped-twice-best-practice", 100, {
      "draft.md": "x",
      "resolutions.json": "{}",
      "aspects/a.json": "{}",
    });
    await mkdir(join(liveKbRoot, "best-practices"), { recursive: true });
    await writeFile(join(liveKbRoot, "best-practices", "shipped-twice.md"), "# live", "utf8");

    const r1 = await runKbDraftsCleanup({ home, liveKbRoot });
    expect(r1.trimmed).toHaveLength(1);

    // Second pass — file still old; trimming again should produce no
    // additional changes (no resolutions.json clobber etc.).
    const dir = join(kbDraftsRoot, "20250101T000000Z-shipped-twice-best-practice");
    const before = await readdir(dir);
    await utimes(
      dir,
      new Date(Date.now() - 100 * 86_400_000),
      new Date(Date.now() - 100 * 86_400_000),
    );
    const r2 = await runKbDraftsCleanup({ home, liveKbRoot });
    const after = await readdir(dir);
    expect(after.sort()).toEqual(before.sort());
    expect(r2.errors).toHaveLength(0);
  });

  it("respects a custom thresholdDays override", async () => {
    await makeDraft("20260415T000000Z-just-recent-best-practice", 10, {
      "draft.md": "x",
    });
    const r = await runKbDraftsCleanup({ home, thresholdDays: 5 });
    expect(r.removed).toHaveLength(1);
  });

  it("returns examined=0 when kb-drafts dir is missing", async () => {
    await rm(kbDraftsRoot, { recursive: true, force: true });
    const r = await runKbDraftsCleanup({ home });
    expect(r.examined).toBe(0);
    expect(r.removed).toHaveLength(0);
  });
});

// Quiet a TS unused import warning in some node typings.
void stat;
