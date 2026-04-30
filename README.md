# @kaelith-labs/cli

The **Vibe Coding Framework MCP** — an LLM-agnostic Model Context Protocol server + `vcf` CLI for the vibe-coding lifecycle: **capture → spec → init → plan → build → test → review → ship**. Same workflow, any MCP client (Claude Code, Codex, or Gemini CLI).

- **Server owns state, files, index, context prep.** Clients own conversation + execution.
- **Token-economy first**: tools default to `{paths, summary}`; `expand=true` gets content.
- **Two scopes**: global (idea / spec / project-init / catalog) and project (full lifecycle).
- **61 MCP tools** across the full lifecycle, including cross-project admin tools (PM role) and the unified research pipeline (PM-only).
- **27-stage review subsystem** with carry-forward manifest, stage-entry rules, disposable workspaces, and per-model calibration overlays.
- **Primer tag-matching** is deterministic (weighted Jaccard), with optional embedding-based blending.
- **Configurable output paths**: all project-tree writes go through `config.outputs.*`; no hardcoded layout.
- **No hardcoded paths, no ambient network, no auto-update.** Everything through `~/.vcf/config.yaml`.

Current version: **0.7.0**.

---

## Install

```bash
# npm (any OS; the primary channel)
npm install -g @kaelith-labs/cli
```

```bash
# Homebrew (macOS / Linux)
brew tap kaelith-labs/vcf
brew install vcf-cli
```

```powershell
# Scoop (Windows)
scoop bucket add kaelith-labs https://github.com/Kaelith-Labs/scoop-vcf
scoop install vcf-cli
```

Requires Node >= 22.13. Two bins land: `vcf` (maintenance CLI) and `vcf-mcp` (stdio MCP server).

## First-run setup

```bash
vcf init
```

This:

- seeds `~/.vcf/config.yaml` (asks y/N for opt-in error reporting, default **off**)
- writes/merges `~/.mcp.json` so every MCP client session launches `vcf-mcp`
  (scope is auto-detected from the global registry at boot — no `--scope`
  flag needed)
- creates `~/.vcf/vcf.db` on first tool call

```bash
vcf install-skills claude-code   # → ~/.claude/skills/<name>/SKILL.md
vcf install-skills codex         # → ~/.agents/skills/<name>/SKILL.md  (also read from project-scope .agents/skills/)
vcf install-skills gemini        # → ~/.gemini/commands/<name>.toml    (also read from project-scope .gemini/commands/)
```

Copies the skill pack (15 lifecycle skills + the `vcf-usage-guide` common skill) into the client's skills/commands directory. Claude Code and Codex use the open agent-skills `SKILL.md` format; Gemini CLI uses `.toml` custom slash-commands. Re-running is idempotent — existing entries are skipped so your edits aren't clobbered.

## Lifecycle walk-through

### 1. Capture an idea (global scope)

In Claude Code:

> _"capture this idea: a primer-scraper that pulls newly-added docs from @kaelith-labs/kb and summarizes the diff as an email digest"_

Claude's `capture-idea` skill fires `idea_capture`. The result is `~/vcf/ideas/YYYY-MM-DD-primer-scraper.md` with tagged frontmatter, indexed in the global DB.

### 2. Spec the idea

> _"spec that"_ — `/spec-idea primer-scraper`

Claude's `spec-idea` skill runs `spec_template(project_name, idea_ref)`, fills the 14-section PM-ready template from conversation + the captured idea, then `spec_save`s it to `~/vcf/specs/YYYY-MM-DD-primer-scraper.md`.

### 3. Initialize the project

> _"/initialize-project \"Primer Scraper\" ~/projects/primer-scraper \<spec-path\>"_

`project_init` scaffolds the dir: AGENTS.md / CLAUDE.md / TOOLS.md / MEMORY.md / README.md / CHANGELOG.md (from templates) + plans/ memory/ docs/ skills/ backups/ subdirs + `.mcp.json` (auto-wiring `vcf-mcp` for the next session — scope is auto-detected when the client launches in the project dir) + `git init` with `post-commit` (daily-log append) and `pre-push` (gitleaks + uncommitted artifact warning) hooks. The project's runtime state (SQLite DB + review-run scratch) lives out of tree at `~/.vcf/projects/<slug>/` — the project directory itself stays clean of VCF-generated files.

#### Adopting an existing project (`vcf adopt`)

If a project already exists on disk (built before VCF, or pulled from a
teammate) and you want to run the review / portfolio surface against it
without re-scaffolding every lifecycle artifact, use `vcf adopt`:

```bash
vcf adopt /path/to/existing-project
vcf adopt /path/to/existing-project --name "Legacy App" --state draft
```

What this does (bypass mode — the only mode shipped today; `strict` /
`reconstruct` are reserved):

- Creates `~/.vcf/projects/<slug>/project.db` with `adopted = 1`,
  defaulting `project.state` to `reviewing` (override with `--state`).
  Nothing is written to the project directory itself.
- Writes a registry entry to `~/.vcf/vcf.db` so `vcf project list` and
  portfolio tools see the project, and so scope auto-detect resolves
  project scope when any MCP client launches inside (or below) the
  registered path.
- Does **not** scaffold AGENTS.md / CLAUDE.md / plans / git hooks.
  Review, audit, and portfolio tools run fine without them; if you
  want the full scaffold run `vcf init` instead.

Key behaviors to know:

- **Idempotent re-adoption.** Running `vcf adopt` a second time on the
  same path updates `adopted = 1` + the updated_at timestamp but
  **preserves the existing `state` and `name`** — safe to re-run after a
  half-finished adoption or if you're unsure whether a path was already
  adopted. `--state` is only honored on a fresh adoption.
- **`allowed_roots` enforcement, with a precise escape hatch.** If
  `~/.vcf/config.yaml` exists, the adopt target must live inside one of
  `workspace.allowed_roots`. If the config is absent (pre-init), adopt
  proceeds without the check — so your very first `vcf adopt` doesn't
  require an earlier `vcf init`. If the config exists but fails to
  load (parse or schema error), adopt **refuses** rather than silently
  skip the safety boundary; fix the config and retry.
- **Global-registry failure is non-fatal + self-healing.** If the
  `~/.vcf/vcf.db` write fails (permission hiccup, disk full, etc.),
  the local `project.db` is still authoritative and a warning is
  printed. Re-running `vcf adopt` heals the registry.

### 4. Plan inside the project

Open a new MCP client session in the project directory. The `.mcp.json` loads `vcf-mcp` automatically, and scope is auto-detected from the registry — launching inside (or below) the registered project root gives project scope, everywhere else gives global scope.

> _"/plan scraper"_

`plan_context` assembles:

- `planner.md` (role overlay + what a good plan must name and forbid)
- `company-standards.md` + `vibe-coding-primer.md`
- **Tag-matched primers** — the engine ranks `@kaelith-labs/kb` entries against the spec's `tech_stack` + `lens` tags (weighted Jaccard; fresher `last_reviewed` wins ties).
- The spec body

Claude writes `plans/scraper-plan.md` / `scraper-todo.md` / `scraper-manifest.md`. `plan_save(advance_state: "planning")` persists and bumps project state.

### 5. Accept the plan → start building

> _"/accept-plan scraper"_ → flips state to `building`.
> _"/build scraper"_ → loops through todo items one at a time.

`build_context` returns `builder.md` + vibe-coding best-practices + the plan files + prior decision log + response log. The builder LLM picks the next unchecked todo, implements, commits (which triggers the `post-commit` hook to append the daily log), and moves on.

Any non-trivial design call → `/log-decision` (ADR-lite at `plans/decisions/YYYY-MM-DD-<slug>.md`).

At phase boundaries the plan named: `/build-swap backend frontend scraper` returns a compaction hint and the frontend best-practice for the fresh session to load.

### 6. Test

> _"/test"_

`test_generate` returns stubs per kind (unit, integration, db, prompt-injection, rate-limit, volume-@-10×-scale, regression). Builder fills them. `test_execute` spawns the runner (pytest, vitest, jest, k6, vegeta, locust) with cancellation + timeout. `test_analyze` detects pytest / vitest / jest / go / cargo / mocha / k6 failure signatures and returns the first N distinct failures.

### 7. Review (27-stage subsystem)

> _"/review code 1"_

`review_prepare` creates a **disposable** `.review-runs/code-1-<ts>/` workspace. It _copies_ (never references) the stage file + reviewer overlay from `@kaelith-labs/kb`, writes a `carry-forward.yaml` seeded from the most recent Stage-0 PASS, snapshots the decision + response logs, and (if `diff_ref` given) writes a scoped git diff.

The reviewer LLM produces `{verdict: PASS|NEEDS_WORK|BLOCK, summary, findings, carry_forward}` → `review_submit`. Report lands at `plans/reviews/code/stage-1-<ts>.md`.

Stage-entry rule: Stage N>1 **requires** Stage N-1 PASS unless `force: true` (audited). Re-running a passed stage creates a new run id and marks the prior row `superseded`.

Builder responds via `/log-response` — disagreements are respected by future reviewers. `response_log_add` takes `{ run_id, finding_ref?, builder_claim, response_text, references? }` and persists to `project.db.response_log`; the rendered markdown view at `plans/reviews/response-log.md` is regenerated on every write so reviewers always see a consistent append-only record.

Each `review_execute` call loads a **per-model calibration overlay** on top of the base reviewer role: the resolver walks `reviewer-<type>.<family>.md → reviewer-<type>.<trust-level>.md → reviewer-<type>.md` and picks the most specific one available. Family overlays (e.g. `reviewer-code.qwen.md`) are opt-in; `.frontier` and `.local` trust-level overlays ship by default and correct the known calibration biases surfaced during dual-model dogfooding (frontier over-flags with padded findings; local hallucinates on redaction markers and keyword shape). The applied overlay shows up in the `review_execute` envelope so you can confirm which calibration was in effect.

### 7.25. Lifecycle report (any phase)

> _"vcf lifecycle-report --project $(pwd)"_ (CLI)
> _"/lifecycle-report structured"_ (MCP tool)

`lifecycle_report` snapshots the project: audit activity, artifact index, review history, decisions, response log, builds, and lessons. Two modes:

- **Structured** (`mode: structured`) — deterministic, no LLM call. Writes `plans/lifecycle-report.md` + `lifecycle-report.json`. Target: under 2s on a 10K-audit-row project (enforced by `test/perf/lifecycle_report_10k.test.ts`). The JSON is a versioned contract (`src/schemas/lifecycle-report.schema.ts`); downstream tools can consume it without re-implementing the assembly.
- **Narrative** (`mode: narrative`) — fan out per-section LLM calls to `config.defaults.lifecycle_report` (one call per non-project section, redacted before send). Output carries a `generated_by: { model_id, endpoint }` footer plus a pointer back to the structured JSON so a reader can cross-check the prose. Target: under 60s on the same dataset.

> **Outbound data-routing warning (narrative mode).** Narrative mode serializes a broad slice of project state into the prompt: audit activity, review history, response-log entries, decisions, builds, and lesson titles/tags. Redaction runs pre-send (same pipeline as `review_execute`), and the endpoint is whatever `config.defaults.lifecycle_report` names — which can be local (Ollama / CLIProxyAPI on trusted local network) or public. Choose an endpoint whose residency and retention terms match the project's data classification. **Redaction is not confidentiality.** For projects under NDA or regulated data handling, either run narrative mode only against a local-trust endpoint or stay on structured mode, which never calls an LLM.

The CLI flags mirror the tool: `--mode structured|narrative`, `--format md|json|both`, `--include <csv>`, `--frontier` (opt into public-trust endpoints for narrative mode).

### 7.5. Log lessons (during or after any phase)

> _"/log-lesson"_

`lesson_log_add` appends a structured lesson. Required: `title`, `observation`. Optional: `context`, `actionable_takeaway`, `scope` (`project` \| `universal`), `stage`, `tags`. Lesson text runs through the same redactor that gates outbound LLM traffic, so a pasted `sk-…` key or `.env`-shaped value lands in the DB as `[REDACTED:openai-key]` / `[REDACTED]`. Every call writes exactly one audit row.

Lessons go to a single global store at `config.lessons.global_db_path` (default `~/.vcf/lessons.db`), tagged with `project_root`. There is no per-project mirror table — the store is the authority. `global_db_path: null` disables it entirely (`E_SCOPE_DENIED` on every lesson/feedback tool).

`lesson_search` accepts `query` (substring), `tags` (AND-filter), `stage`, `filter` (`current` \| `universal` \| `all`), and `limit` (default 20, max 200). `current` scopes to the active project; `universal` returns rows marked `scope='universal'`; `all` returns the full store. Ranking: `tag-hit-count × 2 + title-exact 10 / title-prefix 5 / title-contains 3 / body-contains 1`. `expand=true` attaches observation + context bodies.

> **Cross-project trust boundary.** The global store is a **single-operator, single-workstation** convenience. It is **not** a multi-tenant boundary: if two projects on the same machine must not share lessons (e.g., one is under NDA), set `config.lessons.global_db_path: null` to disable the store entirely, or scope all searches to `filter: "current"` and keep lesson writes limited to that project.

### 8. Ship

> _"/ship-audit"_

7 passes: **hardcoded-path** (blocker), **secrets** (blocker; uses gitleaks if installed), **test-data-residue** (blocker), **config-completeness** (blocker), **company-standards** (deterministic checks declared in `~/.vcf/kb/standards/company-standards.md`; skipped if the file is absent), **personal-data** (warning), **stale-security-TODOs** (warning). `fail_fast: true` halts at the first blocker.

> _"/ship-build"_

`ship_build({ targets })` orchestrates packagers in sequence (npm publish, goreleaser, electron-builder, pkg, custom) — never reinvents them. Per-target stdout/stderr tail, cancellation, timeout. Every target lands in `project.db.builds`.

Final `gh release create` is manual in this MVP (`ship_release` lands as a plan/confirm tool in the next iteration).

## Maintenance (CLI-only)

```bash
vcf reindex                  # re-scan plans/ memory/ docs/ into project.db
vcf verify                   # config + allowed_roots + KB + packs + hooks
vcf verify --format json     # structured output for cron / n8n pipelines
vcf health                   # HEAD each endpoint, exit 9 if any unreachable
vcf register-endpoint \      # append a new LLM endpoint to config.yaml
  --name openai-main \
  --provider openai-compatible \
  --base-url https://api.openai.com/v1 \
  --trust-level public \
  --auth-env-var OPENAI_API_KEY
vcf config upgrade           # add 0.7 fields (endpoint.kind, model_alias.vendor/tags, roles scaffold)
                             #   to an existing config.yaml — idempotent, purely additive
vcf stale-check              # flag KB entries past review.stale_primer_days
vcf update-primers           # pull latest @kaelith-labs/kb (three-way merge)
vcf standards init           # seed ~/.vcf/kb/standards/<kind>.md from shipped .example stubs
vcf pack add --name <slug> --path <abs>   # register a third-party KB pack
vcf pack list                # show registered packs
vcf embed-kb                 # populate embeddings cache (optional)
vcf admin audit --tool idea_capture --format table
vcf admin audit --format json --full     # include redacted inputs/outputs JSON
vcf admin config-history     # forensic log of config file changes per boot
vcf backup <subset>          # snapshot ~/.vcf/ subsets (projects|global|kb|all)
vcf restore <archive>        # restore from a backup tarball (conflict-safe)
vcf migrate 0.3              # automate 0.3.x → 0.5+ state-dir relocation
vcf test-trends              # cross-project test-run summary from global DB
vcf project list             # list registered projects
vcf project move             # copy/move a project directory (PM scope)
vcf project rename           # rename a project + state-dir (PM scope)
vcf project relocate         # re-point root_path without moving files (PM scope)
vcf project set-role         # designate a project as pm or standard
vcf lifecycle-report         # structured or narrative project lifecycle snapshot
```

These are intentionally not MCP tools. Deterministic maintenance that a human or CI runs should be a CLI command, not a tool that burns tokens on every LLM turn.

### Configuring review defaults + provider options

`~/.vcf/config.yaml` accepts two related blocks for routing endpoint-using
tools (`review_execute`, `lifecycle_report`, and the research pipeline tools):

```yaml
# Per-endpoint knobs merged into the outbound request body as `options`.
# Required for Ollama: Ollama silently caps context at 2048 tokens when
# `num_ctx` is unset, regardless of the model's native window. Set high
# enough for your longest review prompt (stage file + reviewer overlay +
# diff + carry-forward).
endpoints:
  - name: local-ollama
    provider: openai-compatible
    base_url: http://127.0.0.1:11434/v1
    trust_level: local
    provider_options:
      num_ctx: 131072      # unlock Gemma / qwen3-coder's full context
      num_predict: 8192    # room for a full structured-verdict response

# Per-tool defaults. Each entry makes `endpoint` + `model` implicit so
# tool calls don't have to re-name them. Resolution order at call time:
#   explicit arg  →  defaults.<tool>  →  legacy (model_aliases for review)
# Missing defaults + missing arg → E_VALIDATION (fail loud, not silent).
defaults:
  review: { endpoint: local-ollama, model: "qwen3-coder:30b" }
```

**Data-routing security note.** `review_execute` sends the full prompt bundle
(stage file + reviewer overlay + scoped diff + decision/response log
snapshots + carry-forward manifest) to whichever endpoint is resolved — via
explicit arg OR the `defaults.review` block above. Set `defaults.review`
pointing at a **`trust_level: local`** endpoint (e.g. your on-host Ollama)
for sensitive/regulated codebases. Endpoints that proxy to a third-party
provider retain your review context per that provider's retention policy
even when declared `trust_level: local` in config; VCF's trust taxonomy
classifies on *reachability* (is the proxy on this host?), not on
*data residency* (does the proxy forward payloads off-host?). When in
doubt, pass `endpoint` + `model_id` explicitly so a config change can't
silently reroute a sensitive review to a new backend.

**Troubleshooting**:

- _"review_execute returned E_VALIDATION: endpoint not provided and
  config.defaults.review.endpoint is unset"_ — either pass `endpoint`
  explicitly to the tool, or add `defaults.review.endpoint` pointing at a
  declared endpoint.
- _Verdicts feel shallow / reviewer keeps saying "I don't see the
  diff"_ — Ollama is probably truncating. Add the `provider_options`
  block above to the Ollama endpoint; a rerun should show much more
  specific findings.
- _Reviews keep going to GPT when you set a local default_ — the tool
  argument wins over the default. Omit the `endpoint` and `model_id`
  args (or set them to match the default) if the caller is pinning them.

### Scheduled automation

Importable n8n workflows for weekly stale-check, hourly endpoint-health, and weekly KB-update notifications live under [`packaging/n8n/`](packaging/n8n/). See its README for setup + cron equivalents if you're not on n8n.

## 0.7 feature surface

### Capability-aware role system

`~/.vcf/config.yaml` gains three new fields at 0.7. All are optional — legacy configs continue to validate without them, and `vcf config upgrade` adds them automatically.

```yaml
endpoints:
  - name: local-claude
    kind: cli              # "api" (HTTP, default) or "cli" (local subprocess: claude/codex/gemini/ollama)
    enabled: true          # set false to disable without removing the entry

model_aliases:
  - alias: frontier-gpt
    model_id: gpt-5.4
    endpoint: openai-main
    vendor: openai         # inferred from model_id prefix by "vcf config upgrade"
    tags: [frontier, code_review, long_context]
                           # capability declarations; drives vendor-diversity enforcement on panels

roles:
  research_panel:          # role name → model_alias + capability requirements
    model_alias: frontier-gpt
    required_tags: [frontier]
  kb_finalize:
    model_alias: local-claude
    required_tags: [local]

searxng:                   # local SearXNG instance for search_web tool
  base_url: http://127.0.0.1:8080
  engines: [google, bing]  # optional engine override
```

Valid `tags`: `frontier`, `local`, `web_search`, `harness`, `code_review`, `long_context`, `vision`.

### Unified research pipeline (PM-only tools)

Five MCP tools, registered only when the project's role is `pm`:

| Tool | What it does |
|---|---|
| `research_compose` | Fan out N aspects to a vendor-diverse panel of frontier models. `mode=execute` dispatches through the `research_panel` role; `mode=directive` returns a scaffold prompt for the orchestrator to fan out itself. |
| `research_assemble` | Closes the gap between compose and verify. Two-step pattern: outline first (think the draft through end-to-end), then fill in the body. Includes a kind-aware exemplar pointer (primer→`primers/coding.md`, best-practice→`best-practices/coding.md`) so each draft mirrors a known-good shape. |
| `research_verify` | Different-model cross-check; flags weakly-supported and hallucinated claims. Accepts upstream `phase=compose` or `phase=assemble`. |
| `research_resolve` | Per-claim re-investigation against primary sources. `mode=execute` dispatches per-claim in parallel; `mode=directive` returns a scaffold prompt. |
| `search_web` | Wraps a configured SearXNG instance for local-model web search. Registers only when `config.searxng` is set; no-op otherwise. Available under both scopes. |

All multi-agent tools support `mode=execute` (server fans out) or `mode=directive` (server returns prompts and paths for the orchestrator to fan out, useful when the orchestrator's harness has its own web-search capability).

### Provenance enforcement

Every LLM-generated artifact (`draft.md`, `verify.json`, `resolutions.json`, `lifecycle-report.md`) carries a `provenance` block: `{ tool, phase, model, endpoint, generated_at }`. Downstream research tools (`research_assemble`, `research_verify`, `research_resolve`) refuse to operate on artifacts that lack a provenance block.

## Pins

| Pin                        | Version                                           |
| -------------------------- | ------------------------------------------------- |
| MCP spec                   | **2025-11-25**                                    |
| `@modelcontextprotocol/sdk` | **^1.29** (v2 is pre-alpha)                      |
| Node                       | **≥ 22.13** (active LTS through Oct 2027)         |
| Zod                        | **^4**                                            |
| Content package            | `@kaelith-labs/kb` dep in range `>=0.0.1-alpha <0.2.0` |

## Non-negotiables (enforced in code, not aspirational)

- `.strict()` Zod inputs; fuzz suite proves every tool rejects every malformed shape with a stable `E_*` code or SDK-level schema error.
- Paths re-validated against `workspace.allowed_roots` after `fs.realpath` (symlink + `..` + URL-encoded + prefix-sibling all rejected).
- Secrets live in env vars; config interpolates `${VAR}` and fails loud with the var _name_ on miss.
- Append-only audit: every tool call emits one row with sha256 of redacted inputs + outputs.
- Disposable review runs; the stage template is never mutated in place.
- Stdout is JSON-RPC only in stdio mode; pino logs to stderr (fd 2). ESLint bans `process.stdout` writes to prevent regressions.

## Known gaps / future work

- `ship_release` plan/confirm step — `gh release create` runs but the plan/confirm wrapper (`confirm_token`) has not landed as a formal tool flow.
- Codex CLI and Gemini CLI native-protocol adapters for `review_execute` (OpenAI-compatible shape covers Ollama / LiteLLM / OpenRouter today).
- `vcf project scan` is obsolete since 0.5.0 and will be removed in a future release; use `vcf adopt <path>` instead.
- Per-project `lessons` opt-out from the global store (`global_db_path: null` disables for the whole operator; per-project granularity is tracked as a followup).

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Links

- Umbrella project: [../README.md](../README.md)
- KB: [github.com/Kaelith-Labs/vcf-kb](https://github.com/Kaelith-Labs/vcf-kb)
- CHANGELOG: [./CHANGELOG.md](./CHANGELOG.md)
