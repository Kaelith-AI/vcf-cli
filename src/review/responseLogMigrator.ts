// Response-log markdown ⇄ DB bridge.
//
// Two directions:
//
//   parseResponseLogMarkdown(text)
//     Legacy-format parser for `plans/reviews/response-log.md`. Handles
//     the v1 triple-dash frontmatter + body + trailing `---` block shape
//     and maps it into the v4 column set. Ambiguous entries (missing
//     finding_ref, unknown stance) default to builder_claim='disagree'
//     and carry a migration_note so nothing is silently lost.
//
//   renderResponseLogMarkdown(db)
//     Re-emit the table as an append-only-shaped markdown file. The DB
//     is authoritative; we always regenerate the whole file from rows in
//     id order — this preserves append-only semantics because
//     response_log rows are monotonic AUTOINCREMENT + never mutated.
//
//   migrateResponseLogMarkdown(db, logPath)
//     Idempotent one-shot. Reads the markdown, parses it, inserts rows
//     that aren't already present (keyed on run_id + created_at + first
//     128 chars of response_text so same-second double-writes don't
//     collide). Safe to re-run.

import { readFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface ParsedResponseLogEntry {
  run_id: string;
  finding_ref: string | null;
  builder_claim: "agree" | "disagree";
  response_text: string;
  references: string[];
  created_at: number | null;
  migration_note: string | null;
}

const _BLOCK_DELIMITER = /(^|\n)---\s*\n/g;

/**
 * Parse the v1 markdown format. Each entry is a YAML-ish frontmatter
 * block (review_run_id / stance / created_at / finding_ref?) followed by
 * the note body, separated by `---` lines. The parser is permissive:
 * unknown keys in the frontmatter become migration_note annotations.
 */
export function parseResponseLogMarkdown(text: string): ParsedResponseLogEntry[] {
  const out: ParsedResponseLogEntry[] = [];
  const lines = text.split("\n");
  let i = 0;
  // Skip the file header / preamble until the first delimiter.
  while (i < lines.length && lines[i]?.trim() !== "---") i++;

  while (i < lines.length) {
    // Expect a `---` opener.
    if (lines[i]?.trim() !== "---") {
      i++;
      continue;
    }
    i++;
    // Collect frontmatter lines until the next `---`.
    const fm: Record<string, string> = {};
    while (i < lines.length && lines[i]?.trim() !== "---") {
      const line = lines[i] ?? "";
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (m?.[1]) fm[m[1]] = (m[2] ?? "").trim();
      i++;
    }
    if (i >= lines.length) break;
    i++; // consume the closing `---` of the frontmatter
    // Body: accumulate until the next `---` delimiter OR eof.
    const body: string[] = [];
    while (i < lines.length && lines[i]?.trim() !== "---") {
      body.push(lines[i] ?? "");
      i++;
    }
    // Consume exactly one trailing `---` (closing the block body). The
    // next iteration's "expect opener" check will pick up the following
    // `---` as the next block's opener — doubled delimiters in the legacy
    // and rendered formats resolve naturally.
    if (i < lines.length && lines[i]?.trim() === "---") i++;

    const responseText = body.join("\n").trim();
    if (responseText.length === 0) continue; // preamble or stray separator

    const rawRunId = fm.run_id ?? fm.review_run_id ?? "";
    const rawStance = (fm.builder_claim ?? fm.stance ?? "").toLowerCase();
    const notes: string[] = [];

    let builderClaim: "agree" | "disagree" = "disagree";
    if (rawStance === "agree") builderClaim = "agree";
    else if (rawStance === "disagree") builderClaim = "disagree";
    else notes.push(`unknown stance "${rawStance || "<missing>"}"; defaulted to disagree`);

    const rawTs = fm.created_at ?? "";
    let createdAt: number | null = null;
    if (rawTs) {
      const parsed = Date.parse(rawTs);
      if (!Number.isNaN(parsed)) createdAt = parsed;
      else notes.push(`unparseable created_at "${rawTs}"`);
    }

    const findingRef = fm.finding_ref || null;
    if (!findingRef) notes.push("imported without finding_ref (run-level response)");

    out.push({
      run_id: rawRunId,
      finding_ref: findingRef,
      builder_claim: builderClaim,
      response_text: responseText,
      references: [],
      created_at: createdAt,
      migration_note: notes.length > 0 ? notes.join("; ") : null,
    });
  }
  return out;
}

interface ResponseLogRow {
  id: number;
  run_id: string;
  finding_ref: string | null;
  builder_claim: string;
  response_text: string;
  references_json: string;
  created_at: number;
  migration_note: string | null;
}

/**
 * Re-emit the whole response_log table as markdown. Rows are written in
 * id order so the output is deterministic and append-only-shaped.
 */
export function renderResponseLogMarkdown(db: DatabaseSync): string {
  const rows = db
    .prepare(
      `SELECT id, run_id, finding_ref, builder_claim, response_text,
              references_json, created_at, migration_note
         FROM response_log
         ORDER BY id ASC`,
    )
    .all() as unknown as ResponseLogRow[];

  const header = [
    "# Response Log (rendered view — edit via `response_log_add`)",
    "",
    "> Reviewers read this before every pass.",
    "> Source-of-truth is `project.db.response_log`; this file is regenerated on every write.",
    "",
  ].join("\n");

  const blocks = rows.map((r) => {
    const refs = safeParseRefs(r.references_json);
    const fm: string[] = [
      "---",
      `run_id: ${r.run_id}`,
      `builder_claim: ${r.builder_claim}`,
      `created_at: ${new Date(r.created_at).toISOString()}`,
    ];
    if (r.finding_ref) fm.push(`finding_ref: ${r.finding_ref}`);
    if (refs.length > 0) fm.push(`references: ${JSON.stringify(refs)}`);
    if (r.migration_note) fm.push(`migration_note: ${JSON.stringify(r.migration_note)}`);
    fm.push("---");
    return [...fm, "", r.response_text.trim(), "", "---"].join("\n");
  });

  if (blocks.length === 0) return header + "\n_no responses yet_\n";
  return header + "\n" + blocks.join("\n") + "\n";
}

function safeParseRefs(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * One-shot migrator: parse the legacy markdown and insert any rows not
 * already present in the DB. Keyed on (run_id, created_at,
 * response_text prefix) to survive same-second inserts from automated
 * tooling. Idempotent — re-running against a migrated log is a no-op.
 */
export function migrateResponseLogMarkdown(
  db: DatabaseSync,
  logPath: string,
): { inserted: number; skipped: number; parsed: number } {
  if (!existsSync(logPath)) return { inserted: 0, skipped: 0, parsed: 0 };
  const text = readFileSync(logPath, "utf8");
  const entries = parseResponseLogMarkdown(text);

  const existing = db
    .prepare("SELECT run_id, response_text, created_at FROM response_log")
    .all() as unknown as Array<{
    run_id: string;
    response_text: string;
    created_at: number;
  }>;
  const seen = new Set(existing.map((e) => keyFor(e.run_id, e.response_text, e.created_at)));

  const insert = db.prepare(
    `INSERT INTO response_log
       (run_id, finding_ref, builder_claim, response_text, references_json,
        created_at, migration_note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    const ts = e.created_at ?? Date.now();
    const key = keyFor(e.run_id, e.response_text, ts);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    insert.run(
      e.run_id,
      e.finding_ref,
      e.builder_claim,
      e.response_text,
      JSON.stringify(e.references),
      ts,
      e.migration_note,
    );
    inserted++;
    seen.add(key);
  }
  return { inserted, skipped, parsed: entries.length };
}

function keyFor(runId: string, text: string, createdAt: number): string {
  return `${runId}|${createdAt}|${text.slice(0, 128)}`;
}
