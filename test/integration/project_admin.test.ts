import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { upsertProject, setProjectRole, getProjectByName } from "../../src/util/projectRegistry.js";
import { adoptProject } from "../../src/project/adopt.js";
import { moveProject } from "../../src/project/move.js";
import { renameProject } from "../../src/project/rename.js";
import { relocateProject } from "../../src/project/relocate.js";
import type { ResolvedScope } from "../../src/scope.js";

// Phase F — cross-project admin surfaces. Exercises the four operation
// cores (move/rename/relocate/set-role) plus the PM-gate on MCP tool
// registration.

interface Envelope {
  ok: boolean;
  code?: string;
  summary?: string;
  content?: unknown;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("Phase F — project admin (move / rename / relocate / PM role)", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-pf-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-pf-home-")));
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function makeConfig() {
    return ConfigSchema.parse({
      version: 1,
      workspace: {
        allowed_roots: [workRoot],
        ideas_dir: join(workRoot, "ideas"),
        specs_dir: join(workRoot, "specs"),
      },
      endpoints: [
        {
          name: "local-stub",
          provider: "local-stub",
          base_url: "http://127.0.0.1:1",
          trust_level: "local",
        },
      ],
      kb: { root: join(home, ".vcf", "kb") },
    });
  }

  describe("moveProject core", () => {
    it("copy mode: copies source to target, updates both DBs, leaves source intact", async () => {
      const src = join(workRoot, "proj-a");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "README.md"), "# Proj A\n");
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "Proj A",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });

      const dst = join(workRoot, "moved-proj-a");
      const r = await moveProject({
        slug: "proj-a",
        newPath: dst,
        mode: "copy",
        force: false,
        allowedRoots: [workRoot],
        globalDb,
        homeDir: home,
      });
      expect(r.newPath).toBe(dst);
      expect(r.mode).toBe("copy");
      expect(existsSync(src)).toBe(true);
      expect(existsSync(dst)).toBe(true);
      expect(await readFile(join(dst, "README.md"), "utf8")).toContain("# Proj A");
      // Registry points at new path.
      const row = getProjectByName(globalDb, "proj-a");
      expect(row?.root_path).toBe(dst);
      // project.db's project row also updated.
      const pdb = openProjectDb({ path: join(home, ".vcf", "projects", "proj-a", "project.db") });
      const pr = pdb.prepare("SELECT root_path FROM project WHERE id=1").get() as
        | { root_path: string }
        | undefined;
      expect(pr?.root_path).toBe(dst);
      pdb.close();
    });

    it("move mode: deletes source after success", async () => {
      const src = join(workRoot, "proj-b");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "README.md"), "# B\n");
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "Proj B",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });
      const dst = join(workRoot, "new-b");
      await moveProject({
        slug: "proj-b",
        newPath: dst,
        mode: "move",
        force: false,
        allowedRoots: [workRoot],
        globalDb,
        homeDir: home,
      });
      expect(existsSync(src)).toBe(false);
      expect(existsSync(dst)).toBe(true);
    });

    it("rejects target outside allowed_roots", async () => {
      const src = join(workRoot, "proj-c");
      await mkdir(src, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "Proj C",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });
      const outsidePath = join(tmpdir(), "out-of-scope-target-xyz");
      await expect(
        moveProject({
          slug: "proj-c",
          newPath: outsidePath,
          mode: "copy",
          force: false,
          allowedRoots: [workRoot],
          globalDb,
          homeDir: home,
        }),
      ).rejects.toMatchObject({ code: "E_SCOPE_DENIED" });
    });
  });

  describe("renameProject core", () => {
    it("renames slug, state-dir, and project.db.name", async () => {
      const src = join(workRoot, "original");
      await mkdir(src, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "Original",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });

      const r = await renameProject({
        slug: "original",
        newName: "Renamed Clean",
        globalDb,
        homeDir: home,
      });
      expect(r.oldSlug).toBe("original");
      expect(r.newSlug).toBe("renamed-clean");
      expect(r.stateDirRenamed).toBe(true);
      // Registry carries the new slug; old slug is gone.
      expect(getProjectByName(globalDb, "original")).toBeNull();
      expect(getProjectByName(globalDb, "renamed-clean")).not.toBeNull();
      // State-dir moved.
      expect(existsSync(join(home, ".vcf", "projects", "original"))).toBe(false);
      expect(existsSync(join(home, ".vcf", "projects", "renamed-clean", "project.db"))).toBe(true);
    });

    it("rejects when new slug collides with an existing project", async () => {
      const a = join(workRoot, "a");
      const b = join(workRoot, "b");
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({ root: a, name: "Alpha", state: "reviewing", globalDb, homeDir: home });
      await adoptProject({ root: b, name: "Beta", state: "reviewing", globalDb, homeDir: home });
      await expect(
        renameProject({ slug: "alpha", newName: "Beta", globalDb, homeDir: home }),
      ).rejects.toMatchObject({ code: "E_ALREADY_EXISTS" });
    });
  });

  describe("relocateProject core", () => {
    it("updates root_path without touching the filesystem", async () => {
      const src = join(workRoot, "src-rel");
      const moved = join(workRoot, "moved-rel");
      await mkdir(src, { recursive: true });
      await mkdir(moved, { recursive: true }); // operator moved the dir manually
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "RelProj",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });

      const r = await relocateProject({
        slug: "relproj",
        newPath: moved,
        allowedRoots: [workRoot],
        globalDb,
        homeDir: home,
      });
      expect(r.oldPath).toBe(src);
      expect(r.newPath).toBe(moved);
      // Old src still on disk (we didn't touch the filesystem).
      expect(existsSync(src)).toBe(true);
      // Registry re-pointed.
      expect(getProjectByName(globalDb, "relproj")?.root_path).toBe(moved);
    });

    it("rejects when new path doesn't exist", async () => {
      const src = join(workRoot, "src-rel-2");
      await mkdir(src, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: src,
        name: "RelProj2",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });
      await expect(
        relocateProject({
          slug: "relproj2",
          newPath: join(workRoot, "does-not-exist"),
          allowedRoots: [workRoot],
          globalDb,
          homeDir: home,
        }),
      ).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    });
  });

  describe("PM role MCP tool-registration gate", () => {
    async function connectProject(role: "standard" | "pm", slug: string) {
      const projectDir = join(workRoot, slug);
      await mkdir(projectDir, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      upsertProject(globalDb, { name: slug, root_path: projectDir, state: "reviewing" });
      setProjectRole(globalDb, slug, role);

      const dbPath = join(home, ".vcf", "projects", slug, "project.db");
      const projectDb = openProjectDb({ path: dbPath });
      const now = Date.now();
      projectDb
        .prepare(
          `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
           VALUES (1, ?, ?, 'reviewing', ?, ?)`,
        )
        .run(slug, projectDir, now, now);

      const resolved: ResolvedScope = {
        scope: "project",
        projectRoot: projectDir,
        projectSlug: slug,
        projectDbPath: dbPath,
        projectRole: role,
      };
      const server = createServer({
        scope: "project",
        resolved,
        config: makeConfig(),
        globalDb,
        projectDb,
        homeDir: home,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await client.connect(b);
      return { client, globalDb, projectDb };
    }

    it("PM session exposes project_move / project_rename / project_relocate", async () => {
      const { client } = await connectProject("pm", "pm-project");
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      expect(names.has("project_move")).toBe(true);
      expect(names.has("project_rename")).toBe(true);
      expect(names.has("project_relocate")).toBe(true);
    });

    it("standard session does NOT expose the admin tools", async () => {
      const { client } = await connectProject("standard", "std-project");
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      expect(names.has("project_move")).toBe(false);
      expect(names.has("project_rename")).toBe(false);
      expect(names.has("project_relocate")).toBe(false);
      // But baseline project-scope tools are still there.
      expect(names.has("plan_context")).toBe(true);
      expect(names.has("review_prepare")).toBe(true);
    });
  });

  describe("project_set_role (global-scope tool)", () => {
    it("promotes a project to PM and demotes back to standard", async () => {
      const projectDir = join(workRoot, "target");
      await mkdir(projectDir, { recursive: true });
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      await adoptProject({
        root: projectDir,
        name: "Target",
        state: "reviewing",
        globalDb,
        homeDir: home,
      });
      expect(getProjectByName(globalDb, "target")?.role).toBe("standard");

      const resolved: ResolvedScope = { scope: "global" };
      const server = createServer({
        scope: "global",
        resolved,
        config: makeConfig(),
        globalDb,
        homeDir: home,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await client.connect(b);

      const promote = parseResult(
        await client.callTool({
          name: "project_set_role",
          arguments: { slug: "target", role: "pm" },
        }),
      );
      expect(promote.ok).toBe(true);
      expect(getProjectByName(globalDb, "target")?.role).toBe("pm");

      const demote = parseResult(
        await client.callTool({
          name: "project_set_role",
          arguments: { slug: "target", role: "standard" },
        }),
      );
      expect(demote.ok).toBe(true);
      expect(getProjectByName(globalDb, "target")?.role).toBe("standard");

      const miss = parseResult(
        await client.callTool({
          name: "project_set_role",
          arguments: { slug: "no-such-project", role: "pm" },
        }),
      );
      expect(miss.ok).toBe(false);
      expect(miss.code).toBe("E_NOT_FOUND");
    });
  });
});
