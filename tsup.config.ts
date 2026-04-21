import { defineConfig } from "tsup";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    server: "src/server.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Post-build fixup: esbuild strips the `node:` prefix on built-ins for
  // older-Node compatibility, but `node:sqlite` has no bare alias — the
  // bundled `from 'sqlite'` import fails at runtime with "Cannot find
  // package 'sqlite'". Restore the prefix after the bundle writes.
  async onSuccess() {
    const distDir = "dist";
    for (const name of await readdir(distDir)) {
      if (!name.endsWith(".js")) continue;
      const path = join(distDir, name);
      const src = await readFile(path, "utf8");
      const patched = src.replace(/from ['"]sqlite['"]/g, 'from "node:sqlite"');
      if (patched !== src) await writeFile(path, patched, "utf8");
    }
  },
});
