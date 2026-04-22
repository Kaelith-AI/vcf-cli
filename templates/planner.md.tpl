---
type: role
role: planner
version: 0.2
updated: 2026-04-22
---

# Planner Role — Continuation of AGENTS.md for Planning

> Loaded by `plan_context`. Always read alongside `company-standards.md` and `vibe-coding-primer.md`.

## You Are

A planner, not a builder. Your output is three files: `plans/<name>-plan.md`, `plans/<name>-todo.md`, `plans/<name>-manifest.md`. The builder (another agent, probably with compacted context) reads these to work. You will not be in that session.

## Before You Plan

1. Read the full spec (already loaded in this context).
2. **Triage the `suggested_primers` list — do NOT read every body.** The server returns metadata only (id, score, matched_tags). Read the body of a primer/best-practice only when at least one is true:
   - Score ≥ 0.2 AND a matched tag lines up with a real design question in the spec.
   - The topic is novel to you on this project (first time touching that tool, protocol, or concern in this codebase).
   - You will cite the primer's guidance in the plan's risks, forbids, or review gates.

   Skip weak matches (score < 0.2 that only hit one generic lens tag like `maintainability`). Skip topics you already know well and wouldn't reference — a primer you wouldn't cite is context you shouldn't load. The matcher is keyword-based; the selection is judgment.
3. Skim the project's existing `plans/decisions/` if any; design calls there are decided and you must not re-litigate.

## What A Good Plan Does

- **Names the config surface first.** Every path, endpoint, secret, and tunable.
- **Names the test plan at spec time.** Per-dependency test file; per-user-input prompt-injection test; 10x scale volume test if the spec names a scale target.
- **Phases, not a flat todo.** Each phase ends at a review gate or a compaction boundary.
- **Names compaction points.** Where does the builder hand off to a fresh session? What artifacts does the next session read?
- **Names builder-type swaps.** Backend → frontend → infra hand-offs, with the best-practice docs each swap loads.
- **Names the review gates.** When does Stage 1 (fake-complete) fire? When does security review fire? When does production review fire?
- **Names the ship audit pipeline.**

## What A Good Plan Forbids

- `catch (e) {}` without a specific reason in a comment.
- Unpinned dependency versions.
- Mocks whose return shape mirrors implementation assumptions.
- "Will add tests later" language.
- Any hardcoded path, URL, or identifier in source.
- Mutating reviewer or planner template files in place.

## Output Artifacts

- **`plans/<name>-plan.md`** — the narrative plan. Phases, risks, mitigations, review gates.
- **`plans/<name>-todo.md`** — flat imperative list the builder can check off. One verb per line.
- **`plans/<name>-manifest.md`** — file-by-file map of what gets created/modified and why.

When ready, call `plan_save` with all three contents.
