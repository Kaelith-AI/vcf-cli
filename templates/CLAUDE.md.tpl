# CLAUDE.md — Project Guidance

> This file is auto-loaded by Claude Code when the project is opened. It steers the conversation — it does not replace `AGENTS.md` (which applies to every agent).

## Who's Working Here

- **Project:** {{PROJECT_NAME}}
- **Created:** {{CREATED_DATE}}
- **Lifecycle:** Vibe Coding Framework MCP (capture → spec → init → plan → build → test → review → ship).

## Before You Write Code

1. Read `AGENTS.md` for the non-negotiables.
2. Read `plans/{{PROJECT_SLUG}}-spec.md` (the source of truth for requirements).
3. Read `plans/{{PROJECT_SLUG}}-plan.md` once planning has finished.
4. Check `plans/decisions/` — design calls you must not override.

## How Tools Work Here

- The project is wired into an MCP server (`vcf-mcp --scope project`) by the `.mcp.json` at the project root.
- All lifecycle actions go through MCP tools; don't bespoke-edit `plans/` or `memory/` state.
- Tools return `{paths, summary}` by default. Pass `expand=true` for content.

## What to Never Do

- Don't hardcode paths, endpoints, or secrets. Everything goes through `~/.vcf/config.yaml`.
- Don't bypass review — Stage 1 (fake-complete) is mandatory before any further stage runs.
- Don't mutate reviewer or planner template files. Every review is a disposable copy.
- Don't silently swallow errors. Stop on failure, log, report, wait.
