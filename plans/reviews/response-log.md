# Response Log (append-only)

> Reviewers read this before every pass.

---
review_run_id: code-4-20260422T002950762Z
stance: agree
created_at: 2026-04-22T01:05:37.696Z
---

Fixed in a subsequent commit on the same branch. Both Gemma and GPT-5.4 independently flagged two real issues at code/stage-4: (1) `absRoot.split('/').pop()` is POSIX-only — swapped for `path.basename()`. (2) `runAdopt` wrote to two databases (local project.db then global registry) without a rollback path; wrapped `upsertProject` in try/catch with a non-fatal warning mirroring the MCP tool's existing pattern, so a registry failure no longer silently leaves the operator in an ambiguous state. Both fixes verified against the existing test surface plus a new positive-path ship_release test.

---
---
review_run_id: code-4-20260422T003054802Z
stance: agree
created_at: 2026-04-22T01:05:37.700Z
---

Same issues as the Gemma run at this stage — GPT-5.4 independently caught the POSIX-only split, and also flagged that `runAdopt`'s two-write sequence lacks an atomicity guard. Accepted and fixed as above. Additionally, GPT flagged the missing positive-path test for ship_release's state transition to 'shipped'; that's now in test/integration/ship_release_positive.test.ts using vi.mock at module scope (vi.spyOn hit ESM limits on `node:child_process`).

---
---
review_run_id: security-2-20260422T003707768Z
stance: agree
created_at: 2026-04-22T01:05:37.701Z
---

Legitimate asymmetry flagged: the MCP tool `project_init_existing` calls `assertInsideAllowedRoot`, but the CLI's `runAdopt` did not. That was a parity gap — the CLI now loads config and applies the same check, with a graceful fallback for the pre-init case (no config on disk yet). Note on framing: the CLI is operator-driven so 'path traversal' is a strong word for this — the real issue is the asymmetry with the MCP surface, not an untrusted-input escalation. Reviewer overlay v0.2 now codifies that framing distinction so future security reviews on operator-CLI paths don't over-escalate.

---
---
review_run_id: security-6-20260422T004124768Z
stance: disagree
created_at: 2026-04-22T01:05:37.702Z
---

BLOCK verdict based on a redaction-marker hallucination. `src/util/templates.ts` has `const PACKAGE_ROOT = findPackageRoot(__dirname);` — that's a module-load-time assignment, not a hardcoded secret. The `[REDACTED]` Gemma 'saw' came from this server's outbound redactor pre-processing the prompt (some pattern matched as secret-shaped elsewhere in the diff), NOT a committed secret. Reviewer overlay v0.2 (security) now has an explicit rule: 'Redaction markers are NOT committed secrets — a real secret would appear as a literal value.' Followup: file #36/#37 on redaction marker clarity (distinguish scrubber output from source content via marker format like `[redacted:pattern=<name>]`). No code change required for the alleged issue itself.

---
---
review_run_id: production-1-20260422T004712831Z
stance: disagree
created_at: 2026-04-22T01:05:37.703Z
---

Category error: the production reviewer demanded runbooks, pager routes, and escalation paths for `vcf adopt` and `project_init_existing`. Those artifacts make sense for SERVICES (things that page people at 3am). vcf-cli is a developer CLI tool — the applicable 'runbook' is the README and --help output; the 'owner' is the package maintainer; SLO is not meaningful. Reviewer overlay v0.2 (production) now has a Stage 1 artifact-class gate: service vs CLI/library/tool. Findings demanding service-grade artifacts of non-service artifacts are category errors, not blockers. Backup/restore considerations for the user's .vcf/project.db ARE worth documenting — that's a legitimate kernel — see production-5 and production-8 responses for the partial-agree.

---
---
review_run_id: production-5-20260422T005015224Z
stance: agree
created_at: 2026-04-22T01:05:37.705Z
---

Real finding: migration v2 adds the `adopted` column via ALTER TABLE but the diff has no documented rollback path. SQLite's ALTER TABLE DROP COLUMN is supported (3.35+) but we don't ship a down-migration, and the CHANGELOG's 'no operator action required' note is incomplete for recovery planning. Documenting in CHANGELOG: rolling back a v2 migration requires either (a) running `ALTER TABLE project DROP COLUMN adopted` manually, or (b) restoring project.db from backup. Also noting: vcf-cli is a developer tool so 'production rollback' here means 'how a user undoes a bad upgrade', not 'how ops unwinds a fleet-wide regression'. Severity-calibrate accordingly.

---
---
review_run_id: production-8-20260422T005431483Z
stance: disagree
created_at: 2026-04-22T01:05:37.706Z
---

Partial disagree. GPT flagged 'no DR/backup procedure for project.db and vcf.db' as BLOCK. For a developer CLI tool, that's a category error (see production-1 response) — the artifact class doesn't have a production DR contract. HOWEVER there IS a legitimate kernel: users SHOULD know that `~/.vcf/vcf.db` holds their global registry and `<project>/.vcf/project.db` holds per-project state; both are SQLite files they can back up with `cp`. Adding one paragraph to README under 'Data & Backup' covers this without pretending the tool has a service-grade DR commitment. Not a BLOCK, not even a NEEDS_WORK at the severity the stage file calls out — closer to Low/Info on the security rubric.

---
