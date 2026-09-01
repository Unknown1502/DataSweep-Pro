import { quoteIdent } from '../../engine/sql';
import type { SqlEngine } from '../../engine/types';
import { toExcerpt } from '../injection';

/**
 * Alias columns positionally (c0, c1, ...) when building wide aggregate
 * queries. Real column names can be anything - including names that collide
 * with each other once normalized, or with our own aliases - so they are never
 * used as output identifiers, only as input references.
 */
export function positionalAlias(index: number): string {
  return `c${index}`;
}

/** Pull up to `limit` example values matching a predicate, for display. */
export async function sampleValues(
  engine: SqlEngine,
  table: string,
  column: string,
  predicate: string,
  limit = 3,
): Promise<string[]> {
  const col = quoteIdent(column);
  const result = await engine.query(
    `SELECT DISTINCT ${col} AS v
       FROM ${quoteIdent(table)}
      WHERE ${predicate}
      LIMIT ${Math.max(1, Math.floor(limit))}`,
  );
  return result.rows
    .map((row) => row['v'])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => toExcerpt(v, 60));
}

export function ratioOf(affected: number, total: number): number {
  return total === 0 ? 0 : affected / total;
}

/** Stable, human-readable issue id. Lets the UI key rows across re-analysis. */
export function issueId(type: string, column: string | null): string {
  return column === null ? type : `${type}:${column}`;
}

export function pct(ratio: number): string {
  const value = ratio * 100;
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}
