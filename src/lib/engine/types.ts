/**
 * The SQL surface the rest of the app is allowed to see.
 *
 * Everything above this file — domain analyzers, tools, UI — depends on this
 * interface and never on DuckDB directly. That is what lets the domain layer be
 * unit-tested without WebAssembly, and what lets the browser and the Node test
 * harness bootstrap DuckDB in their own incompatible ways without the rest of
 * the codebase noticing.
 */

/** A single result row, keyed by column name. */
export type Row = Record<string, unknown>;

export interface QueryResult {
  /** Column names, in select order. */
  columns: string[];
  rows: Row[];
  numRows: number;
}

export interface SqlEngine {
  /**
   * Run a SQL statement.
   *
   * Callers must never build this string by concatenating unvalidated user
   * input. Table and column names go through `DatasetRegistry.resolve()` /
   * `quoteIdent()`; literal values go through `sqlLiteral()`.
   */
  query(sql: string): Promise<QueryResult>;

  /** Register in-memory text as a virtual file DuckDB's `read_csv` can open. */
  registerFileText(name: string, content: string): Promise<void>;

  /** Drop a previously registered virtual file. */
  dropFile(name: string): Promise<void>;

  close(): Promise<void>;
}

/** Raised when a query fails. Carries the SQL for debugging, never for display. */
export class SqlError extends Error {
  override readonly name = 'SqlError';
  constructor(
    message: string,
    readonly sql: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
