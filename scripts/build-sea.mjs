#!/usr/bin/env node
// Build a Node SEA (Single Executable Application) from dist/cli.js.
//
// Produces a standalone binary with the VCF CLI bundled alongside a
// platform-specific Node runtime. Users who don't have Node installed can
// curl one file and run it — no npm/brew/scoop/node prerequisite.
//
// Followup #8. Chosen approach is Node's built-in SEA (vs. @yao-pkg/pkg)
// because we have zero native deps after the 0.3.0 node:sqlite migration,
// SEA is the canonical future direction, and it adds no supply-chain
// surface (no external packager).
//
// Usage:
//   node scripts/build-sea.mjs              # build for the current platform
//   node scripts/build-sea.mjs --out OUT    # override output filename
//
// Requirements:
//   - npm run build has already produced dist/cli.js (script skips the
//     build if dist/cli.js is already present; pass --rebuild to force)
//   - postject is in devDependencies (added in #8).
//
// Platform notes:
//   - Linux / Windows: straightforward postject inject.
//   - macOS: binary must be ad-hoc signed after the inject. `codesign
//     --sign -` is available by default on macOS hosts (no certificate
//     required for ad-hoc signing). CI runners on macos-* have it.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function usage() {
  console.log(
    "Usage: node scripts/build-sea.mjs [--out <path>] [--rebuild]\n" +
      "\n" +
      "Produces a SEA binary at dist/sea/vcf-cli-<os>-<arch>[.exe] by default.",
  );
}

function parseArgs(argv) {
  const out = { out: null, rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--rebuild") out.rebuild = true;
    else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      usage();
      process.exit(2);
    }
  }
  return out;
}

function run(cmd, args, opts = {}) {
  console.log(`→ ${cmd} ${args.join(" ")}`);
  // shell: true is required on Windows so spawnSync can locate
  // .cmd / .bat shims (npx → npx.cmd, npm → npm.cmd). Without it,
  // spawnSync returns status=null with errno=ENOENT.
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} exited ${res.status}`);
  }
}

function platformSuffix() {
  const platform = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function defaultOutputPath() {
  const suffix = platformSuffix();
  const name = `vcf-cli-${suffix}${process.platform === "win32" ? ".exe" : ""}`;
  return join(REPO_ROOT, "dist", "sea", name);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out ? resolve(args.out) : defaultOutputPath();
  const distCli = join(REPO_ROOT, "dist", "cli.js");

  if (!existsSync(distCli) || args.rebuild) {
    console.log(`dist/cli.js missing or --rebuild passed — running npm run build`);
    run("npm", ["run", "build"]);
  }

  // 1a) Build a CJS-bundled entry specifically for SEA. Node SEA currently
  //     requires a CJS `main` — ESM entries fail with "Cannot use import
  //     statement outside a module". Must bundle EVERY runtime dependency
  //     into one file (no `require`s resolved at runtime) because the SEA
  //     binary has no node_modules alongside it. Use esbuild directly
  //     rather than tsup so we can pass the `packages: bundle` flag that
  //     tsup doesn't expose.
  const seaEntry = join(REPO_ROOT, "dist", "cli.sea.cjs");
  run("npx", [
    "esbuild",
    "src/sea-entry.ts",
    `--bundle`,
    `--platform=node`,
    `--target=node22`,
    `--format=cjs`,
    `--packages=bundle`,
    `--outfile=${seaEntry}`,
    // Keep node: built-in prefixes as-is.
    "--external:node:*",
  ]);
  if (!existsSync(seaEntry)) {
    throw new Error(`esbuild did not produce ${seaEntry}`);
  }

  // 1b) Generate the SEA blob.
  const blobPath = join(REPO_ROOT, "dist", "sea-cli.blob");
  run("node", ["--experimental-sea-config", join(REPO_ROOT, "sea-config.json")]);
  if (!existsSync(blobPath)) {
    throw new Error(`SEA blob not produced at ${blobPath}`);
  }

  // 2) Copy the Node binary to the output path.
  mkdirSync(dirname(outPath), { recursive: true });
  copyFileSync(process.execPath, outPath);
  chmodSync(outPath, 0o755);

  // 3) Remove signature on macOS (required before postject) + on Windows
  //    (optional; postject will still succeed). Best-effort.
  if (process.platform === "darwin") {
    try {
      run("codesign", ["--remove-signature", outPath]);
    } catch (e) {
      console.warn(`codesign --remove-signature failed: ${e.message} (continuing)`);
    }
  }

  // 4) Inject the SEA blob via postject.
  const postjectArgs = [
    "postject",
    outPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run("npx", postjectArgs);

  // 5) Re-sign on macOS (ad-hoc signature — no certificate required).
  if (process.platform === "darwin") {
    try {
      run("codesign", ["--sign", "-", outPath]);
    } catch (e) {
      console.warn(`codesign (re-sign) failed: ${e.message} (the binary may still run)`);
    }
  }

  const sizeMb = (statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log("");
  console.log(`✓ SEA binary: ${outPath}`);
  console.log(`  Size: ${sizeMb} MB`);
  console.log(`  Platform: ${platformSuffix()}`);
  console.log("");
  console.log("Smoke test:");
  console.log(`  ${outPath} version`);
}

main().catch((err) => {
  console.error(`SEA build failed: ${err.message}`);
  process.exit(1);
});
