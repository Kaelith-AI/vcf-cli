# src/cli — CLI command handlers

`cli.ts` is the Commander bootstrap and top-level argv router. Command handlers are split across 14 per-group modules here.

## Module map

| File | Subcommands covered |
|---|---|
| `init.ts` | `vcf init` |
| `reindex.ts` | `vcf reindex` |
| `verify.ts` | `vcf verify` |
| `project.ts` | `vcf project list / register / unregister / scan / refresh / move / rename / relocate / set-role` |
| `admin.ts` | `vcf admin audit / config-history` |
| `pack.ts` | `vcf pack add / list / remove` |
| `skills.ts` | `vcf install-skills` |
| `embed.ts` | `vcf embed-kb` |
| `lifecycle.ts` | `vcf lifecycle-report` |
| `backup.ts` | `vcf backup / vcf restore` |
| `migrate.ts` | `vcf migrate 0.3` |
| `configUpgrade.ts` | `vcf config upgrade` |
| `standards.ts` | `vcf standards init` |
| `testTrends.ts` | `vcf test-trends` |
| `_shared.ts` | Shared helpers (output formatting, error handling) |

`src/cli.ts` re-exports the test-import surface (`mergePrimerTree`, `seedKbIfMissing`, `resolveUpstreamKbRoot`) for backward-compat with tests that import from the top-level module.

## Why CLI, not MCP tools?

Commands in this directory are deterministic maintenance operations a human or CI script runs directly. They are intentionally not MCP tools — they should not burn LLM tokens on every invocation and they do not need the context-assembly machinery the MCP server provides.
