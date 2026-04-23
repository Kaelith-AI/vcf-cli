// Followup #44 + #49 — `vcf backup` / `vcf restore` CLI handlers.

import { resolve as resolvePath } from "node:path";
import { createBackup, restoreBackup } from "../util/backup.js";
import { err, log, vcfHomeDir } from "./_shared.js";

export async function runBackup(opts: {
  out?: string;
  include: string;
  format: string;
}): Promise<void> {
  const subsetsRaw = opts.include.split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(["projects", "global", "kb", "all"]);
  const invalid = subsetsRaw.filter((s) => !allowed.has(s));
  if (invalid.length > 0) {
    err(`invalid --include values: ${invalid.join(", ")} (allowed: projects|global|kb|all)`);
    return;
  }
  const subsets = subsetsRaw as Array<"projects" | "global" | "kb" | "all">;
  const backupInput: Parameters<typeof createBackup>[0] = {
    include: subsets,
    homeDir: vcfHomeDir(),
  };
  if (opts.out !== undefined) backupInput.outDir = resolvePath(opts.out);
  const result = createBackup(backupInput);
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  log(
    `backup: ${result.archive} (${(result.size_bytes / 1024).toFixed(1)} KiB, subsets=[${result.included_subsets.join(",")}])`,
  );
}

export async function runRestore(
  archive: string,
  opts: { dryRun?: boolean; replace?: boolean; format: string },
): Promise<void> {
  const restoreInput: Parameters<typeof restoreBackup>[0] = {
    archive: resolvePath(archive),
    homeDir: vcfHomeDir(),
  };
  if (opts.dryRun) restoreInput.dryRun = true;
  if (opts.replace) restoreInput.replace = true;
  const result = restoreBackup(restoreInput);
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  for (const entry of result.plan) {
    const tag =
      entry.action === "copy"
        ? "copy    "
        : entry.action === "replace"
          ? "replace "
          : "skip    ";
    process.stderr.write(
      `${tag}${entry.relative_path}${entry.reason ? `  (${entry.reason})` : ""}\n`,
    );
  }
  log(
    `restore ${result.dry_run ? "(dry-run)" : "applied"}: copy=${result.applied}, replace=${result.replaced}, skipped=${result.skipped} (archive=${result.archive})`,
  );
}
