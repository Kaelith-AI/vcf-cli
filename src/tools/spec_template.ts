// spec_template — global scope.
//
// Returns the project spec template for the client's LLM to fill. The server
// does not drive the conversation; it hands back the template + any rich
// context the caller has assembled (an optional idea_ref slug to seed with).
// This is the "prepare" half of the prepare/execute split — the client's LLM
// owns the spec-writing conversation, then calls spec_save with the finished
// output.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { readTemplate, renderTemplate } from "../util/templates.js";
import { isoDate, slugify } from "../util/slug.js";
import { writeAudit } from "../util/audit.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { McpError } from "../errors.js";

const SpecTemplateInput = z
  .object({
    project_name: z
      .string()
      .min(1)
      .max(128)
      .describe("human-readable name; used for the template title and filename hint"),
    idea_ref: z
      .string()
      .optional()
      .describe("optional slug of an existing captured idea to seed the Raw Notes section with"),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerSpecTemplate(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "spec_template",
    {
      title: "Spec Template",
      description:
        "Return the project spec template (rendered with project name + today's date). If idea_ref is provided, seeds Raw Notes with that idea's body. The client LLM fills the template; spec_save persists the filled result.",
      inputSchema: SpecTemplateInput.shape,
    },
    async (args: z.infer<typeof SpecTemplateInput>) => {
      return runTool(
        async () => {
          const parsed = SpecTemplateInput.parse(args);
          // RAW_NOTES_SEED is the default content for the Raw Notes section.
          // When idea_ref is provided, the idea body is prepended before it.
          // We render it as a variable so the template engine can substitute
          // it along with PROJECT_NAME/DATE in a single pass, avoiding a
          // "missing variable" error on the placeholder token.
          const RAW_NOTES_SEED_DEFAULT =
            "_Use this section to preserve verbatim context from the capture conversation that doesn't fit above. A good PM spec can be reconstructed from the notes alone if the sections above are lost._";
          const rawTemplate = await readTemplate("spec-template.md.tpl");

          let withSeed: string;
          let seededPath: string | undefined;
          if (parsed.idea_ref !== undefined) {
            const row = deps.globalDb
              .prepare("SELECT path FROM ideas WHERE slug = ? ORDER BY created_at DESC LIMIT 1")
              .get(parsed.idea_ref) as { path: string } | undefined;
            if (!row) {
              throw new McpError("E_NOT_FOUND", `no idea with slug "${parsed.idea_ref}"`);
            }
            seededPath = await assertInsideAllowedRoot(
              row.path,
              deps.config.workspace.allowed_roots,
            );
            const ideaBody = await readFile(seededPath, "utf8");
            // Seed the Raw Notes section with the idea body, followed by the
            // default instructional text so the author still has the prompt.
            withSeed = renderTemplate(rawTemplate, {
              PROJECT_NAME: parsed.project_name,
              DATE: isoDate(),
              RAW_NOTES_SEED:
                "### From captured idea: " +
                parsed.idea_ref +
                "\n\n" +
                ideaBody +
                "\n\n" +
                RAW_NOTES_SEED_DEFAULT,
            });
          } else {
            withSeed = renderTemplate(rawTemplate, {
              PROJECT_NAME: parsed.project_name,
              DATE: isoDate(),
              RAW_NOTES_SEED: RAW_NOTES_SEED_DEFAULT,
            });
          }

          const slug = slugify(parsed.project_name);
          const targetFilename = `${isoDate()}-${slug}.md`;

          const payload = success(
            seededPath ? [seededPath] : [],
            `Spec template prepared for "${parsed.project_name}". Save as ${targetFilename} in specs_dir via spec_save.`,
            parsed.expand
              ? {
                  content: {
                    template: withSeed,
                    suggested_filename: targetFilename,
                    suggested_slug: slug,
                    ...(seededPath ? { seeded_from: seededPath } : {}),
                  },
                }
              : {},
          );
          return payload;
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "spec_template",
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
