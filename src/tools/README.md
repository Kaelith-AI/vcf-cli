# src/tools — MCP tool registry

61 tools registered in `src/server.ts`. Each file exports a single `register*` function. Tools follow the envelope pattern: default response is `{paths, summary}`; pass `expand=true` for content. All inputs are `.strict()` Zod schemas — unknown keys reject at the SDK boundary.

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
| `test_stub_get.ts` | `test_stub_get` | Retrieve a previously generated test stub by slug or path. |
| `test_results_search.ts` | `test_results_search` | Query the cross-project `test_runs` table for historical test results. |
| `test_add_missing_case.ts` | `test_add_missing_case` | LLM-driven. Given plan + manifest + existing test files, returns a scaffolding prompt for identifying uncovered test cases. Prompts for `test_for_lesson:` frontmatter when the case came from a lesson. |
| `test_stress.ts` | `test_stress` | Fuzz at volume. Five input shapes (valid-fuzz, invalid-fuzz, boundary, unicode, path-traversal). `mode=llm-driven` returns a scaffolding prompt; `mode=endpoint` forwards to a configured endpoint. |
| `test_qa.ts` | `test_qa` | Coverage-not-volume. Reads the audit log, assembles a tool-coverage matrix, and flags tools not exercised within `stale_days`. |
| `conformance_check.ts` | `conformance_check` | Deterministic. Asserts manifest files exist and accepted decisions have no dangling supersede references. No LLM. |
| `charter_check.ts` | `charter_check` | Deterministic. Validates that the project's CLAUDE.md / AGENTS.md / TOOLS.md are present and well-formed. No LLM. |
| `vibe_check.ts` | `vibe_check` | Deterministic regex sweep for vibe-coding anti-patterns (bare TODO/HACK/FIXME, `.catch(() => {})`, `as any`, etc.). Six default rules, scopable via `rules` arg. No LLM. |

### Review

| File | Tool | What it does |
|---|---|---|
| `review_prepare.ts` | `review_prepare` | Create a disposable `.review-runs/<run-id>/` workspace under `~/.vcf/projects/<slug>/`. Copies stage file + reviewer overlay snapshots; writes carry-forward seeded from last Stage-0 PASS; optionally writes scoped git diff (excludes lockfiles, `dist/**`, etc. per `review.diff_exclude`). |
| `review_execute.ts` | `review_execute` | Server-side review pass: compose prompt from workspace, call a configured OpenAI-compatible endpoint, parse `{verdict, summary, findings, carry_forward}`, persist via submit core. Trust-level gate: public endpoints require `allow_public_endpoint: true`. `mode=directive` hands `project_root` to the orchestrator's reviewer for full Read access instead of a pre-computed diff. |
| `review_submit.ts` | `review_submit` | Client-side review submission (verdict produced by the MCP client, not the server). Persists via the same submit core as `review_execute`. |
| `review_history.ts` | `review_history` | List review runs for this project, optionally filtered by type or stage. |
| `review_type_apply.ts` | `review_type_apply` | Write stage files and a `reviewer-<name>.md` overlay into `<kb>/review-system/<name>/` and `<kb>/reviewers/`. Does not mutate `config.review.categories`; returns operator instructions for the slug to add. `force=true` overwrites existing files. |

### Cycle status

| File | Tool | What it does |
|---|---|---|
| `cycle_status.ts` | `cycle_status` | Return the current lifecycle state of the project (idea → spec → planning → building → testing → reviewing → shipped) with a next-action hint. Pure DB read. |

### Decisions / responses / lessons / feedback

| File | Tool | What it does |
|---|---|---|
| `decision_log.ts` | `decision_log_add` | Append an ADR-lite decision to `plans/decisions/`. |
| `decision_log.ts` | `decision_log_list` | List decisions, optionally filtered by review type. |
| `response_log.ts` | `response_log_add` | Record a builder response to a review finding. Input: `{run_id, finding_ref?, builder_claim, response_text, references?}`. Persists to DB; regenerates `plans/reviews/response-log.md`. |
| `lesson_log_add.ts` | `lesson_log_add` | Append a structured lesson. Redacts before persist. Writes to the global lessons store at `~/.vcf/lessons.db` tagged with `project_root`. |
| `lesson_search.ts` | `lesson_search` | Query lessons by free-text, tags (AND), stage, filter (`current` \| `universal` \| `all`). SQL pushdown; p95 < 100ms at 10k rows. |
| `feedback.ts` | `feedback_add` | Log a one-line friction note (distinct from a lesson). Optional stage + urgency. |
| `feedback.ts` | `feedback_list` | List feedback entries for this project. |

### Ship

| File | Tool | What it does |
|---|---|---|
| `ship_audit.ts` | `ship_audit` | 7-pass pre-ship audit: hardcoded-path (blocker), secrets/gitleaks (blocker), test-data residue (blocker), config-completeness (blocker), company-standards (deterministic checks from `~/.vcf/kb/standards/company-standards.md`; skipped if absent), personal-data (warning), stale-security-TODOs (warning). |
| `ship_build.ts` | `ship_build` | Orchestrate packagers in sequence (npm publish / goreleaser / electron-builder / pkg / custom). Per-target stdout/stderr tail, cancellation, timeout. |
| `ship_release.ts` | `ship_release` | Wrap `gh release create`; transitions project state to `shipped` on exit 0. |

### Lifecycle / portfolio

| File | Tool | What it does |
|---|---|---|
| `lifecycle_report.ts` | `lifecycle_report` | Project snapshot. Structured mode: deterministic, no LLM call, writes `plans/lifecycle-report.{md,json}`. Narrative mode: fans per-section LLM calls to `config.defaults.lifecycle_report`, appends `generated_by` footer. |
| `portfolio_status.ts` | `portfolio_status` | Return this project's state + last-updated + next-action hint. Pure DB read. |

### Cross-project admin and KB growth (PM scope only)

Registered only when the session's project has `role = 'pm'`.

| File | Tool | What it does |
|---|---|---|
| `project_move.ts` | `project_move` | Copy or move a project's directory; updates registry + `project.db root_path` atomically. |
| `project_rename.ts` | `project_rename` | Rename a project and its state-dir. |
| `project_relocate.ts` | `project_relocate` | Re-point `root_path` without moving files ("I cloned into a different folder"). |
| `review_type_create.ts` | `review_type_create` | Returns a 5-phase scaffolding prompt for creating a new review type end-to-end via subagent dispatch. Calls `review_type_apply` at phase 4. |
| `research_compose.ts` | `research_compose` | Fan out N aspects to a vendor-diverse panel of frontier models. `mode=execute` dispatches through the `research_panel` role; `mode=directive` returns a scaffold prompt for the orchestrator. |
| `research_assemble.ts` | `research_assemble` | Two-step outline-then-fill pattern for composing a KB draft. Includes a kind-aware exemplar pointer so each new draft mirrors a known-good shape. Accepts upstream `phase=compose`. |
| `research_verify.ts` | `research_verify` | Different-model cross-check on an assembled draft; flags weakly-supported and hallucinated claims. Accepts upstream `phase=compose` or `phase=assemble`. |
| `research_resolve.ts` | `research_resolve` | Per-claim re-investigation against primary sources. `mode=execute` dispatches per-claim in parallel; `mode=directive` returns a scaffold prompt. |

### Always-on (both scopes)

`vcf_ping` is registered directly in `src/server.ts` (not via a `register*` function in `src/tools/`). It is available under both scopes and has no side effects — clients use it to verify the server is reachable.

`search_web` registers only when `config.searxng` is set; it wraps a configured SearXNG instance for local-model web search and is available under both scopes.

---

## Error codes

All tools surface stable `E_*` codes on failure. Key codes: `E_VALIDATION`, `E_NOT_FOUND`, `E_STATE_INVALID`, `E_CANCELED`, `E_FILESYSTEM`, `E_UNWRITABLE`, `E_SCOPE_DENIED`. Every tool call writes one audit row to `~/.vcf/vcf.db.audit`, including the sad path.
