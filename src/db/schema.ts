// SQL migration text for the two SQLite databases.
//
// Schemas mirror the spec §10 layout. Kept as inline SQL rather than a
// migration library because the footprint is tiny and shipping a pure-SQL
// upgrade path is cheaper than threading a schema lib through bin startup.
//
// Each migration is numbered, applied in a transaction, and recorded in a
// `schema_migrations` table. Running the opener twice is idempotent.

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const GLOBAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE IF NOT EXISTS ideas (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        slug            TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array of tags
        created_at      INTEGER NOT NULL,             -- ms since epoch
        frontmatter_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_ideas_slug ON ideas(slug);
      CREATE INDEX IF NOT EXISTS idx_ideas_created_at ON ideas(created_at);

      CREATE TABLE IF NOT EXISTS specs (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        slug            TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'draft',
        created_at      INTEGER NOT NULL,
        frontmatter_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_specs_slug ON specs(slug);
      CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);

      CREATE TABLE IF NOT EXISTS primers (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,        -- primer | best-practice | lens | stage | reviewer | standard
        tags            TEXT NOT NULL DEFAULT '[]',
        applies_to      TEXT NOT NULL DEFAULT '[]',
        last_reviewed   INTEGER,              -- ms since epoch; NULL if never
        version         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_primers_kind ON primers(kind);

      CREATE TABLE IF NOT EXISTS endpoints (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        provider        TEXT NOT NULL,
        base_url        TEXT NOT NULL,
        auth_env_var    TEXT,
        trust_level     TEXT NOT NULL CHECK (trust_level IN ('local','trusted','public'))
      );

      CREATE TABLE IF NOT EXISTS model_aliases (
        alias           TEXT PRIMARY KEY,
        endpoint_id     INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        model_id        TEXT NOT NULL,
        prefer_for      TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        tool            TEXT NOT NULL,
        scope           TEXT NOT NULL CHECK (scope IN ('global','project','cli')),
        project_root    TEXT,
        client_id       TEXT,
        inputs_hash     TEXT NOT NULL,
        outputs_hash    TEXT NOT NULL,
        endpoint        TEXT,
        result_code     TEXT NOT NULL    -- 'ok' or an E_* code
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_root);
    `,
  },
  {
    version: 2,
    name: "audit_full_payload",
    up: `
      -- Nullable redacted-JSON columns for opt-in full-audit mode.
      -- Populated only when config.audit.full_payload_storage = true.
      -- Same redaction pass that runs before hashing is applied before
      -- storage, so enabling the flag does not leak secrets.
      ALTER TABLE audit ADD COLUMN inputs_json TEXT;
      ALTER TABLE audit ADD COLUMN outputs_json TEXT;
    `,
  },
  {
    version: 3,
    name: "cross_project_registry",
    up: `
      -- Opt-in cross-project registry for portfolio_graph + project_list.
      -- Populated by project_init (auto) or 'vcf project register/scan'
      -- (manual). state_cache + depends_on_json + last_seen_at are kept
      -- current by project-scope tool calls; the authoritative values
      -- live in each project's own project.db and plan frontmatter.
      CREATE TABLE IF NOT EXISTS projects (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL UNIQUE,
        root_path       TEXT NOT NULL UNIQUE,
        state_cache     TEXT,                    -- mirror of project.state
        depends_on_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of project slugs
        registered_at   INTEGER NOT NULL,        -- ms since epoch
        last_seen_at    INTEGER NOT NULL         -- ms since epoch; updated on every tool call
      );
      CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(root_path);
    `,
  },
  {
    version: 4,
    name: "project_role",
    up: `
      -- Phase F: project admin role. A project marked 'pm' gets the
      -- cross-project admin tool surface (project_move, project_rename,
      -- project_relocate) registered in its MCP sessions. Default
      -- 'standard' preserves prior behavior for every existing row.
      ALTER TABLE projects
        ADD COLUMN role TEXT NOT NULL DEFAULT 'standard'
          CHECK (role IN ('standard', 'pm'));
      CREATE INDEX IF NOT EXISTS idx_projects_role ON projects(role);
    `,
  },
  {
    version: 5,
    name: "config_boots",
    up: `
      -- Followup #48: config integrity forensics. Every vcf-mcp boot
      -- captures (config_path, ctime, mtime, sha256) so an operator can
      -- spot a post-hoc endpoint-config swap via 'vcf admin
      -- config-history'. prev_sha256 lets the reader see when the hash
      -- changed between boots without re-running the query twice.
      CREATE TABLE IF NOT EXISTS config_boots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,        -- ms since epoch (boot wall time)
        config_path     TEXT NOT NULL,           -- resolved absolute path
        exists_on_disk  INTEGER NOT NULL,        -- 0 | 1 (file present at boot)
        ctime_ms        INTEGER,                 -- filesystem ctime; NULL if !exists
        mtime_ms        INTEGER,                 -- filesystem mtime; NULL if !exists
        size_bytes      INTEGER,                 -- NULL if !exists
        sha256          TEXT,                    -- sha256 of bytes; NULL if !exists
        prev_sha256     TEXT,                    -- sha256 from the previous boot row for this path; NULL on first ever boot
        pid             INTEGER NOT NULL,        -- process.pid of the booting process
        vcf_version     TEXT NOT NULL            -- VERSION constant at boot time
      );
      CREATE INDEX IF NOT EXISTS idx_config_boots_path_ts ON config_boots(config_path, ts);
      CREATE INDEX IF NOT EXISTS idx_config_boots_ts ON config_boots(ts);
    `,
  },
];

export const PROJECT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE IF NOT EXISTS project (
        id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
        name            TEXT NOT NULL,
        root_path       TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN (
                          'draft','planning','building','testing','reviewing','shipping','shipped'
                        )),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        spec_path       TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        mtime           INTEGER NOT NULL,
        hash            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);

      CREATE TABLE IF NOT EXISTS review_runs (
        id              TEXT PRIMARY KEY,     -- '<type>-<ts>' run id
        type            TEXT NOT NULL,
        stage           INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN (
                          'pending','running','submitted','superseded'
                        )),
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        report_path     TEXT,
        verdict         TEXT CHECK (verdict IN ('PASS','NEEDS_WORK','BLOCK')),
        carry_forward_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_review_runs_type ON review_runs(type);
      CREATE INDEX IF NOT EXISTS idx_review_runs_stage ON review_runs(stage);

      CREATE TABLE IF NOT EXISTS decisions (
        id              INTEGER PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL,
        path            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS response_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        -- review_run_id is a free-form id string. The M5 response-log tool
        -- accepts any value so builders can write stance notes before the
        -- M7 review subsystem creates the matching review_runs row.
        -- Application-level validation (tighter than a DB FK) is added when
        -- M7 lands and the run-id lifecycle is known.
        review_run_id   TEXT NOT NULL,
        stance          TEXT NOT NULL CHECK (stance IN ('agree','disagree')),
        note            TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_response_log_run ON response_log(review_run_id);

      CREATE TABLE IF NOT EXISTS builds (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        target          TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        status          TEXT NOT NULL CHECK (status IN ('running','success','failed','canceled')),
        output_path     TEXT
      );
    `,
  },
  {
    version: 2,
    name: "project_adoption_flag",
    up: `
      -- adopted = 1 marks projects brought into VCF via project_init_existing
      -- (followup #20, bypass mode). Informational: signals partial provenance
      -- to auditors and enables future strict/reconstruct modes to drive the
      -- correct reconstruction flow. 0 for projects scaffolded by project_init.
      ALTER TABLE project ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: "lessons",
    up: `
      -- Phase-2 inward loop (#11): per-project lesson log. Mirrored to the
      -- global lessons DB (~/.vcf/lessons.db) on every write so a vibe coder
      -- can search across projects. scope = 'project' is the default; flip
      -- to 'universal' when the observation is cross-project guidance.
      -- stage nullable (not every lesson maps to one lifecycle step).
      CREATE TABLE IF NOT EXISTS lessons (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        title                TEXT NOT NULL,
        context              TEXT,
        observation          TEXT NOT NULL,
        actionable_takeaway  TEXT,
        scope                TEXT NOT NULL CHECK (scope IN ('project','universal')),
        stage                TEXT CHECK (stage IS NULL OR stage IN (
                               'draft','planning','building','testing','reviewing','shipping','shipped'
                             )),
        tags_json            TEXT NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope);
      CREATE INDEX IF NOT EXISTS idx_lessons_stage ON lessons(stage);
      CREATE INDEX IF NOT EXISTS idx_lessons_created_at ON lessons(created_at);
    `,
  },
  {
    version: 4,
    name: "response_log_formal_schema",
    up: `
      -- Phase-2 inward loop (#22). Evolve the v1 response_log table to the
      -- formal schema: run_id + builder_claim + response_text + finding_ref
      -- + references_json. Existing rows (from the M5 surface) preserve
      -- their data; finding_ref is NULL for legacy rows because they
      -- responded to a whole review run, not a specific finding.
      -- SQLite ≥ 3.25 rewrites the CHECK constraint automatically when a
      -- column referenced by it is renamed.
      ALTER TABLE response_log RENAME COLUMN review_run_id TO run_id;
      ALTER TABLE response_log RENAME COLUMN stance TO builder_claim;
      ALTER TABLE response_log RENAME COLUMN note TO response_text;
      ALTER TABLE response_log ADD COLUMN finding_ref TEXT;
      ALTER TABLE response_log ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE response_log ADD COLUMN migration_note TEXT;
      -- Existing idx_response_log_run follows the renamed column (SQLite
      -- re-points internal name). Add a finding_ref index for the common
      -- "has the builder responded to this specific finding?" query.
      CREATE INDEX IF NOT EXISTS idx_response_log_finding ON response_log(finding_ref);
    `,
  },
  {
    version: 5,
    name: "decisions_review_type",
    up: `
      -- Phase-2 inward loop close-out. Scope decisions to a review type so
      -- review_prepare's decisions.snapshot.md can filter: a code reviewer
      -- shouldn't read security-scoped decisions as context for their own
      -- run. NULL = universal (shown in every review type's snapshot).
      -- Existing rows keep review_type=NULL so legacy decisions stay visible
      -- across all review types.
      ALTER TABLE decisions ADD COLUMN review_type TEXT;
      CREATE INDEX IF NOT EXISTS idx_decisions_review_type ON decisions(review_type);
    `,
  },
  {
    version: 6,
    name: "lessons_mirror_status",
    up: `
      -- Followup #42: track mirror state on each lesson so operators can
      -- reconcile after a transient global-DB failure. 'pending' = new
      -- row, not yet written to mirror; 'mirrored' = write succeeded;
      -- 'failed' = write raised. Existing rows default to 'mirrored' —
      -- they were written under the old code path that mirrored
      -- unconditionally and never retried. Operators who want to force a
      -- re-mirror of legacy rows can 'UPDATE lessons SET
      -- mirror_status = ''pending''' then run 'vcf lessons reconcile'.
      ALTER TABLE lessons
        ADD COLUMN mirror_status TEXT NOT NULL DEFAULT 'mirrored'
          CHECK (mirror_status IN ('pending', 'mirrored', 'failed'));
      CREATE INDEX IF NOT EXISTS idx_lessons_mirror_status ON lessons(mirror_status);
    `,
  },
  {
    version: 7,
    name: "feedback",
    up: `
      -- Followup #18: lightweight ad-hoc feedback channel. Distinct from
      -- lesson_log (which wants structured context + observation +
      -- takeaway) — feedback is the "sigh, that was annoying" one-liner
      -- that the improvement cycle triages later.
      --
      -- urgency: low | normal | high. NULL = normal (default at write
      -- time). stage is optional — some feedback ("the CLI help is
      -- confusing") doesn't map to a lifecycle stage.
      CREATE TABLE IF NOT EXISTS feedback (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        note        TEXT NOT NULL,
        stage       TEXT CHECK (stage IS NULL OR stage IN (
                      'draft','planning','building','testing','reviewing','shipping','shipped'
                    )),
        urgency     TEXT CHECK (urgency IS NULL OR urgency IN ('low','normal','high')),
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_stage ON feedback(stage);
    `,
  },
];
