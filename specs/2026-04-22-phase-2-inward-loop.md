---
title: "Phase-2 — Inward Self-Improvement Loop"
status: draft
created: 2026-04-22
tech_stack: [node, typescript, zod, sqlite, mcp, json-rpc]
tags: [phase-2, self-improvement, dogfood]
lens: [api-design, testability, maintainability, token-economy]
author_agent: claude-opus-4-7
domain: vcf-mcp
---

# Phase-2 — Inward Self-Improvement Loop

## 1. Problem

Phase-1 (the 0.4 cut) delivered a working VCF lifecycle: capture → spec → plan → build → test → review → ship. All seven steps function; 4 of the 7 have been dogfooded in real use against vcf-cli itself. The dogfood pass surfaced evidence of a **specific gap**: the framework produces valuable self-observations — review findings, lessons, response stances, reviewer-model bias — but none of them flow back into the next cycle in a structured way.

Concretely, the 2026-04-21 dogfood:
- **Generated ~15 lessons** (reviewer-overlay misses, tsup bundling trap, Ollama num_ctx silent cap, etc.) that exist only in memory notes or ad-hoc markdown. No durable store.
- **Produced two dozen review findings** across 4 dual-model runs with stances (agree/disagree) scribbled into `plans/reviews/response-log.md` as freeform markdown. No formal contract means the next reviewer reads them as instruction instead of context.
- **Exposed per-model reviewer bias** (GPT's always-NEEDS_WORK pattern) that a single reviewer-overlay file cannot calibrate out — the overlay is model-agnostic.
- **Made VCF's own value invisible to its target audience**. The audit trail, lessons, reviews, decisions — all there, all correct, all unreadable unless you're the builder. Vibe coders who don't read code have nothing to look at.
- **Gave new LLM sessions no curriculum**. Starting from "here are 33 tools" is strictly worse than "here is a guide to the lifecycle and when to call each step."

## 2. Solution (bundle)

Ship five coupled improvements as one Phase-2 bundle. They share a theme: **make the inward loop a durable artifact stream, not scattered session-level notes.**

1. **`response_log_add` formalized (followup #22)** — structured tool replacing freeform markdown edits, with explicit "context not instruction" semantics so subsequent reviewers may disagree.
2. **`lesson_log` family (followup #11)** — stage-indexed, per-project + global lessons DB with a search surface. The foundation everything else in the improvement loop depends on.
3. **`vcf lifecycle-report` / `lifecycle_report` tool (followup #27)** — structured data mode + LLM-enriched narrative mode. Renders the audit trail as something a vibe coder would actually read.
4. **LLM usage guide, shipped as a skill (followup #16)** — one markdown, covering lifecycle + when-to-call-which-tool + envelope semantics. Ships via `vcf install-skills`.
5. **Per-model reviewer overlays (followup #32)** — per-family variant files resolved by `reviewer-<type>.<family>.md` or `.<trust-level>.md` before the default. Directly addresses the frontier-vs-local bias observed in the dogfood.

## 3. Goals

**G1. Lessons become first-class.** Every lifecycle step can log a lesson in ≤1 tool call; the improvement cycle reads them by stage.

**G2. Review threads survive across runs without socially coercing the next reviewer.** A response is data, not marching orders.

**G3. Vibe coders can see their project.** `vcf lifecycle-report --project X` produces a narrative structured per step, with LLM-enriched prose using the per-step model defaults (already shipped in #28).

**G4. New LLM sessions hit the ground running.** `vcf install-skills` drops a guide that lets a fresh LLM make its first correct MCP call without reading 33 descriptions.

**G5. Reviewer signal-to-noise improves measurably.** Matrix harness shows frontier "always-NEEDS_WORK" bias disappears on the new per-model overlays.

## 4. Non-goals

- **Research agents (#29).** Outward loop. Requires #11/#27/#28 signal first.
- **`project_init_existing` strict/reconstruct modes (#20).** Wait for real adoption friction to produce evidence.
- **Stress / QA test kinds (#23/#24).** Ship after the improvement loop is shedding lessons that suggest which surfaces need the stress pass.
- **`conformance` / `vibe-check` test kinds (#13/#14).** Depend on plan templates gaining structured success criteria — that's a later phase.
- **Single-executable builds (#8).** Distribution polish — not this bundle.

## 5. Constraints

- **Audit trail unchanged.** Every new tool in this bundle writes one audit row per call, using the existing `runTool` envelope.
- **Redaction preserved.** Outbound lesson/response text goes through `redact()` before surfacing in envelopes or leaving the host.
- **Backward compat on DB.** New tables via migrations; no breaking changes to existing schema rows.
- **Tool count stays manageable.** Prefer 1–2 new tools per followup over spreading surface.
- **Local-first default.** `lifecycle_report --narrative` defaults to the `defaults.lifecycle_report` endpoint (already shipped as a forward-compat stub in #28).

## 6. Tech stack

Node 22+, TypeScript 5.4+, Zod 4, `@modelcontextprotocol/sdk` ^1.29, `node:sqlite` (existing), tsup (existing). No new runtime dependencies.

## 7. Open questions (to decide during plan)

- Universal lesson schema: do we expose `scope: session` or only `project | universal`? (Session scope keeps ephemeral notes out of the DB but duplicates `feedback` (#18).)
- Response-log contract: does an `accepted_risk` entry carry forever, or expire at next release?
- Lifecycle-report: JSON-only + separate renderer, or single tool with both modes? (Prefer single tool with `--format` flag.)
- Per-model overlay resolution precedence: family over trust-level, or reverse? (Likely family-first; trust-level is the fallback when no family variant exists.)

## 8. Risks

- **Scope creep.** Five followups in one bundle is wide. Mitigation: strict milestones with go/no-go gates; a single followup slipping doesn't stop the rest.
- **Lesson fatigue.** If the tool is too heavyweight, LLMs stop logging. Mitigation: ship the `feedback` one-field tool (#18) alongside or shortly after, so there's a cheap fallback.
- **Response-log migration.** Existing `plans/reviews/response-log.md` has real content. Migration script reads it and seeds the new `response_log` table.
- **Narrative report cost.** Running frontier on every narrative render is expensive. Mitigation: default to local per `defaults.lifecycle_report`; frontier is opt-in via explicit flag.

## 9. Success criteria

1. `lesson_log_add` + `lesson_search` land with tests; vcf-cli's own lessons from the 2026-04-21 dogfood are migrated as the seed corpus (≥12 entries).
2. `response_log_add` replaces the markdown file; reviewer overlay v0.3 explicitly names "you may disagree with prior responses."
3. `vcf lifecycle-report` produces a structured markdown report for vcf-cli in <2s (structured mode) and a narrative report in <60s using the local default.
4. The LLM usage guide ships in `skills/common/` and is installed by `vcf install-skills claude-code`; a fresh conversation can complete an idea-capture → spec-save cycle using only the guide as context.
5. Matrix harness run over 3+ models confirms GPT's "always-NEEDS_WORK" bias drops from ≥70% to ≤30% with the per-model overlay.

## 10. Out-of-scope but worth noting

- Followups #12/#13/#14 (test-kind expansions) are the natural next bundle after this one lands. They depend on #11 (lesson linkage) and on plan-template structured success criteria.
- Followup #29 (research agents) is explicitly gated on this bundle's #11 + #27 producing real signal before building.
