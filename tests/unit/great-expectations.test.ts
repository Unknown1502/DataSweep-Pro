import { describe, expect, it } from 'vitest';
import {
  buildSuite,
  EMITTED_EXPECTATION_TYPES,
  GE_TARGET_VERSION,
  toGreatExpectations,
} from '../../src/lib/domain/great-expectations';
import type { SemanticDetection } from '../../src/lib/domain/quality/semantics';

function detection(over: Partial<SemanticDetection>): SemanticDetection {
  return {
    column: 'c',
    detectedType: 'free_text',
    confidence: 1,
    label: 'Free text',
    ambiguous: false,
    alternatives: [],
    populated: 10,
    distinctCount: 10,
    ...over,
  };
}

const base = {
  name: 'orders_suite',
  columns: ['id', 'email', 'order_date', 'amount', 'status'],
  rowCount: 100,
  semantics: [
    detection({ column: 'id', detectedType: 'identifier', label: 'Identifier' }),
    detection({ column: 'email', detectedType: 'email', label: 'Email address' }),
    detection({ column: 'order_date', detectedType: 'date', label: 'Date' }),
    detection({ column: 'amount', detectedType: 'decimal', label: 'Decimal number' }),
    detection({ column: 'status', detectedType: 'categorical', label: 'Category', distinctCount: 3 }),
  ],
  completeColumns: ['id', 'email'],
};

describe('Great Expectations suite', () => {
  const suite = buildSuite(base);
  const types = suite.expectations.map((e) => e.expectation_type);

  it('uses the 0.18 top-level key, which is the format we can verify', () => {
    expect(suite.expectation_suite_name).toBe('orders_suite');
    expect(suite.meta['great_expectations_version']).toBe(GE_TARGET_VERSION);
  });

  it('tells a 1.x user exactly what differs, rather than failing confusingly', () => {
    // GX 1.x renamed the key; a file that just breaks on load is a bad export.
    expect(String(suite.meta['format_note'])).toMatch(/1\.x renamed/);
    expect(String(suite.meta['format_note'])).toMatch(/suite migrate/);
  });

  it('only emits expectation types it declares', () => {
    for (const type of types) {
      expect(EMITTED_EXPECTATION_TYPES).toContain(type);
    }
  });

  it('every expectation carries a column or is table-scoped', () => {
    for (const e of suite.expectations) {
      const tableScoped = e.expectation_type.startsWith('expect_table_');
      expect(tableScoped || typeof e.kwargs['column'] === 'string').toBe(true);
    }
  });

  it('asserts the schema and a row-count band, not an exact count', () => {
    // An exact row count fails on every correct future batch.
    expect(types).toContain('expect_table_columns_to_match_set');
    const rowCount = suite.expectations.find(
      (e) => e.expectation_type === 'expect_table_row_count_to_be_between',
    );
    expect(rowCount?.kwargs['min_value']).toBe(50);
    expect(rowCount?.kwargs['max_value']).toBe(200);
  });

  it('requires every column to exist', () => {
    const existence = suite.expectations.filter((e) => e.expectation_type === 'expect_column_to_exist');
    expect(existence).toHaveLength(base.columns.length);
  });

  it('asserts not-null only for columns that were actually complete', () => {
    const notNull = suite.expectations
      .filter((e) => e.expectation_type === 'expect_column_values_to_not_be_null')
      .map((e) => e.kwargs['column']);
    expect(notNull.sort()).toEqual(['email', 'id']);
  });

  it('asserts ISO dates for a date column', () => {
    const dateRule = suite.expectations.find(
      (e) =>
        e.expectation_type === 'expect_column_values_to_match_regex' &&
        e.kwargs['column'] === 'order_date',
    );
    // Assert on behaviour rather than on the literal pattern text: what matters
    // is that the emitted regex accepts ISO and rejects the formats we convert
    // away from.
    const re = new RegExp(String(dateRule?.kwargs['regex']));
    expect(re.test('2024-01-15')).toBe(true);
    expect(re.test('15/01/2024')).toBe(false);
    expect(re.test('Mar 15 2024')).toBe(false);
  });

  it('emits a numeric pattern that accepts plain numbers and rejects currency', () => {
    const amountRule = suite.expectations.find(
      (e) =>
        e.expectation_type === 'expect_column_values_to_match_regex' &&
        e.kwargs['column'] === 'amount',
    );
    const re = new RegExp(String(amountRule?.kwargs['regex']));
    expect(re.test('1200.50')).toBe(true);
    expect(re.test('-40')).toBe(true);
    expect(re.test('$1,200.50')).toBe(false);
  });

  it('asserts uniqueness for an identifier', () => {
    const unique = suite.expectations.find((e) => e.expectation_type === 'expect_column_values_to_be_unique');
    expect(unique?.kwargs['column']).toBe('id');
  });

  it('bounds cardinality for a categorical column', () => {
    const card = suite.expectations.find(
      (e) => e.expectation_type === 'expect_column_unique_value_count_to_be_between',
    );
    expect(card?.kwargs['column']).toBe('status');
  });

  it('emits nothing for an ambiguous column', () => {
    // An expectation that fails on correct data trains people to ignore the suite.
    const withAmbiguous = buildSuite({
      ...base,
      semantics: [detection({ column: 'email', detectedType: 'email', ambiguous: true })],
      completeColumns: [],
    });
    const emailRules = withAmbiguous.expectations.filter((e) => e.kwargs['column'] === 'email');
    expect(emailRules.map((e) => e.expectation_type)).toEqual(['expect_column_to_exist']);
  });

  it('records the cleaning steps as provenance when a pipeline is given', () => {
    const withPipeline = buildSuite({
      ...base,
      pipeline: {
        name: 'p',
        version: '1',
        createdAt: '2026-01-01T00:00:00.000Z',
        requiredColumns: ['amount'],
        steps: [
          { operation: 'parse_numbers', column: 'amount', parameters: {}, description: 'parse' },
        ],
      },
    });
    expect(withPipeline.meta['cleaning_steps']).toEqual([
      { operation: 'parse_numbers', column: 'amount' },
    ]);
  });

  it('serializes to valid JSON', () => {
    const parsed = JSON.parse(toGreatExpectations(base));
    expect(parsed.expectation_suite_name).toBe('orders_suite');
    expect(Array.isArray(parsed.expectations)).toBe(true);
    expect(parsed.data_asset_type).toBeNull();
  });

  it('handles an empty dataset without emitting a nonsensical row-count band', () => {
    const empty = buildSuite({ ...base, rowCount: 0, semantics: [], completeColumns: [] });
    expect(empty.expectations.map((e) => e.expectation_type)).not.toContain(
      'expect_table_row_count_to_be_between',
    );
  });
});
