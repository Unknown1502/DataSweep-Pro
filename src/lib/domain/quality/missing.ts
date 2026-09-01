import { quoteIdent } from '../../engine/sql';
import { issueId, pct, positionalAlias, ratioOf } from './helpers';
import { scoreSeverity } from './severity';
import type { Analyzer, QualityIssue } from './types';

/**
 * Missing values, counting both SQL NULL and the empty/whitespace-only strings
 * that CSV ingestion produces. Treating those as distinct would under-report
 * badly: a spreadsheet exported to CSV represents "blank" as an empty field far
 * more often than as a true NULL.
 */
export const analyzeMissing: Analyzer = async (ctx) => {
  if (ctx.columns.length === 0 || ctx.rowCount === 0) return [];

  const selects = ctx.columns.map((column, i) => {
    const col = quoteIdent(column);
    return `COUNT(*) FILTER (WHERE ${col} IS NULL OR trim(${col}) = '') AS ${positionalAlias(i)}`;
  });

  const result = await ctx.engine.query(
    `SELECT ${selects.join(', ')} FROM ${quoteIdent(ctx.table)}`,
  );
  const row = result.rows[0];
  if (!row) return [];

  const issues: QualityIssue[] = [];

  ctx.columns.forEach((column, i) => {
    const affected = Number(row[positionalAlias(i)] ?? 0);
    if (affected === 0) return;

    const ratio = ratioOf(affected, ctx.rowCount);
    const everythingMissing = affected === ctx.rowCount;
    const rows = affected.toLocaleString();
    const total = ctx.rowCount.toLocaleString();

    issues.push({
      id: issueId('missing_values', column),
      type: 'missing_values',
      severity: everythingMissing ? 'high' : scoreSeverity('missing_values', ratio),
      column,
      description: everythingMissing
        ? `Every value in "${column}" is empty.`
        : `${rows} of ${total} rows (${pct(ratio)}) have no value for "${column}".`,
      affectedRows: affected,
      totalRows: ctx.rowCount,
      ratio,
      evidence: [],
      suggestedFix: everythingMissing
        ? {
            operation: 'drop_column',
            column,
            parameters: {},
            rationale: `"${column}" is empty in every row and carries no information.`,
          }
        : {
            // Deleting rows is the more destructive option, so it is only
            // suggested when the affected slice is small enough that losing it
            // costs less than imputing values that were never measured.
            operation: ratio < 0.05 ? 'drop_rows_with_missing' : 'fill_missing',
            column,
            parameters: ratio < 0.05 ? {} : { strategy: 'placeholder', value: 'Unknown' },
            rationale:
              ratio < 0.05
                ? `Only ${pct(ratio)} of rows are affected; dropping them loses less than guessing.`
                : `${pct(ratio)} of rows are affected - too many to drop without biasing the data.`,
          },
    });
  });

  return issues;
};
