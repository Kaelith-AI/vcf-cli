---
name: plan
description: Produce the four plan artifacts (charter, plan, todo, manifest) from the project's spec via plan_context / plan_save. Triggers on "plan this", "start planning", "$plan".
---

# Plan

Drive the planning session for the current project.

## When to use

- Inside a project-scope MCP session (server launched with `--scope project`).
- User invokes `$plan [<name>]` or says: *"plan this"*, *"start planning"*, *"let's plan the build"*.

## What to do

1. Call `plan_context({ name: "<slug>", expand: true })`. The server returns:
   - `planner_md` (role overlay), `standards_md`, `vibe_primer_md`, `spec_md`
   - `suggested_primers[]` (tag-matched from the spec's `tech_stack` / `lens` tags)
   - `output_targets` — where plan_save will write
2. Load every returned primer into context (you may call `primer_list` to resolve ids to bodies). The planner role file tells you what a good plan must name (config, tests, review gates, compaction, swaps, docs, ship audit) and forbid (unpinned deps, swallowed errors, tautology mocks).
3. Write four documents:
   - **charter**: frozen statement of project intent — problem, success criteria, hard constraints, out-of-scope, locked design decisions. Write this first; everything else flows from it.
   - **plan**: phased narrative with risks, mitigations, review gates per phase.
   - **todo**: flat imperative list the builder checks off one item at a time.
   - **manifest**: file-by-file map of what gets created/modified and why.
4. Call `plan_save({ name, charter, plan, todo, manifest, advance_state: "planning" })`. On E_ALREADY_EXISTS, confirm with the user before retrying with `force: true`.
5. After `plan_save` succeeds: the summary includes a compact directive with a copy-paste prompt. Share it with the user so they can compact and resume the build session cleanly.

## Reminders

- The planner role file forbids mocks-that-mirror-impl, unpinned deps, swallowed errors, hardcoded literals. Don't slip.
- Every spec scale target requires a 10× volume test in the plan.
- Name compaction points explicitly — otherwise the builder will hit one at the worst moment.
- The charter is frozen. Deviations during build require `decision_log_add`. Use `charter_check` to audit drift.
