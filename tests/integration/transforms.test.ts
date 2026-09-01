import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import { compileTransform, TransformError } from '../../src/lib/domain/transforms';
import { UnsafeIdentifierError } from '../../src/lib/engine/sql';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

describe('transformations', () => {
  let engine: SqlEngine;
  let registry: DatasetRegistry;

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });

  /** Ingest a CSV, run one transform, return the resulting rows. */
  async function run(csv: string, spec: Parameters<typeof compileTransform>[0]) {
    registry = new DatasetRegistry();
    const dataset = await ingestCsv(engine, registry, 't.csv', csv);
    const head = dataset.history[0]!;
    const compiled = compileTransform(spec, {
      sourceTable: dataset.id,
      columns: [...head.columns],
    });
    const impact = await engine.query(compiled.impactSql);
    const rows = await engine.query(compiled.sql);
    return { compiled, rows, impact: Number(impact.rows[0]?.['n'] ?? 0) };
  }

  it('removes exact duplicate rows and reports the count first', async () => {
    const csv = ['a,b', '1,x', '1,x', '2,y'].join(NL);
    const { rows, impact } = await run(csv, {
      operation: 'remove_duplicates',
      column: null,
    });

    expect(impact).toBe(1);
    expect(rows.numRows).toBe(2);
  });

  it('trims whitespace without altering the value', async () => {
    const csv = ['name', '"  Acme  "', 'Beta'].join(NL);
    const { rows, impact } = await run(csv, { operation: 'trim_whitespace', column: 'name' });

    expect(impact).toBe(1);
    expect(rows.rows.map((r) => r['name'])).toEqual(['Acme', 'Beta']);
  });

  describe('standardize_dates', () => {
    it('converts every recognised format to ISO', async () => {
      const csv = [
        'd',
        '2024-01-15',
        '15/02/2024',
        '03.03.2024',
        'Mar 15 2024',
        '20240416',
      ].join(NL);

      const { rows } = await run(csv, { operation: 'standardize_dates', column: 'd' });

      expect(rows.rows.map((r) => r['d'])).toEqual([
        '2024-01-15',
        '2024-02-15',
        '2024-03-03',
        '2024-03-15',
        '2024-04-16',
      ]);
    });

    it('leaves unparseable values untouched rather than nulling them', async () => {
      // Destroying data to make a column look tidy is the opposite of the job.
      // The blank date is given a trailing column so it is a real row rather
      // than a trailing newline, which read_csv correctly ignores.
      const csv = ['d,id', '2024-01-15,1', 'sometime in June,2', ',3'].join(NL);
      const { rows } = await run(csv, { operation: 'standardize_dates', column: 'd' });

      expect(rows.rows.map((r) => r['d'])).toEqual(['2024-01-15', 'sometime in June', null]);
    });

    it('honours dayFirst and states the ambiguity in its caveat', async () => {
      const csv = ['d', '01/02/2024'].join(NL);

      const dayFirst = await run(csv, {
        operation: 'standardize_dates',
        column: 'd',
        parameters: { dayFirst: true },
      });
      expect(dayFirst.rows.rows[0]?.['d']).toBe('2024-02-01');
      expect(dayFirst.compiled.caveat).toMatch(/ambiguous/i);

      const monthFirst = await run(csv, {
        operation: 'standardize_dates',
        column: 'd',
        parameters: { dayFirst: false },
      });
      expect(monthFirst.rows.rows[0]?.['d']).toBe('2024-01-02');
    });
  });

  describe('parse_numbers', () => {
    it('strips currency and thousands separators', async () => {
      const csv = ['amt', '"$1,200.50"', '980', '"1,000"'].join(NL);
      const { rows } = await run(csv, { operation: 'parse_numbers', column: 'amt' });

      expect(rows.rows.map((r) => Number(r['amt']))).toEqual([1200.5, 980, 1000]);
    });

    it('reads accounting negatives as negative', async () => {
      const csv = ['amt', '"(1,200.50)"'].join(NL);
      const { rows } = await run(csv, { operation: 'parse_numbers', column: 'amt' });
      expect(Number(rows.rows[0]?.['amt'])).toBe(-1200.5);
    });

    it('handles European decimal notation', async () => {
      const csv = ['amt', '"1.200,50"'].join(NL);
      const { rows } = await run(csv, { operation: 'parse_numbers', column: 'amt' });
      expect(Number(rows.rows[0]?.['amt'])).toBe(1200.5);
    });
  });

  it('caps outliers at the given fence', async () => {
    const csv = ['v', '10', '20', '9999'].join(NL);
    const { rows, impact } = await run(csv, {
      operation: 'clip_outliers',
      column: 'v',
      parameters: { lower: 0, upper: 100 },
    });

    expect(impact).toBe(1);
    expect(rows.rows.map((r) => Number(r['v']))).toEqual([10, 20, 100]);
  });

  it('fills blanks with a placeholder', async () => {
    const csv = ['name', 'Acme', '', '   '].join(NL);
    const { rows, impact } = await run(csv, {
      operation: 'fill_missing',
      column: 'name',
      parameters: { strategy: 'placeholder', value: 'Unknown' },
    });

    expect(impact).toBe(2);
    expect(rows.rows.map((r) => r['name'])).toEqual(['Acme', 'Unknown', 'Unknown']);
  });

  it('drops a column while keeping the rest in order', async () => {
    const csv = ['a,b,c', '1,2,3'].join(NL);
    const { rows, compiled } = await run(csv, { operation: 'drop_column', column: 'b' });

    expect(compiled.resultColumns).toEqual(['a', 'c']);
    expect(rows.columns).toEqual(['a', 'c']);
  });

  describe('safety', () => {
    const ctx = { sourceTable: 'ds_abc123def456', columns: ['id', 'name'] };

    it('rejects a column that is not in the schema', () => {
      expect(() =>
        compileTransform({ operation: 'trim_whitespace', column: 'password' }, ctx),
      ).toThrow(UnsafeIdentifierError);
    });

    it('rejects a SQL payload supplied as a column name', () => {
      expect(() =>
        compileTransform(
          { operation: 'trim_whitespace', column: 'name"; DROP TABLE x; --' },
          ctx,
        ),
      ).toThrow(UnsafeIdentifierError);
    });

    it('refuses to drop the last remaining column', () => {
      expect(() =>
        compileTransform({ operation: 'drop_column', column: 'id' }, {
          sourceTable: 'ds_abc123def456',
          columns: ['id'],
        }),
      ).toThrow(TransformError);
    });

    it('rejects an inverted clip range instead of silently emptying the column', () => {
      expect(() =>
        compileTransform(
          { operation: 'clip_outliers', column: 'id', parameters: { lower: 100, upper: 0 } },
          ctx,
        ),
      ).toThrow(/must not exceed/);
    });

    it('requires a column for column-scoped operations', () => {
      expect(() => compileTransform({ operation: 'trim_whitespace', column: null }, ctx)).toThrow(
        TransformError,
      );
    });
  });
});
