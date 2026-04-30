// VCF-managed secrets file loader.
//
// Why this exists: the original design routed auth through process.env
// (`endpoints[].auth_env_var` names the env var; values resolve at call time).
// That works when the operator has full control of the shell that launches
// vcf-mcp. It DOES NOT work when Claude Code (or any IDE / desktop launcher)
// spawns vcf-mcp from a process tree that didn't source the operator's
// shell-startup file. We hit this in production: a user added LITELLM_MASTER_KEY
// to ~/.bashrc, restarted the terminal, and the MCP child still didn't see it
// because the GUI launcher → konsole → bash → claude → vcf-mcp chain skipped
// .bashrc somewhere.
//
// Fix: VCF owns its own secrets source. `~/.vcf/secrets.env` is a standard
// dotenv file (KEY=value, # comments, optional `export` prefix, optional quotes).
// At server boot we read it and merge into process.env — but ONLY for keys that
// aren't already set. That preserves the "explicit env wins" property so
// `LITELLM_MASTER_KEY=... vcf-mcp` overrides the file for testing.
//
// Security:
//   - The file is never written by VCF code. Operators create / edit it
//     themselves. (A future `vcf secrets set` CLI is a followup; for now,
//     edit with a text editor.)
//   - Values never appear in audit, logs, or tool returns. Loader returns
//     names only.
//   - chmod 600 enforcement is left to the operator (the loader warns on a
//     world-readable file but does not refuse to load — refusing breaks
//     ops, warning surfaces the issue).

import { existsSync, readFileSync, statSync } from "node:fs";

export interface SecretsLoadReport {
  /** Path that was attempted. Always present so callers can log it. */
  path: string;
  /** True if the file existed; false means "no file, nothing to load." */
  fileExists: boolean;
  /** Names of env vars that the file provided AND we set into process.env. */
  loaded: string[];
  /** Names that were already set in process.env; we skipped them. */
  skipped: string[];
  /** Names parsed but rejected (malformed, empty value, invalid name). */
  invalid: string[];
  /** True when the file's mode allows world or group read — operator should fix. */
  permissive: boolean;
  /** Octal mode of the file when it exists, e.g. "0600". */
  mode: string | null;
}

/**
 * Load a dotenv-style secrets file and merge into `process.env`.
 *
 * Existing process.env entries always win — this lets an operator override
 * a file value for one run by setting the env var explicitly.
 *
 * Returns a report with names only; the function never logs or returns
 * any secret value.
 */
export function loadSecretsEnv(path: string): SecretsLoadReport {
  const report: SecretsLoadReport = {
    path,
    fileExists: false,
    loaded: [],
    skipped: [],
    invalid: [],
    permissive: false,
    mode: null,
  };
  if (!existsSync(path)) return report;
  report.fileExists = true;

  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    report.mode = "0" + mode.toString(8).padStart(3, "0");
    // 0o077 = group + other bits. Anything set there is too permissive.
    if ((mode & 0o077) !== 0) report.permissive = true;
  } catch {
    /* stat failures are non-fatal — proceed with mode unknown */
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return report;
  }

  for (const entry of parseDotenv(raw)) {
    if (entry.kind === "invalid") {
      report.invalid.push(entry.name);
      continue;
    }
    if (process.env[entry.name] !== undefined) {
      report.skipped.push(entry.name);
      continue;
    }
    process.env[entry.name] = entry.value;
    report.loaded.push(entry.name);
  }

  return report;
}

interface ParsedEntry {
  kind: "valid" | "invalid";
  name: string;
  value: string;
}

/**
 * Parse a dotenv-style file body. Handles:
 *   - blank lines and # comments (skipped)
 *   - optional `export KEY=value` prefix (stripped — bashrc compat)
 *   - single-quoted, double-quoted, or unquoted values
 *   - inline trailing comments after unquoted values (`KEY=val # note`)
 *
 * Multi-line values are NOT supported. Variable interpolation
 * (`KEY=$OTHER`) is NOT supported — values are treated literally so a
 * literal `$` doesn't get expanded into something surprising.
 *
 * Exported only for tests; production code goes through `loadSecretsEnv`.
 */
export function parseDotenv(body: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx <= 0) {
      out.push({ kind: "invalid", name: stripped.slice(0, 64), value: "" });
      continue;
    }

    const name = stripped.slice(0, eqIdx).trim();
    if (!isValidEnvName(name)) {
      out.push({ kind: "invalid", name: name.slice(0, 64), value: "" });
      continue;
    }

    let valuePart = stripped.slice(eqIdx + 1);
    valuePart = valuePart.replace(/^[ \t]+/, "");

    let value: string;
    if (valuePart.startsWith('"')) {
      const close = findClosingQuote(valuePart, '"');
      if (close < 0) {
        out.push({ kind: "invalid", name, value: "" });
        continue;
      }
      value = valuePart.slice(1, close);
    } else if (valuePart.startsWith("'")) {
      const close = findClosingQuote(valuePart, "'");
      if (close < 0) {
        out.push({ kind: "invalid", name, value: "" });
        continue;
      }
      value = valuePart.slice(1, close);
    } else {
      // Unquoted: strip an inline trailing comment (` # ...`).
      const hashIdx = valuePart.search(/\s+#/);
      value = (hashIdx >= 0 ? valuePart.slice(0, hashIdx) : valuePart).trimEnd();
    }

    if (value === "") {
      // Empty values are valid in some .env conventions but useless for our
      // use case (an unset key vs. an empty key is the same to us). Treat
      // as invalid so operators don't accidentally clear an inherited env
      // var via a typo.
      out.push({ kind: "invalid", name, value: "" });
      continue;
    }

    out.push({ kind: "valid", name, value });
  }
  return out;
}

function isValidEnvName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

function findClosingQuote(s: string, q: '"' | "'"): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\" && q === '"') {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}
