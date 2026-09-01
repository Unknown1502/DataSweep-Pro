import { createDuckDB, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/blocking';
import type { Table } from 'apache-arrow';
import path from 'node:path';
import { arrowToResult } from '../../src/lib/engine/arrow';
import { SqlError, type QueryResult, type SqlEngine } from '../../src/lib/engine/types';

/**
 * Node bootstrap for DuckDB-Wasm, used by the integration and eval suites.
 *
 * This uses the package's **blocking** Node target rather than the async,
 * worker-backed one. The worker route needs a Web-Worker shim over
 * `worker_threads`, and DuckDB's Node worker bundles are not loadable through
 * that shim's `importScripts` (it rejects the path as a non-file URL). The
 * blocking bindings need no worker at all, so tests get the real engine with
 * strictly less machinery.
 *
 * The synchronous calls are wrapped to satisfy the async {@link SqlEngine}
 * contract the browser implements. Production code never imports this file.
 */
const DIST = path.resolve(process.cwd(), 'node_modules/@duckdb/duckdb-wasm/dist');

export async function createTestEngine(): Promise<SqlEngine> {
  const bindings = await createDuckDB(
    {
      // mainWorker is required by the bundle type but never loaded by the
      // blocking bindings, which run DuckDB on the calling thread.
      mvp: {
        mainModule: path.join(DIST, 'duckdb-mvp.wasm'),
        mainWorker: path.join(DIST, 'duckdb-node-mvp.worker.cjs'),
      },
      eh: {
        mainModule: path.join(DIST, 'duckdb-eh.wasm'),
        mainWorker: path.join(DIST, 'duckdb-node-eh.worker.cjs'),
      },
    },
    new VoidLogger(),
    NODE_RUNTIME,
  );
  await bindings.instantiate();

  const connection = bindings.connect();

  return {
    query(sql: string): Promise<QueryResult> {
      try {
        return Promise.resolve(arrowToResult(connection.query(sql) as unknown as Table));
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return Promise.reject(new SqlError(`Query failed: ${detail}`, sql, cause));
      }
    },

    registerFileText(name: string, content: string): Promise<void> {
      bindings.registerFileText(name, content);
      return Promise.resolve();
    },

    dropFile(name: string): Promise<void> {
      bindings.dropFile(name);
      return Promise.resolve();
    },

    close(): Promise<void> {
      connection.close();
      return Promise.resolve();
    },
  };
}
