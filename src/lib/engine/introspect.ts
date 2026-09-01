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
