# CLAUDE.md — Vibe Coding Framework MCP

## What this project is

`@kaelith-labs/cli` ships `vcf` (maintenance CLI) and `vcf-mcp` (stdio MCP
server) for the Vibe Coding Framework: an LLM-agnostic lifecycle tooling
surface covering **capture → spec → init → plan → build → test → review → ship**.
The server owns state/files/index/context-prep; clients (Claude Code, Codex,
Gemini CLI) own conversation + execution. This directory is one
component — the build — of the wider project; everything under
`/home/kaelith/Projects/Vibe-Coding-Framework-MCP/` is the project as the
registry sees it.

## How to get productive

Run `vcf install-skills claude-code` once to drop the skill pack into
`~/.claude/skills/`. Then:

- **`vcf-usage-guide`** — the ground-truth reference for lifecycle phases,
  every tool in the MCP surface, error codes, and the
  decision/lesson/feedback/response taxonomy. Read this before touching
  anything.
- **`/capture-idea` → `/spec-idea` → `/initialize-project` → `/plan` →
  `/build` → `/test` → `/review` → `/ship`** — the happy path.
- **`/review`** — runs `review_prepare` for one of code/security/production
  at a given stage, hands you the bundle, then `review_submit` persists your
  verdict. Twenty-seven stages total per review pass (9 × 3 types).

## Where state lives (0.5.0)

Runtime state is out of tree:

- `~/.vcf/projects/<slug>/project.db` — per-project SQLite (lifecycle +
  lessons + response-log + review runs + audit).
- `~/.vcf/projects/<slug>/review-runs/<run-id>/` — review-run scratch
  (stage file, reviewer overlay snapshot, decisions snapshot, response-log
  snapshot, scoped diff). Disposable.
- `~/.vcf/vcf.db` — cross-project global registry (which paths are VCF
  projects) + audit + endpoints + model-aliases + primer catalog.
- `~/.vcf/lessons.db` — cross-project lessons mirror (redacted, opt-out
  via `config.lessons.global_db_path: null`).
- `~/.vcf/kb/` — shared KB content (primers, stages, reviewers, lenses,
  standards) from `@kaelith-labs/kb`.

In-tree (committed by the team): `plans/`, `plans/reviews/<type>/`,
`plans/decisions/`, `docs/`, `skills/`, `memory/daily-logs/`, spec docs,
CLAUDE.md/AGENTS.md/TOOLS.md/MEMORY.md.

## Design invariants (don't break these)

1. **Token-economy first.** Every tool defaults to `{paths, summary}`;
   `expand=true` gets content.
2. **Scope partitioning.** Global scope owns idea/spec/project-init/catalog;
   project scope owns plan/build/test/review/ship + lesson/decision/
   response/lifecycle_report. Server registers tools by scope at boot.
3. **Redact before audit.** Every tool call runs `redact()` on inputs +
   outputs before hashing/persisting. No secret values ever touch disk.
4. **API keys live in env, not config.** `endpoints[].auth_env_var` names
   the env var; values are read at call time and discarded.
5. **Trust-level gate.** `local` | `trusted` | `public` endpoints with
   explicit-consent (`allow_public_endpoint=true`) required for
   defaults-routing to any non-local endpoint.
6. **VCF does not write to project directories.** Only user-authored /
   user-blessed artifacts belong in-tree. Any MCP tool that needs to
   persist runtime state goes through `src/project/stateDir.ts` helpers.

## Common operator commands

```bash
vcf version                   # pinned version + MCP spec
vcf verify                    # check config, endpoints, hooks
vcf health                    # ping configured endpoints
vcf adopt <path>              # register an existing dir as a VCF project
vcf project list              # all registered projects
vcf project refresh           # re-read state_cache from each project.db
vcf lifecycle-report          # emit plans/lifecycle-report.{md,json}
vcf reindex                   # re-scan plans/memory/docs into the artifact index
vcf install-skills <client>   # drop the skill pack into claude-code/codex/gemini
```

## When debugging

- `sqlite3 ~/.vcf/vcf.db "SELECT tool, result_code, ts FROM audit ORDER BY ts DESC LIMIT 20"` —
  recent tool calls across every project.
- `sqlite3 ~/.vcf/projects/<slug>/project.db "SELECT name, state FROM project"` —
  is the project row what I expect?
- `vcf verify` — catches config/endpoint/hook drift.
- Every error carries a stable `E_*` code; `errors.ts` is the catalog.
