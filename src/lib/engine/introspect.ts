import { quoteIdent, quoteLiteral } from './sql';
import type { SqlEngine } from './types';

/**
 * Schema and shape queries.
 *
 * `getColumns` is load-bearing for security, not just convenience: it produces
 * the allowlist that `assertKnownColumn` validates every agent-supplied column
 * name against. Read it from `information_schema` rather than caching a
 * remembered list, so the allowlist can never drift from the real table.
 */
export async function getColumns(engine: SqlEngine, table: string): Promise<string[]> {
  const result = await engine.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = ${quoteLiteral(table)}
      ORDER BY ordinal_position`,
  );
  return result.rows.map((row) => String(row['column_name']));
}

export async function getRowCount(engine: SqlEngine, table: string): Promise<number> {
  const result = await engine.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  return Number(result.rows[0]?.['n'] ?? 0);
}

export interface ColumnType {
  readonly column: string;
  readonly dataType: string;
}

export async function getColumnTypes(engine: SqlEngine, table: string): Promise<ColumnType[]> {
  const result = await engine.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = ${quoteLiteral(table)}
      ORDER BY ordinal_position`,
  );
  return result.rows.map((row) => ({
    column: String(row['column_name']),
    dataType: String(row['data_type']),
  }));
}

/** Whether a physical table currently exists. */
export async function tableExists(engine: SqlEngine, table: string): Promise<boolean> {
  const result = await engine.query(
    `SELECT COUNT(*) AS n
       FROM information_schema.tables
      WHERE table_name = ${quoteLiteral(table)}`,
  );
  return Number(result.rows[0]?.['n'] ?? 0) > 0;
}

export interface ColumnProfile {
  readonly column: string;
  readonly dataType: string;
  readonly nullCount: number;
  readonly nullRate: number;
  readonly distinctCount: number;
  readonly minLength: number;
  readonly maxLength: number;
  /** A few real values, for a data dictionary. Untrusted content. */
  readonly samples: readonly string[];
}

/**
 * Per-column statistics for the data dictionary.
 *
 * Blank strings count as null: CSV export writes "missing" as an empty field
 * far more often than as a true NULL, and a dictionary that reported 0% missing
 * on a column full of empty strings would be actively misleading.
 */
export async function profileColumns(
  engine: SqlEngine,
  table: string,
  columns: readonly string[],
  sampleSize = 3,
): Promise<ColumnProfile[]> {
  if (columns.length === 0) return [];

  const types = new Map(
    (await getColumnTypes(engine, table)).map((t) => [t.column, t.dataType]),
  );
  const total = await getRowCount(engine, table);
  const profiles: ColumnProfile[] = [];

  for (const column of columns) {
    const col = quoteIdent(column);
    const stats = await engine.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${col} IS NULL OR trim(${col}) = '') AS nulls,
         COUNT(DISTINCT ${col}) AS distinct_count,
         MIN(length(${col})) AS min_len,
         MAX(length(${col})) AS max_len
       FROM ${quoteIdent(table)}`,
    );
    const row = stats.rows[0];

    const sampleRows = await engine.query(
      `SELECT DISTINCT ${col} AS v FROM ${quoteIdent(table)}
        WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
        LIMIT ${Math.max(1, Math.floor(sampleSize))}`,
    );

    const nullCount = Number(row?.['nulls'] ?? 0);
    profiles.push({
      column,
      dataType: types.get(column) ?? 'VARCHAR',
      nullCount,
      nullRate: total === 0 ? 0 : nullCount / total,
      distinctCount: Number(row?.['distinct_count'] ?? 0),
      minLength: Number(row?.['min_len'] ?? 0),
      maxLength: Number(row?.['max_len'] ?? 0),
      samples: sampleRows.rows.map((r) => String(r['v'] ?? '')),
    });
  }

  return profiles;
}
