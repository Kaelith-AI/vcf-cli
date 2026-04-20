// Catalog: config_get, endpoint_list, primer_list, model_list.
//
// All four are read-only and cheap. They exist because the client can't
// read `~/.vcf/config.yaml` directly (and shouldn't — secrets resolve via
// env at call time, not via file read), and because primers are filesystem
// state the server owns.
//
// config_get is the only one that can surface *secret-shaped* fields. It
// redacts `auth_env_var` *values* from process.env before returning.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { loadKbCached } from "../primers/load.js";

// ---- config_get ------------------------------------------------------------

const ConfigGetInput = z
  .object({
    section: z
      .enum([
        "workspace",
        "endpoints",
        "model_aliases",
        "kb",
        "review",
        "redaction",
        "telemetry",
        "all",
      ])
      .default("all"),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerConfigGet(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "config_get",
    {
      title: "Get Config",
      description:
        "Return one section (or all) of the resolved config. Never returns env-var values; only the declared var *names*. Pass expand=true for the full section payload.",
      inputSchema: ConfigGetInput.shape,
    },
    async (args: z.infer<typeof ConfigGetInput>) => {
      return runTool(async () => {
        const parsed = ConfigGetInput.parse(args);
        const redacted = {
          workspace: deps.config.workspace,
          endpoints: deps.config.endpoints.map((e) => ({
            name: e.name,
            provider: e.provider,
            base_url: e.base_url,
            // expose var *name*, never value
            ...(e.auth_env_var !== undefined ? { auth_env_var: e.auth_env_var } : {}),
            trust_level: e.trust_level,
          })),
          model_aliases: deps.config.model_aliases,
          kb: deps.config.kb,
          review: deps.config.review,
          redaction: deps.config.redaction,
          telemetry: {
            error_reporting_enabled: deps.config.telemetry.error_reporting_enabled,
            // DSN may itself be a ${ENV_VAR} — redact to var name only.
            ...(deps.config.telemetry.dsn !== undefined
              ? { dsn_configured: true }
              : { dsn_configured: false }),
          },
        };
        const out =
          parsed.section === "all" ? redacted : { [parsed.section]: redacted[parsed.section] };
        const payload = success(
          [],
          `config_get(${parsed.section}): ${Object.keys(out).length} section(s).`,
          parsed.expand
            ? { content: out }
            : { expand_hint: "Call config_get with expand=true for the section data." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "config_get",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

// ---- endpoint_list ---------------------------------------------------------

const EndpointListInput = z
  .object({
    trust_level: z.enum(["local", "trusted", "public"]).optional(),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerEndpointList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "endpoint_list",
    {
      title: "List Endpoints",
      description:
        "List configured LLM endpoints (name, provider, base_url, auth_env_var name only, trust_level). Optional trust_level filter.",
      inputSchema: EndpointListInput.shape,
    },
    async (args: z.infer<typeof EndpointListInput>) => {
      return runTool(async () => {
        const parsed = EndpointListInput.parse(args);
        const endpoints = deps.config.endpoints
          .filter((e) => parsed.trust_level === undefined || e.trust_level === parsed.trust_level)
          .map((e) => ({
            name: e.name,
            provider: e.provider,
            base_url: e.base_url,
            ...(e.auth_env_var !== undefined ? { auth_env_var: e.auth_env_var } : {}),
            trust_level: e.trust_level,
          }));
        const payload = success(
          [],
          `endpoint_list: ${endpoints.length} endpoint(s)${
            parsed.trust_level ? ` filtered by trust_level=${parsed.trust_level}` : ""
          }.`,
          parsed.expand
            ? { content: { endpoints } }
            : { expand_hint: "Call endpoint_list with expand=true for the full array." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "endpoint_list",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

// ---- model_list ------------------------------------------------------------

const ModelListInput = z
  .object({
    prefer_for: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerModelList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "model_list",
    {
      title: "List Model Aliases",
      description:
        "List configured model aliases (alias, endpoint, model_id, prefer_for). Optional prefer_for filter.",
      inputSchema: ModelListInput.shape,
    },
    async (args: z.infer<typeof ModelListInput>) => {
      return runTool(async () => {
        const parsed = ModelListInput.parse(args);
        const aliases = deps.config.model_aliases.filter(
          (a) => parsed.prefer_for === undefined || a.prefer_for.includes(parsed.prefer_for),
        );
        const payload = success(
          [],
          `model_list: ${aliases.length} alias(es)${
            parsed.prefer_for ? ` for prefer_for=${parsed.prefer_for}` : ""
          }.`,
          parsed.expand
            ? { content: { model_aliases: aliases } }
            : { expand_hint: "Call model_list with expand=true for the full array." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "model_list",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

// ---- primer_list -----------------------------------------------------------

const PrimerListInput = z
  .object({
    kind: z
      .enum(["primer", "best-practice", "lens", "stage", "reviewer-config", "standard", "all"])
      .default("all"),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(16)
      .default([])
      .describe("filter: entry must include ALL listed tags (AND)"),
    limit: z.number().int().min(1).max(500).default(200),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerPrimerList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "primer_list",
    {
      title: "List KB Entries",
      description:
        "List KB entries (primers, best-practices, lenses, stages, reviewer-configs, standards) by kind + tag filter. Returns metadata only; read bodies separately.",
      inputSchema: PrimerListInput.shape,
    },
    async (args: z.infer<typeof PrimerListInput>) => {
      return runTool(async () => {
        const parsed = PrimerListInput.parse(args);
        const all = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
        const filtered = all.filter((e) => {
          if (parsed.kind !== "all" && e.kind !== parsed.kind) return false;
          for (const t of parsed.tags) {
            if (!e.tags.includes(t) && !e.applies_to.includes(t)) return false;
          }
          return true;
        });
        const rows = filtered.slice(0, parsed.limit).map((e) => ({
          id: e.id,
          kind: e.kind,
          name: e.name,
          path: e.path,
          tags: e.tags,
          ...(e.category !== undefined ? { category: e.category } : {}),
          ...(e.version !== undefined ? { version: e.version } : {}),
          ...(e.updated !== undefined ? { updated: e.updated } : {}),
          ...(e.pack !== undefined ? { pack: e.pack } : {}),
        }));
        const payload = success(
          rows.map((r) => r.path),
          `primer_list: ${rows.length} / ${all.length} KB entr(y|ies).`,
          parsed.expand
            ? { content: { entries: rows } }
            : { expand_hint: "Call primer_list with expand=true for the full array." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "primer_list",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

// ---- pack_list -------------------------------------------------------------

const PackListInput = z
  .object({
    expand: z.boolean().default(true),
  })
  .strict();

export function registerPackList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "pack_list",
    {
      title: "List Registered KB Packs",
      description:
        "Return the name + root + entry count of each third-party KB pack registered in config.kb.packs. Pack content is accessible via primer_list filtered by id prefix '@<name>/'.",
      inputSchema: PackListInput.shape,
    },
    async (args: z.infer<typeof PackListInput>) => {
      return runTool(async () => {
        const parsed = PackListInput.parse(args);
        const all = await loadKbCached(deps.config.kb.root, deps.config.kb.packs);
        const byPack = new Map<string, number>();
        for (const e of all) if (e.pack) byPack.set(e.pack, (byPack.get(e.pack) ?? 0) + 1);
        const rows = deps.config.kb.packs.map((p) => ({
          name: p.name,
          root: p.root,
          entry_count: byPack.get(p.name) ?? 0,
        }));
        const payload = success(
          rows.map((r) => r.root),
          `pack_list: ${rows.length} pack(s) registered, ${rows.reduce((n, r) => n + r.entry_count, 0)} entr(y|ies) total.`,
          parsed.expand
            ? { content: { packs: rows } }
            : { expand_hint: "Call pack_list with expand=true for the full array." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "pack_list",
            scope: deps.scope === "project" ? "project" : "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}
