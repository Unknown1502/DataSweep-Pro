import { quoteIdent } from '../../engine/sql';
import { toExcerpt } from '../injection';
import { issueId, pct, ratioOf } from './helpers';
import { scoreSeverity } from './severity';
import type { Analyzer } from './types';

/**
 * Fully duplicated rows.
 *
 * Reported as *excess* rows (total minus distinct) rather than as a count of
 * duplicated groups, because excess is the number a fix would actually remove
 * and therefore the number the user needs in order to judge the fix.
 */
export const analyzeDuplicates: Analyzer = async (ctx) => {
  if (ctx.rowCount === 0 || ctx.columns.length === 0) return [];

  const table = quoteIdent(ctx.table);
  const result = await ctx.engine.query(
    `SELECT (SELECT COUNT(*) FROM ${table}) AS total,
            (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM ${table})) AS distinct_rows`,
  );

  const total = Number(result.rows[0]?.['total'] ?? 0);
  const distinct = Number(result.rows[0]?.['distinct_rows'] ?? 0);
  const excess = total - distinct;
  if (excess <= 0) return [];

  const ratio = ratioOf(excess, total);

  // Show concrete repeated rows so the finding is verifiable, not just a number.
  const sample = await ctx.engine.query(
    `SELECT *, COUNT(*) AS occurrences
       FROM ${table}
      GROUP BY ALL
     HAVING COUNT(*) > 1
      ORDER BY occurrences DESC
      LIMIT 3`,
  );

  const evidence = sample.rows.map((row) => {
    const occurrences = Number(row['occurrences'] ?? 0);
    const preview = ctx.columns
      .slice(0, 4)
      .map((c) => `${c}=${toExcerpt(String(row[c] ?? ''), 24)}`)
      .join(', ');
    return `${occurrences}x  ${preview}`;
  });

  return [
    {
      id: issueId('duplicate_rows', null),
      type: 'duplicate_rows',
      severity: scoreSeverity('duplicate_rows', ratio),
      column: null,
      description:
        `${excess.toLocaleString()} of ${total.toLocaleString()} rows (${pct(ratio)}) are exact ` +
        `duplicates of another row. Any total or average over this data is currently wrong.`,
      affectedRows: excess,
      totalRows: total,
      ratio,
      evidence,
      suggestedFix: {
        operation: 'remove_duplicates',
        column: null,
        parameters: {},
        rationale:
          `Keeps the first occurrence of each row and removes ${excess.toLocaleString()} ` +
          `${excess === 1 ? 'repeat' : 'repeats'}.`,
      },
    },
  ];
};
