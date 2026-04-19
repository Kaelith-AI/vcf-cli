# TOOLS.md

## MCP Tools Available In This Project

When this project is open in an MCP client, the following tools are registered (project scope):

- `plan_context`, `plan_save`, `plan_get`
- `build_context`, `build_swap`, `decision_log_add`, `decision_log_list`
- `test_generate`, `test_execute`, `test_analyze`
- `review_prepare`, `review_submit`, `response_log_add`, `review_history`
- `ship_audit`, `ship_build`
- `portfolio_status`

Global-scope tools (`idea_capture`, `spec_template`, `spec_save`, `project_init`, `config_get`, `endpoint_list`, `primer_list`, `model_list`) are available from a parallel `--scope global` server.

## CLI Tools

Maintenance lives on the `vcf` CLI, not MCP:

```bash
vcf reindex                    # re-scan files into SQLite
vcf verify                     # check config + KB + hooks
vcf register-endpoint          # add an LLM endpoint
vcf update-primers             # pull latest @kaelith-labs/kb
vcf admin audit                # query audit log
```
