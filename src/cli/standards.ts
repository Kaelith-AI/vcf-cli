// `vcf standards init` — copy the shipped company-standards.example.md (and
// optional niche stubs) from the upstream KB into the user's kb root,
// stripping the `.example` suffix. Idempotent: anything already present at
// the destination is left alone and reported as skipped.

import { resolve as resolvePath, join } from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { err, log, loadConfigOrExit, resolveUpstreamKbRoot } from "./_shared.js";

const SUPPORTED_KINDS = ["company-standards", "design-system", "brand", "privacy"] as const;
type Kind = (typeof SUPPORTED_KINDS)[number];

export async function runStandardsInit(opts: { kinds?: string[] }): Promise<void> {
  const requested = (opts.kinds ?? []).filter((k): k is Kind =>
    (SUPPORTED_KINDS as readonly string[]).includes(k),
  );
  const invalid = (opts.kinds ?? []).filter(
    (k) => !(SUPPORTED_KINDS as readonly string[]).includes(k),
  );
  if (invalid.length > 0) {
    err(`unknown standard(s): ${invalid.join(", ")} — supported: ${SUPPORTED_KINDS.join(", ")}`, 2);
  }
  const kinds: Kind[] = requested.length > 0 ? requested : [...SUPPORTED_KINDS];

  const config = await loadConfigOrExit();
  const kbRoot = config.kb.root;
  const destDir = resolvePath(kbRoot, "standards");
  await mkdir(destDir, { recursive: true });

  const upstream = resolveUpstreamKbRoot();
  if (upstream === null) {
    err(
      "could not locate @kaelith-labs/kb package; ensure it's installed or the sibling repo is present",
      6,
    );
  }

  let created = 0;
  let skipped = 0;
  let missing = 0;
  for (const kind of kinds) {
    const src = join(upstream!, "standards", `${kind}.example.md`);
    const dst = join(destDir, `${kind}.md`);
    if (!existsSync(src)) {
      log(`standards init: upstream stub missing for '${kind}' at ${src}`);
      missing++;
      continue;
    }
    if (existsSync(dst)) {
      log(`standards init: ${dst} exists — skipping (edit manually or remove to re-seed)`);
      skipped++;
      continue;
    }
    await copyFile(src, dst);
    log(`standards init: created ${dst}`);
    created++;
  }

  log(
    `standards init: ${created} created, ${skipped} skipped, ${missing} upstream stub(s) missing`,
  );
  if (missing > 0) process.exit(7);
}
