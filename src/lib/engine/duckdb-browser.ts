import * as duckdb from '@duckdb/duckdb-wasm';
import { createDuckDbEngine } from './engine';
import type { SqlEngine } from './types';

/**
 * Browser bootstrap for DuckDB-Wasm.
 *
 * Notes that cost time to rediscover:
 *
 * - The worker is loaded through a Blob URL wrapping `importScripts`. Pointing a
 *   `new Worker()` straight at a cross-origin CDN script is blocked by the same
 *   origin policy; the Blob shim is the documented way around it.
 * - `selectBundle` picks `mvp` / `eh` / `coi` by probing WebAssembly features.
 *   The multithreaded `coi` bundle only gets chosen when the page is
 *   cross-origin isolated (COOP + COEP). We do not set those headers, so the
 *   `eh` bundle is what loads. That is expected, not a misconfiguration —
 *   single-threaded DuckDB is entirely adequate at these data sizes.
 */
let enginePromise: Promise<SqlEngine> | null = null;

async function bootstrap(): Promise<SqlEngine> {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  if (!bundle.mainWorker) {
    throw new Error(
      'DuckDB-Wasm could not select a worker bundle for this browser. ' +
        'A WebAssembly-capable browser is required.',
    );
  }

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  );

  try {
    const worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return createDuckDbEngine(db);
  } finally {
    // Safe to revoke immediately: the Worker holds its own reference to the blob.
    URL.revokeObjectURL(workerUrl);
  }
}

/** Returns the process-wide engine, booting it on first call. */
export function getEngine(): Promise<SqlEngine> {
  enginePromise ??= bootstrap().catch((error: unknown) => {
    // Don't cache a rejected promise — a transient CDN failure should be retryable.
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

/** Test/HMR affordance. Does not terminate an already-running instance. */
export function resetEngineForTesting(): void {
  enginePromise = null;
}
