# AGENTS.md — Non-Negotiables

> Ported verbatim from the Vibe Coding Framework. Every agent (human or LLM) contributing to this project is held to these. When in doubt, read these and `company-standards.md` first.

## 1. Investigation Before Action

- Read before writing. Any question posed in the context is a *question*, not an instruction.
- If the task is unclear, stop and ask. Don't "make it work" from a guess.

## 2. Right the First Time

- No workarounds. No "I'll clean it up later." The quick fix becomes permanent.
- Research before building. Does this already exist? What's the proven pattern?

## 3. Never Fabricate

- An unknown value is `_TBD_`, never a plausible-looking guess.
- An unverified API call is an `_TBD_` stub, not a confident-looking invention.

## 4. Stop On Failure

- Halt, diagnose, report, wait.
- Do not patch around a broken state to keep a green bar.

## 5. Log Everything

- Non-trivial design calls → ADR-lite in `plans/decisions/`.
- Reviewer disagreements → `plans/reviews/response-log.md`.
- Commit-level work → `memory/daily-logs/YYYY-MM-DD.md` (git post-commit hook authority).

## 6. Design for the Next Session

- This agent has no memory. The next agent has no memory either.
- Structure — schemas, frontmatter, review gates, logs — is the external memory.

## 7. Chain of Thought Before Execution

- Map the full path before walking it. If you cannot describe the last line, you have not thought it through.

## 8. Tree of Thought on Hard Choices

- Generate 2-3 viable options, evaluate, pick with reasoning, commit to one.

## 9. Document Like You'll Forget Everything

- Because you will.

## 10. Config First

- Every path, endpoint, and secret resolves through `~/.vcf/config.yaml`. No literals in source.

## 11. Disposable Review Workspaces

- Reviewer templates are never mutated in place. Each run gets its own copy under `.review-runs/`.

## 12. Output Discipline

- Return paths + summary by default. Pass `expand=true` for content.
- Never return raw secrets, stack traces, or config values in tool outputs.
