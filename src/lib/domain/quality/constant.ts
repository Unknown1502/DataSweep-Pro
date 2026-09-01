import { quoteIdent } from '../../engine/sql';
import { issueId, positionalAlias } from './helpers';
import type { Analyzer, QualityIssue } from './types';

/**
 * Columns holding a single distinct value across every row.
 *
 * Informational rather than a defect: it is usually an export artifact - a
 * filter applied upstream - and the column then costs memory and attention
 * without carrying information.
 */
export const analyzeConstantColumns: Analyzer = async (ctx) => {
  if (ctx.columns.length === 0 || ctx.rowCount < 2) return [];

  const selects = ctx.columns.map(
    (column, i) => `COUNT(DISTINCT ${quoteIdent(column)}) AS ${positionalAlias(i)}`,
  );

  const result = await ctx.engine.query(
    `SELECT ${selects.join(', ')} FROM ${quoteIdent(ctx.table)}`,
  );
  const row = result.rows[0];
  if (!row) return [];

  const issues: QualityIssue[] = [];

  for (const [i, column] of ctx.columns.entries()) {
    // COUNT(DISTINCT) ignores NULL, so 0 means "entirely empty" - that is the
    // missing-values analyzer's finding to report, not ours.
    if (Number(row[positionalAlias(i)] ?? 0) !== 1) continue;

    const sample = await ctx.engine.query(
      `SELECT DISTINCT ${quoteIdent(column)} AS v FROM ${quoteIdent(ctx.table)}
        WHERE ${quoteIdent(column)} IS NOT NULL LIMIT 1`,
    );
    const value = String(sample.rows[0]?.['v'] ?? '');

    issues.push({
      id: issueId('constant_column', column),
      type: 'constant_column',
      severity: 'low',
      column,
      description: `Every row has the same value for "${column}" ("${value}"), so it cannot distinguish rows.`,
      affectedRows: ctx.rowCount,
      totalRows: ctx.rowCount,
      ratio: 1,
      evidence: [value],
      suggestedFix: {
        operation: 'drop_column',
        column,
        parameters: {},
        rationale: 'The column carries no information; removing it simplifies the dataset.',
      },
    });
  }

  return issues;
};
