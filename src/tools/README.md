# src/tools — MCP tool registry

42 tools registered in `src/server.ts`. Each file exports a single `register*` function. Tools follow the envelope pattern: default response is `{paths, summary}`; pass `expand=true` for content. All inputs are `.strict()` Zod schemas — unknown keys reject at the SDK boundary.

Scope is auto-detected from the global registry at server boot; no `--scope` flag required.

---

## Global scope tools

Available in any MCP session (project or non-project directory).

### Capture

| File | Tool | What it does |
|---|---|---|
| `idea_capture.ts` | `idea_capture` | Write a timestamped idea markdown file to `workspace.ideas_dir`; index in global DB. |
| `idea_search.ts` | `idea_search` | Full-text + tag search across captured ideas. |
| `idea_get.ts` | `idea_get` | Retrieve a single idea by slug or path. |

### Spec

| File | Tool | What it does |
|---|---|---|
| `spec_template.ts` | `spec_template` | Fill the 14-section PM-ready spec template from idea ref + conversation context. |
| `spec_save.ts` | `spec_save` | Persist a completed spec to `workspace.specs_dir`. |
| `spec_get.ts` | `spec_get` | Retrieve a spec by slug or path. |
| `spec_suggest_primers.ts` | `spec_suggest_primers` | Rank KB primers against the spec's `tech_stack` + `lens` tags (weighted Jaccard; optional cosine blend when embeddings cache is populated). |

### Init / admin (global)

| File | Tool | What it does |
|---|---|---|
| `project_init.ts` | `project_init` | Scaffold a new project directory with AGENTS.md, CLAUDE.md, TOOLS.md, MEMORY.md, README.md, CHANGELOG.md, subdirs, `.mcp.json`, and git hooks. Registers in global registry. |
| `project_init_existing.ts` | `project_init_existing` | Adopt a pre-existing project (bypass mode) — creates state-dir DB with `adopted=1`, registers in registry. Does not scaffold files. |
| `project_set_role.ts` | `project_set_role` | Designate a project as `pm` (unlocks cross-project admin tools) or revert to `standard`. |
| `catalog.ts` | `config_get` | Return the resolved config (section-scoped). Redacts env-var values. |
| `catalog.ts` | `endpoint_list` | List configured LLM endpoints. |
| `catalog.ts` | `primer_list` | List KB primer metadata (tags, pack, last_reviewed). |
| `catalog.ts` | `model_list` | List model aliases from config. |
| `portfolio.ts` | `project_list` | List all registered projects from the global registry. |
| `portfolio.ts` | `portfolio_graph` | Cross-project dependency graph: projects + active blockers + unblocked-if-ships map (derived from `depends_on:` plan frontmatter). |
| `pack_list.ts` (via `catalog.ts`) | `pack_list` | List registered third-party KB packs (name, root, entry count). |

---

## Project scope tools

Available only when the MCP session cwd resolves to a registered project root.

### Plan

| File | Tool | What it does |
|---|---|---|
| `plan_context.ts` | `plan_context` | Assemble plan-time context bundle: planner overlay + tag-matched KB primers + spec body. |
| `plan_save.ts` | `plan_save` | Persist the plan files and advance project state. |
| `plan_get.ts` | `plan_get` | Retrieve the current plan. |

### Build

| File | Tool | What it does |
|---|---|---|
| `build_context.ts` | `build_context` | Assemble build-time context bundle: builder overlay + best-practices + plan files + decision log + response log. |
| `build_swap.ts` | `build_swap` | Emit a phase-boundary compaction hint and the relevant best-practice for the incoming phase session. |

### Test

| File | Tool | What it does |
|---|---|---|
| `test_generate.ts` | `test_generate` | Return test stubs per kind (unit, integration, db, prompt-injection, rate-limit, volume-@-10×-scale, regression) fanned across `dependencies`. |
| `test_execute.ts` | `test_execute` | Spawn test runner (pytest / vitest / jest / k6 / vegeta / locust) with cancellation + timeout. Cross-project row written to `~/.vcf/vcf.db.test_runs`. |
| `test_analyze.ts` | `test_analyze` | Parse runner output (pytest / vitest / jest / go / cargo / mocha / k6) and return the first N distinct failures. |

### Review

| File | Tool | What it does |
|---|---|---|
| `review_prepare.ts` | `review_prepare` | Create a disposable `.review-runs/<run-id>/` workspace under `~/.vcf/projects/<slug>/`. Copies stage file + reviewer overlay snapshots; writes carry-forward seeded from last Stage-0 PASS; optionally writes scoped git diff (excludes lockfiles, `dist/**`, etc. per `review.diff_exclude`). |
| `review_execute.ts` | `review_execute` | Server-side review pass: compose prompt from workspace, call a configured OpenAI-compatible endpoint, parse `{verdict, summary, findings, carry_forward}`, persist via submit core. Trust-level gate: public endpoints require `allow_public_endpoint: true`. |
| `review_submit.ts` | `review_submit` | Client-side review submission (verdict produced by the MCP client, not the server). Persists via the same submit core as `review_execute`. |
| `review_history.ts` | `review_history` | List review runs for this project, optionally filtered by type or stage. |

### Decisions / responses / lessons / feedback

| File | Tool | What it does |
|---|---|---|
| `decision_log.ts` | `decision_log_add` | Append an ADR-lite decision to `plans/decisions/`. |
| `decision_log.ts` | `decision_log_list` | List decisions, optionally filtered by review type. |
| `response_log.ts` | `response_log_add` | Record a builder response to a review finding. Input: `{run_id, finding_ref?, builder_claim, response_text, references?}`. Persists to DB; regenerates `plans/reviews/response-log.md`. |
| `lesson_log_add.ts` | `lesson_log_add` | Append a structured lesson. Redacts before persist. Dual-writes: project DB + global mirror at `~/.vcf/lessons.db`. |
| `lesson_search.ts` | `lesson_search` | Query lessons by free-text, tags (AND), stage, scope (`project` \| `global` \| `all`). SQL pushdown; p95 < 100ms at 10k rows. |
| `feedback.ts` | `feedback_add` | Log a one-line friction note (distinct from a lesson). Optional stage + urgency. |
| `feedback.ts` | `feedback_list` | List feedback entries for this project. |

### Ship

| File | Tool | What it does |
|---|---|---|
| `ship_audit.ts` | `ship_audit` | 6-pass pre-ship audit: hardcoded-path (blocker), secrets/gitleaks (blocker), test-data residue (blocker), config-completeness (blocker), personal-data (warning), stale-security-TODOs (warning). |
| `ship_build.ts` | `ship_build` | Orchestrate packagers in sequence (npm publish / goreleaser / electron-builder / pkg / custom). Per-target stdout/stderr tail, cancellation, timeout. |
| `ship_release.ts` | `ship_release` | Wrap `gh release create`; transitions project state to `shipped` on exit 0. |

### Lifecycle / portfolio

| File | Tool | What it does |
|---|---|---|
| `lifecycle_report.ts` | `lifecycle_report` | Project snapshot. Structured mode: deterministic, no LLM call, writes `plans/lifecycle-report.{md,json}`. Narrative mode: fans per-section LLM calls to `config.defaults.lifecycle_report`, appends `generated_by` footer. |
| `portfolio_status.ts` | `portfolio_status` | Return this project's state + last-updated + next-action hint. Pure DB read. |

### Cross-project admin (PM scope only)

Registered only when the session's project has `role = 'pm'`.

| File | Tool | What it does |
|---|---|---|
| `project_move.ts` | `project_move` | Copy or move a project's directory; updates registry + `project.db root_path` atomically. |
| `project_rename.ts` | `project_rename` | Rename a project and its state-dir. |
| `project_relocate.ts` | `project_relocate` | Re-point `root_path` without moving files ("I cloned into a different folder"). |

---

## Error codes

All tools surface stable `E_*` codes on failure. Key codes: `E_VALIDATION`, `E_NOT_FOUND`, `E_STATE_INVALID`, `E_CANCELED`, `E_FILESYSTEM`, `E_UNWRITABLE`, `E_SCOPE_DENIED`. Every tool call writes one audit row to `~/.vcf/vcf.db.audit`, including the sad path.
