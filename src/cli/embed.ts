// Followup #44 — `vcf embed-kb` CLI handler.
//
// Populate the embedding cache that spec_suggest_primers blends against the
// tag matcher. Config block `embeddings: { endpoint, model, blend_weight,
// cache_dir? }` picks the target. Re-runs are idempotent — entries whose
// content hash matches the cached record are skipped.

import { resolve as resolvePath, join } from "node:path";
import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { err, log, loadConfigOrExit } from "./_shared.js";
import { assertApiEndpoint } from "../util/endpointKind.js";

export async function runEmbedKb(opts: { only?: string; force?: boolean }): Promise<void> {
  const config = await loadConfigOrExit();
  if (!config.embeddings) {
    err(
      "no embeddings block in config — add `embeddings: { endpoint, model }` under the top-level to enable blended matching",
      2,
    );
  }
  const endpointRaw = config.endpoints.find((e) => e.name === config.embeddings!.endpoint);
  if (!endpointRaw) {
    err(`embeddings.endpoint '${config.embeddings!.endpoint}' missing from endpoints[]`, 2);
  }
  const endpoint = assertApiEndpoint(endpointRaw);
  const kbRoot = config.kb.root;
  const { loadKb } = await import("../primers/load.js");
  const entries = await loadKb(kbRoot);
  const allowedKinds = new Set(["primer", "best-practice", "lens", "standard"]);
  const filteredByKind = entries.filter((e) => allowedKinds.has(e.kind));
  const filtered = opts.only ? filteredByKind.filter((e) => e.kind === opts.only) : filteredByKind;
  if (filtered.length === 0) {
    log("embed-kb: nothing to embed (KB empty or filter excludes everything)");
    return;
  }

  // Resolve API key if needed.
  let apiKey: string | undefined;
  if (endpoint.auth_env_var) {
    apiKey = process.env[endpoint.auth_env_var];
    if (!apiKey && endpoint.trust_level !== "local") {
      err(`env var ${endpoint.auth_env_var} unset; endpoint '${endpoint.name}' needs it`, 3);
    }
  }

  const cacheDir = config.embeddings!.cache_dir ?? resolvePath(homedir(), ".vcf", "embeddings");
  await mkdir(cacheDir, { recursive: true });

  const { callEmbeddings, LlmError } = await import("../util/llmClient.js");
  const { buildEmbeddingInput, writeEmbeddingRecord, sha256 } = await import("../primers/embed.js");

  log(
    `embed-kb: ${filtered.length} entr(y|ies) via ${endpoint.name} (model=${config.embeddings!.model})`,
  );

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of filtered) {
    const cacheFile = join(cacheDir, `${entry.id}.json`);
    const body = await readFile(entry.path, "utf8");
    const input = buildEmbeddingInput(entry, body);
    const hash = sha256(input);

    if (!opts.force && existsSync(cacheFile)) {
      try {
        const existing = JSON.parse(await readFile(cacheFile, "utf8")) as {
          content_sha256?: string;
          model?: string;
        };
        if (existing.content_sha256 === hash && existing.model === config.embeddings!.model) {
          skipped++;
          continue;
        }
      } catch {
        // corrupt cache entry — fall through and regenerate
      }
    }

    try {
      const [vector] = await callEmbeddings({
        baseUrl: endpoint.base_url,
        apiKey,
        model: config.embeddings!.model,
        inputs: [input],
      });
      if (!vector || vector.length === 0) {
        failed++;
        process.stderr.write(`  ${entry.id}: empty vector\n`);
        continue;
      }
      await writeEmbeddingRecord(cacheDir, entry.id, {
        model: config.embeddings!.model,
        dim: vector.length,
        content_sha256: hash,
        vector,
        updated_at: Date.now(),
      });
      embedded++;
    } catch (e) {
      failed++;
      const msg = e instanceof LlmError ? `${e.kind}: ${e.message}` : (e as Error).message;
      process.stderr.write(`  ${entry.id}: ${msg}\n`);
    }
  }

  log(
    `embed-kb: ${embedded} embedded, ${skipped} unchanged, ${failed} failed (cache: ${cacheDir})`,
  );
  if (failed > 0) process.exit(8);
}
