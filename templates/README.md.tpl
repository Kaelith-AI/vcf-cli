# {{PROJECT_NAME}}

> _Spec lives in_ `plans/{{PROJECT_SLUG}}-spec.md`.

## Getting Started

This project was bootstrapped by the Vibe Coding Framework MCP (`vcf init`).

```bash
# Fresh MCP-client session inside this directory auto-loads --scope project.
# Then, from your MCP client (e.g. Claude Code):
/status                       # check project state
/plan                         # if not yet planned
/build                        # begin the build
/test                         # drive the test pipeline
/review code                  # start code review stage 1
```

## Layout

- `plans/` — spec, plan, todo, manifest, reviews, decisions
- `memory/` — daily logs, project-local memory
- `docs/` — project-specific documentation (not KB)
- `skills/` — project-specific skill overlays (optional)
- `backups/` — automated backup snapshots (gitignored)
- `.vcf/project.db` — per-project SQLite index

## License

_TBD — set by the team before first ship._
