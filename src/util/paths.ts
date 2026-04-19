// Path-scope enforcement.
//
// Every tool that accepts a path from a client argument routes it through
// `assertInsideAllowedRoot` before any open/stat/write. Symlinks are resolved
// with fs.realpath so a symlink pointing outside the allowed tree is caught;
// the official MCP filesystem server's 2026 EscapeRoute CVE was exactly this
// missing step.
//
// Errors here bubble as `PathError` with stable codes so the MCP envelope
// layer (M2.5) can translate them uniformly.

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PathError";
  }
}

const ENCODED_TRAVERSAL = /%2e%2e|%2e\.|\.%2e/i;

/**
 * Return a canonical, symlink-resolved absolute path, but only if it lives
 * inside one of `allowedRoots`. Throws PathError otherwise.
 *
 * Rules:
 * - input must be absolute (client is responsible for resolving relatives)
 * - URL-encoded `..` is rejected pre-resolution (attacker shortcut)
 * - the resolved real path must be equal to, or a descendant of, some
 *   allowed root (also realpath-resolved) — string prefix tricks don't cut
 *   it; we use path.relative to avoid `/allowed2` matching `/allowed`
 */
export async function assertInsideAllowedRoot(
  input: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathError("E_PATH_INVALID", "path must be a non-empty string");
  }
  if (!isAbsolute(input)) {
    throw new PathError("E_PATH_NOT_ABSOLUTE", "path must be absolute", { input });
  }
  if (ENCODED_TRAVERSAL.test(input)) {
    throw new PathError("E_PATH_ENCODED_ESCAPE", "url-encoded path traversal rejected", { input });
  }
  if (allowedRoots.length === 0) {
    throw new PathError("E_SCOPE_EMPTY", "no allowed_roots configured — refusing path access");
  }

  // resolve() collapses `..` and normalizes separators. realpath() follows
  // symlinks so the check operates on the true target.
  const logical = resolve(input);
  const real = await safeRealpath(logical);

  // Resolve roots once. We don't realpath roots lazily per-call in a hot
  // loop; the caller wires the canonicalized roots through config boot.
  for (const root of allowedRoots) {
    if (!isAbsolute(root)) continue;
    const rootLogical = resolve(root);
    const rootReal = await safeRealpath(rootLogical);
    if (isInside(rootReal, real)) return real;
  }
  throw new PathError("E_SCOPE_DENIED", "path is outside allowed_roots", { input, real });
}

/**
 * Realpath with a sensible fallback for paths that don't exist yet. A tool
 * that wants to *create* a file needs to validate the intended target — the
 * leaf won't resolve via realpath, but the parent chain will. We walk up
 * until we find a component that exists, realpath that, and re-append the
 * missing tail. The combined path is then re-checked by the caller.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // Try parents until one resolves.
    const parts = p.split(sep);
    const trailing: string[] = [];
    while (parts.length > 1) {
      trailing.unshift(parts.pop() ?? "");
      const parent = parts.join(sep) || sep;
      try {
        const real = await realpath(parent);
        return resolve(real, ...trailing);
      } catch {
        // keep walking up
      }
    }
    // Nothing on the chain resolved — return the logical path. Caller's
    // scope check will still reject anything outside the allowed roots.
    return p;
  }
}

/** `parent` contains `child` iff the relative path stays inside. */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Pre-canonicalize the allowed_roots list at boot so hot-path checks don't
 * realpath the same N roots on every call. If a declared root doesn't exist
 * we fall back to the logical path — the server still boots, but calls that
 * resolve under the missing tree will fail on their own realpath step.
 */
export async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new PathError("E_SCOPE_CONFIG", "allowed_roots entries must be absolute", { root });
    }
    try {
      out.push(await realpath(root));
    } catch {
      out.push(resolve(root));
    }
  }
  return out;
}
