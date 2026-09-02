import { quoteIdent, quoteLiteral } from '../../engine/sql';
import type { SqlEngine } from '../../engine/types';
import { toExcerpt } from '../injection';
import type { FormatPattern } from './patterns';

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

/** Bucket name for values matching no pattern. */
export const OTHER_BUCKET = '__other__';

/**
 * Assign every value to the *first* pattern it matches.
 *
 * A chained CASE rather than one COUNT per pattern, because the patterns are not
 * all mutually exclusive and summing overlapping counts would exceed the row
 * count and corrupt every ratio derived from it.
 */
export function bucketQuery(
  table: string,
  column: string,
  patterns: readonly FormatPattern[],
): string {
  const col = quoteIdent(column);
  const branches = patterns
    .map((p) => `WHEN regexp_matches(${col}, ${quoteLiteral(p.regex)}) THEN ${quoteLiteral(p.id)}`)
    .join('\n           ');

  return `SELECT bucket, COUNT(*) AS n FROM (
            SELECT CASE
           ${branches}
             ELSE ${quoteLiteral(OTHER_BUCKET)}
           END AS bucket
            FROM ${quoteIdent(table)}
           WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
          ) GROUP BY bucket`;
}

export interface BucketCounts {
  readonly counts: Map<string, number>;
  /** Non-null, non-blank values considered. */
  readonly populated: number;
  /** Of those, how many matched some pattern. */
  readonly recognized: number;
}

export async function bucketColumn(
  engine: SqlEngine,
  table: string,
  column: string,
  patterns: readonly FormatPattern[],
): Promise<BucketCounts> {
  const result = await engine.query(bucketQuery(table, column, patterns));

  const counts = new Map<string, number>();
  let populated = 0;
  for (const row of result.rows) {
    const bucket = String(row['bucket']);
    const n = Number(row['n'] ?? 0);
    counts.set(bucket, n);
    populated += n;
  }

  return { counts, populated, recognized: populated - (counts.get(OTHER_BUCKET) ?? 0) };
}
