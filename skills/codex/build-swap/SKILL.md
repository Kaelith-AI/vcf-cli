---
name: build-swap
description: Restore build context at the start of a new session after compacting. Call at the START of a new build session (after compacting) to restore full context as a different builder type. Triggers on "swap to frontend", "swap to infra", "$build-swap".
---

# Build Swap

Restore full build context at the start of a new session after compacting — used at the plan's named builder-type swap boundaries (e.g. backend finished → frontend).

## When to use

- User invokes `$build-swap <from> <to> <plan-name>` at the START of a new build session after compacting.
- Only at a boundary the plan named. Don't swap mid-feature in an ongoing session.

## What to do

1. Call `build_swap({ from_type, to_type, plan_name, expand: true })`. You receive a `context_hint` + the target builder type's `best_practice_md` body.
2. Follow the context_hint: re-read the plan, charter, and manifest files named in it.
3. Load the returned `best_practice_md` as your builder persona for this session.
4. Resume building at the next incomplete item in the todo list.

## Reminders

- Call `build_swap` at the BEGINNING of a new session, not at the end of an old one. Compaction happens between sessions; this tool restores context after it.
- If there's no matching best-practice in the KB for the target type, the tool returns null and notes it — proceed with generic guidance.
