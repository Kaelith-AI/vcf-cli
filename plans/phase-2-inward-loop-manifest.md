---
title: "Phase-2 Manifest"
plan: plans/phase-2-inward-loop-plan.md
created: 2026-04-22
done_definition: "All five followups (#22, #11, #27, #16, #32) shipped behind full-27-stage review, 0.5.0 published via CI."
---

# Phase-2 Manifest

Overall goal: ship the five-followup inward-loop bundle as 0.5.0. File-by-file map of what changes and why.

## Schema + config

| File | Kind | Action | Why |
|---|---|---|---|
| `src/config/schema.ts` | existing | modify | Add `lessons`, `response_log`, `reviewers`, extended `defaults`, `kb.tag_vocabulary_strict` blocks. `.superRefine` for cross-field validation. |
| `src/db/schema.ts` | existing | modify | v3 migration (lessons table); v4 migration (response_log table). |
| `src/db/globalLessons.ts` | new | create | Global DB open + migrations. Reuses the node:sqlite pattern from `primers/node-sqlite-embedded.md`. |

## New tools

| File | Kind | Action | Why |
|---|---|---|---|
| `src/tools/lesson_log_add.ts` | new | create | #11. Writes project + global DBs. Redaction pre-store. Audit via `runTool`. |
| `src/tools/lesson_search.ts` | new | create | #11. Substring + tag filter. Scope arg. |
| `src/tools/lifecycle_report.ts` | new | create | #27. Structured + narrative modes. Fan-out LLM calls in narrative. |
| `src/tools/response_log_add.ts` | existing | modify | #22. Add formal schema; write to table; keep markdown as rendered view. |

## Review surface

| File | Kind | Action | Why |
|---|---|---|---|
| `src/review/overlays.ts` | new | create | Resolver for `<type>.<family>.md → <type>.<trust>.md → <type>.md`. Unit-tested precedence. |
| `src/tools/review_execute.ts` | existing | modify | Load resolved overlay; thread family + trust-level into the prompt. |
| `src/review/responseLogMigrator.ts` | new | create | One-shot: parse legacy markdown → rows in `response_log`. Idempotent; records migration metadata. |

## KB — vcf-kb repo

| File | Kind | Action | Why |
|---|---|---|---|
| `kb/reviewers/reviewer-code.md` | existing | modify → v0.3 | "You may disagree" + carry-forward rule. |
| `kb/reviewers/reviewer-security.md` | existing | modify → v0.3 | Same. |
| `kb/reviewers/reviewer-production.md` | existing | modify → v0.3 | Same. |
| `kb/reviewers/reviewer-code.frontier.md` | new | create | #32. Frontier calibration: empty findings OK, severity matches stage. |
| `kb/reviewers/reviewer-code.local.md` | new | create | #32. Local calibration: anti-hallucination framing, narrower verdicts. |
| `kb/reviewers/reviewer-security.frontier.md` | new | create | #32. |
| `kb/reviewers/reviewer-security.local.md` | new | create | #32. |
| `kb/reviewers/reviewer-production.frontier.md` | new | create | #32. |
| `kb/reviewers/reviewer-production.local.md` | new | create | #32. |

## CLI

| File | Kind | Action | Why |
|---|---|---|---|
| `src/cli.ts` | existing | modify | Add `lifecycle-report` subcommand with flags per plan. Extend `install-skills` to pick up `skills/common/`. |

## Skills

| File | Kind | Action | Why |
|---|---|---|---|
| `skills/common/vcf-usage-guide.md` | new | create | #16. ≤400 lines. Lifecycle + envelope + tool index + error codes + taxonomy. |
| `skills/claude-code/*` | existing | modify | Reference `common/vcf-usage-guide.md`. |
| `skills/codex/*` | existing | modify | Same. |
| `skills/gemini/*` | existing | modify | Same. |
| `scripts/validate-skills.mjs` | new | create | Lint step: ≤400 lines, required sections present. Runs in CI. |

## Tests

| File | Kind | Action | Why |
|---|---|---|---|
| `test/integration/lesson_log.test.ts` | new | create | Write 10, search by tag + substring. Validate redaction. Reject unknown keys. |
| `test/integration/lesson_scale.test.ts` | new | create | 10k entries, tag query p95 <100ms. |
| `test/integration/response_log_migration.test.ts` | new | create | Parse fixture from real 0.3.2 log; idempotent re-run. |
| `test/integration/review_overlay_resolution.test.ts` | new | create | All precedence permutations. |
| `test/integration/lifecycle_report.test.ts` | new | create | Structured mode shape + narrative mode fan-out (LLM mocked). |
| `test/perf/lifecycle_report_10k.mjs` | new | create | 10k audit rows, 500 artifacts, 100 reviews. Assert timing. |
| `test/validation/usage_guide_first_cycle.test.ts` | new | create | Smoke: fresh session, guide only, idea-capture→spec-save completes. |

## Stress harnesses

| File | Kind | Action | Why |
|---|---|---|---|
| `scripts/stress/lesson-log/run.mjs` | new | create | 500 prompt-injection + PII-canary + unicode-edge lesson writes. |
| `scripts/stress/lifecycle-report/run.mjs` | new | create | Project matrix × mode matrix; reports duration + parse success. |

## Docs

| File | Kind | Action | Why |
|---|---|---|---|
| `README.md` | existing | modify | New sections for lesson_log, response_log formalized, lifecycle-report, per-model overlays. |
| `CHANGELOG.md` | existing | modify | `0.5.0` section under Unreleased. |
| `docs/STABILITY.md` | existing | modify | Document lesson_log, response_log, lifecycle_report stability contracts. Document reviewer overlay resolution precedence. |
| `plans/decisions/2026-04-22-reviewer-overlay-resolution.md` | new | create | ADR for family > trust-level > default. |
| `plans/decisions/2026-04-22-lesson-schema.md` | new | create | ADR for scope enum + optional fields. |

## Release

| File | Kind | Action | Why |
|---|---|---|---|
| `package.json` | existing | modify | Bump to `0.5.0`. |
| `.github/workflows/release.yml` | existing | no change expected | Already OIDC-gated. Tag triggers publish. |
| `vcf-kb/package.json` | existing | modify | Bump to whatever the next kb version is; `@kaelith-labs/kb` publishes separately. |

## Done-definition (reassertion)

All five followups (#22, #11, #27, #16, #32) shipped behind full 27-stage review. 0.5.0 published via CI OIDC. Seed lesson corpus ≥12 entries. Usage-guide skill ≤400 lines. Reviewer overlay resolution unit-tested across all precedence permutations. Lifecycle-report structured mode <2s / narrative <60s on 10k-audit-row fixture. Redaction verified at both lesson DB write and narrative LLM prompt.

Anything not on this list is out of scope for 0.5. Bundle ships or waits; partial shipping breaks the theme.
