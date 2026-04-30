// `vcf config upgrade` — opt-in helper that adds the new role-based fields
// (endpoint.kind, model_alias.vendor, model_alias.tags, roles) to an
// existing config.yaml without changing semantics.
//
// The 0.7 schema is purely additive: legacy configs continue to validate
// because every new field has a default. This command exists to remove
// the friction of *adopting* the new fields — typing `vendor: anthropic`
// for every claude alias is busywork that nobody wants to do twice.
//
// What it does:
//   - Adds `kind: api` to endpoints lacking it (cosmetic — same default).
//   - Adds `vendor: <inferred>` to model_aliases lacking it, for known
//     model-id prefixes (claude → anthropic, gpt → openai, etc.).
//   - Adds `tags: []  # TODO: declare capabilities` to model_aliases
//     lacking tags so the operator notices the field exists.
//   - Appends a commented-out `roles:` scaffolding block when no roles
//     are configured yet.
//
// What it does NOT do:
//   - Guess capability tags (frontier/local/web_search/...) — too
//     deployment-specific to auto-fill correctly.
//   - Auto-create role bindings — the operator must pick which model
//     plays which role given their lineup.
//   - Touch fields that are already set.
//
// Output modes:
//   --dry-run            print the upgraded YAML to stdout
//   default              write to <config>.upgraded (operator renames)
//   --apply              backup to <config>.bak-<ts> + overwrite <config>

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { log, vcfHomeDir } from "./_shared.js";

export interface UpgradeOptions {
  config?: string;
  dryRun?: boolean;
  apply?: boolean;
}

interface UpgradeReport {
  endpointsTouched: number;
  aliasesTouched: number;
  rolesScaffoldAdded: boolean;
  unknownVendors: string[];
}

/**
 * Map a model_id prefix to the model's vendor. Returns null when the prefix
 * doesn't match anything in the seed table — the operator must fill in
 * the vendor manually for those.
 *
 * Exported for test coverage; the inference table is the load-bearing
 * heuristic in this command.
 */
export function inferVendor(modelId: string): string | null {
  const id = modelId.toLowerCase();
  // Prefix-match table. Order matters when prefixes overlap (gpt vs gemma);
  // we list the longer/more-specific prefix first.
  const table: Array<[RegExp, string]> = [
    [/^claude/, "anthropic"],
    [/^chatgpt/, "openai"],
    [/^o[1-9]/, "openai"],
    [/^gpt/, "openai"],
    [/^gemma/, "google"],
    [/^gemini/, "google"],
    [/^palm/, "google"],
    [/^llama/, "meta"],
    [/^meta-/, "meta"],
    [/^codellama/, "meta"],
    [/^mistral/, "mistral"],
    [/^mixtral/, "mistral"],
    [/^qwen/, "qwen"],
    [/^deepseek/, "deepseek"],
    [/^grok/, "xai"],
    [/^command-/, "cohere"],
    [/^cohere/, "cohere"],
    [/^phi-/, "microsoft"],
    [/^phi[0-9]/, "microsoft"],
  ];
  for (const [re, vendor] of table) {
    if (re.test(id)) return vendor;
  }
  // Strip a leading namespace segment (e.g. "CLIProxyAPI/gpt-5.4" → "gpt-5.4")
  // and retry once. Operators commonly route through proxies that prefix.
  if (id.includes("/")) {
    const tail = id.slice(id.lastIndexOf("/") + 1);
    if (tail !== id) return inferVendor(tail);
  }
  return null;
}

/**
 * Mutate the YAML document in place to fill in missing endpoint.kind,
 * model_alias.vendor + tags, and append a roles scaffold when absent.
 * Returns a report so the CLI can print what changed.
 */
export function upgradeConfigDoc(doc: Document.Parsed): UpgradeReport {
  const report: UpgradeReport = {
    endpointsTouched: 0,
    aliasesTouched: 0,
    rolesScaffoldAdded: false,
    unknownVendors: [],
  };

  const endpoints = doc.get("endpoints");
  if (isSeq(endpoints)) {
    for (const node of endpoints.items) {
      if (!isMap(node)) continue;
      if (!node.has("kind")) {
        // Insert kind right after name for readability.
        insertAfter(node, "name", "kind", "api");
        report.endpointsTouched++;
      }
    }
  }

  const aliases = doc.get("model_aliases");
  if (isSeq(aliases)) {
    for (const node of aliases.items) {
      if (!isMap(node)) continue;
      const modelId = node.get("model_id");
      if (typeof modelId !== "string") continue;

      let touched = false;
      if (!node.has("vendor")) {
        const vendor = inferVendor(modelId);
        if (vendor) {
          insertAfter(node, "model_id", "vendor", vendor);
          touched = true;
        } else {
          // Unknown — don't insert; let the operator add it. Track for the
          // post-run summary so they know which entries need attention.
          report.unknownVendors.push(modelId);
        }
      }

      if (!node.has("tags")) {
        // Empty tags list with a comment hint — capability tags are too
        // deployment-specific to auto-infer (a claude-opus alias on a
        // public endpoint is frontier+web_search, but on a local proxy
        // routing through a smaller model it might not be).
        const seq = doc.createNode([]) as YAMLSeq;
        seq.flow = true;
        seq.comment =
          " TODO: declare capability tags " +
          "(frontier | local | web_search | harness | code_review | long_context | vision)";
        node.add(doc.createPair("tags", seq));
        touched = true;
      }

      if (touched) report.aliasesTouched++;
    }
  }

  if (!doc.has("roles")) {
    // Detect a scaffold already appended on a prior run. The scaffolder
    // appends to doc.comment (printed after the doc body) — use a
    // unique sentinel to make idempotency robust against subsequent
    // upgrade calls.
    const alreadyScaffolded =
      typeof doc.comment === "string" && doc.comment.includes(ROLES_SCAFFOLD_SENTINEL);
    if (!alreadyScaffolded) {
      appendRolesScaffold(doc);
      report.rolesScaffoldAdded = true;
    }
  }

  return report;
}

// Stable marker — the upgrader checks for this on re-runs to skip
// re-emitting the scaffold. Don't reword without bumping detection logic.
const ROLES_SCAFFOLD_SENTINEL = "Suggested roles block — uncomment + edit";

function insertAfter(map: YAMLMap, anchorKey: string, key: string, value: string): void {
  const idx = map.items.findIndex((p) => {
    const k = p.key as { value?: unknown } | string;
    return (typeof k === "string" ? k : k?.value) === anchorKey;
  });
  if (idx < 0) {
    map.set(key, value);
    return;
  }
  // YAMLMap.add(pair, idx+1) inserts at the given index.
  map.add({ key, value }, false);
  // Re-order so the new entry sits right after the anchor.
  const last = map.items[map.items.length - 1];
  if (last) {
    map.items.splice(map.items.length - 1, 1);
    map.items.splice(idx + 1, 0, last);
  }
}

function appendRolesScaffold(doc: Document.Parsed): void {
  // Free-form text appended after the existing document. yaml's Document
  // exposes `.commentBefore` / `.comment` on nodes; the simplest way to
  // attach a multi-line comment block to the bottom is on the document's
  // `.comment` (printed after the document body).
  const block = [
    "# ─────────────────────────────────────────────────────────────────────",
    "# Suggested roles block — uncomment + edit. Roles are the call-site",
    '# abstraction for "which model do I use here?". Each role declares',
    "# its required capability tags and a default model alias (singleton",
    "# or 3-slot panel). Set tags on your model_aliases first, then bind",
    "# them here.",
    "# ─────────────────────────────────────────────────────────────────────",
    "# roles:",
    "#   research_primary:",
    "#     default: <alias>           # frontier + web_search singleton",
    "#     requires: [frontier, web_search]",
    "#   research_panel:",
    "#     defaults: [<a>, <b>, <c>]  # 3-slot, vendor-disjoint",
    "#     requires: [frontier, web_search]",
    "#     vendor_diverse: true",
    "#   kb_review_primary:",
    "#     default: <alias>",
    "#     requires: [frontier, web_search]",
    "#   kb_finalize:",
    "#     default: <alias>",
    "#     requires: [frontier]",
    "#   gate_review_primary:",
    "#     default: <alias>           # local OK; needs code_review tag",
    "#     requires: [code_review]",
    "#   builder_local:",
    "#     default: <alias>",
    "#     requires: [local]",
  ].join("\n");
  // Append to the existing comment (preserves any pre-existing trailer).
  doc.comment = (doc.comment ?? "") + block;
}

/**
 * Render the document to YAML, preserving comments + ordering. Wraps
 * `Document.toString()` with a stable line width so machine-generated
 * diffs stay tidy.
 */
export function renderDoc(doc: Document.Parsed): string {
  return doc.toString({ lineWidth: 0, indent: 2 });
}

export async function runConfigUpgrade(opts: UpgradeOptions): Promise<void> {
  const configPath = opts.config
    ? resolvePath(opts.config)
    : process.env["VCF_CONFIG"]
      ? resolvePath(process.env["VCF_CONFIG"])
      : resolvePath(vcfHomeDir(), ".vcf", "config.yaml");

  if (!existsSync(configPath)) {
    log(`config not found at ${configPath}`);
    log("run `vcf init` first, or pass --config <path> to point at a non-default location");
    throw new Error("config not found");
  }

  const raw = await readFile(configPath, "utf8");
  const doc = parseDocument(raw, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) log(`yaml parse error: ${e.message}`);
    throw new Error(`config at ${configPath} has YAML errors — refusing to upgrade`);
  }

  const report = upgradeConfigDoc(doc);
  const upgraded = renderDoc(doc);

  if (opts.dryRun) {
    process.stdout.write(upgraded);
    log(
      `dry-run: ${report.endpointsTouched} endpoint(s), ${report.aliasesTouched} alias(es) ` +
        `would be touched${report.rolesScaffoldAdded ? "; roles scaffold appended" : ""}`,
    );
    return;
  }

  if (opts.apply) {
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const backupPath = `${configPath}.bak-${ts}`;
    await copyFile(configPath, backupPath);
    await writeFile(configPath, upgraded, "utf8");
    log(`upgraded ${configPath} (backup: ${backupPath})`);
  } else {
    const outPath = `${configPath}.upgraded`;
    await writeFile(outPath, upgraded, "utf8");
    log(`wrote ${outPath} — review the diff, then mv into place to apply`);
  }
  log(
    `endpoints touched: ${report.endpointsTouched}` +
      ` | aliases touched: ${report.aliasesTouched}` +
      ` | roles scaffold: ${report.rolesScaffoldAdded ? "added" : "skipped (already set)"}`,
  );
  if (report.unknownVendors.length > 0) {
    log(
      `model_ids with no inferred vendor (set vendor: manually): ${report.unknownVendors.join(", ")}`,
    );
  }
}
