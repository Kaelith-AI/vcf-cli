import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUpstreamKbRoot, seedKbIfMissing } from "../src/cli.js";

// `seedKbIfMissing` is the helper that `vcf init` calls to populate
// ~/.vcf/kb on first run. Covers followup #5 — without it, every KB-
// reading tool (spec_suggest_primers, build_context, plan_context,
// primer_list, review_prepare) degraded silently to empty results on
// a fresh install.

async function writeAt(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("init KB seed", () => {
  let root: string;
  let upstream: string;
  let kb: string;
  let ancestor: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-seed-")));
    upstream = join(root, "upstream");
    kb = join(root, "kb");
    ancestor = join(root, "ancestor");
    prevEnv = process.env["VCF_KB_SOURCE"];
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env["VCF_KB_SOURCE"];
    else process.env["VCF_KB_SOURCE"] = prevEnv;
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("copies every upstream *.md into kb root and seeds the ancestor", async () => {
    await writeAt(upstream, "primers/p1.md", "# one\n");
    await writeAt(upstream, "best-practices/b1.md", "# two\n");
    await writeAt(upstream, "review-system/code/01-x.md", "# three\n");
    process.env["VCF_KB_SOURCE"] = upstream;

    await seedKbIfMissing(kb, ancestor);

    expect(await readFile(join(kb, "primers/p1.md"), "utf8")).toBe("# one\n");
    expect(await readFile(join(kb, "best-practices/b1.md"), "utf8")).toBe("# two\n");
    expect(await readFile(join(kb, "review-system/code/01-x.md"), "utf8")).toBe("# three\n");
    // Ancestor mirrors upstream — required for future three-way merges
    // in `vcf update-primers`.
    expect(await readFile(join(ancestor, "primers/p1.md"), "utf8")).toBe("# one\n");
    expect(await readFile(join(ancestor, "best-practices/b1.md"), "utf8")).toBe("# two\n");
  });

  it("is a no-op when the kb directory already exists (respects user edits)", async () => {
    await writeAt(upstream, "primers/p1.md", "# upstream\n");
    await writeAt(kb, "primers/existing.md", "# user-authored\n");
    process.env["VCF_KB_SOURCE"] = upstream;

    await seedKbIfMissing(kb, ancestor);

    // User file preserved; upstream file NOT copied in.
    expect(await readFile(join(kb, "primers/existing.md"), "utf8")).toBe("# user-authored\n");
    expect(existsSync(join(kb, "primers/p1.md"))).toBe(false);
    // Ancestor also not touched on the "already initialized" path.
    expect(existsSync(join(ancestor, "primers/p1.md"))).toBe(false);
  });

  it("warns but does not throw when the upstream KB is unresolvable", async () => {
    // Point env override at a non-existent path, and (best-effort) clear
    // the inherited runtime's resolution. If the test runner happens to
    // have @kaelith-labs/kb installed, the createRequire fallback still
    // finds it — in that case the resolver returns a real path and the
    // seed runs successfully, which is also acceptable behavior. The
    // assertion we care about: `seedKbIfMissing` never throws on a
    // missing dep.
    process.env["VCF_KB_SOURCE"] = join(root, "does-not-exist");

    await expect(seedKbIfMissing(kb, ancestor)).resolves.toBeUndefined();
  });
});

describe("resolveUpstreamKbRoot", () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-resolve-")));
    prevEnv = process.env["VCF_KB_SOURCE"];
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env["VCF_KB_SOURCE"];
    else process.env["VCF_KB_SOURCE"] = prevEnv;
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("honors VCF_KB_SOURCE when the directory exists", async () => {
    await mkdir(join(root, "primers"), { recursive: true });
    process.env["VCF_KB_SOURCE"] = root;
    expect(resolveUpstreamKbRoot()).toBe(root);
  });

  it("ignores VCF_KB_SOURCE when the directory does not exist and falls through", () => {
    process.env["VCF_KB_SOURCE"] = join(root, "missing");
    // Falls through to dev-sibling / installed-package lookup. The result
    // depends on the test environment — we only assert it's either a
    // resolvable string path or null (never the bogus env path).
    const result = resolveUpstreamKbRoot();
    if (result !== null) {
      expect(result).not.toBe(join(root, "missing"));
      expect(existsSync(result)).toBe(true);
    }
  });
});
