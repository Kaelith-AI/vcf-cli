// SEA (Single Executable Application) entry point.
//
// Node SEA runs a CJS script with `import.meta.url` unavailable, so the
// `if (import.meta.url === entryUrl)` guard in src/cli.ts never fires when
// the bundle is invoked as a SEA binary. This entry skips that guard and
// calls the command parser directly. Builds through scripts/build-sea.mjs
// via esbuild with `packages=bundle` so every dep is inlined.

import { program, parseArgv } from "./cli.js";

// `program` is set up by src/cli.ts's module body (commander registrations
// run at import time). `parseArgv` is a tiny helper that runs
// program.parseAsync(process.argv) with the same error formatting as the
// normal CLI entrypoint.
parseArgv(program);
