# VCF n8n workflow templates

Three scheduled workflows you can import into an n8n instance to automate the deterministic parts of VCF maintenance. All three are optional — nothing in VCF requires n8n.

## What's in here

| File | Schedule | What it does |
|---|---|---|
| [`stale-check.json`](workflows/stale-check.json) | Weekly (Mon 09:00) | Runs `vcf stale-check --format json` and posts to Slack if any primer is past `review.stale_primer_days` |
| [`endpoint-health.json`](workflows/endpoint-health.json) | Hourly | Runs `vcf health --format json` and posts to Slack if any endpoint is unreachable |
| [`kb-update-available.json`](workflows/kb-update-available.json) | Weekly (Mon 10:00) | Checks npm for a newer `@kaelith-labs/kb` and posts to Slack if the local install is behind |

## Prerequisites

1. An n8n instance that can shell out on the same host as your `vcf` install (Execute Command node is used for `vcf stale-check`, `vcf health`, and reading `~/.vcf/kb/package.json`).
2. A webhook URL for the notification channel — Slack is used as the example but any HTTP webhook works (Discord, Teams, generic).
3. `vcf` ≥ 0.1.0-alpha.0 on PATH where n8n runs (`--format json` and `vcf health` landed in 0.1.0).

## Import

1. Open n8n → **Workflows** → **Import from File**.
2. Pick one of the `workflows/*.json` files.
3. Search each workflow for `REPLACE_WITH_YOUR_SLACK_WEBHOOK_URL` and paste your webhook.
4. Adjust the cron schedule on the Schedule Trigger node to taste.
5. Activate the workflow.

## Using a different notifier

The notify node is a plain HTTP POST with a JSON body. To switch from Slack to Discord or email:

- **Discord**: same shape (`{"content": "..."}` instead of `{"text": "..."}`).
- **Email**: replace the HTTP Request node with an Email node wired to the same inputs.
- **Generic webhook**: adjust the JSON body to what your receiver expects.

## Not using n8n?

Every workflow reduces to a cron job. The equivalent of `stale-check.json` is:

```cron
0 9 * * MON  vcf stale-check --format json | jq '.stale_count > 0' | grep -q true && curl -X POST "$SLACK_WEBHOOK" -d "..."
```

The n8n templates exist because the branching + JSON parsing + HTTP POST are tedious to reimplement in shell. If you have an n8n instance, this is the faster path.

## Troubleshooting

- **Execute Command returns exit code 9** on `vcf health`: that's expected when endpoints are unreachable — the `|| true` tail in the command keeps the workflow going so the Code node can still parse the stdout report.
- **Parse JSON fails with `Unexpected token`**: confirm `vcf` ≥ 0.1.0-alpha.0 is on the n8n host's PATH. Older releases don't have `--format json`.
- **vcf can't find the config**: n8n's command node runs in its own shell — set `VCF_CONFIG` as an environment variable on the n8n service, or invoke `vcf` with `VCF_CONFIG=/home/youruser/.vcf/config.yaml vcf ...`.
