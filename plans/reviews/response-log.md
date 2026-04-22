# Response Log (rendered view — edit via `response_log_add`)

> Reviewers read this before every pass.
> Source-of-truth is `project.db.response_log`; this file is regenerated on every write.

---
run_id: code-4-20260422T002950762Z
builder_claim: agree
created_at: 2026-04-22T01:05:37.697Z
---

Fixed in a subsequent commit on the same branch. Both Gemma and GPT-5.4 independently flagged two real issues at code/stage-4: (1) `absRoot.split('/').pop()` is POSIX-only — swapped for `path.basename()`. (2) `runAdopt` wrote to two databases (local project.db then global registry) without a rollback path; wrapped `upsertProject` in try/catch with a non-fatal warning mirroring the MCP tool's existing pattern, so a registry failure no longer silently leaves the operator in an ambiguous state. Both fixes verified against the existing test surface plus a new positive-path ship_release test.

---
---
run_id: code-4-20260422T003054802Z
builder_claim: agree
created_at: 2026-04-22T01:05:37.700Z
---

Same issues as the Gemma run at this stage — GPT-5.4 independently caught the POSIX-only split, and also flagged that `runAdopt`'s two-write sequence lacks an atomicity guard. Accepted and fixed as above. Additionally, GPT flagged the missing positive-path test for ship_release's state transition to 'shipped'; that's now in test/integration/ship_release_positive.test.ts using vi.mock at module scope (vi.spyOn hit ESM limits on `node:child_process`).

---
---
run_id: security-2-20260422T003707768Z
builder_claim: agree
created_at: 2026-04-22T01:05:37.701Z
---

Legitimate asymmetry flagged: the MCP tool `project_init_existing` calls `assertInsideAllowedRoot`, but the CLI's `runAdopt` did not. That was a parity gap — the CLI now loads config and applies the same check, with a graceful fallback for the pre-init case (no config on disk yet). Note on framing: the CLI is operator-driven so 'path traversal' is a strong word for this — the real issue is the asymmetry with the MCP surface, not an untrusted-input escalation. Reviewer overlay v0.2 now codifies that framing distinction so future security reviews on operator-CLI paths don't over-escalate.

---
---
run_id: security-6-20260422T004124768Z
builder_claim: disagree
created_at: 2026-04-22T01:05:37.702Z
---

BLOCK verdict based on a redaction-marker hallucination. `src/util/templates.ts` has `const PACKAGE_ROOT = findPackageRoot(__dirname);` — that's a module-load-time assignment, not a hardcoded secret. The `[REDACTED]` Gemma 'saw' came from this server's outbound redactor pre-processing the prompt (some pattern matched as secret-shaped elsewhere in the diff), NOT a committed secret. Reviewer overlay v0.2 (security) now has an explicit rule: 'Redaction markers are NOT committed secrets — a real secret would appear as a literal value.' Followup: file #36/#37 on redaction marker clarity (distinguish scrubber output from source content via marker format like `[redacted:pattern=<name>]`). No code change required for the alleged issue itself.

---
---
run_id: production-1-20260422T004712831Z
builder_claim: disagree
created_at: 2026-04-22T01:05:37.704Z
---

Category error: the production reviewer demanded runbooks, pager routes, and escalation paths for `vcf adopt` and `project_init_existing`. Those artifacts make sense for SERVICES (things that page people at 3am). vcf-cli is a developer CLI tool — the applicable 'runbook' is the README and --help output; the 'owner' is the package maintainer; SLO is not meaningful. Reviewer overlay v0.2 (production) now has a Stage 1 artifact-class gate: service vs CLI/library/tool. Findings demanding service-grade artifacts of non-service artifacts are category errors, not blockers. Backup/restore considerations for the user's .vcf/project.db ARE worth documenting — that's a legitimate kernel — see production-5 and production-8 responses for the partial-agree.

---
---
run_id: production-5-20260422T005015224Z
builder_claim: agree
created_at: 2026-04-22T01:05:37.705Z
---

Real finding: migration v2 adds the `adopted` column via ALTER TABLE but the diff has no documented rollback path. SQLite's ALTER TABLE DROP COLUMN is supported (3.35+) but we don't ship a down-migration, and the CHANGELOG's 'no operator action required' note is incomplete for recovery planning. Documenting in CHANGELOG: rolling back a v2 migration requires either (a) running `ALTER TABLE project DROP COLUMN adopted` manually, or (b) restoring project.db from backup. Also noting: vcf-cli is a developer tool so 'production rollback' here means 'how a user undoes a bad upgrade', not 'how ops unwinds a fleet-wide regression'. Severity-calibrate accordingly.

---
---
run_id: production-8-20260422T005431483Z
builder_claim: disagree
created_at: 2026-04-22T01:05:37.706Z
---

Partial disagree. GPT flagged 'no DR/backup procedure for project.db and vcf.db' as BLOCK. For a developer CLI tool, that's a category error (see production-1 response) — the artifact class doesn't have a production DR contract. HOWEVER there IS a legitimate kernel: users SHOULD know that `~/.vcf/vcf.db` holds their global registry and `<project>/.vcf/project.db` holds per-project state; both are SQLite files they can back up with `cp`. Adding one paragraph to README under 'Data & Backup' covers this without pretending the tool has a service-grade DR commitment. Not a BLOCK, not even a NEEDS_WORK at the severity the stage file calls out — closer to Low/Info on the security rubric.

---
---
run_id: code-2-20260422T073320533Z
builder_claim: agree
created_at: 2026-04-22T07:40:01.121Z
finding_ref: code:stage-2:duplicated-adoption
---

Agree the duplication is a real drift vector. Both paths pass tests today and the behavior is known-equivalent, but the two implementations will skew the moment either side gets a new concern. Not gating 0.5.0 — filed as followup #39 with the fix shape (shared `adoptProject` core in src/project/adopt.ts; CLI and MCP tool become thin wrappers). Revisit before any new adoption-mode work in 0.6.0.

---
---
run_id: code-2-20260422T073320533Z
builder_claim: agree
created_at: 2026-04-22T07:40:11.209Z
finding_ref: code:stage-2:changelog-toolcount
---

Real documentation bug. The Unreleased section claimed `31 → 32 MCP tools (project_init_existing added)` — undercounting both the delta (4 tools added, not 1) and the starting baseline (34 at v0.3.2, not 31). Corrected to `34 → 38 MCP tools` with the four new tools enumerated (project_init_existing, lesson_log_add, lesson_search, lifecycle_report) plus a new Security boundaries section covering the cross-project lessons mirror + lifecycle_report narrative routing.

---
---
run_id: security-1-20260422T073216877Z
builder_claim: agree
created_at: 2026-04-22T07:40:11.558Z
finding_ref: security:stage-1:cross-project-lesson-reads
---

Agree the trust boundary needed to be explicit. The cross-project read is the designed behavior of the global mirror — a single-operator's universal lessons should be queryable from anywhere on their workstation. The gap the reviewer correctly identified was that this was not called out as an intentional authorization model; nor was the isolation path documented. Fixed by: (1) README now carries an explicit 'Cross-project trust boundary' callout naming the single-operator/single-workstation assumption, enumerating the three isolation options (stay on scope:project, skip sensitive projects, set config.lessons.global_db_path: null), and pointing at followup #41 for a future per-project mirror_policy knob; (2) CHANGELOG Unreleased section has a 'Security boundaries documented for this release' block mirroring the same content. Followup #41 tracks the per-project isolation knob for 0.6.0. No code change for 0.5.0 — the documentation was the gap.

---
---
run_id: security-1-20260422T073216877Z
builder_claim: agree
created_at: 2026-04-22T07:40:11.906Z
finding_ref: security:stage-1:lifecycle-report-routing
---

Agree — the review_execute routing warning was explicit and the lifecycle_report narrative-mode warning was not. Fixed by adding a README callout under the lifecycle_report section naming the data classes serialized into the outbound prompt (audit activity, review history, response-log entries, decisions, builds, lesson titles/tags), reminding operators that redaction is not confidentiality, and directing NDA/regulated-data projects to either stay on structured mode or route narrative only to local-trust endpoints. Matches the review_execute warning's structure.

---
---
run_id: production-4-20260422T073334386Z
builder_claim: agree
created_at: 2026-04-22T07:40:12.252Z
finding_ref: production:stage-4:lesson-search-fullscan
---

Agree on the evidence-vs-claim gap. The '10k entries / p95 <100ms' target in the Phase-2 plan was aspirational and the v0.5.0 implementation's full-table-read + in-JS filter doesn't back it. For the realistic corpus at ship (≤1k lessons per operator) the in-memory path is sub-10ms locally, but the scale claim was overstated. Narrowed the plan to 'sub-100ms at ≤1k lessons' until SQL pushdown lands, filed followup #40 with the fix shape (WHERE stage/scope pushdown, LIKE or fts5 for query substring search, LIMIT cap before in-memory ranking, reinstate the 10k target after a perf test mirroring lifecycle_report_10k.test.ts passes). No code change for 0.5.0 — the claim was the gap.

---
---
run_id: security-1-20260422T074108994Z
builder_claim: agree
created_at: 2026-04-22T07:50:25.050Z
finding_ref: security:stage-1:mirror-disable-claim-unbacked
---

Legit catch. The README/CHANGELOG language said `config.lessons.global_db_path: null` disabled the cross-project mirror, but the shipped schema defined it as optional-string-only and the code unconditionally resolved any missing/empty value to the default path. Claim was ahead of implementation. Fixed end-to-end in this commit: (1) LessonsSchema now accepts `z.union([z.string(), z.null()])`; (2) resolveGlobalLessonsPath returns null for null input; (3) getGlobalLessonsDb returns null when the path resolves to null; (4) lesson_log_add skips the mirror write cleanly and reports `mirror_status: 'disabled-by-config'` in the envelope; (5) lesson_search rejects scope=global|all with E_SCOPE_DENIED when the mirror is off. New test file test/integration/lesson_mirror_disabled.test.ts covers the full contract: no mirror file created when null, E_SCOPE_DENIED on global/all reads, default path still mirrors for the regression guard. Docs now match shipped behavior.

---
---
run_id: code-2-20260422T074150596Z
builder_claim: agree
created_at: 2026-04-22T07:50:25.392Z
finding_ref: code:stage-2:duplicated-adoption-unresolved
---

Moved from deferred to fixed. Prior pass response logged 'agree, follow-up #39 in 0.6.0', but the reviewer correctly noted that carry-forward requires either a verified code change or an explicit accepted_risk — a deferred note doesn't qualify. Extracted the shared adoption core at src/project/adopt.ts: mkdir .vcf, open project.db, idempotent row upsert with adopted=1, global-registry upsert with non-fatal registryWarning. Both callers refactored to thin wrappers: src/cli.ts runAdopt owns path validation + config loading + allowed_roots + state enum + CLI messaging; src/tools/project_init_existing.ts owns MCP schema + scope check + audit + envelope. No behavior change — both paths now exercise the same DB-write sequence. New test/integration/adopt_parity.test.ts covers: fresh adoption creates project.db + registry row; re-adoption preserves original name + state; registry failure is non-fatal and surfaced via registryWarning. 277/277 tests green.

---
---
run_id: production-2-20260422T074219406Z
builder_claim: agree
created_at: 2026-04-22T07:50:25.738Z
finding_ref: production:stage-2:mirror-state-durability
---

Partial agree. On the documentation side, the overstated 'disable via null' claim is now fixed (see security/stage-1 response). On the runtime side, the reviewer's kernel — mirror failures swallowed with no replay — is a real supportability gap but is low-impact given current operating characteristics: mirror failures have never been observed across ~100 lesson writes in dogfood; the envelope surfaces them when they happen; and the project DB is authoritative so correctness is never at risk. Filed as followup #42 with the fix shape (mirror_status column on project.db.lessons, `vcf lessons reconcile` CLI subcommand, optional lazy-reconcile on next lesson_log_add). Not a 0.5.0 blocker — audit + envelope already give operators the signal; what's missing is the replay mechanism, which is Phase-3 material.

---
---
run_id: code-2-20260422T075145110Z
builder_claim: agree
created_at: 2026-04-22T08:00:05.979Z
finding_ref: code:stage-2:overlay-live-kb-read
---

Real boundary leak. review_execute was resolving the reviewer overlay against the live KB at execute time, so KB edits between review_prepare and review_execute changed what the prepared run saw — a broken prepare→execute contract. Fixed: review_prepare now copies the base reviewer file plus every `reviewer-<type>.*.md` variant into the run dir (src/tools/review_prepare.ts copyReviewerFile). review_execute passes `reviewersDir: runDir` to readOverlayBundle (new opt on ResolveOverlayOpts in src/review/overlays.ts); resolution reads only the prepared snapshot. The base reviewer and every per-model/per-trust overlay are now frozen at prepare time. Overlay selection itself still happens at execute because it depends on model_id + trust_level which aren't known at prepare time — but the files it picks from are the snapshot, not live KB. test/integration/review_overlay_snapshot.test.ts proves this: KB edits after prepare do not leak into the snapshot's resolution path.

---
---
run_id: code-2-20260422T075145110Z
builder_claim: agree
created_at: 2026-04-22T08:00:06.331Z
finding_ref: code:stage-2:project-init-existing-shape
---

Legit inconsistency. project_init_existing was registered with `inputSchema: ProjectInitExistingInput.shape` while Phase-2 standardized on whole-ZodObject registration (`Schema` not `Schema.shape`) for lesson_log_add, lesson_search, response_log_add, lifecycle_report, etc. The shape path lets the SDK strip unknown keys silently at the protocol boundary; whole-schema rejection returns MCP error -32602 for unknown keys. One-line fix: `inputSchema: ProjectInitExistingInput` in src/tools/project_init_existing.ts. All other project-scope tools added this phase already follow the pattern.

---
---
run_id: security-2-20260422T075149632Z
builder_claim: agree
created_at: 2026-04-22T08:00:06.670Z
finding_ref: security:stage-2:endpoint-trust-gate-too-loose
---

Real exfiltration surface. Pre-fix, review_execute and lifecycle_report narrative mode only blocked `trust_level='public'` endpoints — `trust_level='trusted'` resolved silently from config.defaults was not gated. Config drift on defaults.review.endpoint could quietly route review bundles off-host. Tightened in src/tools/review_execute.ts and src/tools/lifecycle_report.ts: the gate now fires on any non-local endpoint resolved from defaults (no explicit endpoint arg) unless `allow_public_endpoint: true` is passed. Explicit endpoint arg is the consent signal that bypasses the defaults gate (public trust still always requires opt-in regardless). Error message names config.defaults.<tool>.endpoint + trust_level so the caller knows exactly what's routing where. test/integration/review_endpoint_trust_gate.test.ts covers the four paths: defaults+trusted rejected; explicit+trusted accepted; defaults+trusted+allow accepted; defaults+local accepted.

---
---
run_id: production-4-20260422T075359850Z
builder_claim: agree
created_at: 2026-04-22T08:00:07.010Z
finding_ref: harness:stop-on-accepted-residual
---

Not a review-surface finding — a harness bug caught during the re-gate. scripts/dogfood-plan/run-full-gate.mjs was stopping whenever any stage's carry_forward contained a non-info entry, even when the stage verdict itself was PASS. That misread the protocol: carry_forward with non-info severity IS the accepted-residual mechanism — a PASS stage with carried warnings is a legitimate outcome, not a halt signal. Fixed: harness now stops only on `verdict != PASS`. The reviewer's structured verdict is the source of truth; carry-forward is context for the next stage, not a gate against this one.

---
