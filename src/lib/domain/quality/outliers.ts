import { quoteIdent, quoteLiteral } from '../../engine/sql';
import { issueId, ratioOf } from './helpers';
import { scoreSeverity } from './severity';
import type { Analyzer, QualityIssue } from './types';

/**
 * Minimum populated numeric values before outlier detection runs.
 *
 * Quartiles over a handful of points are noise, and reporting "3 outliers" on a
 * 9-row column would be worse than saying nothing - it teaches the user the
 * findings are not trustworthy.
 */
const MIN_SAMPLE = 12;

/** Tukey's constant. 1.5x IQR is the conventional "mild outlier" fence. */
const IQR_MULTIPLIER = 1.5;

/** Strip currency symbols, thousands separators and spaces before casting. */
const NUMERIC_CLEAN = String.raw`[^0-9.\-]`;

/**
 * Numeric outliers via the interquartile-range fence.
 *
 * IQR rather than standard deviations because it does not assume a normal
 * distribution and is not itself dragged around by the outliers it is looking
 * for - a single 1000x data-entry error inflates the standard deviation enough
 * to hide itself.
 */
export const analyzeOutliers: Analyzer = async (ctx) => {
  const issues: QualityIssue[] = [];

  for (const column of ctx.columns) {
    const col = quoteIdent(column);
    const cleaned = `TRY_CAST(regexp_replace(${col}, ${quoteLiteral(NUMERIC_CLEAN)}, '', 'g') AS DOUBLE)`;

    const sql = `
      WITH v AS (
        SELECT ${cleaned} AS x
          FROM ${quoteIdent(ctx.table)}
         WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
      ),
      s AS (
        SELECT quantile_cont(x, 0.25) AS q1,
               quantile_cont(x, 0.75) AS q3,
               COUNT(x) AS numeric_n,
               COUNT(*) AS populated_n
          FROM v
      )
      SELECT s.q1, s.q3, s.numeric_n, s.populated_n,
             (SELECT COUNT(*) FROM v
               WHERE v.x IS NOT NULL
                 AND (v.x < s.q1 - ${IQR_MULTIPLIER} * (s.q3 - s.q1)
                   OR v.x > s.q3 + ${IQR_MULTIPLIER} * (s.q3 - s.q1))) AS outlier_n
        FROM s`;

    const result = await ctx.engine.query(sql);
    const row = result.rows[0];
    if (!row) continue;

    const numericN = Number(row['numeric_n'] ?? 0);
    const populatedN = Number(row['populated_n'] ?? 0);
    const outlierN = Number(row['outlier_n'] ?? 0);
    const q1 = Number(row['q1'] ?? 0);
    const q3 = Number(row['q3'] ?? 0);
    const iqr = q3 - q1;

    if (numericN < MIN_SAMPLE) continue;
    // Skip columns that only incidentally parse as numbers (IDs, postcodes are
    // caught by the ratio check; a zero IQR means the middle half is constant).
    if (populatedN === 0 || numericN / populatedN < 0.8) continue;
    if (!Number.isFinite(iqr) || iqr <= 0) continue;
    if (outlierN === 0) continue;

    const lower = q1 - IQR_MULTIPLIER * iqr;
    const upper = q3 + IQR_MULTIPLIER * iqr;
    const ratio = ratioOf(outlierN, numericN);

    const extremes = await ctx.engine.query(
      `SELECT DISTINCT ${col} AS v
         FROM ${quoteIdent(ctx.table)}
        WHERE ${cleaned} IS NOT NULL
          AND (${cleaned} < ${lower} OR ${cleaned} > ${upper})
        ORDER BY abs(${cleaned}) DESC
        LIMIT 3`,
    );

    issues.push({
      id: issueId('outliers', column),
      type: 'outliers',
      severity: scoreSeverity('outliers', ratio),
      column,
      description:
        `${outlierN.toLocaleString()} values in "${column}" fall outside the expected range ` +
        `${lower.toFixed(2)} to ${upper.toFixed(2)}. These may be genuine extremes or data-entry errors.`,
      affectedRows: outlierN,
      totalRows: ctx.rowCount,
      ratio,
      evidence: extremes.rows.map((r) => String(r['v'] ?? '')),
      suggestedFix: {
        // Deliberately not auto-suggested as destructive: an outlier is often
        // the most interesting real row in the dataset, not an error.
        operation: 'clip_outliers',
        column,
        parameters: { lower, upper, method: 'iqr' },
        rationale:
          'Review these before acting. Clipping caps them at the fence; removing them is ' +
          'only correct if they are known to be entry errors.',
      },
    });
  }

  return issues;
};
