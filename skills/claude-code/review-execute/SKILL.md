---
name: review-execute
description: Run a review stage using a configured local or API endpoint instead of driving it through the client LLM. Triggers on "review with ollama", "auto-review", "server-side review", or "/review-execute".
---

# Review — execute via endpoint

Run the disposable-workspace review flow (`review_prepare` → endpoint → `review_submit` logic) entirely through an OpenAI-compatible endpoint named in `config.endpoints[]`. Useful for offloading stages to Ollama / OpenRouter / CLIProxyAPI / OpenAI / any LiteLLM proxy.

## When to use

- User invokes `/review-execute <type> [stage] [endpoint]` or says *"review with ollama"*, *"run the security review on openrouter"*, *"auto-review this stage"*.
- The operator wants cost / latency / privacy routing the client LLM can't directly give them.

## What to do

1. Call `review_prepare({ type, stage, diff_ref?, expand: true })` to create the disposable `.review-runs/<id>/` workspace. The stage, reviewer overlay, carry-forward, decisions, response log, and scoped diff all land inside it.
2. Pick an endpoint from `config.endpoints[]` (call `endpoint_list` to resolve names). Defaults to a local endpoint when one exists. Respect trust level:
   - `local` — default choice
   - `trusted` — allowed without flags
   - `public` — requires `allow_public_endpoint: true` on the call, because private diff + carry-forward would leave the operator's box
3. Optionally pick `model_id`. If omitted, the server prefers a `model_aliases` entry with `prefer_for: ["reviewer-<type>"]` or `"reviewer"`.
4. Call `review_execute({ run_id, endpoint, model_id?, timeout_ms?, allow_public_endpoint?, expand: true })`. The server composes the prompt, redacts outgoing content, calls the endpoint, parses a structured `{verdict, summary, findings, carry_forward}` JSON response, and persists the report identically to `review_submit`.
5. Report verdict + report path to the user. If PASS, offer to proceed to Stage N+1.

## Reminders

- API keys live in env vars (config stores the *name* via `auth_env_var`). Never ask the user for them in conversation; if missing you'll get `E_CONFIG_MISSING_ENV` and the fix is setting the env var.
- Outgoing messages are redacted unconditionally; if a diff line contains what looks like a secret, the endpoint sees a placeholder, not the value.
- The server never knows about OAuth-linked accounts (Claude / Codex / Gemini sign-ins) — those are not in scope for this tool; use a standard API key or route through CLIProxyAPI.
- For the "client sub-agent" path (Claude Code spawning a Sonnet agent, Codex spawning a nested model), use `/review` instead — that's a client-driven skill, not server-driven.
