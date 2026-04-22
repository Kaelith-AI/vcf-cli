// Template rendering + bundled-template location resolver.
//
// Templates live in the package under `templates/` (alongside `src/` and
// `dist/`). The package.json `files` array carries the directory into every
// publish, so both dev and installed runs can find it — the only variable is
// the current `import.meta.url`:
//   - dev:    {pkg}/src/util/templates.ts      → up 2 then /templates
//   - bundle: {pkg}/dist/{cli|mcp|server}.js   → up 1 then /templates
// tsup emits a FLAT dist/, not a mirrored src/ tree, so the old hardcoded
// `../../templates` overshoots by one level in production. Instead we walk
// up from the module until `package.json` appears and resolve from there.
//
// Rendering is deliberately trivial — `{{VARIABLE}}` substitution, no
// conditionals, no loops. Anything richer belongs in generated code, not
// templates.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up from `start` until we find a directory containing `package.json`.
 * Returns that directory (package root). Bails after 8 levels so a botched
 * install can't send us into an infinite loop.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolvePath(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: two-up is the dev source layout; preserves pre-fix behavior
  // for any exotic environment where package.json can't be found.
  return resolvePath(start, "..", "..");
}

const PACKAGE_ROOT = findPackageRoot(__dirname);

export function templatesDir(): string {
  return resolvePath(PACKAGE_ROOT, "templates");
}

export async function readTemplate(name: string): Promise<string> {
  return readFile(resolvePath(templatesDir(), name), "utf8");
}

export function renderTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`template: missing variable {{${key}}}`);
    const value = vars[key];
    if (value === undefined) throw new Error(`template: variable {{${key}}} is undefined`);
    return value;
  });
}
