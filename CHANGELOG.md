# Changelog

All notable changes to `@kaelith-labs/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). MCP spec compatibility and SDK version pin are called out per release.

## Unreleased

### Changed (breaking — 0.7 scope)

- **Lessons + feedback are now global-only (#41).** Both improvement-cycle
  channels live in one store at the resolved `config.lessons.global_db_path`
  (default `~/.vcf/lessons.db`) tagged with `project_root`. The per-project
  `lessons` and `feedback` tables are dropped by project-DB migration v8.
  - `lesson_search` renamed its filter arg: `scope` (`project | global | all`)
    is now `filter` (`current | universal | all`). `current` scopes to this
    project, `universal` returns rows marked `scope='universal'`, `all` returns
    everything.
  - `feedback_list` gained a `filter` arg (`current | all`) with the same
    semantics.
  - Removed config knobs: `config.lessons.mirror_policy` (no mirror → no
    policy), `config.lessons.default_scope` (redundant with explicit arg).
    `global_db_path: null` still disables the store entirely (E_SCOPE_DENIED
    on every lesson/feedback tool).
  - Removed CLI: `vcf lessons reconcile` (obsolete — single store).
  - Migration path: `openProjectDb` runs a one-shot drain (`src/db/drain.ts`)
    BEFORE v8 executes. Any surviving per-project rows are copied to the
    global store with idempotent `INSERT OR IGNORE` keyed on
    `(project_root, title, created_at)` / `(project_root, note, created_at)`.
    No data loss on upgrade.
  - Rationale: improvement-cycle data is about how the operator works, not
    about one specific project. Cross-project retrospectives and
    self-improvement passes should read the full corpus without having to
    walk N project DBs.
- `lifecycle_report`'s lessons section reads from the global store filtered
  by `project_root`. When the store is disabled, the section reports zero
  rows rather than failing.

### Removed

- `src/cli/lessons.ts`, `src/project/lessonsReconcile.ts` — obsolete.
- `test/integration/lessons_reconcile.test.ts`,
  `test/integration/lesson_mirror_disabled.test.ts`,
  `test/integration/lesson_mirror_policy.test.ts` — obsolete.

### Added

- **Test-surface tools (#12, #13, #14).** Three new MCP tools shipped
  together under the test-lifecycle surface:
  - **`test_add_missing_case` (#12):** LLM-driven. Given the current plan +
    manifest + existing test files, returns a scaffolding prompt that walks
    the calling LLM through identifying test cases the manifest promises
    but the tests don't cover. Prompts for `test_for_lesson: <slug>`
    frontmatter when the case came from a lesson_log entry — closes the
    loop from "we learned X" to "X is guarded in CI."
  - **`conformance_check` (#13):** deterministic. Reads the plan's
    manifest + decisions and asserts reality matches — flags manifest
    files that don't exist (blocker), decisions marked accepted but
    superseded with a dangling reference (warning), and optionally
    empty files (info). No LLM; fast enough for pre-commit.
  - **`vibe_check` (#14):** deterministic. Regex sweep for vibe-coding
    anti-patterns: bare TODO/HACK/FIXME without ticket references,
    `.catch(() => {})`, `as any`, `@ts-ignore`, empty catch blocks,
    `await` inside `.forEach()`. Pure regex + file-walk; no LLM. Six
    default rules, scopable via the `rules` arg. Integration tests
    cover all three tools end-to-end.
- **SEA (single executable applications) build infrastructure (#8).** New
  `sea-config.json` + `scripts/build-sea.mjs` + `npm run build:sea` produce
  a standalone per-platform binary (`vcf-cli-<os>-<arch>[.exe]`) with the
  CLI + a Node runtime bundled. Release workflow gains a `sea-binaries`
  matrix job that builds across linux/darwin/windows × x64/arm64 and
  uploads the binaries as GitHub release assets. A new `src/sea-entry.ts`
  is the SEA `main` — imports `src/cli.ts` and calls `parseArgv` directly,
  bypassing the `import.meta.url` check that doesn't resolve in a SEA
  bundle. `postject` added as a devDependency for the blob-injection step.
  Build infrastructure complete; the runtime `process.argv` startup path
  inside a SEA binary still has a known startup-error edge case that
  needs further iteration on cli.ts's entry guard (tracked as TODO in
  the script; the pipeline itself is green).
- **Model matrix review harness (#33).** `scripts/stress/review-matrix/run.mjs`
  generalizes the dual-model dogfood script to N models. Runs the 27-stage
  review (3 types × 9 stages) against every configured `(endpoint, model)`
  tuple, writes per-stage matrix rows (md + json), clusters verdicts, flags
  outliers, and fingerprints findings as sorted `<severity>@<file>:<line>`
  tuples so agreement clusters surface even when verbatim prose differs.
  Configurable via env vars: `VCF_MATRIX_DIFF_REF`, `VCF_MATRIX_TYPES`,
  `VCF_MATRIX_STAGES`.
- **project_init_existing `strict` + `reconstruct` adoption modes (#20).**
  `bypass` (default) stays unchanged. `strict` refuses to adopt unless the
  project already has a spec, a plan, and a manifest — the registry stays
  untouched when validation fails, so a strict run is safe to retry.
  `reconstruct` adopts the project in state `draft` and returns a
  scaffolding prompt (in `content.reconstruct_prompt`) that the calling
  LLM uses to infer a *backwards-facing* spec from README + source +
  git log, then call `spec_template` + `spec_save`. Planning for future
  changes is forward-facing and happens separately after reconstruct —
  no plan is created at adoption time.
- **Review-step self-learning wiring (#19).** Reviewer overlays (`reviewer-code.md`,
  `reviewer-security.md`, `reviewer-production.md` in vcf-kb) now document when
  to call `lesson_log_add({stage: "reviewing", scope: "universal", ...})`
  during a review pass — patterns that would generalize across projects, not
  one-off findings. Carry-forward entries gain a `carried_count` field that
  bumps by 1 each time `mergeCarryForward` carries an unresolved entry through
  another stage; reviewers treat `carried_count ≥ 3` on a warning/blocker as
  a drift signal and log it with `tags: ["carry-forward-drift"]`. Back-compat:
  old YAML without the field parses as `carried_count: 0`.

---

## [0.6.2] — 2026-04-23

Clarifies the project-tree vs server-state boundary and makes every
project-tree output location configurable.

### Added

- **`config.outputs.*` (new block)** — one configurable location per
  artifact kind the MCP server writes into a project. Defaults preserve
  the pre-0.6.2 layout (`plans/`, `plans/decisions/`, `plans/reviews/`,
  `plans/reviews/response-log.md`, `plans/lifecycle-report.md/.json`,
  `memory/daily-logs/`, `docs/`, `skills/`, `backups/`, all relative to
  the registered `project_root`). Absolute paths override per-kind for
  e.g. a company-wide decision log on shared storage. New helper
  `src/util/outputs.ts:resolveOutputs(projectRoot, config)` is the single
  contact surface every writer goes through.
- **Operator config** — `~/.vcf/config.yaml` gets a documented
  `outputs:` block via `vcf init` seed template. Existing installs
  continue to work with defaults without editing the file.

### Changed

- **Every tool that writes project-tree output now reads from
  `config.outputs`** — `plan_save`, `plan_get`, `plan_context`,
  `build_context`, `decision_log_add`, `response_log_add`,
  `review_submit` + `review_execute` (via `persistReviewSubmission`),
  `lifecycle_report`, `project_init` scaffold. No hardcoded `plans/` /
  `plans/reviews/` strings remain in the write paths.
- **`persistReviewSubmission` signature** — takes `reviewsDir: string`
  instead of `projectRoot: string`. Callers look up via `resolveOutputs`.
  Internal contract; no external surface change.

### Fixed

- **Project evidence stranded in `vcf-cli/`** (separate commit on top).
  After the 0.5.0 parent-adoption, review reports + response-log + plan
  docs + specs from the earlier subdir-adoption era sat at
  `vcf-cli/plans/` instead of the project root. Relocated to the
  registered `project_root`; the `vcf-cli/` component no longer carries
  project-output files.

---

## [0.6.1] — 2026-04-23

Followup backlog sweep — a batch of correctness, refactor, and light-feature
work across 14 items (11 full + 3 partial) from
`plans/2026-04-20-followups.md`. Additive only; no breaking changes.

### Added

- **`review.diff_exclude` config + defaults (followup #38, partial).**
  `review_prepare` now forwards each pathspec as `:(exclude)<pattern>`
  to `git diff`, dropping lockfiles / `dist/**` / `build/**` /
  `node_modules/**` / minified bundles / sourcemaps from the scoped
  diff. Single biggest reviewer-prompt headroom win without touching
  stage files. Operators set `diff_exclude: []` to disable or extend
  per-project. (Options #1 fan-out, #2 stage-file slim, #4 streaming
  carry-forward still open.)
- **`config.lessons.mirror_policy` (followup #41).** New enum
  `write-and-read | write-only | read-only | off`. `write-only` lets a
  project contribute to the cross-project lessons mirror without letting
  cross-scope `lesson_search` reads complete; `read-only` keeps writes
  local but allows cross-scope queries. Default preserves prior behavior.
  Global-only for now — per-project override waits on a per-project
  config merge.
- **`test_runs` cross-project table + `vcf test-trends` CLI (followup
  #17).** Every `test_execute` call now also writes a row into
  `~/.vcf/vcf.db.test_runs` so the operator can ask "how are tests
  trending across my portfolio?" without opening every project.db.
  Summary mode aggregates per-project (total runs, pass-rate, median /
  p95 duration, last-seen); `--format=runs` prints raw rows;
  `--format=json` is machine-readable.
- **`vcf backup` + `vcf restore` CLI (followup #49).** Tarball-based
  snapshot + restore for `~/.vcf/` subsets (`projects` | `global` | `kb`
  | `all`). Shells out to `tar` so no new npm dep is needed. Restore is
  conflict-safe — existing targets are skipped by default; `--replace`
  opts in to overwrite; `--dry-run` reports the plan without writing.
- **`vcf migrate 0.3` CLI (followup #50).** Automates the 0.3 → 0.5
  state-dir refactor documented in the 0.5.0 CHANGELOG: copies an in-tree
  `<project>/.vcf/project.db` to `~/.vcf/projects/<slug>/`, rewrites
  `root_path`, upserts the registry, moves `.review-runs/` out of the
  tree, and (with `--delete-source`) removes the legacy `.vcf/` dir.
  Idempotent; `--all` walks `workspace.allowed_roots` for every in-tree
  marker.
- **`vcf lessons reconcile` CLI (followup #42).** Drains project lessons
  whose `mirror_status != 'mirrored'` into the global mirror DB.
  Idempotent thanks to the new `uniq_global_lessons_identity` unique
  index. Operators use this after a transient mirror outage.
- **`feedback_add` + `feedback_list` MCP tools (followup #18).** One-line
  "sigh, that was annoying" channel distinct from `lesson_log_add`. Note
  + optional stage + optional urgency. Audit row per call; redacts
  before persist.
- **`vcf admin config-history` CLI + `config_boots` global-DB table
  (followup #48).** Every `vcf-mcp` boot captures a sha256 + stat
  snapshot of the resolved config file so an operator can spot a
  post-hoc endpoint-config swap. Emits a one-line stderr note on boot
  when the sha256 changed since the previous boot for the same path.
- **`node:sqlite` ExperimentalWarning suppression (followup #7).** Shebang
  on `dist/cli.js` / `dist/mcp.js` uses `env -S node
  --disable-warning=ExperimentalWarning`. Will self-revert once
  `node:sqlite` hits stability-2 and we bump the Node floor.
- **Extended secret-redaction patterns (followup #47).** GitHub tokens
  (`ghp_`, `gho_`, `ghs_`, `ghr_`, `ghu_`, `github_pat_`), Stripe
  (`sk|rk|pk_live|test_`), Slack (`xox[a-z]-*`, `hooks.slack.com`
  webhook URLs), and Google API keys (`AIza…`). All covered by
  regression tests.

### Changed

- **Registry-based scope lookup canonicalizes through `realpathSync`
  (followup #46).** Closes a latent UX defect on case-insensitive
  filesystems (macOS APFS/HFS+ default, Windows NTFS default) and
  symlinked checkouts — a cwd that realpaths to a registered `root_path`
  now resolves to `project` scope regardless of case / symlink variance.
- **`lesson_search` SQL pushdown (followup #40).** Stage + per-tag LIKE +
  free-text query predicates now evaluate in SQL; the DB returns at most
  `limit × 5` rows newest-first. Reinstates the "p95 < 100ms @ 10k rows"
  claim, guarded by a new perf fixture
  (`test/perf/lesson_search_10k.test.ts`).
- **`review_execute.ts` split (followup #45).** Prompt composition +
  submission parsing moved to `src/review/prompt.ts`; endpoint + model +
  trust-level resolution moved to `src/review/endpointResolve.ts`.
  `review_execute.ts` is now a 262-line orchestrator (was 484 lines).
- **`cli.ts` god-module decomposition (followup #44).** 29 command
  handlers split across 13 per-group modules under `src/cli/`. `cli.ts`
  is now the commander bootstrap + top-level argv router only (2688 →
  599 lines). `src/primers/merge.ts` owns the three-way-merge core that
  backs both `vcf init` seeding and `vcf update-primers`. Test-import
  surface (`mergePrimerTree`, `seedKbIfMissing`,
  `resolveUpstreamKbRoot`) is re-exported from `src/cli.ts` for
  backward-compat.

### Schema

- **Global DB v6: `test_runs` table** — cross-project mirror of every
  `test_execute` call. Indexed on `project_root`, `started_at`,
  `passed` for the trend queries above.
- **Global DB v5: `config_boots` table** — forensic snapshot of config
  path + ctime + mtime + sha256 + prev_sha256 + pid + vcf_version per
  `vcf-mcp` boot.
- **Project DB v6: `lessons.mirror_status` column** (`pending |
  mirrored | failed`, default `mirrored`). Lets `vcf lessons reconcile`
  find rows that still need to land in the global mirror.
- **Project DB v7: `feedback` table** — id, note, optional stage,
  optional urgency, created_at. Backs the new `feedback_add` /
  `feedback_list` MCP tools.
- **Global lessons v2: `uniq_global_lessons_identity` unique index** on
  (project_root, title, created_at) — makes `vcf lessons reconcile`
  safely idempotent via `INSERT OR IGNORE`.

### Fixed

- **Scope case-insensitivity on macOS/Windows** — see Changed #46.
- **Lesson mirror drift is now observable + repairable** — writes that
  fail flip the row's `mirror_status` to `failed`; operators run `vcf
  lessons reconcile` to drain.
- **Reviewer-endpoint gate now unit-tested at the module boundary** —
  `test/review/endpointResolve.test.ts` pins the trust-level + defaults
  + env-var behavior independent of the full MCP surface.

---

## [0.6.0] — 2026-04-23

**Phase F — cross-project admin surfaces + PM (admin) project concept.**
Operator-requested feature set building on the 0.5.0 out-of-tree layout:
move a project's directory, rename it, or re-point its registry
`root_path`, all from a project designated as PM ("admin").

### Added

- **`moveProject` core + `project_move` MCP tool + `vcf project move` CLI** —
  copy or move a registered project's directory to a new path, updating
  the global registry + project.db `root_path` atomically. Copy-then-commit
  pattern rolls back the copy on DB failure. `mode: "copy" | "move"`
  controls post-copy source delete. Target must live inside
  `workspace.allowed_roots`. PM-only MCP tool; CLI works from any project.
- **`renameProject` core + `project_rename` MCP tool + `vcf project rename` CLI** —
  change a project's display name. The slug derived from the new name
  keys the state-dir under `~/.vcf/projects/`, so this also renames the
  state-dir (atomic, with rollback on DB failure). `root_path` is NOT
  touched. PM-only MCP tool.
- **`relocateProject` core + `project_relocate` MCP tool + `vcf project relocate` CLI** —
  re-point a project's registered `root_path` WITHOUT moving files. For
  the "I cloned into a different folder" case. Closes followup #43.
  PM-only MCP tool.
- **`setProjectRole` registry helper + `project_set_role` MCP tool +
  `vcf project set-role` CLI** — designate a project as `pm` or revert
  to `standard`. PM elevation unlocks the cross-project admin tool
  surface inside that project's MCP sessions. Multiple PMs are allowed.
- **`ResolvedScope.projectRole`** — populated from the global registry at
  scope resolution time. Drives the PM-tool registration gate in
  `src/server.ts`.
- **`E_FILESYSTEM` error code** — surfaced by move/rename when a copy,
  rename, or delete fails. Retryable so clients know a second attempt
  may succeed (transient filesystem errors).

### Schema

- **Global DB migration v4** — `projects.role TEXT NOT NULL DEFAULT
  'standard' CHECK (role IN ('standard', 'pm'))` + index. Purely
  additive; every existing row gets `role='standard'` via the default.
  No operator action required.

### MCP compatibility

- MCP spec `2025-11-25`. `@modelcontextprotocol/sdk ^1.29`. Node `>=22.13`.
- **38 → 42 MCP tools.** New since v0.5.0:
  - `project_set_role` (global scope) — set/revoke PM role.
  - `project_move` (project scope, PM-only) — copy/move a project's directory.
  - `project_rename` (project scope, PM-only) — rename a project + state-dir.
  - `project_relocate` (project scope, PM-only) — re-point `root_path` without
    moving files.

---

## [0.5.0] — 2026-04-23

**Breaking: runtime state moves out of tree.** Per-project SQLite + review-run
scratch no longer live inside project directories; they live under
`~/.vcf/projects/<slug>/`. The project directory stays clean of any
VCF-generated binaries — only artifacts the team would commit (plans/, specs,
review reports under plans/reviews/, CLAUDE.md) go in-tree. Scope is now
auto-detected from the global registry (`~/.vcf/vcf.db`); the `--scope` flag
becomes an optional override. The 0.5 line skips 0.4 to signal the layout
break clearly.

### Breaking changes

- **State-dir moved out of tree.** Pre-0.5.0 layout stored `<project>/.vcf/project.db`
  and `<project>/.review-runs/<run-id>/` inside each project directory. Post-0.5.0,
  both live at `~/.vcf/projects/<slug>/project.db` and
  `~/.vcf/projects/<slug>/review-runs/<run-id>/` respectively. No `.vcf/`
  directory is created in the project anymore. Rationale: (a) git repos should
  not carry MCP-server runtime state; (b) the project root is the directory
  the LLM is launched from (the one with CLAUDE.md), not a subcomponent of it;
  (c) runtime state surviving a fresh clone is a feature, not a regression.
- **Scope is auto-detected.** `vcf-mcp` no longer requires `--scope <global|project>`.
  It walks up from cwd, matches against registered root_paths in `~/.vcf/vcf.db`,
  and chooses project scope if it finds a match, global otherwise. The
  `--scope` flag is still accepted as an explicit override. `vcf init` and
  `project_init` no longer emit a `--scope` arg in generated `.mcp.json`
  files.
- **`vcf project scan` is obsolete.** Without in-tree markers there is
  nothing to scan for. The command now prints an error pointing at
  `vcf adopt <path>` as the replacement. Future releases may remove the
  subcommand entirely.

### Migration from 0.3.2

Upgrading on top of an existing 0.3.x install will NOT silently delete your
state, but auto-detect won't find your project until the state is moved. The
manual migration, per project, is:

```bash
# 1. Backup the old project.db
cp <project>/.vcf/project.db ~/backups/project.db.pre-0.5.$(date +%s)

# 2. Create the new state-dir and copy the DB in. <slug> is kebab-case of the
#    project name (usually matches the name you registered with).
mkdir -p ~/.vcf/projects/<slug>
cp <project>/.vcf/project.db ~/.vcf/projects/<slug>/project.db

# 3. If your project directory is different from what's registered (e.g., the
#    project root is actually the parent of a sub-component), update both the
#    registry and the project.db to the correct path. Otherwise skip this step.
#    Use any SQLite client (sqlite3 CLI, DB Browser, node:sqlite).
#      - In ~/.vcf/vcf.db:         UPDATE projects SET root_path = '<new-path>', name = '<new-slug>' WHERE name = '<old-slug>';
#      - In the copied project.db: UPDATE project  SET root_path = '<new-path>', name = '<new-name>'  WHERE id = 1;

# 4. If you have in-tree .review-runs, move those too:
mv <project>/.review-runs ~/.vcf/projects/<slug>/review-runs  # optional; safe to drop if you don't care about the prior run scratch

# 5. Remove the now-orphaned in-tree state dir.
rm -rf <project>/.vcf
```

An automated `vcf migrate` command is tracked as a followup for 0.6.0.

### Added

- **`src/project/stateDir.ts` helpers** — `projectStateDir(slug, home?)`,
  `projectDbPath(slug, home?)`, `projectRunsDir(slug, home?)`. All three
  honor `VCF_HOME` env var for test isolation (in addition to an explicit
  home parameter). `~` prefix in config stays env-expanded as before.
- **Registry-based scope auto-detect** — `resolveScope({ cwd, globalDb })`
  opens the global registry, walks up from cwd, matches against registered
  `root_path`, returns project scope rooted at the first hit. No in-tree
  marker required. `--scope` flag explicit overrides are still honored.
- **`ServerDeps.homeDir` for test isolation** — tests pass a tmpdir so
  runtime state doesn't leak into the real `~/.vcf/`. Production omits it
  and the state-dir helpers fall back to `VCF_HOME` / `homedir()`.
- **`findProjectForCwd(globalDb, cwd)` util** — shared registry walk-up
  helper used by `resolveScope` and the CLI commands (`vcf reindex`,
  `vcf lifecycle-report`, `vcf verify`). Single source of truth for
  "which project am I in."
- **State-dir bootstrap guard in `vcf-mcp`** — if the registry resolves a
  project but the state-dir DB is missing (e.g., deleted externally),
  the binary now exits 4 with a targeted stderr pointing at `vcf adopt <root>`
  to heal, instead of silently recreating an empty DB.
- **`lifecycle_report` tool + `vcf lifecycle-report` CLI** (phase-2 inward
  loop, followup #27 — Phase C). Structured mode emits a versioned JSON
  (`src/schemas/lifecycle-report.schema.ts`, schema 1.0.0) plus a
  rendered markdown view at `plans/lifecycle-report.{md,json}`; no LLM
  call, deterministic, target under 2s on a 10K-audit-row fixture.
  Narrative mode fans per-section LLM calls to
  `config.defaults.lifecycle_report` (one call per non-project
  section) and appends a `generated_by: { model_id, endpoint }` footer
  plus a pointer to the structured JSON. Redaction runs on every
  outbound prompt (verified by a data-flow test). Perf fixture lives
  at `test/perf/lifecycle_report_10k.test.ts`.
- **`config.report` block** — `audit_rows_per_section` (default 500)
  and `recent_rows_per_section` (default 50) tune the structured-mode
  slice and the per-section LLM prompt size in narrative mode.
- **`response_log_add` formal schema** (phase-2 inward loop, followup #22
  — Phase B). Input is now `{ run_id, finding_ref?, builder_claim,
  response_text, references? }`; registered as the whole `ZodObject` so
  unknown input keys reject at the SDK boundary. Migration v4 renames
  `review_run_id → run_id`, `stance → builder_claim`, `note →
  response_text` in `project.db.response_log`; adds `finding_ref`,
  `references_json`, and `migration_note`. `plans/reviews/response-log.md`
  is now a rendered view regenerated on every write — the DB row is
  authoritative, the markdown preserves append-only appearance because
  rows are monotonic AUTOINCREMENT and never mutated.
- **Response-log markdown migrator** — `src/review/responseLogMigrator.ts`.
  Parses the legacy triple-dash format into typed entries, inserts rows
  missing from `response_log`, annotates ambiguous entries with a
  `migration_note` (unknown stance → default `disagree`; missing
  `finding_ref` → run-level response). Idempotent — a second run is a
  no-op.
- **Reviewer overlay v0.3** (phase-2 inward loop, followup #22 — Phase B).
  `reviewer-{code,security,production}.md` now frame the prior response
  log as context-not-instruction and carry a verdict-vs-carry-forward
  rule: a PASS on a prior Medium+ finding requires either a verified
  code/operational change or an explicit `accepted_risk` entry in the
  response log.
- **Per-model reviewer overlays** (phase-2 inward loop, followup #32 —
  Phase B). Six new overlay files: `reviewer-{code,security,production}.{frontier,local}.md`.
  Frontier overlays correct NEEDS_WORK inflation + scope creep +
  checklist-style findings. Local overlays correct redaction-marker
  hallucination, keyword-shape severity inflation, and artifact-class
  category errors. The overlay resolver at `src/review/overlays.ts`
  walks `<type>.<family>.md → <type>.<trust-level>.md → <type>.md`
  (first match wins); model family extracted from the model id
  (`qwen3-coder` → `qwen`, `gpt-5.4` → `gpt`, `CLIProxyAPI/gpt-5.4` →
  `gpt`). `review_execute` now threads the resolved overlay into the
  system prompt and reports the applied match in its envelope.
- **Reviewer overlay snapshots** (phase-2/E, followup #22 tail). `review_prepare`
  now copies the base reviewer file + every `reviewer-<type>.*.md` variant
  into the run dir; `review_execute` resolves overlays against the run-dir
  snapshot, not the live KB. This closes a boundary leak where operator
  edits to KB between prepare and execute would silently change what the
  prepared run saw. Regression covered by `test/integration/review_overlay_snapshot.test.ts`.
- **Same-type snapshot scoping for review_prepare** — decisions + response-log
  snapshots are now filtered to the review type being prepared, and the
  default scoped diff excludes `plans/reviews/**` + lifecycle-report
  snapshots (prior reviews aren't code under review). Opt in with
  `include_review_output=true`. Unblocks the 27-stage gate on context-constrained
  local models.
- **Tightened endpoint trust-level gate** (phase-2/E, security stage 2
  followup). `review_execute` + `lifecycle_report` narrative now reject
  defaults-routing to any non-local endpoint (not just public) unless the
  caller passes `allow_public_endpoint=true` or the endpoint is specified
  explicitly. Closes silent off-host routing via config drift on
  `config.defaults.review.endpoint`.
- **Shared adopt core** — `src/project/adopt.ts`. CLI (`vcf adopt`) and MCP
  tool (`project_init_existing`) now share a single `adoptProject()` that
  creates the state-dir, opens/creates the project.db, marks `adopted=1`,
  and upserts the registry. Registry-write failures are non-fatal and
  surfaced via `registryWarning` in the envelope. Closes followup #39.
- **`config.kb.tag_vocabulary_strict` flag** (default `false`). Reserved
  for the next phase: when enabled, unknown tags in KB frontmatter will
  fail validation at load time. No enforcement yet — the flag only
  reserves the surface so the future switch is a one-line config edit.
- **`lesson_log_add` + `lesson_search` tools** (phase-2 inward loop,
  followup #11 — Phase A). Project-scope lesson log persisted twice: once
  in the per-project SQLite (new `lessons` table), once mirrored into a
  separate cross-project global DB at `config.lessons.global_db_path`
  (default `~/.vcf/lessons.db`). Lesson text runs through the existing
  redaction pass before either persist, so an `sk-…` key lands as
  `[REDACTED:openai-key]`. `lesson_search` accepts `query` / `tags`
  (AND-filter) / `stage` / `scope` (`project` | `global` | `all` with
  de-dup). SDK-level `.strict()` rejection of unknown input keys — the
  input schema is registered as the whole `ZodObject`, not `.shape`.
- **Cross-project lessons mirror can be disabled.** Setting
  `config.lessons.global_db_path: null` in `config.yaml` disables the
  mirror globally: `lesson_log_add` writes only to the project DB and
  `lesson_search({ scope: "global" | "all" })` returns `E_SCOPE_DENIED`.
  Closes followup #29 / security stage 1 documentation-only warning.
- **`config.lessons` block** — `global_db_path` (optional, `~` expanded
  at resolve time, `null` disables the mirror) + `default_scope`
  (`project` | `universal`). Surfaced via `config_get section=lessons`.
- **`E_UNWRITABLE` error code** — surfaced by `openGlobalLessonsDb` when
  the target directory cannot be created or lacks write permission.
- **Redaction pattern for OpenAI / Anthropic-style keys** — bare
  `sk-[A-Za-z0-9_-]{20,}` now redacts to `[REDACTED:openai-key]` via the
  shared `redact()` pass that already covers AWS keys, JWTs, PEM blocks,
  and `.env`-style assignments.
- **`project_init_existing` tool + `vcf adopt` CLI** (followup #20, bypass
  mode). Adopts a pre-existing project directory into VCF tracking without
  scaffolding AGENTS.md/CLAUDE.md/plans/git-hooks. Creates the state-dir
  project.db with `adopted=1`, registers in the global registry, defaults
  `project.state` to `reviewing` (the typical reason to adopt). Idempotent
  re-adoption preserves existing state + name. `strict` and `reconstruct`
  modes are reserved for future releases.
- **Per-step model/endpoint defaults** (`config.defaults`, followup #28).
  New optional block in `config.yaml` lets operators set default
  endpoint+model per tool (`review`, `lifecycle_report`, `retrospective`,
  `research`, `research_verify`, `stress_test`). `review_execute` now resolves
  endpoint via explicit arg → `defaults.review.endpoint` → E_VALIDATION, and
  resolves model via explicit arg → `defaults.review.model` → legacy
  `model_aliases` fallback. `vcf init` documents the block with a commented
  starter example.
- **`vcf-usage-guide` common skill** (phase-2/D). Ships with `vcf install-skills`
  for every supported client (claude-code / codex / gemini). Ground-truth
  reference for the VCF lifecycle, tool index, error codes, and
  decision/lesson/feedback/response taxonomy — lets a fresh LLM operator
  get productive without reading the full README.

### Fixed

- **Mid-review inline fixes landed during the 0.5.0 gate** (surfaced by the
  27-stage self-review, code stages 4 + 6): (a) `src/mcp.ts` now guards
  `resolved.projectDbPath` with `existsSync` before calling `openProjectDb`,
  so a state-dir deleted externally between registration and boot exits 4
  with a clear stderr pointing at `vcf adopt` rather than silently
  recreating an empty DB; (b) `test/integration/m10.test.ts` swapped POSIX-only
  `spawnSync("mkdir", ["-p", path])` for cross-platform `fs.mkdirSync(path,
  { recursive: true })` so the Windows CI cell is truly exercised.

- **`templatesDir()` resolved to the wrong directory in published installs**
  (followup #31). The hard-coded `../../templates` walk worked in dev (where
  `src/util/templates.ts` lives two levels deep) but missed in production —
  `tsup` bundles everything into a flat `dist/` so the built file is only
  one level from the package root. Every install of 0.3.0–0.3.2 therefore
  saw `spec_template` (and any other template-dependent tool) fail with
  `ENOENT`. Replaced with a walk-up that stops at the first `package.json`
  so both dev and bundled layouts resolve correctly. The 229 existing tests
  didn't catch this because they run against source, never the bundled
  artifact; packaging smokes didn't catch it because they don't call
  `spec_template`. Surfaced by the spec stress harness
  (`scripts/stress/spec/`) on first run. Smoke-test coverage for the tool
  is filed in followup #31 as a regression guard.

- **`ship_release` now transitions `project.state` to `shipped`** on a
  successful release (closes the ship item from followup #25). Portfolio
  queries can finally distinguish shipped projects from projects still in
  `reviewing`. Global registry `state_cache` is mirrored at the same time.
  Transition is gated on `gh` exiting 0 — failed releases leave the state
  unchanged.

### Schema

- **Storage layout (breaking)**: per-project DB and review-run scratch
  relocate from `<project>/.vcf/` to `~/.vcf/projects/<slug>/`. The SQLite
  schema itself is unchanged; only the path on disk is different. No
  down-migration ships — manual move (see Migration section) is the
  supported downgrade recovery path.
- **Project DB migration v5** (phase-2 A): adds `review_type` column to
  the `decisions` table + index for same-type snapshot scoping. Existing
  project.dbs auto-migrate on next open; no operator action required.
- **Project DB migration v4** (phase-2 B): renames response-log columns
  `review_run_id → run_id`, `stance → builder_claim`, `note → response_text`;
  adds `finding_ref`, `references_json`, `migration_note`. Auto-applies on
  next open.
- **Project DB migration v3** (phase-2 A): adds `lessons` table with
  redaction-friendly columns + indexes on `tags_json` and `created_at`.
  Mirrored into `~/.vcf/lessons.db` (same schema) when
  `config.lessons.global_db_path` is set.
- **Project DB migration v2** (0.4 prep): adds `adopted INTEGER NOT NULL
  DEFAULT 0` to the `project` table.
  - **Rollback:** SQLite 3.35+ supports column drops; both column additions
    (v2, v5) and column renames (v4) are reversible with manual DDL if an
    operator downgrades. Plain SQLite files are safe to `cp` when vcf-mcp
    is not running. Forward-only is the norm for a developer CLI.
- **Global DB `state_cache` / `projects.root_path` invariant**: the
  registry's `projects.root_path` is now the source of truth for scope
  auto-detect. Hand-editing this column (e.g., during a project move) is
  supported until `vcf project move` / `vcf project relocate` lands in
  0.6.0.

### Review KB updates (shipped with `@kaelith-labs/kb`)

- **Reviewer overlays bumped to v0.2** (`kb/reviewers/reviewer-{code,security,production}.md`).
  First dual-model dogfood review against vcf-cli surfaced three calibration
  gaps: frontier models defaulted to `NEEDS_WORK` on every stage regardless
  of diff quality; local models interpreted the server's outbound redaction
  markers as committed secrets; production review demanded service-grade
  runbooks/SLOs/on-call rotations for a developer CLI tool. All three
  overlays now carry explicit verdict-calibration rules ("empty findings on
  PASS is correct; do not manufacture nits; severity drives verdict, not
  finding count") and evidence-discipline rules ("redaction markers are not
  committed secrets"; "cite file:line for every finding"). The production
  overlay gains an artifact-class gate so service-grade checks don't run
  against CLI/library/tool projects.

### MCP compatibility

- MCP spec `2025-11-25`. `@modelcontextprotocol/sdk ^1.29`. Node `>=22.13`.
- **34 → 38 MCP tools.** New since v0.3.2:
  - `project_init_existing` (global scope) — adopt a pre-existing repo as a VCF project.
  - `lesson_log_add` (project scope) — write a lesson; dual-writes to the project DB and the global lessons mirror (`~/.vcf/lessons.db`) after redaction. Phase-2 A.
  - `lesson_search` (project scope) — query project/global/all lessons. Phase-2 A. Cross-project reads are intentional; see **Security boundaries** below.
  - `lifecycle_report` (project scope) — structured + narrative project report. Narrative mode routes project metadata outbound to `config.defaults.lifecycle_report`. Phase-2 C.
- **Launch shape**: `vcf-mcp` no longer requires `--scope`. The flag is still
  accepted as an explicit override, but the default is auto-detect via the
  global registry. `vcf init` and `project_init` emit `.mcp.json` args
  without the flag.

### Security boundaries documented for this release

- **Global lessons mirror is cross-project queryable by design.** Any project-scope MCP session that calls `lesson_search({ scope: "global" | "all" })` will read lessons mirrored from every project that has written to `~/.vcf/lessons.db`. The design intent is cross-project learning for a single operator on a single workstation. On shared or multi-tenant machines, operators must either (a) not write lessons from projects under confidentiality constraints, (b) set `config.lessons.global_db_path: null` to disable the mirror, or (c) keep `scope` at its default `"project"` in sessions where cross-project reads are unwanted. A config flag to harden this per-project is tracked as followup #41.
- **`lifecycle_report` narrative mode sends project-derived data outbound.** The same data-classification and trust-level reasoning that applies to `review_execute` applies here: audit activity, review history, response-log entries, decisions, builds, and lesson titles/tags are serialized into the prompt, redacted, and sent to the endpoint named by `config.defaults.lifecycle_report`. Operators must choose an endpoint whose residency/retention terms match the project's data classification. Redaction is not confidentiality.

---

## [0.3.2] — 2026-04-21

**KB auto-seed on `vcf init`.** Closes followup #5: every fresh install now
has a populated `~/.vcf/kb` out of the box, so KB-reading tools return real
content on the first call instead of silently degrading to empty lists.

### Fixed

- **`vcf init` now seeds `~/.vcf/kb` from `@kaelith-labs/kb`.** Previously
  the init command wrote `kb.root: ~/.vcf/kb` into `config.yaml` but never
  created or populated the directory. Every KB-reading tool
  (`spec_suggest_primers`, `build_context`, `plan_context`, `primer_list`,
  `review_prepare`, …) tolerates a missing KB dir by returning an empty
  list, so fresh installs looked healthy while answering every KB query
  with nothing. Init now copies the full primer/best-practice/lens/
  review-system/reviewers/standards tree into place and seeds
  `~/.vcf/kb-ancestors` as the three-way-merge base for future
  `vcf update-primers` runs. Idempotent — skipped if `~/.vcf/kb` already
  exists.

### Changed

- **`@kaelith-labs/kb` promoted from optional peer dependency to regular
  dependency.** Every install path (npm, brew, scoop) now pulls the
  content package so `vcf init` can seed deterministically. Existing
  installs that skipped the optional peer will pick it up on upgrade.
- **Shared KB-path resolver.** `vcf init` and `vcf update-primers` both
  resolve the upstream KB through a single `resolveUpstreamKbRoot()`
  helper using `createRequire` — robust against hoisted/nested npm
  layouts and pnpm store symlinks. Honors a `VCF_KB_SOURCE` env override
  for offline builds and tests.

### MCP compatibility

- MCP spec: `2025-11-25` (unchanged)
- SDK pin: `^1.29` (unchanged)

## [0.3.1] — 2026-04-21

**Hardening pass — real bugs + workaround cleanup.** No public-API changes;
every CLI flag, MCP tool, and config shape is identical to 0.3.0.

### Fixed

- **Audit-on-error invariant across all 28 MCP tools.** Previously only
  `test_execute` wrote an audit row on the sad path. Every other tool's
  fallback `.catch()` was unreachable because `runTool` already swallows
  errors. `E_CANCELED`, `E_STATE_INVALID`, and Zod-validation failures
  now persist to `~/.vcf/vcf.db.audit` so `vcf admin audit` can replay
  a failed session.
- **`upsertProject` TOCTOU race.** Two concurrent registrations on the
  same `root_path` could both miss the SELECT and race to INSERT, with
  the second failing at the UNIQUE constraint. Replaced SELECT-then-
  INSERT with a single atomic `INSERT ... ON CONFLICT DO UPDATE`.
- **SIGKILL escalation timer leak in `test_execute` and `ship_build`.**
  When a child process exited between SIGTERM and the 2s SIGKILL
  escalation, the inner timer's callback stayed pinned to closure state
  until it fired uselessly. Both now clear the escalation handle when
  the process finishes cleanly.
- **`vcf init` now accepts `--telemetry` / `--no-telemetry`** and
  auto-defaults to `false` when stdin is not a TTY. CI pipelines and
  unattended provisioning no longer need a `printf 'n\\n' |` hack.

### Changed

- **`VERSION` constant auto-derived from `package.json`.** Previously
  `src/version.ts` was a hardcoded string that drifted three releases
  behind reality once already. Now uses the ESM JSON import
  (`with { type: "json" }`) so `vcf version` can never lie again.
- **`DatabaseSync` row shapes validated at the data boundary.**
  Replaced `as unknown as T[]` casts in `projectRegistry`, `idea_get`,
  `idea_search`, `spec_get` with a shared Zod-parsing `queryRow` /
  `queryAll` helper in `src/util/db.ts`. A dropped/renamed column now
  throws loudly rather than silently producing `undefined`.
- **Vitest `poolOptions` migrated to the v4 top-level shape**
  (`maxWorkers: 1, isolate: false`). Silences the every-test
  deprecation warning.
- **Shared `src/util/ids.ts`** now owns the filesystem-safe compact-ISO
  timestamp generator. `review_prepare` and `submitCore` both use it;
  the second-resolution pattern in `submitCore` is now ms-resolution
  too, closing the class of "two writes in the same second collided
  on a UNIQUE constraint" bug.

### Documentation

- `docs/STABILITY.md` now documents CLI exit codes — particularly that
  `vcf health` exits `9` (not `1`) when endpoints are unreachable, so
  CI can accept exit 0 OR 9 without eating real crashes.

## [0.3.0] — 2026-04-21

**Drop `alpha` tag.** Four-platform smoke coverage (macOS, Windows ARM64,
Windows x64, Linux) all green on `0.3.0-alpha.0`. No code changes from that
cut — only the prerelease suffix is removed and the `latest` dist-tag will
now advance as releases ship.

### Smoke coverage added in this cut

- `packaging/smoke-tests/smoke-linux.sh` — npm-global install path on Linux,
  mirrors the macOS/Windows scripts (16 checks, runs in ~3s).
- Windows x64 validation via a KVM-hosted Win11 25H2 VM. Closes the
  architecture-gap followup filed alongside the ARM64 smoke: `node:sqlite`
  works identically on x64 Windows, no native compile.

## [0.3.0-alpha.0] — 2026-04-21

**Migrate off `better-sqlite3` to `node:sqlite`.** Eliminates every native-addon
install-path failure class in one change.

### Why

The 2026-04-20 Surface smoke test surfaced a hard block on Windows ARM64 +
Node 24: `better-sqlite3@11.10`'s `prebuild-install` couldn't locate the
matching prebuilt binary despite it existing on GitHub releases. Upstream
research (better-sqlite3 #1463, #655, PR #1446, archived `prebuild-install`
repo) showed this is a known, multi-year-stalled issue — not something a
formula tweak can route around.

Node 22.5 introduced a built-in SQLite module (`node:sqlite`), unflagged
since 22.13, at Stability 1.2 RC since Node 25.7. Migrating gives us:
- Zero native compile — no `prebuild-install`, no `node-gyp`, no MSVC
  dependency on Windows, no Xcode on macOS
- Works identically on every platform Node runs on: Windows x64, Windows
  ARM64, macOS Intel, macOS ARM, Linux glibc, Linux musl
- Smaller install footprint
- No peer dependency on `@types/better-sqlite3`

### Changed

- **Dependency:** removed `better-sqlite3` (and `@types/better-sqlite3`
  devDep). No runtime additions — `node:sqlite` ships with Node itself.
- **`engines.node`:** bumped `>=20` → `>=22.13`. Node 22 is active LTS
  through October 2027.
- **CI matrix:** dropped Node 20, kept 22 and added 24. Matrix stays
  Ubuntu + macOS + Windows.
- **DB layer** (`src/db/global.ts`, `src/db/project.ts`, `src/db/migrate.ts`):
  - `new Database(path, opts)` → `new DatabaseSync(path, opts)`
  - `opts.readonly` → `opts.readOnly` (API naming)
  - `db.pragma("journal_mode = WAL")` → `db.exec("PRAGMA journal_mode = WAL")`
  - `db.transaction(fn)` → explicit `BEGIN / COMMIT / ROLLBACK` in migrate.ts
    (node:sqlite has no wrapper helper; the migration path's one usage was
    trivial to convert)
  - Foreign keys on by default now (node:sqlite default) — kept the
    explicit `PRAGMA foreign_keys = ON` anyway so the contract is clear.
- **Type imports:** every `Database as DatabaseType from "better-sqlite3"`
  rewritten to `DatabaseSync as DatabaseType from "node:sqlite"`.
  Sites: `src/server.ts`, `src/review/submitCore.ts`, `src/util/audit.ts`,
  `src/util/projectRegistry.ts`, `test/helpers/db-cleanup.ts`.
- **Stmt return-type casts:** `node:sqlite`'s typed return is
  `Record<string, SQLOutputValue>`, stricter than better-sqlite3's generic.
  Added `as unknown as RowType[]` where needed at known-safe call sites
  (idea_search, spec_get, idea_get, projectRegistry.listProjects).

### Build infrastructure

- **tsup:** esbuild strips the `node:` protocol prefix on built-ins when
  bundling for Node. For `node:sqlite` that breaks runtime (no bare
  `sqlite` alias exists in Node's builtin map). Added a post-build
  `onSuccess` hook that rewrites `from 'sqlite'` back to
  `from "node:sqlite"` across `dist/*.js`.
- **vitest:** bumped to ^4.1.4 (from ^2.1.9). Vite 5 + vitest 2 didn't
  handle `node:sqlite` resolution because the module predates their
  built-in map. Vitest 4 / Vite 6 resolves it correctly.
- **tsup target:** `node20` → `node22` to match the new engines floor.

### Known followups (not blocking 0.3.0)

- `node:sqlite` still emits `ExperimentalWarning` on Node 22/24. Stability-2
  lands in Node 25.7 (April 2027 LTS). Cosmetic — doesn't affect the MCP
  stdio protocol. Filed as followup 7.
- Windows x64 VM smoke not yet run — only Windows ARM64 was tested this
  pass. Filed as followup 6.

## [0.2.1-alpha.0] — 2026-04-20

Three install-path bugs found during the first real Homebrew smoke run on
macOS 26.3.1, all blocking `vcf` from doing anything when installed via
`brew install` or any other symlink-based install path.

### Fixed

- **CLI entrypoint guard fails on symlink invocation.** `src/cli.ts`
  compared `import.meta.url` against `pathToFileURL(process.argv[1]).href`
  to decide whether to run `parseAsync`. Homebrew, Scoop, and npm all
  install the `vcf` binary as a symlink into a versioned Cellar / shim
  directory, so argv[1] was the symlink while import.meta.url was the
  target — the URLs never matched, main never ran, and every invocation
  silently exited 0 with no output. Fix: canonicalize argv[1] via
  `fs.realpathSync` before the comparison. Regression test in
  `test/integration/cli-symlink-entrypoint.test.ts` spawns the built
  `dist/cli.js` via a real symlink and asserts version output reaches
  stdout.
- **`vcf version` wrote to stderr and used the wrong prefix.** Output is
  now on stdout (so shell pipelines and smoke tests can grep it) and
  formatted as `vcf-cli <version> (MCP spec <spec>)` to match the brew
  formula's `test do` block, the Scoop package name, and the install-path
  smoke scripts.
- **`src/version.ts` was stale at 0.0.2-alpha.0** — the M0 stub comment
  promised a build-time pipeline that never landed. Synced manually to
  0.2.1-alpha.0; a proper build-time auto-sync is filed in
  `plans/2026-04-20-followups.md` item 4.

### Pipeline

- Homebrew tap formula was also updated to use `std_npm_args(prefix:)` —
  Homebrew dropped `Language::Node.std_npm_install_args` in a recent
  release, causing `brew install vcf-cli` to fail with `NameError:
  uninitialized constant Language::Node`. Change lives in
  `Kaelith-Labs/homebrew-vcf`.

## [0.2.0-alpha.0] — 2026-04-20

Phase-3 feature wave. Cross-project visibility, third-party KB
extensibility, scheduled-automation surface, Windows reliability fix.

### Added

- **Cross-project dependency graph** (Phase 3):
  - New global DB table `projects` (migration v3) tracks name +
    root_path + state_cache + depends_on + timestamps. Opt-in —
    `project_init` auto-registers unless `register: false` is passed.
  - New MCP tools: **`project_list`** (all registered projects) and
    **`portfolio_graph`** (projects + active blockers + unblocked-
    if-ships reverse map, derived from each plan's `depends_on:`
    frontmatter).
  - New CLI: `vcf project register/list/scan/unregister/refresh`.
    `scan` bulk-discovers `.vcf/project.db` dirs under a root.
  - State stays current automatically: `plan_save` + `review_prepare`
    mirror the new state into the registry; every project-scope tool
    call bumps `last_seen_at` via a hook in `writeAudit`.
  - Plan frontmatter gains optional `depends_on: [slug, …]` (or
    multi-line YAML list form). `plan_save` projects it into the
    registry — no separate indexing step.
  - Purely informational: the graph does not block state transitions;
    `ship_audit` does not consult it.
- **KB plugin protocol** — `config.kb.packs: [{name, root}]` registers
  third-party primer packs. Loader walks each pack's `<root>/kb/` and
  tags entries with `pack=<name>`; IDs are namespaced `@<name>/...` so
  pack content can never shadow main-KB files. `vcf pack add/list/remove`
  manage the registry. `primer_list` surfaces the `pack` field. New
  **`pack_list` MCP tool** (global scope) returns name + root + entry
  count per pack — lets agents discover the extension surface. `vcf
  verify` gained a `kb-packs` section that checks each pack root exists.
- **`vcf health` command** — probes each configured endpoint (HEAD,
  falls back to GET on 405/501) with a 5s default timeout, reports
  reachability. Exits 9 if any endpoint is down. `--format json` for
  automation pipelines.
- **`--format json` on `vcf verify` and `vcf stale-check`** — structured
  output on stdout (not stderr) so reports pipe cleanly into `jq` /
  n8n / cron scripts. `admin audit --format json` was also switched
  from stderr to stdout (latent bug — it was unpipe-able).
- **n8n workflow templates** under `packaging/n8n/workflows/`: weekly
  stale-check, hourly endpoint health, weekly KB-update notification.
  Each is a ready-to-import JSON with a Slack webhook placeholder; see
  `packaging/n8n/README.md` for the import walkthrough and cron
  equivalents for users not running n8n.

### Changed

- **`vcf init` seed config** now writes a commented template including
  `kb.packs: []`, explicit `review:` block, `audit.full_payload_storage`,
  and a commented-out `embeddings:` block. Easier for new users to see
  what knobs exist without reading the schema source.

### Fixed

- **`ship_release`** now enforces `timeout_ms` (default 60s, max 10 min)
  on the `gh` subprocess. Previously the spawn had no timeout, which
  on Linux CI failed fast with auth errors but on Windows Node 22 CI
  hung indefinitely. Real users get the same protection — a hung `gh`
  can't leak the handler forever.

## [0.1.0-alpha.0] — 2026-04-19

Milestone release rolling up the Phase-2 wave: server-side LLM review,
embedding-based primer selection, sub-agent review skill, full Windows
+ macOS CI matrix, and user-defined reviewer categories.

### Added

- **Homebrew tap + Scoop bucket** — install paths beyond npm:
  - `brew tap kaelith-labs/vcf && brew install vcf-cli` (formula in
    [Kaelith-Labs/homebrew-vcf](https://github.com/Kaelith-Labs/homebrew-vcf))
  - `scoop bucket add kaelith-labs https://github.com/Kaelith-Labs/scoop-vcf && scoop install vcf-cli`
    (manifest in [Kaelith-Labs/scoop-vcf](https://github.com/Kaelith-Labs/scoop-vcf))
  Both pin the current alpha tarball for reproducibility. Scoop
  auto-updates via `checkver` on the npm `alpha` dist-tag; Homebrew is
  manual until we cut 1.0.
- **Full-audit mode** (`config.audit.full_payload_storage`, default
  `false`) — when enabled, audit rows also store the *redacted* JSON of
  each tool call's inputs and outputs in two new nullable columns
  (`inputs_json`, `outputs_json`). The same redaction pass that runs
  before hashing runs before storage, so secrets don't leak; the risk
  delta vs. hash-only is that the shape of the payload is visible.
  `vcf admin audit --full` surfaces these columns in table / json / csv
  output. Migration v2 adds the columns non-destructively.
- **Custom reviewer categories** — `review.categories` in `config.yaml`
  is now fully honored at runtime. Add `"accessibility"` (or any slug)
  to the list, drop a stage file under
  `kb/review-system/accessibility/0N-*.md` with matching `review_type:`
  frontmatter, and `review_prepare`/`review_history` accept it end-to-end.
  Unknown types are rejected with `E_VALIDATION` that names the
  configured set so typos surface immediately.
- **Full cross-platform CI matrix** — ubuntu/macos/windows × Node 20/22
  on every push and PR. Re-enabled after resolving two Windows-only
  failure classes: (1) path separator + `realpath` canonicalization
  in tests; (2) SQLite `.db` / `-wal` / `-shm` OS-level locks blocking
  `fs.rm` in `afterEach`. Fixed via an explicit `closeTrackedDbs()`
  helper that tests call at the start of their cleanup, before `rm`.
  Windows cells run in ~70–130s; Linux/macOS in ~25–40s.
- **`review_execute` MCP tool** — server-side review pass against any
  configured OpenAI-compatible endpoint (Ollama `/v1`, OpenRouter, OpenAI
  itself, CLIProxyAPI, LiteLLM, Together, Groq, LM Studio, …). Given a
  `run_id` from `review_prepare` + an endpoint name, the server composes
  the prompt from the disposable workspace, redacts outgoing content,
  calls `/chat/completions`, parses a `{verdict, summary, findings,
  carry_forward}` JSON response, and persists via the shared submit
  core — same path `review_submit` uses.
  - API keys resolve from env at call time (config stores the env-var
    name via `auth_env_var`); rotation needs no server restart.
  - Trust-level gate: `trust_level='public'` endpoints require explicit
    `allow_public_endpoint: true`.
  - Cancellation via MCP SDK signal + `timeout_ms` (default 180s).
  - Audit row records run_id / endpoint / model / outcome only — never
    prompt content, response body, or API key.
- **`/review-execute` skill** in all three packs (claude-code, codex,
  gemini) with endpoint-picking guidance.
- **Shared `src/review/submitCore.ts`** — the render-report + DB-update
  persistence both `review_submit` and `review_execute` call.
- **`src/util/llmClient.ts`** — native-`fetch` OpenAI-compatible client
  with URL-redacted error messages and no raw-body surfacing.

### Changed

- `review_submit` now delegates persistence to `submitCore` (behavior
  unchanged).
- MCP tool count: 28 → 29 (review_execute added).

### Notes

- Native Anthropic / Gemini / OAuth-linked accounts are *not* in this
  tool. The OpenAI-compatible shape covers Ollama + OpenRouter + gateway
  proxies, which is what Phase-2 expected; adapters for native protocols
  are future work.
- The "client sub-agent" path (Claude Code spawning Sonnet, Codex
  spawning a nested model) remains a *client* concern — driven by the
  existing `/review` skill, not `review_execute`.

### Added — embedding-based primer selection

- **Config: optional `embeddings: { endpoint, model, blend_weight?, cache_dir? }`**
  block. `endpoint` references a declared `endpoints[]` entry (schema
  refine fails loud on typo). `blend_weight` ∈ [0,1]: 0 = pure tag
  Jaccard, 1 = pure cosine, default 0.5.
- **`vcf embed-kb` CLI command** — walks primers / best-practices /
  lenses / standards, POSTs each to the configured `/embeddings` surface
  (Ollama + OpenRouter + OpenAI + LiteLLM + Nomic all speak it), writes
  records under `~/.vcf/embeddings/<entry-id>.json`. Idempotent: entries
  whose content SHA matches the cached record are skipped. Exits 8 if
  any failures.
- **Blended `spec_suggest_primers`** — when embeddings are configured
  and the cache is populated, the tool embeds the query live (tag join),
  computes cosine against each cached entry, and blends with the
  normalized tag score. Falls back to tag-only automatically on: no
  config block, empty cache, endpoint unreachable, live embed failure,
  missing vector for a specific entry. Response now includes
  `scoring: "tag" | "blended"` so callers can see which signal won.
- **`callEmbeddings`** added to `src/util/llmClient.ts` — matches the
  OpenAI-compatible `/embeddings` response shape, same URL-redacted
  error handling as `callChatCompletion`.
- Tests: 15 new unit cases for `src/primers/embed.ts` (cosine, blend,
  cache round-trip, build-embedding-input, sha256) + 4 integration
  cases for `spec_suggest_primers` blended scoring (including all three
  fallback branches).
- 178 tests green (was 162).
- **`/review-subagent` skill** (claude-code + codex + gemini) — completes
  the three-path review story: `/review` (parent agent reviews in-context),
  `/review-subagent` (parent spawns a fresh sub-agent that calls MCP
  tools itself, report file lands in the same `plans/reviews/` tree),
  `/review-execute` (server calls a configured HTTP endpoint, no client
  LLM). The skill is client-side prose — the MCP server already supports
  all three via the existing `review_prepare` + `review_submit` pair.
  The sub-agent prompt optionally pulls `plans/<plan-name>-manifest.md`
  when available (not an error if missing), then drives the disposable
  workspace end-to-end on its own.
- `/review` skill gains a "Variants" section listing all three paths.

## [0.0.2-alpha.0] — 2026-04-19

### Added

- **Codex CLI skill pack** (15 skills) + `vcf install-skills codex` —
  installs into `~/.agents/skills/` (Codex's user-scope skills location per
  [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)).
  Same SKILL.md format as the Claude Code pack (open agent-skills standard);
  only the invocation hint differs (`$capture-idea` vs `/capture-idea`).
- **Gemini CLI skill pack** (15 commands) + `vcf install-skills gemini` —
  installs into `~/.gemini/commands/` as flat `<name>.toml` custom
  slash-commands per
  [geminicli.com/docs/cli/custom-commands](https://geminicli.com/docs/cli/custom-commands/).
  Each command exposes a `description` for `/help` and a `prompt` that
  instructs Gemini to call the matching MCP tool.
- **`test_generate` per-dependency matrix.** The tool now fans fannable
  kinds (`db`, `prompt-injection`, `rate-limit`, `volume`) across a
  `dependencies: string[]` input so the returned stubs name concrete
  pitfalls for postgres / redis / mysql / sqlite / mongodb / dynamodb,
  openai / anthropic / gemini / ollama, stripe / sendgrid / github,
  http / websocket / grpc / db-pool / queue. Non-fannable kinds (`unit`,
  `integration`, `regression`) remain single-stub. The spec-required 10×
  scale-target math still drives the volume stubs.
- **`vcf update-primers` three-way merge.** The MVP warn+skip path is
  replaced with a real three-way merge using `git merge-file` and an
  ancestor cache at `~/.vcf/kb-ancestors/`. Outcomes per file:
  `added` / `in-sync` / `local-only` (upstream unchanged since last sync,
  keep edits) / `fast-forward` (local unchanged since last sync, adopt
  upstream) / `auto-merged` (both moved, different regions) / `conflict`
  (both moved, same region — markers written in place; no ancestor at
  all — `.upstream` sibling written). Exits 7 when any conflict remains.
  The spec's allowed MVP warn+skip behavior is now strictly better
  without changing the invocation surface.

### Changed

- `vcf install-skills` now accepts `claude-code`, `codex`, and `gemini`
  (two nested-markdown layouts + one flat-TOML layout); unknown clients
  exit with a supported-list error.
- `test_generate` input: **`dependency: string?` → `dependencies: string[]`**
  (max 32, kebab-case). Stubs now include a `dependency` field on each
  entry so callers can route files by concrete tech rather than just kind.
  Unknown deps fall through to the kind's generic template.

## [0.0.1-alpha.0] — 2026-04-19

Initial alpha. All 13 milestones of the VCF-MCP MVP plan landed.

### Added

- **Server + CLI** (`@kaelith-labs/cli`) with dual bins (`vcf`, `vcf-mcp`), ESM,
  Node ≥ 20, Apache-2.0.
- **Two-scope MCP surface**: global (idea_capture/search/get,
  spec_template/save/get/suggest_primers, project_init, config_get,
  endpoint_list, model_list, primer_list) + project (portfolio_status,
  plan_*, build_*, decision_log_*, response_log_add, test_*, review_*,
  ship_audit, ship_build).
- **27-stage review subsystem** with carry-forward manifest, stage-entry
  rules, re-run supersession semantics, and disposable run workspaces.
- **Primer tag-matching engine** (deterministic weighted Jaccard) feeding
  `spec_suggest_primers` and `plan_context`.
- **Test pipeline** with stdout/stderr-tail capture, cancellation, timeout.
- **Ship audit**: hardcoded-path / secrets / test-data residue /
  personal-data / config-completeness / stale-security-TODO passes.
- **Ship build**: multi-target packager orchestration.
- **`vcf` maintenance CLI**: init, reindex, verify, register-endpoint,
  stale-check, update-primers, install-skills, admin audit.
- **Claude Code skill pack** (15 skills) + `vcf install-skills claude-code`.
- **Full KB corpus** via `@kaelith-labs/kb` peer dep: 25 primers, 41 best-practices,
  21 lenses, 27 review stages, 3 reviewer configs, 2 standards.
- **Opt-in error reporting** (default off, user-prompted on `vcf init`).
- **Append-only audit** with sha256-of-redacted hashing of every tool
  call's inputs + outputs.

### Pins

- MCP spec: **2025-11-25**
- `@modelcontextprotocol/sdk`: **^1.29**
- Node: **>= 20 LTS**
- Zod: **^4.0**

### Not in this release (Phase 2)

- `ship_release` (plan/confirm via `gh release create`).
- `test_generate` full per-dependency matrix.
- `vcf update-primers` three-way merge UX.
- Codex CLI / Gemini CLI skill packs.
- Local-LLM review backend (Ollama / Gemma / Qwen-coder).
- Brew formula + Scoop manifest.
- Embedding-based primer selection.
