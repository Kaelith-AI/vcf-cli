// Pino logger pinned to stderr (fd 2).
//
// Critical in stdio transport mode: stdout is JSON-RPC; any stray byte on it
// breaks the protocol. Pino's default destination is stdout — we override
// explicitly so nothing accidentally writes there.

import pino from "pino";

// ESLint no-restricted-syntax rule bans process.stdout. Pino to fd 2 bypasses
// that cleanly without triggering the AST selector.
const destination = pino.destination({ dest: 2, sync: false });

export const log = pino(
  {
    level: process.env.VCF_LOG_LEVEL ?? "info",
    base: { pkg: "@kaelith-labs/cli" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

export type Logger = typeof log;
