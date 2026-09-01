import { quoteIdent } from '../../engine/sql';
import { issueId, pct, positionalAlias, ratioOf, sampleValues } from './helpers';
import { scoreSeverity } from './severity';
import type { Analyzer, QualityIssue } from './types';

/**
 * Values carrying leading or trailing whitespace.
 *
 * Low severity alone, but it is the classic silent join-breaker: "Acme " and
 * "Acme" are different keys, so a lookup quietly misses and the row vanishes
 * from a report with no error raised anywhere.
 */
export const analyzeWhitespace: Analyzer = async (ctx) => {
  if (ctx.columns.length === 0 || ctx.rowCount === 0) return [];

  const selects = ctx.columns.map((column, i) => {
    const col = quoteIdent(column);
    return `COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col} <> trim(${col})) AS ${positionalAlias(i)}`;
  });

  const result = await ctx.engine.query(
    `SELECT ${selects.join(', ')} FROM ${quoteIdent(ctx.table)}`,
  );
  const row = result.rows[0];
  if (!row) return [];

  const issues: QualityIssue[] = [];

  for (const [i, column] of ctx.columns.entries()) {
    const affected = Number(row[positionalAlias(i)] ?? 0);
    if (affected === 0) continue;

    const ratio = ratioOf(affected, ctx.rowCount);
    const col = quoteIdent(column);
    const evidence = await sampleValues(
      ctx.engine,
      ctx.table,
      column,
      `${col} IS NOT NULL AND ${col} <> trim(${col})`,
    );

    issues.push({
      id: issueId('whitespace', column),
      type: 'whitespace',
      severity: scoreSeverity('whitespace', ratio),
      column,
      description:
        `${affected.toLocaleString()} values in "${column}" (${pct(ratio)}) have leading or ` +
        `trailing whitespace, so they will not match their trimmed equivalents when joined or grouped.`,
      affectedRows: affected,
      totalRows: ctx.rowCount,
      ratio,
      evidence: evidence.map((v) => `"${v}"`),
      suggestedFix: {
        operation: 'trim_whitespace',
        column,
        parameters: {},
        rationale: 'Removes surrounding whitespace without altering the value itself.',
      },
    });
  }

  return issues;
};
