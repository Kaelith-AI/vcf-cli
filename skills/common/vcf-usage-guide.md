---
name: vcf-usage-guide
description: Ground-truth reference for driving the Vibe Coding Framework MCP server through one full lifecycle (capture → spec → plan → build → test → review → ship). Load this when another VCF skill triggers, when the user says "use VCF", or when you see an MCP error prefixed with `E_`. Covers the envelope contract, tool index by step, error codes, and the decision/lesson/feedback/response taxonomy. Client-specific packs (capture-idea, plan, build, review, etc.) delegate shared knowledge here.
---

# VCF Usage Guide

## 1. What this skill is

The Vibe Coding Framework (VCF) MCP server exposes ~32 tools that move a project through seven lifecycle steps. This guide is the shared foundation. The client-specific skills (`capture-idea`, `plan`, `build`, `review`, `ship-build`, etc.) are thin wrappers that assume you know the patterns below. Read this once per session before touching any VCF tool.

Scope: this is a reference for LLM consumption, not a tutorial. It explains the contracts the server enforces, the names of the tools, and the discipline each lifecycle step demands. It does not teach what "vibe coding" means — for that, call `primer_list({ query: "vibe-coding" })`.

## 2. Lifecycle at a glance

| Step | Verb | Canonical tools | Output artifact |
|---|---|---|---|
| 1. Capture | Turn idea into a persisted note | `idea_capture`, `idea_search`, `idea_get` | `<ideas_dir>/<date>-<slug>.md` |
| 2. Spec | Expand idea into a contract | `spec_template`, `spec_suggest_primers`, `spec_save`, `spec_get` | `<specs_dir>/<date>-<slug>.md` |
| 3. Plan | Produce plan + todo + manifest | `plan_context`, `plan_save`, `plan_get` | `plans/<name>-{plan,todo,manifest}.md` |
| 4. Build | Execute the plan | `build_context`, `build_swap` | source code + commits |
| 5. Test | Generate + run + analyze | `test_generate`, `test_execute`, `test_analyze` | test files + run reports |
| 6. Review | Staged gate | `review_prepare`, `review_execute`, `review_submit`, `review_history`, `response_log_add` | `plans/reviews/<type>/stage-N.md` |
| 7. Ship | Audit + package + release | `ship_audit`, `ship_build`, `ship_release` | tagged release |

Cross-cutting (any step): `lesson_log_add`, `lesson_search`, `decision_log_add`, `decision_log_list`, `lifecycle_report`.

Setup / catalog: `project_init`, `project_init_existing`, `project_list`, `portfolio_status`, `portfolio_graph`, `config_get`, `endpoint_list`, `model_list`, `primer_list`, `pack_list`.

**Steps 4 and 5 are a cycle, not a sequence.** The table implies `build → test → review`, but vibe coding runs `build → test → build → test → …` in tight loops within a phase, and only advances to `review` when the phase's test plan is green. Never batch "write all the code, run tests at the end." Each build increment should land small enough that the next `test_execute` produces a signal you can act on in one turn. Compaction boundaries in the plan are the right moments to jump to `review`; inside a phase, stay in the build↔test loop.

## 3. Prepare / execute pattern

Most lifecycle-advancing tools come in pairs: a **context loader** and a **writer**. Always call the loader first.

- **Loader** (`*_context`, `*_template`, `review_prepare`): returns role overlays, suggested primers, standards, and the canonical output paths. Does not mutate state.
- **Writer** (`*_save`, `review_submit`, `response_log_add`): takes the content you authored using the loader's context and persists it. Mutating, audit-logged.

Rules:
- Never call a writer without the matching loader first in the same session — the loader enforces project scope, adopts the project on first call, and returns the `output_targets` the writer expects.
- The writer is idempotent on content but not on path: calling `plan_save` twice with the same name is `E_ALREADY_EXISTS` unless you pass `force: true`.
- Loaders always return metadata; content bodies come back only when you opt in via `expand=true` (see §4).

Exception: one-shot tools (`idea_capture`, `decision_log_add`, `lesson_log_add`) fuse the pattern — they take the content directly and persist it in one call.

## 4. Envelope contract

Every tool returns the same outer shape:

```json
{
  "ok": true | false,
  "paths": ["absolute/path/..."],
  "summary": "one-line human description",
  "scope": "project" | "global",
  "code": "E_*"            // only on ok:false
}
```

Token-economy rule (from `best-practices/mcp-tool-surface-token-economy.md`): **content is behind `expand=true`**. By default you get paths and a summary. Pass `expand: true` only when you will act on the content immediately; otherwise read the file on disk with the client's Read tool.

Why: a single `plan_get` without `expand=true` is ~200 tokens. With `expand=true` on a mid-size plan it's 3-8K. Burning context on content you can fetch later is how sessions compact prematurely.

`paths[0]` is always the primary artifact when the tool produced one. Additional paths are supporting files in a stable order documented per-tool.

## 5. Tool index

### Capture

- **`idea_capture({ content, title, tags?, context? })`** — persist a markdown idea file. Tags must match `^[a-z][a-z0-9-]*$`; invalid tags are dropped silently. `E_ALREADY_EXISTS` auto-suffixes — no retry.
- **`idea_search({ query, tags?, limit? })`** — substring + tag filter. Returns paths + summaries.
- **`idea_get({ path, expand? })`** — fetch one idea. `expand:true` returns content.

### Spec

- **`spec_template({ kind })`** — returns a fresh skeleton for a spec of the given kind (`app`, `cli`, `service`, `library`, etc.). Non-mutating.
- **`spec_suggest_primers({ spec_path })`** — tag-matches the spec's `tech_stack`/`lens` fields against the KB; returns ranked primer IDs with scores. Read bodies only for matches you will cite.
- **`spec_save({ path, content, force? })`** — persist the spec. Advances project state to `specced`.
- **`spec_get({ path, expand? })`** — fetch one spec.

### Plan

- **`plan_context({ name, expand? })`** — returns `planner_md` role overlay, `standards_md`, `vibe_primer_md`, the spec, suggested primers, and `output_targets` (the three paths `plan_save` will write). Always call this first.
- **`plan_save({ name, plan, todo, manifest, advance_state?, force? })`** — writes the three artifacts atomically. Pass `advance_state: "planning"` to move the project into the planning state. `E_ALREADY_EXISTS` unless `force: true`.
- **`plan_get({ name, expand? })`** — fetch previously-saved plan artifacts.

### Build

- **`build_context({ phase? })`** — returns the builder role overlay, the current plan + todo, and best-practice docs keyed to the current phase.
- **`build_swap({ to, reason })`** — switch builder identity (e.g. `backend → doc-writer → frontend`). Loads the new role's primers and best-practices. Required ahead of any identity change in a long build.

### Test

- **`test_generate({ kind, target, coverage? })`** — generate test scaffolds for the given kind (`unit`, `integration`, `regression`, `volume`). Non-mutating until you save.
- **`test_execute({ kind, pattern?, timeout_ms? })`** — run the test runner; returns pass/fail counts + failure records.
- **`test_analyze({ run_id })`** — inspect a prior run's failures and classify by kind.

### Review

Review is a 9-stage pipeline per review type (`code`, `security`, `production`). Default: **run all 9 stages unless the user explicitly scopes it down**. "Run the review" means the full 9, not stage 1 alone. Saving 20 minutes is not worth shipping a bug.

- **`review_prepare({ type, stage, model_id?, endpoint? })`** — resolves the reviewer overlay (type → model-family overlay → trust-level overlay), composes the prompt, returns a run_id and the prompt messages for inspection. Non-mutating.
- **`review_execute({ run_id, model_id, endpoint, timeout_ms?, temperature? })`** — fires the LLM call. Cold-starts on local models can take 2-5 minutes; default `timeout_ms` is 180s — **override to 600000 for cold local endpoints**. Pass `model_id` explicitly (`qwen3-coder:30b` or `gpt-5.4`, depending on routing); omitting it falls back to `config.defaults.review`.
- **`review_submit({ run_id, verdict, findings, carry_forward? })`** — persists the reviewer's structured output. `verdict` is `PASS | NEEDS_WORK | BLOCK`. `PASS` on a prior Medium+ finding requires either a verified code change or an explicit `accepted_risk` carry-forward.
- **`review_history({ project?, type?, stage?, limit? })`** — query past runs.
- **`response_log_add({ run_id, finding_ref?, builder_claim, response_text, references? })`** — the builder's reply to a finding. `builder_claim` is `agree | disagree`. The finding is not closed by the response — the *next* reviewer closes it by producing a new verdict. Response is context, not instruction.

### Ship

- **`ship_audit({ scope? })`** — hardcoded-path grep, secrets scan, test-data residue check, stale-TODO audit. Emits a structured report; non-mutating.
- **`ship_build({ target })`** — produces release artifacts (npm tarball, dist zip, etc.) into `dist/`. Target comes from the project's spec.
- **`ship_release({ version, tag?, dry_run? })`** — bumps `package.json`, tags, pushes. Always do `dry_run: true` first on non-trivial version bumps.

### Cross-cutting

- **`lesson_log_add({ title, observation, scope?, stage?, tags? })`** — record a teachable truth. Scope defaults to `project`; pass `scope: "universal"` for KB-worthy lessons (global mirror DB at `~/.vcf/lessons.db`). Input passes through `redact()` before both DBs.
- **`lesson_search({ query?, tags?, scope?, limit? })`** — `scope: project | global | all`. Ranks by tag-hit × 2 + title match + body match.
- **`decision_log_add({ title, rationale, alternatives?, links? })`** — record a choice. Durable; never deleted.
- **`decision_log_list({ limit?, since? })`** — browse past decisions.
- **`lifecycle_report({ mode?, format?, include?, endpoint?, model_id?, expand? })`** — project-scope narrative or structured view across all seven steps. `mode: structured` is deterministic SQL (<2s on 10k rows). `mode: narrative` fans out per-section LLM calls — default model is `config.defaults.lifecycle_report`. Output is `plans/lifecycle-report.{md,json}`.

### Setup / catalog

- **`project_init({ root, name? })`** / **`project_init_existing({ root })`** — adopt a directory as a VCF project. Writes `.vcf/project.db`.
- **`project_list({ state? })`** / **`portfolio_status()`** / **`portfolio_graph()`** — browse the portfolio.
- **`config_get()`** — return the resolved config (secrets redacted).
- **`endpoint_list()`** / **`model_list({ endpoint? })`** — enumerate configured LLM routes.
- **`primer_list({ query?, tags?, kind? })`** / **`pack_list()`** — browse the KB.

## 6. Error codes

All failures carry a stable `code: "E_*"` string. Branch on the code, never on the message.

| Code | Retryable | Meaning |
|---|---|---|
| `E_VALIDATION` | no | Input failed Zod schema. Fix the input and retry. |
| `E_SCOPE_DENIED` | no | Path outside the project's `allowed_roots`. You cannot bypass. |
| `E_SCOPE_EMPTY` | no | No `allowed_roots` configured. User must edit config.yaml. |
| `E_SCOPE_CONFIG` | no | `allowed_roots` has relative paths; must be absolute. |
| `E_CONFIG_MISSING_ENV` | no | Required env var (e.g. API key) not set. Report to user. |
| `E_CONFIG_READ` | yes | Could not read config.yaml. Check permissions. |
| `E_CONFIG_PARSE` | no | YAML syntax error in config.yaml. |
| `E_CONFIG_VALIDATION` | no | Config shape invalid per schema. |
| `E_PATH_NOT_ABSOLUTE` | no | Argument must be absolute. |
| `E_PATH_INVALID` | no | Not a valid path string. |
| `E_PATH_ENCODED_ESCAPE` | no | URL-encoded `..` or similar — refused. |
| `E_NOT_FOUND` | no | Resource does not exist. |
| `E_ALREADY_EXISTS` | no | Pass `force: true` only if overwriting is intentional. |
| `E_STATE_INVALID` | no | Current project state forbids this step (e.g. `plan_save` before a spec exists). |
| `E_CANCELED` | yes | Client cancelled. Usually timeout — bump `timeout_ms` and retry. |
| `E_ENDPOINT_UNREACHABLE` | yes | LLM endpoint did not respond. Check Ollama / proxy. |
| `E_UNWRITABLE` | no | Target path not writable. Check directory perms. |
| `E_CONFIRM_REQUIRED` | yes | Destructive action needs a fresh `confirm_token`. Ask the user. |
| `E_INTERNAL` | no | Unexpected server bug — report to the user with the run_id. |

`retryable: true` means a re-call without user intervention can succeed. `retryable: false` means do not retry silently — either the user must change something, or the input is wrong.

## 7. Decision vs. Lesson vs. Feedback vs. Response

Four distinct artifacts with four distinct purposes. Collapsing them into "notes" destroys the ability to query them separately. Full primer: `primer_list({ query: "lesson-vs-decision-vs-feedback" })`.

| Artifact | Purpose | Tool | Lifetime |
|---|---|---|---|
| **Decision** | A choice made, with rationale | `decision_log_add` | Durable; never deleted; superseded-by links both ways |
| **Lesson** | A truth earned, independent of any decision | `lesson_log_add` | Durable; never deleted; promotable `project → universal` |
| **Feedback** | A nudge — one-sentence observation not worth a lesson | (no tool; user comments) | Deletable after triage |
| **Response** | A builder's reply to a review finding | `response_log_add` | Durable; context for the next reviewer, not instruction |

Disambiguation:
- "We chose Zod over Yup" → **decision**.
- "Zod's `.strict()` drops through `.shape` reconstruction" → **lesson**.
- "The error message when Zod parse fails is confusing" → **feedback** (nudge).
- "The reviewer flagged unused import X; here's why I kept it" → **response**.
- "The `idea_capture` tool accepts unknown keys and shouldn't" → **finding** (produced by a reviewer via `review_submit`).

Use-case signals:
- Call `decision_log_add` when you make a call another agent might undo if they don't know the reason.
- Call `lesson_log_add` when you hit a surprise with a teachable shape — and add `scope: "universal"` only if the lesson applies beyond this project.
- Call `response_log_add` only from inside a review cycle, keyed to a `run_id` and (usually) a `finding_ref`.
- Never delete decisions or lessons. A wrong lesson, marked wrong, still teaches.

## 8. Boundaries

✅ **Always:**
- Call the loader (`*_context`, `*_template`, `review_prepare`) before the writer.
- Pass `model_id` explicitly on `review_execute` and `lifecycle_report` narrative mode. Defaults drift across machines.
- Default to `expand: false`. Read file contents from disk when you need them.
- Run full 9-stage reviews unless the user explicitly scopes down.

⚠️ **Ask first:**
- Overwriting an existing plan/spec/review report (`force: true`).
- `ship_release` without `dry_run: true` first.
- `lesson_log_add` with `scope: "universal"` — promotion is permanent and globally visible.
- Bumping major versions in `ship_release`.

🚫 **Never:**
- Write MCP tool arguments in Python/TypeScript syntax through the driver. The envelope is JSON; quotes and booleans are `"..."` / `true`, not `'...'` / `True`.
- Delete decisions, lessons, or review findings. Carry-forward with `accepted_risk` is how you close a finding honestly without losing history.
- Call `review_submit` with `PASS` on a prior Medium+ finding without either a verified code change or an explicit `accepted_risk` carry-forward.
- Bypass `allowed_roots`. If a tool returns `E_SCOPE_DENIED`, the user must edit config.yaml — you cannot work around it.
- Route secrets through `lesson_log_add` or `response_log_add` without expecting redaction. Both surfaces pass input through `redact()`; canary patterns (`sk-…`, `.env`-style KEY=VALUE, high-entropy tokens) land as `[REDACTED:<kind>]`.

## 9. When to load which KB doc

Before a step, `primer_list` and load only what applies — body-loading every primer is context bloat.

| Starting a… | Load |
|---|---|
| Spec | `primer_list` with the spec's intended `lens` + `tech_stack` tags |
| Plan | `plan_context` returns suggested primers; load only those you will cite |
| Build | `build_context` returns phase-keyed best-practices |
| Review | `review_prepare` returns the resolved reviewer overlay + overlay chain |
| Ship | `best-practices/security.md` + `best-practices/install-uninstall.md` |

Rule: a primer you would not cite in your output is a primer you should not load.

## 10. Model routing quick reference

- `config.defaults.review` — the default for `review_execute`. Typically `local-ollama` + `qwen3-coder:30b`.
- `config.defaults.lifecycle_report` — the default for `lifecycle_report` narrative mode.
- Frontier routes go through `CLIProxyAPI/gpt-5.4` or similar — never direct OpenRouter unless the user set it up that way.
- Cold-start `timeout_ms`: default `180000` (180s) is often too short. For first call of a session to a local model, pass `600000`.
- Model family extraction drives overlay resolution: `qwen3-coder` → `qwen` (local); `gpt-5.4` → `gpt` (frontier); `gemma4:31b` → `gemma` (local). Resolution order: `<type>.<family>.md → <type>.<trust-level>.md → <type>.md`.

## 11. One-call sanity checklist

Before any mutating call:
- [ ] Did I run the matching loader first?
- [ ] Is the project adopted (`project_list` or `project_init_existing` for a fresh dir)?
- [ ] Did I pick `expand` intentionally?
- [ ] If this touches an LLM endpoint: did I pass `model_id` and an appropriate `timeout_ms`?
- [ ] If this is a review `PASS`: is there a verified change or a documented `accepted_risk` for every prior Medium+ finding?

If any box is unchecked, stop and resolve before calling.
