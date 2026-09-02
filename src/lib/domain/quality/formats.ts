import { quoteIdent, quoteLiteral } from '../../engine/sql';
import {
  bucketColumn,
  issueId,
  OTHER_BUCKET as OTHER,
  pct,
  ratioOf,
  sampleValues,
} from './helpers';
import { DATE_PATTERNS, FORMAT_CONFIDENCE_THRESHOLD, NUMBER_PATTERNS } from './patterns';
import type { FormatPattern } from './patterns';
import { resolveDateOrder } from './semantics';
import { scoreSeverity } from './severity';
import type { Analyzer, QualityIssue } from './types';

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
    const { counts, populated, recognized } = await bucketColumn(
      ctx.engine,
      ctx.table,
      column,
      DATE_PATTERNS,
    );
    if (populated === 0) continue;

    // Only judge columns that actually hold dates.
    if (recognized / populated < FORMAT_CONFIDENCE_THRESHOLD) continue;

    // Resolve D/M/Y vs M/D/Y from the values themselves rather than assuming.
    const dateOrder = await resolveDateOrder(ctx.engine, ctx.table, column);

    // A column mixing both orderings cannot be parsed correctly under any single
    // setting. That is a defect in its own right, not a parameter to pick — and
    // it is reported even when only one textual format is present, because the
    // damage does not depend on format variety.
    if (dateOrder.order === 'contradictory') {
      const affected = dateOrder.firstOver12 + dateOrder.secondOver12;
      issues.push({
        id: issueId('contradictory_date_order', column),
        type: 'contradictory_date_order',
        severity: 'high',
        column,
        description:
          `"${column}" contains both D/M/YYYY and M/D/YYYY dates. ${dateOrder.evidence} ` +
          `Any conversion will silently mis-read part of this column, so the ordering has to ` +
          `be established per row before it can be standardized.`,
        affectedRows: affected,
        totalRows: ctx.rowCount,
        ratio: ratioOf(affected, ctx.rowCount),
        evidence: [
          `${dateOrder.firstOver12} value(s) can only be day-first`,
          `${dateOrder.secondOver12} value(s) can only be month-first`,
        ],
        // No suggested fix on purpose: there is no correct automatic answer,
        // and offering one would invite a silent corruption.
        suggestedFix: null,
      });
      continue;
    }

    const present = namedBuckets(counts, DATE_PATTERNS);
    if (present.length < 2) continue;

    // The minority formats are the ones needing conversion.
    const dominant = present[0];
    const minority = present.slice(1).reduce((sum, b) => sum + b.n, 0);
    const ratio = ratioOf(minority, ctx.rowCount);
    const dayFirst = dateOrder.order !== 'month_first';

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
        parameters: { target: 'YYYY-MM-DD', dayFirst },
        rationale:
          `Converts all ${present.length} formats to ISO YYYY-MM-DD, which sorts correctly as ` +
          `text. Most values already use ${dominant?.label ?? 'the dominant format'}. ` +
          dateOrder.evidence,
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
    const { counts, populated, recognized } = await bucketColumn(
      ctx.engine,
      ctx.table,
      column,
      NUMBER_PATTERNS,
    );
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
