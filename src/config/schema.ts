// Zod schema for the user-level config.yaml.
//
// This is the single source of truth for what a valid config looks like. The
// loader (./loader.ts) reads YAML, interpolates ${ENV_VAR} references, then
// hands the raw object to `ConfigSchema.parse` here. Everything downstream
// (tools, CLI commands, MCP server) receives a frozen, fully-validated
// Config object — no "maybe undefined" fields at call sites.
//
// Design notes:
// - `.strict()` at every level so unknown keys fail fast. Typos in the YAML
//   should never silently become defaults.
// - Tag / slug shapes (kebab-case, lowercased) are enforced with regex so the
//   primer tag-matching engine (M3.5) can assume normalization.
// - Endpoint trust levels (`local` | `trusted` | `public`) gate what routes a
//   given tool call may take; MCP Primer § "Endpoint trust levels".
// - Telemetry defaults to OFF per locked decision (2026-04-18). The DSN is a
//   string that may carry `${VCF_SENTRY_DSN}` — resolution happens in the
//   loader, not here.

import { z } from "zod";

// ---- Reusable leaves --------------------------------------------------------

// Exported because the primer tag-matching engine (M3.5) and KB frontmatter
// validators in @kaelith-labs/kb both depend on the exact same tag shape.
export const TagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "tags must be lowercase kebab-case");

const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric + hyphen");

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), {
    message: "paths in config must be absolute (POSIX or Windows-drive) after interpolation",
  });

// ---- Workspace --------------------------------------------------------------

export const WorkspaceSchema = z
  .object({
    // Absolute roots the server is allowed to read/write inside. Every tool
    // argument that looks like a path is re-validated against this list using
    // `assertInsideAllowedRoot` (M1 util/paths.ts).
    allowed_roots: z.array(AbsolutePathSchema).min(1).max(64),
    // Where captured ideas land. Must be inside one of allowed_roots.
    ideas_dir: AbsolutePathSchema,
    // Where finished specs land. Must be inside one of allowed_roots.
    specs_dir: AbsolutePathSchema,
  })
  .strict();

export type Workspace = z.infer<typeof WorkspaceSchema>;

// ---- Endpoints + models -----------------------------------------------------

export const EndpointTrustSchema = z.enum(["local", "trusted", "public"]);
export type EndpointTrust = z.infer<typeof EndpointTrustSchema>;

export const EndpointSchema = z
  .object({
    name: SlugSchema,
    // Broad provider taxonomy; adapters pick up `openai-compatible` for
    // Ollama / LM Studio / Together / Groq / OpenAI itself.
    provider: z.enum(["openai-compatible", "anthropic", "gemini", "local-stub"]),
    base_url: z.string().url().max(1024),
    // Env var name holding the API key. Value resolution happens at call
    // time — never at config-load time — so rotating a key doesn't require
    // a server restart.
    auth_env_var: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, "env var names must be SCREAMING_SNAKE_CASE")
      .optional(),
    trust_level: EndpointTrustSchema,
    // Provider-specific options merged into chat-completion request bodies as
    // `options`. Scoped per-endpoint so unknown keys don't get fanned out to
    // providers that might flag them (the OpenAI surface tolerates unknown
    // body keys, but explicit is better). Primary use: Ollama's `num_ctx` /
    // `num_predict` (native default caps context at 2048 — set 131072+ to
    // unlock the model's full window). Followup #34 + review finding
    // security/stage-7 calibration.
    provider_options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

export const ModelAliasSchema = z
  .object({
    // Short alias used by tools (e.g. "planner", "builder", "reviewer-code").
    alias: SlugSchema,
    // Endpoint name — must reference one of `endpoints[].name` (validated in
    // the top-level refinement below so cross-references fail loud).
    endpoint: SlugSchema,
    // Provider-native model id (e.g. "claude-opus-4-7", "gpt-5.2",
    // "gemma-3-12b"). Kept as a free string; validation per provider is the
    // adapter's concern.
    model_id: z.string().min(1).max(128),
    // Optional preference flags — tools may pick the first alias whose
    // prefer_for array contains their role.
    prefer_for: z.array(SlugSchema).max(16).default([]),
  })
  .strict();

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

// ---- Knowledge base location ------------------------------------------------

// Third-party primer packs — community KB extensions. Each pack is a
// directory containing a `kb/` subtree with the same layout as the main
// KB (primers/, best-practices/, lenses/, review-system/, reviewers/,
// standards/). Entries load with IDs prefixed by `@<name>/` so no pack
// can shadow main-KB content.
//
// Security note: packs ship untrusted Markdown that flows into LLM
// prompts. The server does not execute pack content, and redaction
// still runs on any outbound LLM payload, but a malicious pack could
// still inject instructions. Users install packs deliberately via
// `vcf pack add` — there is no auto-discovery.
export const KbPackSchema = z
  .object({
    name: SlugSchema,
    root: AbsolutePathSchema,
  })
  .strict();

export type KbPack = z.infer<typeof KbPackSchema>;

export const KnowledgeBaseSchema = z
  .object({
    // Where the user's forked KB lives — populated by `vcf init` from the
    // @kaelith-labs/kb package in node_modules.
    root: AbsolutePathSchema,
    // Optional upstream pin, used by `vcf update-primers` to know which KB
    // version to diff against.
    upstream_package: z.string().default("@kaelith-labs/kb"),
    // Third-party primer packs. Empty by default.
    packs: z.array(KbPackSchema).max(32).default([]),
    // When true, KB entries whose frontmatter tags include tokens outside
    // `kb/standards/tag-vocabulary.md` fail validation at load time with
    // E_VALIDATION. Off by default through Phase 2 so the vocabulary can
    // settle; will default to true in a later phase once curated tag sets
    // stabilize across all primer packs.
    tag_vocabulary_strict: z.boolean().default(false),
  })
  .strict();

export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

// ---- Review -----------------------------------------------------------------

// Followup #38 — preserve reviewer-prompt headroom by pre-filtering the
// scoped diff. Entries are gitignore-style pathspecs; `review_prepare`
// forwards each as a `:(exclude)<pattern>` arg to `git diff`, so any
// pattern git's pathspec accepts works. Defaults cover the noisy-but-
// useless-to-review cases (lockfiles, build output, minified bundles)
// that otherwise burn 10-50K prompt tokens per stage run.
export const REVIEW_DIFF_EXCLUDE_DEFAULTS: string[] = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  "dist/**",
  "build/**",
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/vendor/**",
  "**/.turbo/**",
  "**/.next/**",
];

export const ReviewSchema = z
  .object({
    // MVP ships code / security / production. Users may add categories; the
    // spec flags this as "Phase 2 or now?" — allowing extension here costs
    // nothing and makes the config shape stable.
    categories: z.array(SlugSchema).min(1).max(16).default(["code", "security", "production"]),
    // Auto-advance through stages until the first non-PASS verdict. Off by
    // default so the first user to run through feels the progression
    // explicitly.
    auto_advance_on_pass: z.boolean().default(true),
    // Stale-primer threshold in days; read by `vcf stale-check`.
    stale_primer_days: z.number().int().positive().max(3650).default(180),
    // Followup #38: diff pre-filter. See REVIEW_DIFF_EXCLUDE_DEFAULTS
    // for the seed list. Operators extend (or override with []) as
    // needed; review_prepare treats each entry as a git pathspec
    // passed via `:(exclude)<pattern>`.
    diff_exclude: z
      .array(z.string().min(1).max(512))
      .max(128)
      .default(REVIEW_DIFF_EXCLUDE_DEFAULTS),
  })
  .strict();

// ---- Redaction --------------------------------------------------------------

export const RedactionSchema = z
  .object({
    // Always redact for public endpoints. For trusted, user may opt in.
    on_public_endpoints: z.literal(true),
    on_trusted_endpoints: z.boolean().default(true),
    on_local_endpoints: z.boolean().default(false),
    // Additional patterns beyond the built-in list (AWS keys, JWTs, private
    // keys, .env-shaped values). Each pattern is a JS regex source string.
    extra_patterns: z.array(z.string().max(512)).max(64).default([]),
  })
  .strict();

// ---- Telemetry (locked decision 2026-04-18) --------------------------------

export const TelemetrySchema = z
  .object({
    // Default OFF per locked decision. `vcf init` asks the user y/N on first
    // run and writes the chosen value.
    error_reporting_enabled: z.boolean().default(false),
    // Sentry DSN or equivalent. Supports ${ENV_VAR} interpolation at load
    // time. Only consulted when error_reporting_enabled is true.
    dsn: z.string().max(2048).optional(),
  })
  .strict();

// ---- Audit (full-payload mode, off by default) -----------------------------

export const AuditPersonalDataSchema = z
  .object({
    // Exact-match allow-list for the ship_audit personal-data pass.
    // Strings in this list suppress warnings when the personal-data
    // scanner finds them in source/docs. Typical use: contributor emails
    // in README, maintainer addresses in CODEOWNERS, contact sections.
    // Only exact-match suppression — no glob or regex.
    allow_list: z.array(z.string().min(1).max(512)).max(256).default([]),
  })
  .strict();

export type AuditPersonalData = z.infer<typeof AuditPersonalDataSchema>;

export const AuditSchema = z
  .object({
    // When true, audit rows also store the redacted JSON of the tool's
    // inputs + outputs (same redaction pass that runs before hashing). Off
    // by default — the original MVP contract is hashes only. Enable for
    // operator debugging; the DB will grow faster. Secrets are still
    // redacted before storage, so the risk delta vs. hash-only is that the
    // shape of the payload becomes visible.
    full_payload_storage: z.boolean().default(false),
    // Followup #25 item 4: personal-data allow-list for ship_audit.
    // Suppresses exact-match warnings (e.g. a README author email).
    personal_data: AuditPersonalDataSchema.default({ allow_list: [] }),
  })
  .strict();

// ---- Per-step defaults (followup #28) --------------------------------------
//
// Each entry points an endpoint-calling tool at an endpoint + model without
// requiring per-call overrides. Resolution order at tool call time:
//   explicit arg → defaults.<tool>.<field> → tool-specific legacy fallback.
// Both fields optional per tool, so an operator can set just the endpoint and
// leave model selection to the legacy `model_aliases` flow if they prefer.
//
// `endpoint` must reference a declared endpoint; cross-reference is enforced
// in the top-level superRefine so a typo fails at config load, not on first
// tool call.

const DefaultEntrySchema = z
  .object({
    endpoint: SlugSchema.optional(),
    model: z.string().min(1).max(128).optional(),
  })
  .strict();

export const DefaultsSchema = z
  .object({
    review: DefaultEntrySchema.optional(),
    lifecycle_report: DefaultEntrySchema.optional(),
    retrospective: DefaultEntrySchema.optional(),
    research: DefaultEntrySchema.optional(),
    research_verify: DefaultEntrySchema.optional(),
    stress_test: DefaultEntrySchema.optional(),
  })
  .strict();

export type Defaults = z.infer<typeof DefaultsSchema>;

// ---- Lessons (project + global self-improvement log) -----------------------

// ---- Outputs (configurable per-project artifact locations) -----------------
//
// Every project-tree artifact the MCP server writes lands under one of
// these keys. Defaults keep the pre-0.6.2 layout — each subdir relative
// to the registered project_root — so upgrading doesn't force a config
// change. Absolute paths override the default per-project routing (e.g.
// to point a company-wide decision log at a shared drive).

export const OutputsSchema = z
  .object({
    plans_dir: z.string().min(1).max(512).default("plans"),
    decisions_dir: z.string().min(1).max(512).default("plans/decisions"),
    reviews_dir: z.string().min(1).max(512).default("plans/reviews"),
    response_log_path: z.string().min(1).max(512).default("plans/reviews/response-log.md"),
    lifecycle_report_dir: z.string().min(1).max(512).default("plans"),
    memory_dir: z.string().min(1).max(512).default("memory/daily-logs"),
    docs_dir: z.string().min(1).max(512).default("docs"),
    skills_dir: z.string().min(1).max(512).default("skills"),
    backups_dir: z.string().min(1).max(512).default("backups"),
  })
  .strict();

export type Outputs = z.infer<typeof OutputsSchema>;

export const LessonsSchema = z
  .object({
    // Absolute path to the global lessons + feedback store. `~` and
    // `${ENV_VAR}` are expanded at resolve time (loader + DB opener),
    // not here, so accept a loose string. Default resolution:
    // `~/.vcf/lessons.db`.
    //
    // Followup #41: lessons and feedback are improvement-cycle data (not
    // project-lifecycle data) and live in one global store tagged with
    // project_root. The old mirror_policy and default_scope knobs are gone
    // — lessons are always global. `lesson_search` uses its `filter` arg
    // (current | universal | all) to select which rows to return.
    //
    // Explicit `null` disables the store entirely — lesson_log_add,
    // feedback_add, lesson_search, and feedback_list all fail with
    // E_SCOPE_DENIED. Operators running VCF on a shared workstation
    // alongside sensitive / NDA work use this to keep the store off.
    global_db_path: z.union([z.string().min(1).max(4096), z.null()]).optional(),
  })
  .strict();

export type Lessons = z.infer<typeof LessonsSchema>;

// ---- Report (lifecycle_report shaping) -------------------------------------

export const ReportSchema = z
  .object({
    // Max audit rows included per lifecycle section's `recent` list (trimmed
    // by ts descending). Higher = richer structured report + bigger
    // narrative-mode prompts. 500 is the default — caps runtime on the
    // 10k-audit-row perf target and keeps per-section LLM prompts under
    // ~30K tokens at typical row width.
    audit_rows_per_section: z.number().int().positive().max(5000).default(500),
    // Same idea for recent artifacts / reviews / builds / lessons tables.
    // Kept smaller because these tables grow slower than audit.
    recent_rows_per_section: z.number().int().positive().max(500).default(50),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;

// ---- Embeddings (optional; off by default) ---------------------------------

export const EmbeddingsSchema = z
  .object({
    // Must name one of config.endpoints[]. That endpoint's base_url +
    // auth_env_var drive the embedding HTTP call (OpenAI-compatible
    // /embeddings surface — Ollama + OpenRouter + OpenAI + LiteLLM all
    // speak it).
    endpoint: SlugSchema,
    // Provider model id (e.g. "text-embedding-3-small", "nomic-embed-text",
    // "mxbai-embed-large"). Mixing vectors from different models in one
    // cache is undefined behavior; `vcf embed-kb` re-generates on change.
    model: z.string().min(1).max(128),
    // 0 = pure tag Jaccard, 1 = pure cosine. Blend when both signals exist.
    blend_weight: z.number().min(0).max(1).default(0.5),
    // Where vectors land. Default ~/.vcf/embeddings/.
    cache_dir: z.string().max(4096).optional(),
  })
  .strict();

// ---- Ship (release-gate knobs) ---------------------------------------------
//
// Followup #25 items 5 + 6: strict_chain requires passing ship_audit and
// ship_build before ship_release is allowed (for the current tag). The
// window within which prior results are accepted is configurable (default
// 60 minutes). version_check adds a semver-order check: the provided tag
// must be strictly newer than the last release recorded in project.db.

export const ShipSchema = z
  .object({
    // When true, ship_release refuses to execute unless a passing ship_audit
    // AND a successful ship_build are recorded in the audit log within the
    // last `strict_chain_window_minutes` minutes. Default false — preserves
    // pre-0.7.0 behavior where the chain is advisory only.
    strict_chain: z.boolean().default(false),
    // How far back (in minutes) ship_release looks for a passing audit+build
    // pair when strict_chain is true. Default 60 minutes.
    strict_chain_window_minutes: z
      .number()
      .int()
      .positive()
      .max(1440)
      .default(60),
    // When true, ship_release additionally rejects if the provided tag is not
    // semver-newer than the last recorded release. With strict_chain=false
    // this is a soft-warn path: the tool logs a warning but still proceeds.
    // With strict_chain=true this becomes a hard gate (E_VALIDATION).
    // Default false.
    version_check: z.boolean().default(false),
  })
  .strict();

export type Ship = z.infer<typeof ShipSchema>;

// ---- Top-level --------------------------------------------------------------

export const ConfigSchema = z
  .object({
    // Schema version on the YAML itself. Bumped on breaking changes so the
    // loader can refuse an incompatible file with a stable error code.
    version: z.literal(1),
    workspace: WorkspaceSchema,
    endpoints: z.array(EndpointSchema).min(1).max(32),
    model_aliases: z.array(ModelAliasSchema).max(64).default([]),
    kb: KnowledgeBaseSchema,
    review: ReviewSchema.default({
      categories: ["code", "security", "production"],
      auto_advance_on_pass: true,
      stale_primer_days: 180,
      diff_exclude: REVIEW_DIFF_EXCLUDE_DEFAULTS,
    }),
    // Route everything we can to local endpoints first when true; spec § 5
    // non-negotiable, see "Local-model preference".
    prefer_local: z.boolean().default(false),
    redaction: RedactionSchema.default({
      on_public_endpoints: true,
      on_trusted_endpoints: true,
      on_local_endpoints: false,
      extra_patterns: [],
    }),
    telemetry: TelemetrySchema.default({ error_reporting_enabled: false }),
    audit: AuditSchema.default({ full_payload_storage: false, personal_data: { allow_list: [] } }),
    embeddings: EmbeddingsSchema.optional(),
    defaults: DefaultsSchema.optional(),
    lessons: LessonsSchema.default({}),
    outputs: OutputsSchema.default({
      plans_dir: "plans",
      decisions_dir: "plans/decisions",
      reviews_dir: "plans/reviews",
      response_log_path: "plans/reviews/response-log.md",
      lifecycle_report_dir: "plans",
      memory_dir: "memory/daily-logs",
      docs_dir: "docs",
      skills_dir: "skills",
      backups_dir: "backups",
    }),
    report: ReportSchema.default({
      audit_rows_per_section: 500,
      recent_rows_per_section: 50,
    }),
    ship: ShipSchema.default({
      strict_chain: false,
      strict_chain_window_minutes: 60,
      version_check: false,
    }),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Cross-reference: every model alias must name a declared endpoint.
    const endpointNames = new Set(cfg.endpoints.map((e) => e.name));
    for (const [i, alias] of cfg.model_aliases.entries()) {
      if (!endpointNames.has(alias.endpoint)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["model_aliases", i, "endpoint"],
          message: `endpoint "${alias.endpoint}" is not declared in endpoints[]`,
        });
      }
    }
    // embeddings.endpoint must also name a declared endpoint.
    if (cfg.embeddings && !endpointNames.has(cfg.embeddings.endpoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddings", "endpoint"],
        message: `endpoint "${cfg.embeddings.endpoint}" is not declared in endpoints[]`,
      });
    }
    // defaults.<tool>.endpoint — when set, must reference a declared endpoint.
    if (cfg.defaults) {
      for (const [tool, entry] of Object.entries(cfg.defaults)) {
        if (entry?.endpoint && !endpointNames.has(entry.endpoint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["defaults", tool, "endpoint"],
            message: `endpoint "${entry.endpoint}" is not declared in endpoints[]`,
          });
        }
      }
    }
    // Endpoint names must be unique.
    const endpointDuplicates = new Set<string>();
    const seen = new Set<string>();
    for (const e of cfg.endpoints) {
      if (seen.has(e.name)) endpointDuplicates.add(e.name);
      seen.add(e.name);
    }
    for (const dup of endpointDuplicates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoints"],
        message: `duplicate endpoint name: "${dup}"`,
      });
    }
    // KB pack names must be unique — they namespace entries at load time.
    const packNames = new Set<string>();
    for (const [i, pack] of cfg.kb.packs.entries()) {
      if (packNames.has(pack.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kb", "packs", i, "name"],
          message: `duplicate KB pack name: "${pack.name}"`,
        });
      }
      packNames.add(pack.name);
    }
    // Model alias names must be unique.
    const aliasNames = new Set<string>();
    for (const [i, alias] of cfg.model_aliases.entries()) {
      if (aliasNames.has(alias.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["model_aliases", i, "alias"],
          message: `duplicate model alias: "${alias.alias}"`,
        });
      }
      aliasNames.add(alias.alias);
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
