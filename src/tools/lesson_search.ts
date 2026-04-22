// lesson_search — project scope.
//
// Substring + tag AND-filter over the lessons log. Three scopes:
//   project  — read only project.db (default)
//   global   — read only the global lessons DB (all projects)
//   all      — read both, de-duplicate on (project_root, created_at, title)
// Rank: exact-phrase > startswith(title) > tag-hit count > created_at desc.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
    scope: z.enum(["project", "global", "all"]).default("project"),
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
  project_root: string | null;
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
  source: "project" | "global";
  score: number;
}

export function registerLessonSearch(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "lesson_search",
    {
      title: "Search Lessons",
      description:
        "Substring + tag AND-filter over the project and/or global lesson log. Returns ranked matches with matched_tags; pass expand=true for the observation bodies.",
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
          const projectRows =
            parsed.scope === "global" ? [] : readLessons(deps.projectDb, projectRoot);

          let globalRows: LessonRow[] = [];
          if (parsed.scope !== "project") {
            const globalDb = getGlobalLessonsDb(deps.config.lessons.global_db_path);
            if (globalDb === null) {
              // Operator has set `config.lessons.global_db_path: null` to
              // disable the cross-project mirror. Refuse the query rather
              // than silently returning an empty set — the caller asked for
              // cross-project data and needs to know the boundary is shut.
              throw new McpError(
                "E_SCOPE_DENIED",
                `lesson_search(scope="${parsed.scope}") is disabled: config.lessons.global_db_path is null. ` +
                  `Use scope="project" for this-project lessons, or re-enable the mirror in ~/.vcf/config.yaml.`,
              );
            }
            globalRows = readLessons(globalDb, null);
          }

          const candidates: Array<{ row: LessonRow; source: "project" | "global" }> = [
            ...projectRows.map((row) => ({ row, source: "project" as const })),
            ...globalRows.map((row) => ({ row, source: "global" as const })),
          ];

          // De-duplicate when scope=all: global mirror entries will show up
          // twice (once from project.db, once from lessons.db). Key on
          // (project_root, title, created_at) — collision odds are negligible
          // at ms granularity.
          const seen = new Set<string>();
          const deduped: Array<{ row: LessonRow; source: "project" | "global" }> = [];
          for (const c of candidates) {
            const key = `${c.row.project_root ?? projectRoot ?? ""}|${c.row.title}|${c.row.created_at}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(c);
          }

          const q = (parsed.query ?? "").toLowerCase();
          const ranked: RankedLesson[] = [];
          for (const { row, source } of deduped) {
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
            ranked.push({ ...row, tags, matched_tags: matchedTags, source, score });
          }

          ranked.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.created_at - a.created_at;
          });
          const top = ranked.slice(0, parsed.limit);

          const summary = `lesson_search: ${top.length} match(es) (scope=${parsed.scope}, query=${parsed.query ? JSON.stringify(parsed.query) : "∅"}, tags=${parsed.tags.join(",") || "∅"})`;

          return success([], summary, {
            content: {
              matches: top.map((r) => ({
                id: r.id,
                source: r.source,
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
              total_considered: deduped.length,
              returned: top.length,
            },
            ...(parsed.expand
              ? {}
              : { expand_hint: "Pass expand=true for observation + context bodies." }),
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

function readLessons(
  db: import("node:sqlite").DatabaseSync,
  projectRoot: string | null,
): LessonRow[] {
  // Try to read project_root if present in the row (global DB has it).
  // Project DB rows lack that column — fall back to the caller-supplied root.
  try {
    const rows = db
      .prepare(
        `SELECT id, project_root, title, context, observation, actionable_takeaway,
                scope, stage, tags_json, created_at
           FROM lessons`,
      )
      .all() as unknown as LessonRow[];
    return rows;
  } catch {
    const rows = db
      .prepare(
        `SELECT id, title, context, observation, actionable_takeaway,
                scope, stage, tags_json, created_at
           FROM lessons`,
      )
      .all() as unknown as Omit<LessonRow, "project_root">[];
    return rows.map((r) => ({ ...r, project_root: projectRoot }));
  }
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
