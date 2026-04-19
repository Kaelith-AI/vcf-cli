// Launch-scope detection for the MCP server.
//
// The server runs in exactly one scope per process:
//
//   --scope global  → exposes idea / spec / project-init / catalog tools.
//                     The server may run anywhere; no project DB required.
//
//   --scope project → exposes the full lifecycle (plan/build/test/review/
//                     ship). The server refuses to boot unless
//                     <cwd>/.vcf/project.db exists — otherwise the LLM
//                     would see lifecycle tools that can't actually run
//                     because state hasn't been initialized.
//
// `vcf init` writes the project-local .mcp.json that launches this server
// with `--scope project` whenever the user opens the project in an MCP
// client.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpError } from "./errors.js";

export type Scope = "global" | "project";

export interface ResolveScopeInput {
  requested: Scope;
  cwd: string;
}

export interface ResolvedScope {
  scope: Scope;
  /** Absolute path to <cwd>/.vcf if scope is project, undefined for global. */
  vcfDir?: string;
  /** Absolute path to <cwd>/.vcf/project.db if scope is project, undefined for global. */
  projectDbPath?: string;
}

/**
 * Confirm the requested scope matches reality. On mismatch, throw a stable
 * McpError so the binary can print a clear message and exit with a
 * documented code.
 */
export function resolveScope(input: ResolveScopeInput): ResolvedScope {
  const cwd = resolve(input.cwd);
  if (input.requested === "global") {
    return { scope: "global" };
  }
  // project scope — verify the marker exists.
  const vcfDir = join(cwd, ".vcf");
  const dbPath = join(vcfDir, "project.db");
  if (!existsSync(vcfDir) || !statSync(vcfDir).isDirectory()) {
    throw new McpError(
      "E_STATE_INVALID",
      `project scope requested but ${vcfDir} is missing — run "vcf init" in this directory first`,
      { cwd, vcfDir },
    );
  }
  if (!existsSync(dbPath)) {
    throw new McpError(
      "E_STATE_INVALID",
      `project scope requested but ${dbPath} is missing — re-run "vcf init" to re-create it`,
      { cwd, dbPath },
    );
  }
  return { scope: "project", vcfDir, projectDbPath: dbPath };
}
