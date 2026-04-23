# src/review — review subsystem

The review subsystem handles the 27-stage LLM-assisted review flow. It is architecturally the most complex part of the server because it coordinates: prompt composition, endpoint + model resolution, reviewer overlay selection, result parsing and persistence, and client-side response logging.

---

## Files

| File | Role |
|---|---|
| `prompt.ts` | Compose the outbound messages array from the disposable workspace (stage file + reviewer overlay + carry-forward + diff + snapshots). Also owns `parseSubmission` — extract `{verdict, summary, findings, carry_forward}` from the LLM response, with fallback partial-parse on malformed JSON. |
| `endpointResolve.ts` | Resolve endpoint + model + trust-level from: explicit tool args → `config.defaults.review` block → `E_VALIDATION`. Enforces the public-endpoint gate (requires `allow_public_endpoint: true` to route to a non-local endpoint). Unit-tested in isolation at `test/review/endpointResolve.test.ts`. |
| `overlays.ts` | Reviewer overlay selection. Walk order: `reviewer-<type>.<family>.md → reviewer-<type>.<trust-level>.md → reviewer-<type>.md` (first match wins, all resolved against the run-dir snapshot, not the live KB). Family is extracted from model id (`qwen3-coder` → `qwen`, `gpt-5.4` → `gpt`). Returns the applied match in the `review_execute` envelope so callers can verify which calibration was in effect. |
| `submitCore.ts` | Shared persistence path used by both `review_execute` (server-side) and `review_submit` (client-side). Renders the review report markdown, writes it under `config.outputs.reviews_dir`, updates `project.db.review_runs`, marks the prior run `superseded` if the same stage was previously PASS. |
| `carryForward.ts` | Read + write the `carry-forward.yaml` in a run workspace. Seeded from the most recent Stage-0 PASS on `review_prepare`; updated by the LLM-supplied `carry_forward` array on submit. |
| `responseLogMigrator.ts` | One-shot migration from the legacy triple-dash markdown format into typed DB rows. Idempotent — a second run is a no-op. |

---

## Data flow

```
review_prepare
  → creates ~/.vcf/projects/<slug>/review-runs/<run-id>/
  → copies stage file from KB snapshot (not live KB)
  → copies all reviewer-<type>.*.md variants (overlay snapshot)
  → writes carry-forward.yaml seeded from last Stage-0 PASS
  → writes scoped git diff (lockfiles / dist / node_modules excluded)
  → snapshots decisions + response-log filtered to the same review type

review_execute  (server calls LLM)          review_submit  (client writes verdict)
  → endpointResolve: find endpoint + model      → receives {verdict,summary,findings,carry_forward}
  → overlays: pick calibration overlay
  → prompt.ts: compose messages array
  → llmClient: POST /chat/completions
  → prompt.ts: parseSubmission
       ↓                                              ↓
                     submitCore
                       → render markdown report
                       → write to config.outputs.reviews_dir
                       → update project.db.review_runs
                       → mark prior same-stage run superseded
                       → update carry-forward.yaml
```

---

## Stage-entry rules

- Stage N > 1 requires Stage N−1 PASS unless `force: true` (audited).
- Re-running a passed stage creates a new run id and marks the prior row `superseded`.
- `review_execute` applies the resolved calibration overlay on top of the base reviewer role. Frontier overlays correct NEEDS_WORK inflation and scope creep; local overlays correct redaction-marker hallucination and severity inflation.

---

## Security considerations

`review_execute` sends the full prompt bundle (stage file + overlay + diff + decision/response-log snapshots) to whichever endpoint is resolved. Set `defaults.review.endpoint` to a `trust_level: local` endpoint for sensitive codebases. Redaction runs pre-send but does not substitute for data-residency controls.
