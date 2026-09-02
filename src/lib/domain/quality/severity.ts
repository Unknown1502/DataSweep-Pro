import type { IssueType, Severity } from './types';

/**
 * Severity is a function of how much of the dataset is affected and how
 * damaging the issue is if it survives into analysis.
 *
 * The thresholds are deliberately not uniform. A single duplicated row is a
 * real correctness problem the moment anyone sums a column, so duplicates
 * escalate fast. Missing values at 2% are usually tolerable and flagging them
 * as "high" would bury the issues that actually matter.
 */
const BASE_WEIGHT: Record<IssueType, number> = {
  injected_content: 1.0,
  // No single parse setting is correct, so any conversion corrupts part of it.
  contradictory_date_order: 0.95,
  duplicate_rows: 0.8,
  mixed_types: 0.7,
  inconsistent_date_format: 0.65,
  inconsistent_number_format: 0.6,
  missing_values: 0.5,
  outliers: 0.4,
  whitespace: 0.3,
  constant_column: 0.15,
};

export function scoreSeverity(type: IssueType, ratio: number): Severity {
  // Any injected content is high regardless of how few rows carry it: one row
  // is enough to attempt a hijack.
  if (type === 'injected_content') return 'high';

  const score = BASE_WEIGHT[type] * Math.sqrt(Math.min(Math.max(ratio, 0), 1));

  if (score >= 0.35) return 'high';
  if (score >= 0.12) return 'medium';
  return 'low';
}

/**
 * A single 0-100 quality score for the dataset, shown as the headline number.
 *
 * Starts at 100 and deducts per issue, weighted by type and reach. Deductions
 * use diminishing returns so that a dataset with many small issues does not
 * score worse than one with a single catastrophic one.
 */
export function overallScore(
  issues: readonly { type: IssueType; ratio: number; severity: Severity }[],
): number {
  if (issues.length === 0) return 100;

  const penalty = issues.reduce((sum, issue) => {
    const weight = BASE_WEIGHT[issue.type];
    return sum + weight * Math.sqrt(Math.min(Math.max(issue.ratio, 0), 1)) * 30;
  }, 0);

  // Asymptotic: heavy damage approaches but never reaches 0, so the number
  // stays informative rather than bottoming out.
  return Math.round(100 * Math.exp(-penalty / 60));
}

export interface SeverityExplanation {
  readonly weight: number;
  readonly reach: number;
  readonly score: number;
  readonly threshold: number;
  readonly severity: Severity;
  readonly sentence: string;
}

/**
 * Show the arithmetic behind a severity, rather than asking to be trusted.
 *
 * This is what genuine explainability looks like for a rule-based analyzer: the
 * inputs that fired the rule and the calculation that graded it. It is
 * deliberately not a narrative about "alternatives considered" — an analyzer
 * evaluates one rule and does not deliberate, so writing that would be
 * describing reasoning that never happened.
 */
export function explainSeverity(type: IssueType, ratio: number): SeverityExplanation {
  const severity = scoreSeverity(type, ratio);

  if (type === 'injected_content') {
    return {
      weight: BASE_WEIGHT[type],
      reach: ratio,
      score: 1,
      threshold: 0,
      severity,
      sentence:
        'Rated high regardless of how few rows are affected: one row is enough to attempt a hijack.',
    };
  }

  const weight = BASE_WEIGHT[type];
  const reach = Math.sqrt(Math.min(Math.max(ratio, 0), 1));
  const score = weight * reach;
  const threshold = severity === 'high' ? 0.35 : severity === 'medium' ? 0.12 : 0;

  const comparison =
    severity === 'low'
      ? `below the 0.12 medium threshold`
      : `at or above the ${threshold} ${severity} threshold`;

  return {
    weight,
    reach,
    score,
    threshold,
    severity,
    sentence:
      `Severity ${severity}: issue weight ${weight} multiplied by reach ` +
      `sqrt(${(ratio * 100).toFixed(1)}%) = ${reach.toFixed(3)}, giving ${score.toFixed(3)}, ` +
      `which is ${comparison}.`,
  };
}
