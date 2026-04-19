// Template rendering + bundled-template location resolver.
//
// Templates live in the package under `templates/` (alongside `src/`). At
// runtime we resolve their path relative to this module; `tsup` copies the
// templates directory into dist/ via package.json `files` so the installed
// package carries them.
//
// Rendering is deliberately trivial — `{{VARIABLE}}` substitution, no
// conditionals, no loops. Anything richer belongs in generated code, not
// templates.

import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the templates/ dir regardless of whether we're running from src/
 * (dev, via tsx) or dist/ (published). Both are siblings of this file after
 * build; in dev, templates/ lives one level up from src/util/.
 */
export function templatesDir(): string {
  // When running from src/util/templates.ts: ../../templates
  // When running from dist/util/templates.js: ../../templates (tsup preserves layout)
  return resolvePath(__dirname, "..", "..", "templates");
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
