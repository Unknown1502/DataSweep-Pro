import { quoteIdent, quoteLiteral } from '../../engine/sql';
import type { SqlEngine } from '../../engine/types';
import { bucketColumn, OTHER_BUCKET } from './helpers';
import type { FormatPattern } from './patterns';

/**
 * Semantic type detection: what a column *means*, not merely how it is stored.
 *
 * Every column in this app is VARCHAR by design (ingest deliberately refuses to
 * let DuckDB coerce anything), so the storage type carries no information. What
 * a user needs to know is that `contact` holds email addresses and `ref` holds
 * UUIDs.
 *
 * Confidence is always reported and never rounded away. A column below the
 * confidence floor is labelled ambiguous with its runners-up rather than
 * assigned a type it might not have — guessing silently is how a cleaning tool
 * corrupts data while looking helpful.
 */

export type SemanticType =
  | 'email'
  | 'url'
  | 'phone'
  | 'uuid'
  | 'ipv4'
  | 'postcode'
  | 'currency'
  | 'percentage'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'categorical'
  | 'identifier'
  | 'free_text';

/** Below this, a column is reported as ambiguous rather than assigned a type. */
export const SEMANTIC_CONFIDENCE_FLOOR = 0.8;

/**
 * Ordered most-to-least specific: the first match wins, so `uuid` is tested
 * before `identifier` and `email` before `free_text`.
 */
export const SEMANTIC_PATTERNS: readonly FormatPattern[] = [
  {
    id: 'email',
    label: 'Email address',
    regex: String.raw`^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$`,
  },
  { id: 'url', label: 'URL', regex: String.raw`^https?://[^\s]+$` },
  {
    id: 'uuid',
    label: 'UUID',
    regex: String.raw`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
  },
  {
    id: 'ipv4',
    label: 'IPv4 address',
    regex: String.raw`^([0-9]{1,3}\.){3}[0-9]{1,3}$`,
  },
  {
    id: 'datetime',
    label: 'Date and time',
    regex: String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}`,
  },
  {
    id: 'date',
    label: 'Date',
    regex: String.raw`^(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{1,2}\.\d{1,2}\.\d{4})$`,
  },
  {
    // Before `phone`, because a leading currency symbol is unambiguous.
    id: 'currency',
    label: 'Currency amount',
    regex: `^[$£€¥] ?-?[\\d,. ]+$`,
  },
  { id: 'percentage', label: 'Percentage', regex: String.raw`^-?\d+(\.\d+)?\s?%$` },
  {
    id: 'phone',
    label: 'Phone number',
    // Requires either a leading + or punctuation. A bare run of digits is far
    // more often an id than a phone number, and is classified as such below.
    regex: String.raw`^(\+\d{1,3}[ -]?)?(\(\d{2,4}\)[ -]?|\d{2,4}[ -])[\d -]{5,}$`,
  },
  {
    id: 'postcode',
    label: 'Postal code',
    // UK outward+inward, or US ZIP+4. The bare 5-digit ZIP is deliberately
    // NOT matched: "10001" is far more often an order id or a quantity, and
    // claiming it as a postcode mislabels ordinary integer columns. A real ZIP
    // column loses its label; an id column keeps its meaning. That trade is
    // worth it because the id case is overwhelmingly more common.
    regex: String.raw`^([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{5}-\d{4})$`,
  },
  {
    id: 'boolean',
    label: 'Boolean',
    // Deliberately excludes 0 and 1. Whether a column is boolean is a property
    // of its entire value set, not of single values — including them here made
    // every "1" in a quantity column claim to be a boolean and dragged the
    // integer confidence below the floor. The 0/1 case is handled after
    // detection, where the distinct set is known.
    regex: `^(?i)(true|false|yes|no|y|n|t|f)$`,
  },
  { id: 'integer', label: 'Integer', regex: String.raw`^-?\d+$` },
  { id: 'decimal', label: 'Decimal number', regex: String.raw`^-?\d+\.\d+$` },
];

export interface SemanticDetection {
  readonly column: string;
  readonly detectedType: SemanticType;
  /** 0..1, the share of populated values matching the winning pattern. */
  readonly confidence: number;
  readonly label: string;
  /** True when confidence is below the floor. */
  readonly ambiguous: boolean;
  /** Other types that matched, most common first. */
  readonly alternatives: readonly { type: SemanticType; share: number }[];
  /** Populated (non-null, non-blank) values examined. */
  readonly populated: number;
  readonly distinctCount: number;
}

/**
 * Distinguish a low-cardinality label column from free text.
 *
 * A column whose distinct count is small relative to its length is a category,
 * even when its values match nothing. That is worth knowing: categories can be
 * validated against a set, free text cannot.
 */
const CATEGORICAL_MAX_DISTINCT = 25;
const CATEGORICAL_MAX_RATIO = 0.2;
/**
 * Below this many values the strict ratio is too harsh — three distinct labels
 * across ten rows is obviously a category even though 0.3 exceeds 0.2.
 */
const CATEGORICAL_SMALL_SAMPLE = 30;
/**
 * The loosened ratio for small samples: at least ~30% of values must be repeats.
 *
 * It is loosened, not removed. Removing it entirely classified a customer
 * column with 20 distinct values across 21 rows as a category, which is plainly
 * wrong. Keeping the strict 0.2 rejected `gold, silver, gold, bronze, gold`,
 * which is plainly a vocabulary. The line asks only for meaningful reuse, which
 * is the most a small sample can actually support.
 *
 * Honest limitation: below roughly ten values this distinction is close to
 * undecidable either way, which is why `confidence` is always reported
 * alongside the type rather than presented as a verdict.
 */
const CATEGORICAL_SMALL_SAMPLE_RATIO = 0.7;

function looksCategorical(distinctCount: number, populated: number): boolean {
  if (populated === 0 || distinctCount === 0) return false;
  if (distinctCount > CATEGORICAL_MAX_DISTINCT) return false;
  // There must be actual repetition; all-distinct values are not a vocabulary.
  if (distinctCount >= populated) return false;

  const ratio = distinctCount / populated;
  return populated < CATEGORICAL_SMALL_SAMPLE
    ? ratio <= CATEGORICAL_SMALL_SAMPLE_RATIO
    : ratio <= CATEGORICAL_MAX_RATIO;
}

/** A column whose entire value set is {0,1} is boolean, however it parses. */
async function isZeroOneBoolean(
  engine: SqlEngine,
  table: string,
  column: string,
  distinctCount: number,
): Promise<boolean> {
  if (distinctCount === 0 || distinctCount > 2) return false;
  const result = await engine.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT trim(${quoteIdent(column)}) AS v FROM ${quoteIdent(table)}
        WHERE ${quoteIdent(column)} IS NOT NULL AND trim(${quoteIdent(column)}) <> ''
     ) WHERE v NOT IN ('0', '1')`,
  );
  return Number(result.rows[0]?.['n'] ?? 1) === 0;
}

export async function detectColumnSemantics(
  engine: SqlEngine,
  table: string,
  column: string,
): Promise<SemanticDetection> {
  const { counts, populated } = await bucketColumn(engine, table, column, SEMANTIC_PATTERNS);

  const distinctResult = await engine.query(
    `SELECT COUNT(DISTINCT ${quoteIdent(column)}) AS n FROM ${quoteIdent(table)}`,
  );
  const distinctCount = Number(distinctResult.rows[0]?.['n'] ?? 0);

  const matched = SEMANTIC_PATTERNS.map((p) => ({
    type: p.id as SemanticType,
    label: p.label,
    n: counts.get(p.id) ?? 0,
  }))
    .filter((m) => m.n > 0)
    .sort((a, b) => b.n - a.n);

  const winner = matched[0];
  const confidence = populated === 0 || !winner ? 0 : winner.n / populated;

  // Nothing matched, or matched too weakly: decide between category and prose.
  if (!winner || confidence < SEMANTIC_CONFIDENCE_FLOOR) {
    const categorical = looksCategorical(distinctCount, populated);

    return {
      column,
      detectedType: categorical ? 'categorical' : 'free_text',
      confidence: categorical ? 1 - distinctCount / populated : 0,
      label: categorical ? 'Category' : 'Free text',
      ambiguous: matched.length > 0,
      alternatives: matched.map((m) => ({ type: m.type, share: m.n / populated })),
      populated,
      distinctCount,
    };
  }

  // Now that the distinct set is known, reclaim the 0/1 boolean case.
  if (
    (winner.type === 'integer' || winner.type === 'decimal') &&
    (await isZeroOneBoolean(engine, table, column, distinctCount))
  ) {
    return {
      column,
      detectedType: 'boolean',
      confidence,
      label: 'Boolean',
      ambiguous: false,
      alternatives: [{ type: winner.type, share: 1 }],
      populated,
      distinctCount,
    };
  }

  // A fully-distinct integer column is an id, not a measurement. Summing an id
  // is meaningless, so the distinction changes what we would suggest doing.
  const isIdentifier =
    winner.type === 'integer' && populated > 0 && distinctCount === populated && populated > 1;

  return {
    column,
    detectedType: isIdentifier ? 'identifier' : winner.type,
    confidence,
    label: isIdentifier ? 'Identifier' : winner.label,
    ambiguous: false,
    alternatives: matched.slice(1).map((m) => ({ type: m.type, share: m.n / populated })),
    populated,
    distinctCount,
  };
}

// ---------------------------------------------------------------------------
// Date order resolution
// ---------------------------------------------------------------------------

export type DateOrder = 'day_first' | 'month_first' | 'ambiguous' | 'contradictory';

export interface DateOrderResult {
  readonly order: DateOrder;
  /** Values whose first component exceeds 12 — only a day can do that. */
  readonly firstOver12: number;
  /** Values whose second component exceeds 12 — only a day can do that. */
  readonly secondOver12: number;
  /** Slash/dot-separated values examined. */
  readonly examined: number;
  /** Plain-language explanation, shown to the user verbatim. */
  readonly evidence: string;
}

/**
 * Resolve whether `D/M/Y` or `M/D/Y` is in use, from the data itself.
 *
 * A component above 12 cannot be a month, so it settles the order outright.
 * This turns what was a documented assumption into a measured fact for most
 * real datasets.
 *
 * The fourth outcome is the interesting one. If *both* positions exceed 12
 * somewhere in the column, the column genuinely mixes orderings and no single
 * setting parses it correctly. Previously we would have silently picked one and
 * produced confidently wrong dates; now it is reportable.
 */
export async function resolveDateOrder(
  engine: SqlEngine,
  table: string,
  column: string,
): Promise<DateOrderResult> {
  const col = quoteIdent(column);
  const separated = String.raw`^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$`;
  const firstPart = String.raw`^(\d{1,2})[/.]`;
  const secondPart = String.raw`^\d{1,2}[/.](\d{1,2})[/.]`;

  const result = await engine.query(
    `SELECT
       COUNT(*) FILTER (WHERE regexp_matches(trim(${col}), ${quoteLiteral(separated)})) AS examined,
       COUNT(*) FILTER (
         WHERE regexp_matches(trim(${col}), ${quoteLiteral(separated)})
           AND TRY_CAST(regexp_extract(trim(${col}), ${quoteLiteral(firstPart)}, 1) AS INTEGER) > 12
       ) AS first_over_12,
       COUNT(*) FILTER (
         WHERE regexp_matches(trim(${col}), ${quoteLiteral(separated)})
           AND TRY_CAST(regexp_extract(trim(${col}), ${quoteLiteral(secondPart)}, 1) AS INTEGER) > 12
       ) AS second_over_12
     FROM ${quoteIdent(table)}
     WHERE ${col} IS NOT NULL AND trim(${col}) <> ''`,
  );

  const row = result.rows[0];
  const examined = Number(row?.['examined'] ?? 0);
  const firstOver12 = Number(row?.['first_over_12'] ?? 0);
  const secondOver12 = Number(row?.['second_over_12'] ?? 0);

  if (firstOver12 > 0 && secondOver12 > 0) {
    return {
      order: 'contradictory',
      firstOver12,
      secondOver12,
      examined,
      evidence:
        `${firstOver12} value(s) have a first component above 12 and ${secondOver12} have a ` +
        `second component above 12. The column mixes D/M/Y and M/D/Y, so no single ` +
        `interpretation is correct for all of it.`,
    };
  }

  if (firstOver12 > 0) {
    return {
      order: 'day_first',
      firstOver12,
      secondOver12,
      examined,
      evidence:
        `${firstOver12} value(s) have a first component above 12, which can only be a day. ` +
        `Resolved from the data, not assumed.`,
    };
  }

  if (secondOver12 > 0) {
    return {
      order: 'month_first',
      firstOver12,
      secondOver12,
      examined,
      evidence:
        `${secondOver12} value(s) have a second component above 12, which can only be a day. ` +
        `Resolved from the data, not assumed.`,
    };
  }

  return {
    order: 'ambiguous',
    firstOver12,
    secondOver12,
    examined,
    evidence:
      examined === 0
        ? 'No slash- or dot-separated dates to examine.'
        : `Every component in all ${examined} separated date(s) is 12 or below, so the ordering ` +
          `cannot be determined from the data. Day-first is assumed.`,
  };
}

/** Semantic types worth offering a type-conversion suggestion for. */
export function isNumericSemantic(type: SemanticType): boolean {
  return type === 'integer' || type === 'decimal' || type === 'currency' || type === 'percentage';
}

/** Pattern for a semantic type, used when generating validation expectations. */
export function patternFor(type: SemanticType): string | null {
  return SEMANTIC_PATTERNS.find((p) => p.id === type)?.regex ?? null;
}

export { OTHER_BUCKET };
