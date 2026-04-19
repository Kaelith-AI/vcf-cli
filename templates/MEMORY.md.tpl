# MEMORY.md

This project's external memory. Agents writing here should write *facts that must survive session loss*, not transient thoughts.

## Contents of `memory/`

- `daily-logs/YYYY-MM-DD.md` — commit-log; appended by the `post-commit` git hook.
- `decisions/` (under `plans/`) — ADR-lite entries for non-trivial design calls.
- `reviews/response-log.md` (under `plans/`) — builder responses to reviewer findings.

## Conventions

- New file per day for the daily log — never amend yesterday's.
- ADRs are created by `decision_log_add`, not by hand.
- Response log is append-only; disagreements stay in the history.
