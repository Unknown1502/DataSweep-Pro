import { describe, expect, it } from 'vitest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import { checkCompatibility, pipelineFromDataset } from '../../src/lib/domain/pipeline';
import { toDbt, toJson, toPython, toSql } from '../../src/lib/domain/export';

function buildDataset() {
  const registry = new DatasetRegistry();
  const dataset = registry.create('sales.csv', {
    rowCount: 100,
    columns: ['id', 'order_date', 'customer'],
    createdAt: new Date('2026-01-01').toISOString(),
  });

  registry.appendCheckpoint(dataset.id, {
    label: 'Remove duplicates',
    tool: 'apply_cleaning_transformations',
    args: [{ operation: 'remove_duplicates', column: null }],
    rowCount: 94,
    columns: ['id', 'order_date', 'customer'],
    createdAt: new Date().toISOString(),
  });

  registry.appendCheckpoint(dataset.id, {
    label: 'Standardize dates',
    tool: 'apply_cleaning_transformations',
    args: [
      { operation: 'trim_whitespace', column: 'customer' },
      { operation: 'standardize_dates', column: 'order_date', parameters: { dayFirst: true } },
    ],
    rowCount: 94,
    columns: ['id', 'order_date', 'customer'],
    createdAt: new Date().toISOString(),
  });

  return { registry, dataset: registry.resolve(dataset.id) };
}

describe('pipelineFromDataset', () => {
  it('flattens the applied history into ordered steps', () => {
    const { dataset } = buildDataset();
    const pipeline = pipelineFromDataset(dataset);

    expect(pipeline.steps.map((s) => s.operation)).toEqual([
      'remove_duplicates',
      'trim_whitespace',
      'standardize_dates',
    ]);
    expect(pipeline.requiredColumns).toEqual(['id', 'order_date', 'customer']);
  });

  it('carries parameters through', () => {
    const { dataset } = buildDataset();
    const pipeline = pipelineFromDataset(dataset);
    expect(pipeline.steps[2]?.parameters).toEqual({ dayFirst: true });
  });

  it('excludes steps the user undid', () => {
    // Exporting work someone explicitly rolled back would hand them a pipeline
    // they rejected.
    const { registry, dataset } = buildDataset();
    registry.moveHead(dataset.id, dataset.history[1]!.id);

    const pipeline = pipelineFromDataset(registry.resolve(dataset.id));
    expect(pipeline.steps.map((s) => s.operation)).toEqual(['remove_duplicates']);
  });

  it('produces an empty pipeline for an untouched dataset', () => {
    const registry = new DatasetRegistry();
    const dataset = registry.create('raw.csv', {
      rowCount: 10,
      columns: ['a'],
      createdAt: new Date().toISOString(),
    });
    expect(pipelineFromDataset(dataset).steps).toEqual([]);
  });
});

describe('checkCompatibility', () => {
  const { dataset } = buildDataset();
  const pipeline = pipelineFromDataset(dataset);

  it('accepts a dataset with the columns the steps touch', () => {
    const report = checkCompatibility(pipeline, ['id', 'order_date', 'customer']);
    expect(report.compatible).toBe(true);
    expect(report.score).toBe(1);
  });

  it('accepts extra columns', () => {
    // A pipeline written for last quarter's export should survive a new column.
    const report = checkCompatibility(pipeline, ['id', 'order_date', 'customer', 'region']);
    expect(report.compatible).toBe(true);
    expect(report.extraColumns).toEqual(['region']);
  });

  it('rejects a dataset missing a column a step needs, and names it', () => {
    const report = checkCompatibility(pipeline, ['id', 'order_date']);
    expect(report.compatible).toBe(false);
    expect(report.missingColumns).toEqual(['customer']);
    expect(report.summary).toContain('customer');
  });

  it('ignores columns that were present but never touched', () => {
    // remove_duplicates uses no column, so "id" being absent is irrelevant.
    const report = checkCompatibility(pipeline, ['order_date', 'customer']);
    expect(report.compatible).toBe(true);
  });
});

describe('exports', () => {
  const { dataset } = buildDataset();
  const pipeline = pipelineFromDataset(dataset);

  describe('SQL', () => {
    const sql = toSql(pipeline, 'raw_data');

    it('emits one CTE per step, chained in order', () => {
      expect(sql).toContain('step_1_remove_duplicates AS (');
      expect(sql).toContain('step_2_trim_whitespace AS (');
      expect(sql).toContain('step_3_standardize_dates AS (');
      expect(sql.trimEnd().endsWith('SELECT * FROM step_3_standardize_dates;')).toBe(true);
    });

    it('reads from the named source table first', () => {
      expect(sql).toMatch(/step_1_remove_duplicates AS \([\s\S]*?FROM "raw_data"/);
    });

    it('chains each step onto the previous one', () => {
      expect(sql).toMatch(/step_2_trim_whitespace AS \([\s\S]*?FROM "step_1_remove_duplicates"/);
    });

    it('documents each step in a comment', () => {
      expect(sql).toContain('-- Remove rows that are exact duplicates');
    });

    it('handles an empty pipeline without emitting a dangling WITH', () => {
      const empty = toSql({ ...pipeline, steps: [] }, 'raw_data');
      expect(empty).not.toContain('WITH');
      expect(empty).toContain('SELECT * FROM raw_data;');
    });
  });

  describe('Python', () => {
    const py = toPython(pipeline, 'orders.csv');

    it('reads as text, matching how the app parsed it', () => {
      // Letting pandas infer dtypes would coerce the exact values these steps fix.
      expect(py).toContain('dtype="string"');
      expect(py).toContain('keep_default_na=False');
    });

    it('emits a pandas statement per step', () => {
      expect(py).toContain('df = df.drop_duplicates()');
      expect(py).toContain('.str.strip()');
      expect(py).toContain('pd.to_datetime');
    });

    it('preserves dayFirst', () => {
      expect(py).toContain('dayfirst=True');
    });

    it('keeps unparseable dates rather than nulling them, as the app does', () => {
      expect(py).toContain('.fillna(df["order_date"])');
    });
  });

  describe('dbt', () => {
    it('wraps the same SQL in a model config referencing a source', () => {
      const dbt = toDbt(pipeline);
      expect(dbt).toContain("{{ config(materialized='table') }}");
      expect(dbt).toContain("{{ ref('raw_data') }}");
      expect(dbt.trimEnd().endsWith(';')).toBe(false);
    });
  });

  describe('JSON', () => {
    it('round-trips through JSON.parse', () => {
      const parsed = JSON.parse(toJson(pipeline));
      expect(parsed.steps).toHaveLength(3);
      expect(parsed.version).toBe('1');
    });
  });
});
