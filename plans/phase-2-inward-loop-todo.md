---
title: "Phase-2 Todo"
plan: plans/phase-2-inward-loop-plan.md
created: 2026-04-22
---

# Phase-2 Todo

Flat imperative list. One verb per line. Tag each item with its phase (A–E) so `advance_state` can verify all items for a stage are checked off.

## Phase A — Foundation: lesson_log

- [ ] A. Draft Zod schema `LessonLogAddInput` in `src/tools/lesson_log_add.ts`. Use `.strict()`. Register whole schema, not `.shape`.
- [ ] A. Add `LessonSearchInput` Zod schema in `src/tools/lesson_search.ts`. Accept `query, tags?, scope?, stage?, limit?`.
- [ ] A. Write migration v3 in `src/db/schema.ts`: add `lessons` table (id, title, context, observation, actionable_takeaway, scope, stage, tags_json, created_at).
- [ ] A. Add global-DB schema module `src/db/globalLessons.ts`. Migrations gated via `schema_version` row.
- [ ] A. Resolve global DB path via `config.lessons.global_db_path` with `~/.vcf/lessons.db` default. Fail loud if unwritable.
- [ ] A. Implement `lesson_log_add` handler. Writes to project DB, then mirrors to global DB with project_root column.
- [ ] A. Implement `lesson_search` handler. Substring + tag AND-filter. Return ranked matches with matched_tags.
- [ ] A. Wire `redact()` before every lesson text persists. Flag in envelope when redaction applied.
- [ ] A. Audit hook via `runTool(auditor)` per `best-practices/audit-trail-discipline.md` — fires in `finally`.
- [ ] A. Write regression test: send `{__bogus: 1}` to `lesson_log_add`, assert `E_VALIDATION`.
- [ ] A. Write integration test: write 10 lessons, then `lesson_search` returns them by tag + substring.
- [ ] A. Write redaction test: send an `sk-abc123...` canary in `observation`, assert it lands as `[REDACTED:openai-key]`.
- [ ] A. Test that project-DB migration v2 → v3 is idempotent on re-open.
- [ ] A. Document both tools in `README.md`.
- [ ] A. Code + security review gate. Fix any blockers; log decisions.
- [ ] A. Compact. Commit. Tag Phase A close.

## Phase B — Review layer

- [ ] B. Harden `response_log_add`: add formal `{finding_ref, response_text, builder_claim, references?}` schema.
- [ ] B. Add DB migration v4: create `response_log` table (id, run_id, finding_ref, response_text, builder_claim, references_json, created_at).
- [ ] B. Write migration script: parse existing `plans/reviews/response-log.md` into `response_log` table. Ambiguous entries default to `builder_claim="disagree"` with `migration_note`.
- [ ] B. Add rendered-view generator that emits `plans/reviews/response-log.md` from the table (for human reading; append-only semantics preserved).
- [ ] B. Author reviewer overlay v0.3 in `vcf-kb/kb/reviewers/reviewer-code.md` (+ security, + production): add "you may disagree" paragraph, carry-forward rule.
- [ ] B. Author `vcf-kb/kb/reviewers/reviewer-code.frontier.md`. Extend for security + production.
- [ ] B. Author `vcf-kb/kb/reviewers/reviewer-code.local.md`. Extend for security + production.
- [ ] B. Write overlay resolver in `src/review/overlays.ts`: `<type>.<family>.md → <type>.<trust-level>.md → <type>.md`. Unit-test the precedence.
- [ ] B. Wire resolver into `src/tools/review_execute.ts`. Extract model family from model id (`qwen3-coder` → `qwen`; `gpt-5.4` → `gpt`).
- [ ] B. Add `kb.tag_vocabulary_strict` flag to config schema (off by default this phase).
- [ ] B. Test overlay fallback order with all permutations (family match, trust-level match, default).
- [ ] B. Test migration of existing response-log content (use fixture based on real 0.3.2 log).
- [ ] B. Code + security review gate.
- [ ] B. Commit. Tag Phase B close.

## Phase C — Visibility: lifecycle_report

- [ ] C. Draft stable JSON schema for structured lifecycle-report output. Checked in at `src/schemas/lifecycle-report.schema.ts`.
- [ ] C. Implement `lifecycle_report` handler, mode=structured. Reads audit, artifact index, review history, decisions, lessons. No LLM.
- [ ] C. Add narrative mode. Fan out per-section LLM calls (one per lifecycle step) to `defaults.lifecycle_report` endpoint + model.
- [ ] C. Cap audit rows per section (configurable; default 500). Trim by `ts` descending.
- [ ] C. Emit `generated_by: {model_id, endpoint}` footer on narrative output. Attach pointer to structured JSON.
- [ ] C. Add CLI wrapper: `vcf lifecycle-report --project <path> [--mode ...] [--format ...] [--frontier]`.
- [ ] C. Envelope follows `best-practices/mcp-tool-surface-token-economy.md`: paths+summary default, content behind `expand`.
- [ ] C. Write perf test: 10K audit rows, 500 artifacts, 100 review runs. Structured <2s; narrative <60s.
- [ ] C. Write data-flow test: assert narrative prompts get redacted audit content, not raw.
- [ ] C. Document CLI + tool in `README.md` with an example output snippet.
- [ ] C. Code + production review gate.
- [ ] C. Commit. Tag Phase C close.

## Phase D — Onboarding skill (parallelizable with C, separate compaction)

- [ ] D. Swap builder-type: load `primers/skill-creation.md` + `best-practices/skill-creation.md`.
- [ ] D. Draft `skills/common/vcf-usage-guide.md`. Sections: lifecycle, prepare/execute pattern, envelope contract, tool index by step, error codes, decision vs lesson vs feedback vs finding (per `primers/lesson-vs-decision-vs-feedback.md`).
- [ ] D. Enforce ≤400 lines. Add a lint step in `scripts/validate-skills.mjs`.
- [ ] D. Reference the guide from each client-specific skill pack under `vcf-cli/skills/<client>/`.
- [ ] D. Write validation: fresh Claude Code session → `/skills install vcf` → idea-capture → spec-save. Asserts success without prior VCF context.
- [ ] D. Update `vcf install-skills` to include `common/` alongside the client-specific skills.
- [ ] D. Code review gate (docs).
- [ ] D. Commit. Tag Phase D close.

## Phase E — Integration + release

- [ ] E. Seed lesson corpus: parse the 2026-04-21 dogfood memory notes + reviewer findings. Migrate ≥12 entries via `lesson_log_add`. Confirm redaction was applied.
- [ ] E. Post-seed PII sanity query: `SELECT COUNT(*) FROM lessons WHERE observation LIKE '%[REDACTED%'`. Human-review any hits before commit.
- [ ] E. Migrate `plans/reviews/response-log.md` (existing Kaelith content) into the new `response_log` table. Verify idempotency on second run.
- [ ] E. Run full 27-stage dual-model review (local qwen3-coder + frontier GPT-5.4) against HEAD vs `v0.4`.
- [ ] E. Resolve any BLOCK findings. Log response-log entries for each carry-forward.
- [ ] E. Update `CHANGELOG.md` under `Unreleased` → `0.5.0`.
- [ ] E. Update `README.md` sections: lesson_log, response_log formalization, lifecycle-report, per-model overlays, usage-guide skill.
- [ ] E. Ship audit: hardcoded-path grep, secrets scan, personal-data scan over the seed corpus. All green required.
- [ ] E. Bump `package.json` to `0.5.0`.
- [ ] E. Commit version bump. `git push --tags v0.5.0`. CI publishes via OIDC.
- [ ] E. Smoke-test published artifact: `npm install -g @kaelith-labs/cli@0.5.0` → `vcf version` → `vcf-mcp --scope global` → `lesson_log_add` round-trip.
- [ ] E. File followup #33 (matrix harness) now that the per-model overlays need comparison evidence.
