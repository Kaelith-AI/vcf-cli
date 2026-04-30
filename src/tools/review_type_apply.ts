// review_type_apply — global scope. Followup #21 (companion to
// review_type_create).
//
// Writes the stage files + reviewer overlay a calling LLM produced during
// the review_type_create scaffolding flow. Does NOT mutate
// config.review.categories — that's an operator decision, not a tool's.
// Returns the slug the operator needs to add to config if they want the
// type picked up by review_prepare.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const StageBody = z
  .object({
    stage_number: z.number().int().min(1).max(15),
    body: z.string().min(64).max(100_000),
  })
  .strict();

const ReviewTypeApplyInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "review type name must be lowercase kebab-case"),
    stages: z.array(StageBody).min(1).max(15),
    reviewer_overlay: z.string().min(64).max(100_000),
    force: z
      .boolean()
      .default(false)
      .describe(
        "overwrite existing stage + overlay files if present (default: refuse if any target exists)",
      ),
    expand: z.boolean().default(true),
  })
  .strict();

type ReviewTypeApplyArgs = z.infer<typeof ReviewTypeApplyInput>;

export function registerReviewTypeApply(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "review_type_apply",
    {
      title: "Apply a New Review Type to KB",
      description:
        "Writes stage files + reviewer overlay produced during the review_type_create flow to <kb>/review-system/<name>/ and <kb>/reviewers/reviewer-<name>.md. Does NOT mutate config.review.categories — returns the slug the operator adds manually. force=true overwrites existing files.",
      inputSchema: ReviewTypeApplyInput,
    },
    async (args: ReviewTypeApplyArgs) => {
      return runTool(
        async () => {
          const parsed = ReviewTypeApplyInput.parse(args);
          const kbRoot = deps.config.kb.root;

          // Deduplicate stage_numbers.
          const seen = new Set<number>();
          for (const s of parsed.stages) {
            if (seen.has(s.stage_number)) {
              throw new McpError(
                "E_VALIDATION",
                `duplicate stage_number ${s.stage_number} in stages[]`,
              );
            }
            seen.add(s.stage_number);
          }

          const stageDir = join(kbRoot, "review-system", parsed.name);
          const reviewerPath = join(kbRoot, "reviewers", `reviewer-${parsed.name}.md`);

          // Refuse to clobber unless force=true.
          if (!parsed.force) {
            if (existsSync(stageDir)) {
              throw new McpError(
                "E_ALREADY_EXISTS",
                `${stageDir} already exists — pass force=true to overwrite`,
              );
            }
            if (existsSync(reviewerPath)) {
              throw new McpError(
                "E_ALREADY_EXISTS",
                `${reviewerPath} already exists — pass force=true to overwrite`,
              );
            }
          }

          await mkdir(stageDir, { recursive: true });
          await mkdir(dirname(reviewerPath), { recursive: true });

          const writtenPaths: string[] = [];
          for (const stage of parsed.stages) {
            const stagePath = join(
              stageDir,
              `stage-${String(stage.stage_number).padStart(2, "0")}-${parsed.name}.md`,
            );
            await writeFile(stagePath, stage.body, "utf8");
            writtenPaths.push(stagePath);
          }
          await writeFile(reviewerPath, parsed.reviewer_overlay, "utf8");
          writtenPaths.push(reviewerPath);

          const alreadyRegistered = deps.config.review.categories.includes(parsed.name);
          const operatorInstructions = alreadyRegistered
            ? `'${parsed.name}' is already in config.review.categories — no further action needed.`
            : `Add '${parsed.name}' to config.review.categories in ~/.vcf/config.yaml to activate the new review type. Until then, review_prepare rejects type='${parsed.name}' with E_VALIDATION.`;

          const summary = alreadyRegistered
            ? `review_type_apply: wrote ${parsed.stages.length} stage file(s) + overlay for '${parsed.name}' (${writtenPaths.length} files total). Type is already in config.review.categories — active.`
            : `review_type_apply: wrote ${parsed.stages.length} stage file(s) + overlay for '${parsed.name}' (${writtenPaths.length} files total). Type '${parsed.name}' registered. Add it to config.review.categories to activate it in review runs.`;

          return success(writtenPaths, summary, {
            ...(parsed.expand
              ? {
                  content: {
                    name: parsed.name,
                    stage_count: parsed.stages.length,
                    stage_paths: writtenPaths.slice(0, -1),
                    reviewer_path: reviewerPath,
                    already_registered: alreadyRegistered,
                    operator_instructions: operatorInstructions,
                  },
                }
              : {}),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "review_type_apply",
            scope: "global",
            project_root: null,
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

export { ReviewTypeApplyInput };
