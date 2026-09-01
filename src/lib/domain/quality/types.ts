import type { SqlEngine } from '../../engine/types';

export type IssueType =
  | 'missing_values'
  | 'duplicate_rows'
  | 'whitespace'
  | 'inconsistent_date_format'
  | 'inconsistent_number_format'
  | 'mixed_types'
  | 'outliers'
  | 'constant_column'
  | 'injected_content';

export type Severity = 'high' | 'medium' | 'low';

/** The cleaning operations a suggested fix may propose. */
export type TransformOperation =
  | 'drop_rows_with_missing'
  | 'fill_missing'
  | 'remove_duplicates'
  | 'trim_whitespace'
  | 'normalize_case'
  | 'standardize_dates'
  | 'parse_numbers'
  | 'clip_outliers'
  | 'drop_column'
  | 'quarantine_rows';

export interface SuggestedFix {
  readonly operation: TransformOperation;
  /** `null` for table-wide operations such as removing duplicate rows. */
  readonly column: string | null;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Why this fix, in language suitable for showing the user verbatim. */
  readonly rationale: string;
}

export interface QualityIssue {
  readonly id: string;
  readonly type: IssueType;
  readonly severity: Severity;
  /** `null` when the issue concerns the whole table. */
  readonly column: string | null;
  readonly description: string;
  readonly affectedRows: number;
  readonly totalRows: number;
  /** affectedRows / totalRows, 0..1. */
  readonly ratio: number;
  /**
   * Sample offending values, already passed through `toExcerpt`. These are
   * untrusted cell contents and must be quarantined before reaching an agent.
   */
  readonly evidence: readonly string[];
  readonly suggestedFix: SuggestedFix | null;
}

export interface AnalyzeContext {
  readonly engine: SqlEngine;
  /** Physical table name, unquoted. Quote via `quoteIdent` before use. */
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
}

export type Analyzer = (ctx: AnalyzeContext) => Promise<QualityIssue[]>;
