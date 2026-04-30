// Runtime role resolver.
//
// Roles are declared in config.yaml as `roles.<name>: {default | defaults, requires, vendor_diverse}`.
// At config load, ConfigSchema.superRefine validates:
//   - default model alias exists
//   - default model's endpoint is enabled
//   - role.requires ⊆ model.tags             (E_ROLE_CAPABILITY_MISMATCH)
//   - panel slots have unique vendors when vendor_diverse=true (E_PANEL_VENDOR_COLLISION)
//
// This module is the *call-site* lookup. Given a frozen Config and a role
// name, return the resolved model(s) the dispatcher should call. The
// runtime checks duplicate the load-time ones as defense in depth — config
// objects are deep-frozen, but tests may construct configs that bypass
// validation, and we want misuse to surface here rather than as a confusing
// error inside the LLM client.

import { McpError } from "../errors.js";
import type { Config, ModelAlias, Endpoint } from "../config/schema.js";

export interface ResolvedModel {
  /** The model_aliases[] entry whose `alias` matches the role's default. */
  model: ModelAlias;
  /** The endpoint the model points at. */
  endpoint: Endpoint;
  /** Convenience — model_aliases.model_id. */
  modelId: string;
}

/**
 * Resolve a singleton role (`role.default`) to {model, endpoint, modelId}.
 * Throws McpError on:
 *   - E_NOT_FOUND if the role isn't declared
 *   - E_VALIDATION if the role is configured as a panel (use resolveRolePanel)
 *   - E_VALIDATION if the role's default model alias / endpoint isn't found
 *   - E_ENDPOINT_DISABLED if the endpoint has enabled=false
 *   - E_ROLE_CAPABILITY_MISMATCH if model tags don't satisfy role.requires
 */
export function resolveRole(config: Config, roleName: string): ResolvedModel {
  const role = config.roles[roleName];
  if (!role) {
    throw new McpError("E_NOT_FOUND", `role '${roleName}' is not declared in config.roles`);
  }
  if (role.defaults !== undefined) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' is a panel (defaults[]); call resolveRolePanel() instead`,
    );
  }
  if (role.default === undefined) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' has no default — config validation should have caught this`,
    );
  }
  return resolveOne(config, roleName, role.default, role.requires);
}

/**
 * Resolve a panel role (`role.defaults`) to one ResolvedModel per slot.
 * Throws McpError on the same conditions as resolveRole, plus:
 *   - E_PANEL_VENDOR_COLLISION when vendor_diverse=true and two slots share a vendor
 */
export function resolveRolePanel(config: Config, roleName: string): ResolvedModel[] {
  const role = config.roles[roleName];
  if (!role) {
    throw new McpError("E_NOT_FOUND", `role '${roleName}' is not declared in config.roles`);
  }
  if (role.default !== undefined) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' is a singleton (default); call resolveRole() instead`,
    );
  }
  if (!role.defaults || role.defaults.length === 0) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' panel has no defaults — config validation should have caught this`,
    );
  }
  const resolved = role.defaults.map((alias) => resolveOne(config, roleName, alias, role.requires));
  if (role.vendor_diverse) {
    const seen = new Map<string, number>();
    for (const [i, r] of resolved.entries()) {
      if (!r.model.vendor) {
        throw new McpError(
          "E_PANEL_VENDOR_COLLISION",
          `role '${roleName}' panel slot ${i} model '${r.model.alias}' has no vendor; vendor_diverse=true requires it`,
        );
      }
      const prev = seen.get(r.model.vendor);
      if (prev !== undefined) {
        throw new McpError(
          "E_PANEL_VENDOR_COLLISION",
          `role '${roleName}' panel has duplicate vendor '${r.model.vendor}' (slots ${prev} and ${i})`,
        );
      }
      seen.set(r.model.vendor, i);
    }
  }
  return resolved;
}

/**
 * True when the role exists and is satisfiable (referenced model exists,
 * endpoint enabled, capability tags match). Returns false on any mismatch
 * — useful for soft fallback paths that prefer roles when configured but
 * accept legacy `defaults.<tool>` resolution otherwise.
 */
export function hasRole(config: Config, roleName: string): boolean {
  const role = config.roles[roleName];
  if (!role) return false;
  try {
    if (role.default !== undefined) resolveRole(config, roleName);
    else resolveRolePanel(config, roleName);
    return true;
  } catch {
    return false;
  }
}

// ---- internals -------------------------------------------------------------

function resolveOne(
  config: Config,
  roleName: string,
  aliasName: string,
  requires: readonly string[],
): ResolvedModel {
  const model = config.model_aliases.find((m) => m.alias === aliasName);
  if (!model) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' references unknown model alias '${aliasName}'`,
    );
  }
  const endpoint = config.endpoints.find((e) => e.name === model.endpoint);
  if (!endpoint) {
    throw new McpError(
      "E_VALIDATION",
      `role '${roleName}' model '${aliasName}' endpoint '${model.endpoint}' not in config.endpoints[]`,
    );
  }
  if (!endpoint.enabled) {
    throw new McpError(
      "E_ENDPOINT_DISABLED",
      `role '${roleName}' model '${aliasName}' uses disabled endpoint '${endpoint.name}'`,
    );
  }
  const missing = requires.filter((t) => !model.tags.includes(t));
  if (missing.length > 0) {
    throw new McpError(
      "E_ROLE_CAPABILITY_MISMATCH",
      `role '${roleName}' requires [${requires.join(", ")}] but model '${aliasName}' is missing [${missing.join(", ")}]`,
    );
  }
  return { model, endpoint, modelId: model.model_id };
}
