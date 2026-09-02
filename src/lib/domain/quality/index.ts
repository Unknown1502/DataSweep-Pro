import { quoteIdent } from '../../engine/sql';
import type { SqlEngine } from '../../engine/types';
import { scanRows } from '../injection';
import { analyzeConstantColumns } from './constant';
import { analyzeDuplicates } from './duplicates';
import { analyzeDateFormats, analyzeNumberFormats } from './formats';
import { issueId, pct, ratioOf } from './helpers';
import { analyzeMissing } from './missing';
import { analyzeOutliers } from './outliers';
import { overallScore } from './severity';
import type { AnalyzeContext, Analyzer, IssueType, QualityIssue, Severity } from './types';
import { analyzeWhitespace } from './whitespace';

export * from './types';
export { overallScore, scoreSeverity } from './severity';

/** How many rows to pull when scanning cell content for injection payloads. */
const INJECTION_SCAN_ROWS = 500;

/**
 * Injection is not a data-quality problem in the usual sense, so it does not
 * go through the `Analyzer` shape - it needs raw rows rather than aggregates.
 */
async function analyzeInjection(ctx: AnalyzeContext): Promise<QualityIssue[]> {
  if (ctx.rowCount === 0 || ctx.columns.length === 0) return [];

  const sample = await ctx.engine.query(
    `SELECT * FROM ${quoteIdent(ctx.table)} LIMIT ${INJECTION_SCAN_ROWS}`,
  );
  const findings = scanRows(sample.rows, ctx.columns);
  if (findings.length === 0) return [];

  // Group by column so the user sees one finding per column, not one per cell.
  const byColumn = new Map<string, typeof findings>();
  for (const finding of findings) {
    const bucket = byColumn.get(finding.column) ?? [];
    bucket.push(finding);
    byColumn.set(finding.column, bucket);
  }

  return [...byColumn.entries()].map(([column, columnFindings]) => {
    const rows = new Set(columnFindings.map((f) => f.rowIndex)).size;
    const rules = [...new Set(columnFindings.map((f) => f.description))];

    return {
      id: issueId('injected_content', column),
      type: 'injected_content' as IssueType,
      severity: 'high' as Severity,
      column,
      description:
        `${rows} row${rows === 1 ? '' : 's'} in "${column}" contain text that appears aimed at an ` +
        `AI agent rather than at a reader (${rules.join('; ')}). This content is quarantined ` +
        `before it reaches the agent, but review it before sharing this dataset.`,
      affectedRows: rows,
      totalRows: Math.min(ctx.rowCount, INJECTION_SCAN_ROWS),
      ratio: ratioOf(rows, Math.min(ctx.rowCount, INJECTION_SCAN_ROWS)),
      evidence: columnFindings.slice(0, 3).map((f) => `row ${f.rowIndex + 1}: ${f.excerpt}`),
      suggestedFix: {
        operation: 'quarantine_rows' as const,
        column,
        parameters: { rowIndexes: [...new Set(columnFindings.map((f) => f.rowIndex))] },
        rationale:
          'Flags these rows so they are excluded from anything sent to an agent, without ' +
          'deleting data you may need.',
      },
    };
  });
}

export type CheckName =
  | 'missing_values'
  | 'duplicates'
  | 'whitespace'
  | 'date_formats'
  | 'number_formats'
  | 'outliers'
  | 'constant_columns'
  | 'injection';

const ANALYZERS: Record<CheckName, Analyzer> = {
  missing_values: analyzeMissing,
  duplicates: analyzeDuplicates,
  whitespace: analyzeWhitespace,
  date_formats: analyzeDateFormats,
  number_formats: analyzeNumberFormats,
  outliers: analyzeOutliers,
  constant_columns: analyzeConstantColumns,
  injection: analyzeInjection,
};

export const ALL_CHECKS = Object.keys(ANALYZERS) as CheckName[];

/**
 * What one check actually did, measured.
 *
 * This is the honest substrate for the concurrency view: the checks genuinely
 * do run at the same time, and these numbers show it rather than assert it. No
 * coordination happens between them and none is claimed — they are independent
 * by construction, which is exactly why running them concurrently is correct.
 */
export interface CheckTiming {
  readonly check: CheckName;
  /** Milliseconds after the batch started that this check began. */
  readonly startOffsetMs: number;
  readonly durationMs: number;
  readonly findings: number;
  /** True when the check threw and its findings were dropped. */
  readonly failed: boolean;
}

export interface QualityReport {
  readonly score: number;
  readonly issues: readonly QualityIssue[];
  readonly checksRun: readonly CheckName[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly summary: string;
  readonly timings: readonly CheckTiming[];
  /** Wall-clock for the whole batch. Less than the sum of durations. */
  readonly totalMs: number;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface AnalyzeOptions {
  readonly checks?: readonly CheckName[];
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
}

/**
 * Run the quality checks and produce a report.
 *
 * Analyzers run independently and a failure in one does not sink the rest: a
 * partial report on a weird column is far more useful than an error page.
 */
export async function analyzeQuality(
  engine: SqlEngine,
  options: AnalyzeOptions,
): Promise<QualityReport> {
  const checks = options.checks?.length ? options.checks : ALL_CHECKS;
  const ctx: AnalyzeContext = {
    engine,
    table: options.table,
    columns: options.columns,
    rowCount: options.rowCount,
  };

  const batchStart = Date.now();
  const timings: CheckTiming[] = [];

  const results = await Promise.all(
    checks.map(async (check) => {
      const analyzer = ANALYZERS[check];
      if (!analyzer) return [];

      const startOffsetMs = Date.now() - batchStart;
      try {
        const found = await analyzer(ctx);
        timings.push({
          check,
          startOffsetMs,
          durationMs: Date.now() - batchStart - startOffsetMs,
          findings: found.length,
          failed: false,
        });
        return found;
      } catch {
        // A single analyzer failing on an unusual column must not lose the
        // findings from the other seven. The failure is still recorded, so a
        // silently empty check is distinguishable from one that found nothing.
        timings.push({
          check,
          startOffsetMs,
          durationMs: Date.now() - batchStart - startOffsetMs,
          findings: 0,
          failed: true,
        });
        return [];
      }
    }),
  );

  const totalMs = Date.now() - batchStart;
  timings.sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.check.localeCompare(b.check));

  const issues = results
    .flat()
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.ratio - a.ratio,
    );

  const score = overallScore(issues);
  const high = issues.filter((i) => i.severity === 'high').length;

  return {
    score,
    issues,
    checksRun: checks,
    rowCount: options.rowCount,
    columnCount: options.columns.length,
    timings,
    totalMs,
    summary:
      issues.length === 0
        ? `No quality issues found across ${options.columns.length} columns and ${options.rowCount.toLocaleString()} rows.`
        : `${issues.length} issue${issues.length === 1 ? '' : 's'} found` +
          (high > 0 ? `, ${high} needing attention` : '') +
          `. Quality score ${score}/100 over ${options.rowCount.toLocaleString()} rows.`,
  };
}

export { pct };
