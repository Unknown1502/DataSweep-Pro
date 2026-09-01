import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import type { SqlEngine } from '../../src/lib/engine/types';

/**
 * Proves the test harness itself before anything is built on top of it:
 * real DuckDB-Wasm, real worker, real SQL. If this suite cannot run in Node,
 * the integration strategy has to move to Vitest browser mode — so it is
 * deliberately the first thing written.
 */
describe('DuckDB-Wasm engine (Node harness)', () => {
  let engine: SqlEngine;

  beforeAll(async () => {
    engine = await createTestEngine();
  });

  afterAll(async () => {
    await engine?.close();
  });

  it('executes SQL and returns named columns', async () => {
    const result = await engine.query(`SELECT 21 * 2 AS answer, 'ok' AS status`);

    expect(result.columns).toEqual(['answer', 'status']);
    expect(result.numRows).toBe(1);
    expect(result.rows[0]).toEqual({ answer: 42, status: 'ok' });
  });

  it('normalizes BIGINT into a JSON-safe number', async () => {
    // COUNT(*) is BIGINT. Unnormalized it arrives as a JS bigint, which makes
    // the whole tool result throw on JSON.stringify before an agent sees it.
    const result = await engine.query(`SELECT COUNT(*) AS n FROM range(5)`);

    expect(result.rows[0]?.n).toBe(5);
    expect(typeof result.rows[0]?.n).toBe('number');
    expect(() => JSON.stringify(result.rows[0])).not.toThrow();
  });

  it('reads a registered CSV without coercing messy values', async () => {
    // all_varchar=true is the core ingestion decision: the inconsistent dates
    // and the empty cell below must survive ingest intact, because detecting
    // them is the entire point of the product.
    const csv = [
      'id,order_date,amount',
      '1,2024-01-15,100',
      '2,15/01/2024,200',
      '3,,300',
      '4,Jan 15 2024,',
    ].join('\n');

    await engine.registerFileText('smoke.csv', csv);
    await engine.query(
      `CREATE TABLE smoke AS
       SELECT * FROM read_csv('smoke.csv', all_varchar=true, header=true, sample_size=-1)`,
    );

    const rows = await engine.query(`SELECT * FROM smoke ORDER BY id`);
    expect(rows.numRows).toBe(4);

    // Three different date encodings preserved verbatim, not parsed or dropped.
    expect(rows.rows.map((r) => r['order_date'])).toEqual([
      '2024-01-15',
      '15/01/2024',
      null,
      'Jan 15 2024',
    ]);

    const types = await engine.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'smoke' AND column_name = 'amount'`,
    );
    expect(types.rows[0]?.['data_type']).toBe('VARCHAR');
  });

  it('surfaces SQL errors as SqlError rather than an opaque worker rejection', async () => {
    await expect(engine.query('SELECT * FROM table_that_does_not_exist')).rejects.toThrow(
      /Query failed/,
    );
  });
});
