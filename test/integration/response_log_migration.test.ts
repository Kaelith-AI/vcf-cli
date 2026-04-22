import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../../src/db/migrate.js";
import { PROJECT_MIGRATIONS } from "../../src/db/schema.js";
import {
  migrateResponseLogMarkdown,
  parseResponseLogMarkdown,
  renderResponseLogMarkdown,
} from "../../src/review/responseLogMigrator.js";

// Real-world 0.3.2 response-log shape — three entries covering agree, disagree,
// and a frontmatter field the legacy format never had (finding_ref).
const FIXTURE_MD = `# Response Log (append-only)

> Reviewers read this before every pass.

---
review_run_id: code-4-20260422T002950762Z
stance: agree
created_at: 2026-04-22T01:05:37.696Z
---

Fixed in a subsequent commit on the same branch. POSIX-only split swapped for path.basename().

---
---
review_run_id: security-6-20260422T004124768Z
stance: disagree
created_at: 2026-04-22T01:05:37.702Z
---

BLOCK verdict based on a redaction-marker hallucination. A [REDACTED] in the diff is not a committed secret.

---
---
review_run_id: production-8-20260422T005431483Z
stance: disagree
finding_ref: production:stage-8:finding-1
created_at: 2026-04-22T01:05:37.706Z
---

Partial disagree. Category error — DR/backup procedure is a service-bar artifact; this is a CLI tool.

---
`;

describe("response_log markdown migration (Phase-2 B)", () => {
  let workRoot: string;
  let dbPath: string;
  let logPath: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-resplog-")));
    dbPath = join(workRoot, ".vcf", "project.db");
    logPath = join(workRoot, "plans", "reviews", "response-log.md");
    await mkdir(join(workRoot, ".vcf"), { recursive: true });
    await mkdir(join(workRoot, "plans", "reviews"), { recursive: true });
    await writeFile(logPath, FIXTURE_MD, "utf8");
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function openDb(): DatabaseSync {
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Seed the project singleton row so FK-free INSERTs don't clash with
    // future additions.
    runMigrations(db, PROJECT_MIGRATIONS);
    return db;
  }

  it("parses the legacy triple-dash format into typed entries", () => {
    const entries = parseResponseLogMarkdown(FIXTURE_MD);
    expect(entries.length).toBe(3);

    expect(entries[0]?.run_id).toBe("code-4-20260422T002950762Z");
    expect(entries[0]?.builder_claim).toBe("agree");
    expect(entries[0]?.finding_ref).toBeNull();
    expect(entries[0]?.response_text).toContain("POSIX-only");

    expect(entries[1]?.builder_claim).toBe("disagree");
    expect(entries[1]?.response_text).toContain("redaction-marker hallucination");

    expect(entries[2]?.finding_ref).toBe("production:stage-8:finding-1");
  });

  it("annotates entries without finding_ref with a migration_note", () => {
    const entries = parseResponseLogMarkdown(FIXTURE_MD);
    expect(entries[0]?.migration_note).toContain("imported without finding_ref");
    expect(entries[2]?.migration_note).toBeNull();
  });

  it("defaults ambiguous stance to disagree with a note", () => {
    const broken = FIXTURE_MD.replace("stance: agree", "stance: maybe-later");
    const entries = parseResponseLogMarkdown(broken);
    expect(entries[0]?.builder_claim).toBe("disagree");
    expect(entries[0]?.migration_note).toMatch(/unknown stance/);
  });

  it("inserts parsed rows and survives a second run without duplicating", () => {
    const db = openDb();
    try {
      const first = migrateResponseLogMarkdown(db, logPath);
      expect(first.parsed).toBe(3);
      expect(first.inserted).toBe(3);
      expect(first.skipped).toBe(0);

      const second = migrateResponseLogMarkdown(db, logPath);
      expect(second.parsed).toBe(3);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(3);

      const rows = db.prepare(
        "SELECT run_id, builder_claim, finding_ref, migration_note FROM response_log ORDER BY id ASC",
      ).all() as unknown as Array<{
        run_id: string;
        builder_claim: string;
        finding_ref: string | null;
        migration_note: string | null;
      }>;
      expect(rows.length).toBe(3);
      expect(rows[0]?.run_id).toBe("code-4-20260422T002950762Z");
      expect(rows[0]?.builder_claim).toBe("agree");
      expect(rows[2]?.finding_ref).toBe("production:stage-8:finding-1");
    } finally {
      db.close();
    }
  });

  it("round-trips: migrate → render → re-parse produces identical run_ids", async () => {
    const db = openDb();
    try {
      migrateResponseLogMarkdown(db, logPath);
      const rendered = renderResponseLogMarkdown(db);
      await writeFile(logPath, rendered, "utf8");

      // Re-parse the rendered output — the new format also uses `run_id`
      // and `builder_claim` directly, so the parser should read them cleanly.
      const re = parseResponseLogMarkdown(await readFile(logPath, "utf8"));
      const ids = re.map((e) => e.run_id).sort();
      expect(ids).toEqual([
        "code-4-20260422T002950762Z",
        "production-8-20260422T005431483Z",
        "security-6-20260422T004124768Z",
      ]);
    } finally {
      db.close();
    }
  });

  it("migration v4 adds the new columns and preserves legacy rows", () => {
    // Simulate the v1 schema state: insert a row using the old column names
    // by applying v1+v2 only, inserting, then finishing migrations.
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, PROJECT_MIGRATIONS.filter((m) => m.version <= 2));
    db.prepare(
      "INSERT INTO response_log (review_run_id, stance, note, created_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-run", "agree", "legacy response text", Date.now());

    // Now apply v3+v4 — the rename must succeed without data loss.
    runMigrations(db, PROJECT_MIGRATIONS);

    const cols = (db.prepare("PRAGMA table_info(response_log)").all() as unknown as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(cols).toContain("run_id");
    expect(cols).toContain("builder_claim");
    expect(cols).toContain("response_text");
    expect(cols).toContain("finding_ref");
    expect(cols).toContain("references_json");
    expect(cols).not.toContain("stance");

    const row = db
      .prepare("SELECT run_id, builder_claim, response_text FROM response_log WHERE id=1")
      .get() as { run_id: string; builder_claim: string; response_text: string };
    expect(row.run_id).toBe("legacy-run");
    expect(row.builder_claim).toBe("agree");
    expect(row.response_text).toBe("legacy response text");

    db.close();
  });
});
