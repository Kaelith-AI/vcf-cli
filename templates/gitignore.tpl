# Vibe Coding Framework MCP-scaffolded project .gitignore
# Hand-edit for project-specific additions; the top block is ours.

# Per-project state (index, runs, backups) — regeneratable
.vcf/*.db*
.review-runs/
backups/

# Environment & secrets
.env
.env.*
!.env.example

# OS / editor
.DS_Store
Thumbs.db
.vscode/
.idea/

# Node
node_modules/
npm-debug.log*

# Python
__pycache__/
*.py[cod]
.venv/
venv/

# Build output
dist/
build/
coverage/
