// Tiny helpers for node:sqlite query results.
//
// node:sqlite's DatabaseSync.prepare(...).get() / .all() return
// `Record<string, SQLOutputValue> | undefined` — the raw column map. Callers
// typically want a typed row. Prior to these helpers we used
// `as unknown as T[]` casts, which silently accept a mismatched schema:
// a renamed or dropped column produces `undefined` at runtime rather than
// a loud validation error. These helpers Zod-parse the row at the data
// boundary so a schema drift is caught at the first read.

import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type { ZodType } from "zod";

type SqlParam = string | number | bigint | Uint8Array | null;

export function queryRow<T>(
  db: DatabaseType,
  sql: string,
  schema: ZodType<T>,
  params: SqlParam[] = [],
): T | undefined {
  const raw = db.prepare(sql).get(...params);
  if (raw === undefined) return undefined;
  return schema.parse(raw);
}

export function queryAll<T>(
  db: DatabaseType,
  sql: string,
  schema: ZodType<T>,
  params: SqlParam[] = [],
): T[] {
  const raw = db.prepare(sql).all(...params);
  return raw.map((r) => schema.parse(r));
}
