---
name: ship-release
description: Cut a GitHub release via ship_release two-call flow. Triggers on "ship release", "cut release", "$ship-release".
---

# Ship Release

Publish a tagged GitHub release. The tool uses a two-call confirm flow so an LLM cannot accidentally ship — the plan is shown first, the user confirms, then execution happens.

## When to use

- User invokes `$ship-release`.
- Only after `$ship-audit` is clean and `$ship-build` has succeeded.
- Requires project-scope MCP and `gh` CLI authenticated on the PATH.

## What to do

### Call 1 — Request the plan

Call `ship_release` without a `confirm_token`:

```json
{
  "tag": "v1.2.3",
  "title": "v1.2.3 — My Release",
  "generate_notes": true,
  "expand": true
}
```

The response includes:
- `plan` — the exact `gh release create` command that will run
- `command` — the full command line for review
- `confirm_token` — a single-use token (TTL configured via `config.ship.confirm_ttl_minutes`, default 60 minutes)
- `notes_source` — where release notes will come from

**Show the plan to the user and wait for explicit approval before proceeding.**

### Call 2 — Execute with confirm_token

Only after the user approves, call `ship_release` again with the same inputs plus the `confirm_token`:

```json
{
  "tag": "v1.2.3",
  "title": "v1.2.3 — My Release",
  "generate_notes": true,
  "confirm_token": "<token from call 1>",
  "expand": true
}
```

The server validates the token, executes `gh release create`, and returns stdout/stderr tails plus the exit code.

## Rules

- Never pass `confirm_token` on the first call — that is how you request a plan.
- Never skip showing the plan to the user. The two-call flow exists precisely so a human sees and approves what will run.
- Tokens are single-use and expire after the configured TTL (default 60 minutes). If expired, start over from Call 1.
- The tool will refuse to execute if the token was issued for a different input payload.
- On success, project state transitions to `shipped` in the portfolio.

## Prerequisites

- `$ship-audit` must have passed (when `config.ship.strict_chain: true`, this is enforced automatically).
- `$ship-build` must have succeeded (same enforcement when strict_chain is on).
- HEAD must be clean and pushed — `gh` pins whatever the remote resolves at execution time.
