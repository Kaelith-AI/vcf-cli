# Lifecycle Report (structured)

> Generated 2026-04-22T05:49:53.076Z · schema 1.0.0 · 8 section(s).
> Structured JSON: `/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli/plans/lifecycle-report.json`

## Project

- name: VCF-CLI
- state: reviewing
- adopted: true
- created: 2026-04-21T23:58:26.468Z · updated: 2026-04-22T05:33:22.642Z

## Audit

- total: 517 (ok 514 / errors 3)
- span: 2026-04-22T00:25:58.706Z → 2026-04-22T05:33:22.644Z
- top tools: review_execute=249, review_prepare=248, response_log_add=7, lesson_log_add=5, plan_context=3, lesson_search=3
- recent (500 / cap 500): 05:33:22 review_execute:ok · 05:32:55 review_prepare:ok · 05:32:55 review_execute:ok · 05:32:28 review_prepare:ok · 05:32:28 review_execute:ok

## Artifacts

- count: 3
- by kind: manifest=1, plan=1, todo=1
- recent:
  - `/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli/plans/phase-2-inward-loop-todo.md` · todo · 2026-04-22T03:08:54.596Z
  - `/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli/plans/phase-2-inward-loop-manifest.md` · manifest · 2026-04-22T03:08:54.596Z
  - `/home/kaelith/Projects/Vibe-Coding-Framework-MCP/vcf-cli/plans/phase-2-inward-loop-plan.md` · plan · 2026-04-22T03:08:54.594Z

## Reviews

- count: 248
- verdicts: PASS=201, NEEDS_WORK=35, BLOCK=10, (pending)=2
- types: code=94, security=82, production=72
- recent:
  - `security-9-20260422T053255894Z` · security stage 9 · submitted (PASS)
  - `security-8-20260422T053228146Z` · security stage 8 · submitted (PASS)
  - `security-7-20260422T053205841Z` · security stage 7 · submitted (PASS)
  - `security-6-20260422T053146236Z` · security stage 6 · submitted (PASS)
  - `security-5-20260422T053119048Z` · security stage 5 · submitted (PASS)

## Decisions

- count: 0

## Responses

- count: 7
- claims: agree=4, disagree=3
  - #7 · production-8-20260422T005431483Z · disagree
  - #6 · production-5-20260422T005015224Z · agree
  - #5 · production-1-20260422T004712831Z · disagree
  - #4 · security-6-20260422T004124768Z · disagree
  - #3 · security-2-20260422T003707768Z · agree

## Builds

- count: 0
- statuses: _none_

## Lessons

- count: 1
- scopes: universal=1
  - #5 · Plan phase-close gates should default to full stage-1-through-9, not a representative stage · stage=reviewing · [vibe-coding, project-planning, documentation, audit-trail]
