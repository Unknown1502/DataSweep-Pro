import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { Table } from 'apache-arrow';
import { arrowToResult } from './arrow';
import { type QueryResult, SqlError, type SqlEngine } from './types';

/**
 * Wraps an already-instantiated `AsyncDuckDB` (the browser, worker-backed
 * flavour) as a {@link SqlEngine}.
 *
 * Instantiation deliberately happens outside this function — see
 * `duckdb-browser.ts` — because the browser and Node bootstrap DuckDB in
 * incompatible ways and nothing above this layer should care which is running.
 */
export function createDuckDbEngine(db: AsyncDuckDB): SqlEngine {
  let connection: AsyncDuckDBConnection | null = null;

  async function conn(): Promise<AsyncDuckDBConnection> {
    connection ??= await db.connect();
    return connection;
  }

  return {
    async query(sql: string): Promise<QueryResult> {
      const c = await conn();
      try {
        const table = (await c.query(sql)) as unknown as Table;
        return arrowToResult(table);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new SqlError(`Query failed: ${detail}`, sql, cause);
      }
    },

    async registerFileText(name: string, content: string): Promise<void> {
      await db.registerFileText(name, content);
    },

    async dropFile(name: string): Promise<void> {
      await db.dropFile(name);
    },

    async close(): Promise<void> {
      await connection?.close();
      connection = null;
      await db.terminate();
    },
  };
}
