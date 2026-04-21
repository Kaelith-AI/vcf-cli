// idea_capture — global scope.
//
// Contract: take a freeform idea string (+ optional context + tags), write
// a timestamped markdown file under workspace.ideas_dir with validated
// frontmatter, and index the row in the global DB's `ideas` table.
//
// Envelope: returns { paths: [written-file], summary }. With expand=true,
// also returns the rendered markdown as content.
//
// Non-negotiables enforced here:
//  - the target path is re-validated against allowed_roots (no client can
//    aim this outside the ideas_dir)
//  - tags are lowercase kebab-case only
//  - duplicate slugs on the same day get a -NN suffix rather than silently
//    overwriting

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerDeps } from "../server.js";
import { success, runTool } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { slugify, isoDate } from "../util/slug.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const IdeaCaptureInput = z
  .object({
    content: z.string().min(1).max(10_000).describe("the idea body (markdown)"),
    context: z.string().max(4_000).optional().describe("optional context / source / link"),
    title: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("optional explicit title; derived from content if omitted"),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(16)
      .default([])
      .describe("lowercase kebab-case tags for search"),
    expand: z.boolean().default(false),
  })
  .strict();

type IdeaCaptureArgs = z.infer<typeof IdeaCaptureInput>;

export function registerIdeaCapture(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "idea_capture",
    {
      title: "Capture Idea",
      description:
        "Persist a captured idea under workspace.ideas_dir/YYYY-MM-DD-<slug>.md with validated frontmatter and index in the global DB. Returns {paths, summary}; pass expand=true to include the written markdown.",
      inputSchema: IdeaCaptureInput.shape,
    },
    async (args: IdeaCaptureArgs) => {
      return runTool(
        async () => {
          const parsed = IdeaCaptureInput.parse(args);
          const ideasDir = deps.config.workspace.ideas_dir;
          await assertInsideAllowedRoot(ideasDir, deps.config.workspace.allowed_roots);
          await mkdir(ideasDir, { recursive: true });

          const titleSource = parsed.title ?? parsed.content.split("\n")[0] ?? "untitled";
          const baseSlug = slugify(titleSource);
          const date = isoDate();
          const { target, slug } = await pickNonConflictingPath(ideasDir, date, baseSlug);

          // Re-validate the final target after we've computed it.
          await assertInsideAllowedRoot(target, deps.config.workspace.allowed_roots);

          const frontmatter = {
            type: "idea",
            slug,
            title: titleSource.slice(0, 256),
            created: new Date().toISOString(),
            tags: parsed.tags,
            ...(parsed.context !== undefined ? { context: parsed.context } : {}),
          };
          const markdown = renderMarkdown(frontmatter, parsed.content);
          await writeFile(target, markdown, { encoding: "utf8", flag: "wx" }).catch(
            (err: NodeJS.ErrnoException) => {
              if (err.code === "EEXIST") {
                throw new McpError("E_ALREADY_EXISTS", `${target} already exists`);
              }
              throw err;
            },
          );

          // Index in the global DB.
          deps.globalDb
            .prepare(
              `INSERT INTO ideas (path, slug, tags, created_at, frontmatter_json)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              target,
              slug,
              JSON.stringify(parsed.tags),
              Date.now(),
              JSON.stringify(frontmatter),
            );

          return success(
            [target],
            `Captured idea "${slug}" with ${parsed.tags.length} tag(s).`,
            parsed.expand
              ? { content: markdown }
              : {
                  expand_hint:
                    'Call idea_capture with {"expand": true} next time to receive the rendered markdown.',
                },
          );
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "idea_capture",
            scope: "global",
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

/**
 * Pick a non-conflicting path like YYYY-MM-DD-slug.md, incrementing -NN on
 * collision so two captures on the same day don't race.
 */
async function pickNonConflictingPath(
  dir: string,
  date: string,
  baseSlug: string,
): Promise<{ target: string; slug: string }> {
  let suffix = 0;
  while (true) {
    const slug = suffix === 0 ? baseSlug : `${baseSlug}-${String(suffix).padStart(2, "0")}`;
    const filename = `${date}-${slug}.md`;
    const target = join(dir, filename);
    try {
      await stat(target);
      suffix++;
      if (suffix > 99) throw new McpError("E_INTERNAL", "too many same-day collisions");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Ensure parent exists (should already from caller's mkdir but safe).
        await mkdir(dirname(target), { recursive: true });
        return { target, slug };
      }
      throw err;
    }
  }
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}
