import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGlobalDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { recordConfigBoot, listConfigBoots } from "../../src/util/configBoot.js";

describe("recordConfigBoot (followup #48)", () => {
  let dir: string;
  let configPath: string;
  let db: ReturnType<typeof openGlobalDb>;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-cfgboot-")));
    configPath = join(dir, "config.yaml");
    db = openGlobalDb({ path: join(dir, "vcf.db") });
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("records a row with sha256 + stat when the config file exists", async () => {
    await writeFile(configPath, "endpoints: []\n", "utf8");
    const snap = recordConfigBoot(db, configPath, "0.6.0");
    expect(snap.exists_on_disk).toBe(true);
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.size_bytes).toBe(14);
    expect(snap.prev_sha256).toBeNull();
    expect(snap.vcf_version).toBe("0.6.0");
    expect(snap.pid).toBe(process.pid);

    const rows = listConfigBoots(db, { path: configPath });
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBe(snap.sha256);
  });

  it("records absence when the config file is missing", () => {
    const snap = recordConfigBoot(db, join(dir, "never-written.yaml"), "0.6.0");
    expect(snap.exists_on_disk).toBe(false);
    expect(snap.sha256).toBeNull();
    expect(snap.size_bytes).toBeNull();
    expect(snap.ctime_ms).toBeNull();
  });

  it("carries forward the previous sha256 across boots for the same path", async () => {
    await writeFile(configPath, "v: 1\n", "utf8");
    const first = recordConfigBoot(db, configPath, "0.6.0");
    const second = recordConfigBoot(db, configPath, "0.6.0");
    expect(second.prev_sha256).toBe(first.sha256);
    expect(second.sha256).toBe(first.sha256); // no change
  });

  it("detects a sha delta after the file is edited between boots", async () => {
    await writeFile(configPath, "v: 1\n", "utf8");
    const a = recordConfigBoot(db, configPath, "0.6.0");
    await writeFile(configPath, "v: 2\n", "utf8");
    const b = recordConfigBoot(db, configPath, "0.6.0");
    expect(b.prev_sha256).toBe(a.sha256);
    expect(b.sha256).not.toBe(a.sha256);
  });

  it("listConfigBoots returns rows newest-first and honors --path filter", async () => {
    const other = join(dir, "other.yaml");
    await writeFile(configPath, "a: 1\n", "utf8");
    await writeFile(other, "b: 1\n", "utf8");
    recordConfigBoot(db, configPath, "0.6.0");
    recordConfigBoot(db, other, "0.6.0");
    recordConfigBoot(db, configPath, "0.6.0");

    const all = listConfigBoots(db);
    expect(all).toHaveLength(3);
    // newest-first
    expect(all[0].ts).toBeGreaterThanOrEqual(all[1].ts);
    expect(all[1].ts).toBeGreaterThanOrEqual(all[2].ts);

    const filtered = listConfigBoots(db, { path: configPath });
    expect(filtered).toHaveLength(2);
    for (const r of filtered) expect(r.config_path).toBe(configPath);
  });

  it("listConfigBoots clamps limit between 1 and 500", async () => {
    await writeFile(configPath, "v: 1\n", "utf8");
    for (let i = 0; i < 3; i++) recordConfigBoot(db, configPath, "0.6.0");
    expect(listConfigBoots(db, { limit: 0 })).toHaveLength(1);
    expect(listConfigBoots(db, { limit: 10000 })).toHaveLength(3);
  });
});
