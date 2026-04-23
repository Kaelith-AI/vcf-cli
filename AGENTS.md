# AGENTS.md — Codex / generic agent guide

This file is a compact orientation for any agent (Codex, Gemini, or
generic) opening `@kaelith-labs/cli`. For a fuller operator-facing
reference see `CLAUDE.md` — everything in that file applies verbatim here.

## Fast-path

1. **Install skills:** `vcf install-skills codex` (for Codex) or
   `vcf install-skills gemini`. Read `~/.agents/skills/vcf-usage-guide/SKILL.md`
   (or `~/.gemini/commands/` equivalent) end-to-end before editing anything.
2. **Scope surfaces.** Global scope: idea / spec / project-init / catalog.
   Project scope: plan / build / test / review / ship + decision / lesson /
   response / lifecycle_report. Scope auto-detects from the global registry
   at `~/.vcf/vcf.db` when you launch `vcf-mcp`; no `--scope` flag needed.
3. **State is out of tree.** The project directory never holds VCF-generated
   files. Runtime lives under `~/.vcf/projects/<slug>/`. The project stays
   clean so its git repo is unpolluted.

## Hard invariants

- Every tool input is zod-validated; unknown keys reject at the SDK
  boundary. Never hand-craft JSON to bypass a schema.
- Every file write goes through `assertInsideAllowedRoot`. Never shortcut
  this guard.
- Redaction runs on every audit write. Don't log raw inputs.
- API keys come from `process.env[endpoint.auth_env_var]` at call time.
  Don't persist them anywhere.

## When in doubt

Read `CLAUDE.md` for the full operator guide, then `vcf-usage-guide` skill
content for the tool index and lifecycle phases. `vcf verify` + `vcf health`
will tell you the state of config and endpoints in under a second.
