// spec_save — global scope.
//
// Validate the frontmatter of a finished spec and persist it to
// workspace.specs_dir/YYYY-MM-DD-<slug>.md. Caller-supplied markdown must
// start with a YAML frontmatter block carrying at minimum:
//   title, status ∈ {draft, accepted, archived}, created (ISO date),
//   tech_stack (array of kebab-case tags)
//
// After save, an index row is written to the global DB's `specs` table so
// spec_get / spec_suggest_primers can find it without rescanning disk.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { slugify } from "../util/slug.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const SpecSaveInput = z
  .object({
    content: z
      .string()
      .min(64)
      .max(200_000)
      .describe(
        "full spec markdown including a YAML frontmatter block (title, status, created, tech_stack[])",
      ),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128)
      .optional()
      .describe("override slug; derived from frontmatter.title when omitted"),
    force: z
      .boolean()
      .default(false)
      .describe(
        "overwrite an existing file with the same date+slug (off by default); also bypasses status-transition enforcement (audited)",
      ),
    expand: z.boolean().default(false),
  })
  .strict();

const FrontmatterSchema = z
  .object({
    title: z.string().min(1).max(256),
    status: z.enum(["draft", "accepted", "archived"]).default("draft"),
    created: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    tech_stack: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(32)
      .default([]),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(32)
      .default([]),
    lens: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(16)
      .default([]),
    author_agent: z.string().max(128).optional(),
    domain: z.string().max(256).optional(),
    // Followup #25: cross-spec links — pure metadata, no enforcement.
    // Values are spec slugs that this spec relates to. Allows annotating
    // cross-spec dependencies without graph queries.
    related_specs: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
      .max(64)
      .default([]),
  })
  .passthrough(); // extra fields allowed — the spec body is human-facing

export function registerSpecSave(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "spec_save",
    {
      title: "Save Spec",
      description:
        "Validate and persist a filled spec to workspace.specs_dir/YYYY-MM-DD-<slug>.md. Frontmatter must carry title, status, created, tech_stack. Returns the written path; the caller typically follows with spec_suggest_primers.",
      inputSchema: SpecSaveInput.shape,
    },
    async (args: z.infer<typeof SpecSaveInput>) => {
      // Captured when force=true bypasses an otherwise-illegal status transition.
      let forcedTransition: string | null = null;
      return runTool(
        async () => {
          const parsed = SpecSaveInput.parse(args);
          const fm = extractFrontmatter(parsed.content);
          if (!fm) {
            throw new McpError(
              "E_VALIDATION",
              "spec content must start with a YAML frontmatter block (--- ... ---)",
            );
          }
          const fmResult = FrontmatterSchema.safeParse(fm);
          if (!fmResult.success) {
            throw new McpError("E_VALIDATION", "spec frontmatter failed schema validation", {
              issues: fmResult.error.issues,
            });
          }
          const validated = fmResult.data;
          const slug = parsed.slug ?? slugify(validated.title);
          const date = validated.created.slice(0, 10);
          const specsDir = deps.config.workspace.specs_dir;
          await assertInsideAllowedRoot(specsDir, deps.config.workspace.allowed_roots);
          await mkdir(specsDir, { recursive: true });

          const filename = `${date}-${slug}.md`;
          const target = join(specsDir, filename);
          await assertInsideAllowedRoot(target, deps.config.workspace.allowed_roots);

          // Overwrite policy + status-transition enforcement.
          let existingContent: string | null = null;
          try {
            const { readFile: readFileFs } = await import("node:fs/promises");
            existingContent = await readFileFs(target, "utf8");
          } catch {
            /* not present */
          }
          if (existingContent !== null && !parsed.force) {
            throw new McpError(
              "E_ALREADY_EXISTS",
              `${target} already exists — pass force=true to overwrite`,
            );
          }

          // Status-transition enforcement (followup #25 item 7).
          // Allowed: draft→accepted, draft→archived, accepted→archived.
          // archived is terminal. force=true bypasses (audited below).
          if (existingContent !== null) {
            const priorFm = extractFrontmatter(existingContent);
            const priorStatus = (priorFm?.["status"] as string | undefined) ?? "draft";
            const nextStatus = validated.status;
            if (!isLegalTransition(priorStatus, nextStatus)) {
              if (!parsed.force) {
                throw new McpError(
                  "E_STATE_INVALID",
                  `illegal spec status transition: ${priorStatus} → ${nextStatus}. Allowed: draft→accepted|archived, accepted→archived. archived is terminal. Pass force=true to override.`,
                );
              }
              // force=true path — will be noted in audit summary below.
              forcedTransition = `${priorStatus} → ${nextStatus}`;
            }
          }

          await writeFile(target, parsed.content, { encoding: "utf8" });

          // Index.
          const allTags = Array.from(
            new Set([...validated.tech_stack, ...validated.tags, ...validated.lens]),
          );
          deps.globalDb
            .prepare(
              `INSERT INTO specs (path, slug, tags, status, created_at, frontmatter_json)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                 slug = excluded.slug,
                 tags = excluded.tags,
                 status = excluded.status,
                 frontmatter_json = excluded.frontmatter_json`,
            )
            .run(
              target,
              slug,
              JSON.stringify(allTags),
              validated.status,
              Date.parse(validated.created) || Date.now(),
              JSON.stringify(validated),
            );

          const payload = success(
            [target],
            `Saved spec "${validated.title}" -> ${filename} (status=${validated.status}, tech_stack=${validated.tech_stack.length} tag(s))${forcedTransition ? ` [FORCE override: ${forcedTransition}]` : ""}.`,
            parsed.expand
              ? {
                  content: {
                    path: target,
                    slug,
                    date,
                    frontmatter: validated,
                    forced_transition: forcedTransition ?? undefined,
                  },
                }
              : {
                  expand_hint:
                    "Call spec_save with expand=true to receive the normalized frontmatter.",
                },
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "spec_save",
            scope: "global",
            inputs: { ...args, forced_transition_override: forcedTransition ?? undefined },
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

/** Reuse of the lightweight parser from primers/load.ts (copied to avoid cross-file coupling). */
function extractFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = raw.slice(3, end).trim();
  const obj: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: string = trimmed.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      obj[key] =
        inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    obj[key] = value;
  }
  return obj;
}

export { FrontmatterSchema as SpecFrontmatterSchema };

/**
 * Spec status transition whitelist (followup #25 item 7).
 *   draft    → accepted | archived
 *   accepted → archived
 *   archived → (terminal — no transitions allowed)
 *
 * Same-status writes (no transition) are always legal.
 */
export function isLegalTransition(from: string, to: string): boolean {
  if (from === to) return true; // same status: re-save is always allowed
  const allowed: Record<string, string[]> = {
    draft: ["accepted", "archived"],
    accepted: ["archived"],
    archived: [], // terminal
  };
  return (allowed[from] ?? []).includes(to);
}
