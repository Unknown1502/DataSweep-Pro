import type { Table } from 'apache-arrow';
import type { QueryResult, Row } from './types';

/**
 * Arrow hands back values that do not survive `JSON.stringify` — BIGINT arrives
 * as a JS `bigint`, which throws on serialization, and DATE/TIMESTAMP arrive as
 * `Date` objects. Every tool result is serialized to JSON before an agent sees
 * it, so normalization happens here once rather than at each call site.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'bigint') {
    // Row counts and SUM() results come back as BIGINT. Realistically far below
    // 2^53 here, but fall back to a string rather than silently lose precision.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;

  return value;
}

/** Convert an Arrow table into plain, JSON-safe rows keyed by column name. */
export function arrowToResult(table: Table): QueryResult {
  const columns = table.schema.fields.map((f) => f.name);
  const rows: Row[] = [];

  for (const arrowRow of table) {
    if (arrowRow === null) continue;
    const plain = arrowRow.toJSON() as Row;
    const row: Row = {};
    for (const column of columns) {
      row[column] = normalizeValue(plain[column]);
    }
    rows.push(row);
  }

  return { columns, rows, numRows: table.numRows };
}
