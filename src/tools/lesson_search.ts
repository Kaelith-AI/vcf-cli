// lesson_search — project scope; reads the global lessons store.
//
// Followup #41: lessons live in one global store tagged with project_root.
// `filter` controls which rows the search considers:
//   current   — rows originating in this project (default)
//   universal — rows marked scope='universal' (cross-project guidance)
//   all       — everything in the store
//
// Ranking: exact-phrase > startswith(title) > tag-hit count > created_at desc.
// SQL pushdown for stage + tag LIKE + free-text cuts the candidate set at
// the DB layer; final scoring runs in-process over the bounded set.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ServerDeps } from "../server.js";
import { success, runTool } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { getGlobalLessonsDb } from "../db/globalLessons.js";

const TagToken = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "tags must be lowercase kebab-case");

const LessonSearchInput = z
  .object({
    query: z.string().max(512).optional(),
    tags: z.array(TagToken).max(16).default([]),
    filter: z.enum(["current", "universal", "all"]).default("current"),
    stage: z
      .enum(["draft", "planning", "building", "testing", "reviewing", "shipping", "shipped"])
      .optional(),
    limit: z.number().int().positive().max(200).default(20),
    expand: z.boolean().default(false),
  })
  .strict();

type LessonSearchArgs = z.infer<typeof LessonSearchInput>;

interface LessonRow {
  id: number;
  project_root: string;
  title: string;
  context: string | null;
  observation: string;
  actionable_takeaway: string | null;
  scope: string;
  stage: string | null;
  tags_json: string;
  created_at: number;
}

interface RankedLesson extends LessonRow {
  tags: string[];
  matched_tags: string[];
  score: number;
}

export function registerLessonSearch(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "lesson_search",
    {
      title: "Search Lessons",
      description:
        "Substring + tag AND-filter over the global lesson store. filter controls scope: current=this project, universal=cross-project guidance only, all=everything. Returns ranked matches with matched_tags; pass expand=true for observation bodies.",
      inputSchema: LessonSearchInput,
    },
    async (args: LessonSearchArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "lesson_search requires project scope");
          }
          const parsed = LessonSearchInput.parse(args);
          const projectRoot = readProjectRoot(deps);

          const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
          if (globalDb === null) {
            throw new McpError(
              "E_SCOPE_DENIED",
              `lesson_search is disabled: config.lessons.global_db_path is null. ` +
                `Re-enable the store in ~/.vcf/config.yaml to query lessons.`,
            );
          }

          const pushdown = {
            query: parsed.query ?? null,
            tags: parsed.tags,
            stage: parsed.stage ?? null,
            capLimit: Math.min(1000, parsed.limit * 5),
            filter: parsed.filter,
            projectRoot,
          };

          const rows = readLessonsFiltered(globalDb, pushdown);

          const q = (parsed.query ?? "").toLowerCase();
          const ranked: RankedLesson[] = [];
          for (const row of rows) {
            const tags = safeParseTags(row.tags_json);
            if (parsed.tags.length > 0) {
              const tagSet = new Set(tags);
              const hasAll = parsed.tags.every((t) => tagSet.has(t));
              if (!hasAll) continue;
            }
            if (parsed.stage && row.stage !== parsed.stage) continue;
            const haystack = `${row.title}\n${row.observation}\n${row.actionable_takeaway ?? ""}\n${row.context ?? ""}`;
            if (q.length > 0 && !haystack.toLowerCase().includes(q)) continue;

            const matchedTags = parsed.tags.filter((t) => tags.includes(t));
            const score = scoreLesson(row, q, matchedTags.length);
            ranked.push({ ...row, tags, matched_tags: matchedTags, score });
          }

          ranked.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.created_at - a.created_at;
          });
          const top = ranked.slice(0, parsed.limit);

          const summary = `lesson_search: ${top.length} match(es) (filter=${parsed.filter}, query=${parsed.query ? JSON.stringify(parsed.query) : "∅"}, tags=${parsed.tags.join(",") || "∅"})`;

          return success([], summary, {
            content: {
              matches: top.map((r) => ({
                id: r.id,
                project_root: r.project_root,
                title: r.title,
                scope: r.scope,
                stage: r.stage,
                tags: r.tags,
                matched_tags: r.matched_tags,
                score: r.score,
                created_at: r.created_at,
                ...(parsed.expand
                  ? {
                      observation: r.observation,
                      context: r.context,
                      actionable_takeaway: r.actionable_takeaway,
                    }
                  : {}),
              })),
              total_considered: rows.length,
              returned: top.length,
            },
            ...(parsed.expand ? {} : {}),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "lesson_search",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

interface PushdownOptions {
  query: string | null;
  tags: string[];
  stage: string | null;
  capLimit: number;
  filter: "current" | "universal" | "all";
  projectRoot: string | null;
}

function readLessonsFiltered(db: DatabaseSync, opts: PushdownOptions): LessonRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts.filter === "current") {
    if (!opts.projectRoot) return [];
    where.push("project_root = ?");
    params.push(opts.projectRoot);
  } else if (opts.filter === "universal") {
    where.push("scope = 'universal'");
  }

  if (opts.stage) {
    where.push("stage = ?");
    params.push(opts.stage);
  }
  for (const tag of opts.tags) {
    where.push("tags_json LIKE ?");
    params.push(`%"${tag}"%`);
  }
  if (opts.query && opts.query.length > 0) {
    where.push(
      "(LOWER(title) LIKE ? OR LOWER(observation) LIKE ? OR LOWER(COALESCE(actionable_takeaway,'')) LIKE ? OR LOWER(COALESCE(context,'')) LIKE ?)",
    );
    const like = `%${opts.query.toLowerCase()}%`;
    params.push(like, like, like, like);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT id, project_root, title, context, observation,
                      actionable_takeaway, scope, stage, tags_json, created_at
                 FROM lessons
                 ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT ${opts.capLimit}`;
  return db.prepare(sql).all(...params) as unknown as LessonRow[];
}

function safeParseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function scoreLesson(row: LessonRow, q: string, matchedTagCount: number): number {
  let s = matchedTagCount * 2;
  if (q.length === 0) return s;
  const title = row.title.toLowerCase();
  if (title === q) s += 10;
  else if (title.startsWith(q)) s += 5;
  else if (title.includes(q)) s += 3;
  if (row.observation.toLowerCase().includes(q)) s += 1;
  return s;
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { LessonSearchInput };
