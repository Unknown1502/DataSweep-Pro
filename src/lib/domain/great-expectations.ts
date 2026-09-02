import type { SemanticDetection } from './quality/semantics';
import { patternFor } from './quality/semantics';
import type { Pipeline } from './pipeline';

/**
 * Emit a Great Expectations suite from a cleaned dataset.
 *
 * The framing matters: a GE suite is a **guard against future data**, not a
 * description of the past. So expectations are derived from the state the data
 * is in *after* cleaning — "dates in this column are ISO from now on" — rather
 * than from the problems that were found and fixed.
 *
 * FORMAT: this emits the **0.18.x** suite shape (`expectation_suite_name`, with
 * `expectations[].expectation_type` + `kwargs`). GE 1.x renamed the top-level
 * key to `name`, and its per-expectation serialization is not published in the
 * docs, so guessing at it would produce a file that fails confusingly. The
 * target version and the 1.x difference are both recorded in `meta` so a user
 * on 1.x knows exactly what to do.
 */

export const GE_TARGET_VERSION = '0.18.x';

export interface GeExpectation {
  readonly expectation_type: string;
  readonly kwargs: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface GeSuite {
  readonly expectation_suite_name: string;
  readonly data_asset_type: null;
  readonly expectations: readonly GeExpectation[];
  readonly meta: Record<string, unknown>;
}

/** Every expectation type this generator can emit. Used to validate output. */
export const EMITTED_EXPECTATION_TYPES = [
  'expect_table_row_count_to_be_between',
  'expect_table_columns_to_match_set',
  'expect_column_to_exist',
  'expect_column_values_to_not_be_null',
  'expect_column_values_to_match_regex',
  'expect_column_values_to_be_between',
  'expect_column_values_to_be_in_set',
  'expect_column_unique_value_count_to_be_between',
  'expect_column_values_to_be_unique',
] as const;

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const PLAIN_NUMBER = '^-?\\d+(\\.\\d+)?$';

export interface SuiteInput {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly semantics: readonly SemanticDetection[];
  /** The cleaning pipeline that produced this state, for provenance. */
  readonly pipeline?: Pipeline;
  /** Columns with no missing values after cleaning. */
  readonly completeColumns?: readonly string[];
  /** Fences from outlier analysis, if any were established. */
  readonly numericRanges?: Readonly<Record<string, { min: number; max: number }>>;
}

export function buildSuite(input: SuiteInput): GeSuite {
  const expectations: GeExpectation[] = [];

  // Shape first: a column that vanished is the failure most likely to make
  // every other expectation misleading rather than merely failing.
  expectations.push({
    expectation_type: 'expect_table_columns_to_match_set',
    kwargs: { column_set: [...input.columns], exact_match: false },
    meta: { note: 'Extra columns are tolerated; missing ones are not.' },
  });

  if (input.rowCount > 0) {
    // A band rather than an exact count: future batches legitimately differ in
    // size, and an exact match would fail on every correct run.
    expectations.push({
      expectation_type: 'expect_table_row_count_to_be_between',
      kwargs: {
        min_value: Math.max(1, Math.floor(input.rowCount * 0.5)),
        max_value: Math.ceil(input.rowCount * 2),
      },
      meta: { note: `Derived from ${input.rowCount} rows at export; widen if batches vary.` },
    });
  }

  for (const column of input.columns) {
    expectations.push({
      expectation_type: 'expect_column_to_exist',
      kwargs: { column },
    });
  }

  for (const column of input.completeColumns ?? []) {
    expectations.push({
      expectation_type: 'expect_column_values_to_not_be_null',
      kwargs: { column },
      meta: { note: 'This column had no missing values after cleaning.' },
    });
  }

  for (const detection of input.semantics) {
    // Only assert a shape we are actually confident about. An ambiguous column
    // would produce an expectation that fails on correct data, which trains
    // people to ignore the suite.
    if (detection.ambiguous) continue;

    const { column, detectedType } = detection;

    if (detectedType === 'date') {
      expectations.push({
        expectation_type: 'expect_column_values_to_match_regex',
        kwargs: { column, regex: ISO_DATE, mostly: 1.0 },
        meta: { note: 'Standardized to ISO YYYY-MM-DD during cleaning.' },
      });
      continue;
    }

    if (detectedType === 'integer' || detectedType === 'decimal' || detectedType === 'currency') {
      expectations.push({
        expectation_type: 'expect_column_values_to_match_regex',
        kwargs: { column, regex: PLAIN_NUMBER, mostly: 1.0 },
        meta: { note: 'Parsed to a plain number during cleaning.' },
      });

      const range = input.numericRanges?.[column];
      if (range) {
        expectations.push({
          expectation_type: 'expect_column_values_to_be_between',
          kwargs: { column, min_value: range.min, max_value: range.max },
          meta: { note: 'Range observed at export time, not a business rule.' },
        });
      }
      continue;
    }

    if (detectedType === 'identifier') {
      expectations.push({
        expectation_type: 'expect_column_values_to_be_unique',
        kwargs: { column },
        meta: { note: 'Every value was distinct at export time.' },
      });
      continue;
    }

    if (detectedType === 'categorical') {
      expectations.push({
        expectation_type: 'expect_column_unique_value_count_to_be_between',
        kwargs: { column, min_value: 1, max_value: Math.max(1, detection.distinctCount * 2) },
        meta: { note: `${detection.distinctCount} distinct values at export time.` },
      });
      continue;
    }

    const pattern = patternFor(detectedType);
    if (pattern) {
      expectations.push({
        expectation_type: 'expect_column_values_to_match_regex',
        kwargs: { column, regex: pattern, mostly: 1.0 },
        meta: { note: `Detected as ${detectedType} with ${Math.round(detection.confidence * 100)}% confidence.` },
      });
    }
  }

  return {
    expectation_suite_name: input.name,
    data_asset_type: null,
    expectations,
    meta: {
      great_expectations_version: GE_TARGET_VERSION,
      generated_by: 'DataSweep Pro',
      // Stated rather than left to fail confusingly for anyone on 1.x.
      format_note:
        'This file uses the Great Expectations 0.18.x suite format. GX 1.x renamed the ' +
        'top-level "expectation_suite_name" key to "name" — rename it, or run ' +
        '`great_expectations suite migrate`, before loading under 1.x.',
      ...(input.pipeline
        ? {
            cleaning_steps: input.pipeline.steps.map((s) => ({
              operation: s.operation,
              column: s.column,
            })),
          }
        : {}),
    },
  };
}

export function toGreatExpectations(input: SuiteInput): string {
  return JSON.stringify(buildSuite(input), null, 2);
}
