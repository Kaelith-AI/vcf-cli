// decision_log_add + decision_log_list — project scope.
//
// ADR-lite: one file per decision at plans/decisions/YYYY-MM-DD-<slug>.md,
// indexed in project.db.decisions. Frontmatter: title, status, created_at,
// supersedes? Body sections: Context / Decision / Consequences.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { slugify, isoDate } from "../util/slug.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

// ---- decision_log_add ------------------------------------------------------

const ADD_STATUS = ["proposed", "accepted", "superseded"] as const;

const DecisionLogAddInput = z
  .object({
    title: z.string().min(1).max(256),
    context: z.string().min(16).max(20_000),
    decision: z.string().min(16).max(20_000),
    consequences: z.string().min(8).max(20_000),
    status: z.enum(ADD_STATUS).default("accepted"),
    supersedes: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("slug of a prior decision this one replaces"),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerDecisionLogAdd(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "decision_log_add",
    {
      title: "Log Decision (ADR-lite)",
      description:
        "Append an ADR-lite entry to plans/decisions/. Fails on slug collision unless supersedes is set.",
      inputSchema: DecisionLogAddInput.shape,
    },
    async (args: z.infer<typeof DecisionLogAddInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "decision_log_add requires project scope");
        }
        const parsed = DecisionLogAddInput.parse(args);
        const root = readProjectRoot(deps);
        if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

        const date = isoDate();
        const slug = slugify(parsed.title);
        const dir = join(root, "plans", "decisions");
        await assertInsideAllowedRoot(dir, deps.config.workspace.allowed_roots);
        await mkdir(dir, { recursive: true });
        const filename = `${date}-${slug}.md`;
        const target = join(dir, filename);

        if (existsSync(target)) {
          throw new McpError("E_ALREADY_EXISTS", `decision log entry already exists: ${target}`);
        }

        // Validate supersedes reference.
        if (parsed.supersedes) {
          const hit = deps.projectDb
            .prepare("SELECT slug FROM decisions WHERE slug = ?")
            .get(parsed.supersedes);
          if (!hit) {
            throw new McpError(
              "E_NOT_FOUND",
              `supersedes="${parsed.supersedes}" does not reference an existing decision`,
            );
          }
        }

        const md = renderAdr({ ...parsed, slug, created: date });
        await writeFile(target, md, "utf8");

        deps.projectDb
          .prepare("INSERT INTO decisions (slug, created_at, path) VALUES (?, ?, ?)")
          .run(slug, Date.now(), target);

        // Mark the superseded entry (if any) superseded.
        if (parsed.supersedes) {
          // We don't mutate the prior file (disposable → never rewrite). We
          // index the relationship via a comment line appended in memory
          // in-future enhancements. For now, the new entry's frontmatter
          // carries `supersedes:` and the reader can follow the link.
        }

        const payload = success(
          [target],
          `Logged decision "${slug}" (${parsed.status}) at ${target}.`,
          parsed.expand
            ? { content: { path: target, slug, status: parsed.status } }
            : {
                expand_hint: "Call decision_log_add with expand=true for the decision metadata.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "decision_log_add",
            scope: "project",
            project_root: root,
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

function renderAdr(opts: {
  title: string;
  slug: string;
  status: (typeof ADD_STATUS)[number];
  created: string;
  supersedes?: string | undefined;
  context: string;
  decision: string;
  consequences: string;
}): string {
  const fm: Record<string, string> = {
    title: JSON.stringify(opts.title),
    status: opts.status,
    created_at: opts.created,
    slug: opts.slug,
  };
  if (opts.supersedes) fm["supersedes"] = opts.supersedes;
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# ${opts.title}\n\n## Context\n\n${opts.context.trim()}\n\n## Decision\n\n${opts.decision.trim()}\n\n## Consequences\n\n${opts.consequences.trim()}\n`;
}

// ---- decision_log_list -----------------------------------------------------

const DecisionLogListInput = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerDecisionLogList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "decision_log_list",
    {
      title: "List Decisions",
      description:
        "Return the project's ADR-lite entries (slug, created_at, path) from project.db.decisions, newest first.",
      inputSchema: DecisionLogListInput.shape,
    },
    async (args: z.infer<typeof DecisionLogListInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "decision_log_list requires project scope");
        }
        const parsed = DecisionLogListInput.parse(args);
        const rows = deps.projectDb
          .prepare("SELECT slug, path, created_at FROM decisions ORDER BY created_at DESC LIMIT ?")
          .all(parsed.limit) as Array<{ slug: string; path: string; created_at: number }>;

        const payload = success(
          rows.map((r) => r.path),
          `decision_log_list: ${rows.length} entr(y|ies).`,
          parsed.expand
            ? { content: { entries: rows } }
            : { expand_hint: "Call decision_log_list with expand=true for the full array." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "decision_log_list",
            scope: "project",
            project_root: readProjectRoot(deps),
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

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
