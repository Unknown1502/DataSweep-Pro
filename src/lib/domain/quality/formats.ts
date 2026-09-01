import { quoteIdent, quoteLiteral } from '../../engine/sql';
import { issueId, pct, ratioOf, sampleValues } from './helpers';
import { DATE_PATTERNS, FORMAT_CONFIDENCE_THRESHOLD, NUMBER_PATTERNS } from './patterns';
import type { FormatPattern } from './patterns';
import { scoreSeverity } from './severity';
import type { AnalyzeContext, Analyzer, QualityIssue } from './types';

const OTHER = '__other__';

/**
 * Assign every value to the *first* pattern it matches.
 *
 * A chained CASE rather than one COUNT per pattern, because the patterns are
 * not all mutually exclusive and summing overlapping counts would exceed the
 * row count and corrupt the ratios.
 */
function bucketQuery(table: string, column: string, patterns: readonly FormatPattern[]): string {
  const col = quoteIdent(column);
  const branches = patterns
    .map((p) => `WHEN regexp_matches(${col}, ${quoteLiteral(p.regex)}) THEN ${quoteLiteral(p.id)}`)
    .join('\n           ');

  return `SELECT bucket, COUNT(*) AS n FROM (
            SELECT CASE
           ${branches}
             ELSE ${quoteLiteral(OTHER)}
           END AS bucket
            FROM ${quoteIdent(table)}
           WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
          ) GROUP BY bucket`;
}

interface BucketCounts {
  readonly counts: Map<string, number>;
  readonly populated: number;
  readonly recognized: number;
}

async function bucketColumn(
  ctx: AnalyzeContext,
  column: string,
  patterns: readonly FormatPattern[],
): Promise<BucketCounts> {
  const result = await ctx.engine.query(bucketQuery(ctx.table, column, patterns));

  const counts = new Map<string, number>();
  let populated = 0;
  for (const row of result.rows) {
    const bucket = String(row['bucket']);
    const n = Number(row['n'] ?? 0);
    counts.set(bucket, n);
    populated += n;
  }

  return { counts, populated, recognized: populated - (counts.get(OTHER) ?? 0) };
}

function namedBuckets(
  counts: Map<string, number>,
  patterns: readonly FormatPattern[],
): { label: string; n: number }[] {
  return patterns
    .map((p) => ({ label: p.label, n: counts.get(p.id) ?? 0 }))
    .filter((b) => b.n > 0)
    .sort((a, b) => b.n - a.n);
}

/**
 * Columns storing dates in more than one textual format.
 *
 * This is the single most expensive issue in the set to find by hand and the
 * most damaging to leave: sorting or comparing mixed-format dates produces
 * confidently wrong answers rather than errors.
 */
export const analyzeDateFormats: Analyzer = async (ctx) => {
  const issues: QualityIssue[] = [];

  for (const column of ctx.columns) {
    const { counts, populated, recognized } = await bucketColumn(ctx, column, DATE_PATTERNS);
    if (populated === 0) continue;

    // Only judge columns that actually hold dates.
    if (recognized / populated < FORMAT_CONFIDENCE_THRESHOLD) continue;

    const present = namedBuckets(counts, DATE_PATTERNS);
    if (present.length < 2) continue;

    // The minority formats are the ones needing conversion.
    const dominant = present[0];
    const minority = present.slice(1).reduce((sum, b) => sum + b.n, 0);
    const ratio = ratioOf(minority, ctx.rowCount);

    issues.push({
      id: issueId('inconsistent_date_format', column),
      type: 'inconsistent_date_format',
      severity: scoreSeverity('inconsistent_date_format', ratio),
      column,
      description:
        `"${column}" mixes ${present.length} date formats ` +
        `(${present.map((b) => `${b.label}: ${b.n.toLocaleString()}`).join(', ')}). ` +
        `Sorting or comparing this column gives wrong results without error.`,
      affectedRows: minority,
      totalRows: ctx.rowCount,
      ratio,
      evidence: present.map((b) => `${b.label} (${b.n.toLocaleString()} rows)`),
      suggestedFix: {
        operation: 'standardize_dates',
        column,
        parameters: { target: 'YYYY-MM-DD' },
        rationale:
          `Converts all ${present.length} formats to ISO YYYY-MM-DD, which sorts correctly as text. ` +
          `Most values already use ${dominant?.label ?? 'the dominant format'}.`,
      },
    });
  }

  return issues;
};

/**
 * Columns storing numbers in more than one textual format, and columns that are
 * mostly numeric but contain stray non-numeric values.
 */
export const analyzeNumberFormats: Analyzer = async (ctx) => {
  const issues: QualityIssue[] = [];

  for (const column of ctx.columns) {
    const { counts, populated, recognized } = await bucketColumn(ctx, column, NUMBER_PATTERNS);
    if (populated === 0) continue;
    if (recognized / populated < FORMAT_CONFIDENCE_THRESHOLD) continue;

    const present = namedBuckets(counts, NUMBER_PATTERNS);
    const col = quoteIdent(column);

    if (present.length >= 2) {
      const minority = present.slice(1).reduce((sum, b) => sum + b.n, 0);
      const ratio = ratioOf(minority, ctx.rowCount);

      issues.push({
        id: issueId('inconsistent_number_format', column),
        type: 'inconsistent_number_format',
        severity: scoreSeverity('inconsistent_number_format', ratio),
        column,
        description:
          `"${column}" mixes ${present.length} number formats ` +
          `(${present.map((b) => `${b.label}: ${b.n.toLocaleString()}`).join(', ')}). ` +
          `It cannot be summed or averaged until they agree.`,
        affectedRows: minority,
        totalRows: ctx.rowCount,
        ratio,
        evidence: present.map((b) => `${b.label} (${b.n.toLocaleString()} rows)`),
        suggestedFix: {
          operation: 'parse_numbers',
          column,
          parameters: {},
          rationale:
            'Strips currency symbols and thousands separators, then stores a plain decimal number.',
        },
      });
    }

    // Mostly-numeric column with stray text: "N/A", "pending", "TBD".
    const other = counts.get(OTHER) ?? 0;
    if (other > 0) {
      const ratio = ratioOf(other, ctx.rowCount);
      const patternChecks = NUMBER_PATTERNS.map(
        (p) => `NOT regexp_matches(${col}, ${quoteLiteral(p.regex)})`,
      ).join(' AND ');
      const evidence = await sampleValues(
        ctx.engine,
        ctx.table,
        column,
        `${col} IS NOT NULL AND trim(${col}) <> '' AND ${patternChecks}`,
      );

      issues.push({
        id: issueId('mixed_types', column),
        type: 'mixed_types',
        severity: scoreSeverity('mixed_types', ratio),
        column,
        description:
          `"${column}" is mostly numeric but ${other.toLocaleString()} values (${pct(ratio)}) are ` +
          `text. Converting the column will turn these into nulls unless they are handled first.`,
        affectedRows: other,
        totalRows: ctx.rowCount,
        ratio,
        evidence: evidence.map((v) => `"${v}"`),
        suggestedFix: {
          operation: 'fill_missing',
          column,
          parameters: { strategy: 'null_non_numeric' },
          rationale:
            'Replaces the non-numeric placeholders with an explicit empty value, making the ' +
            'gap visible instead of silently coercing it to zero.',
        },
      });
    }
  }

  return issues;
};
