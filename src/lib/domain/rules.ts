import { assertKnownColumn, quoteIdent, quoteLiteral } from '../engine/sql';

/**
 * User-defined validation rules.
 *
 * **There is deliberately no `custom_sql` rule type.** Accepting arbitrary SQL
 * from an agent would hand back exactly the injection surface the dataset
 * registry exists to remove, and every rule anyone actually writes fits one of
 * the five declarative shapes below.
 *
 * The regex shape does take a user-supplied pattern, which is safe for two
 * separate reasons: it reaches SQL as a quoted literal rather than as code, and
 * DuckDB evaluates it with RE2, which has no catastrophic backtracking — so a
 * pathological pattern cannot hang the tab either.
 */

export type RuleType = 'not_null' | 'unique' | 'regex' | 'range' | 'in_set';
export type RuleSeverity = 'critical' | 'warning' | 'info';

export interface QualityRule {
  readonly id: string;
  readonly name: string;
  readonly column: string;
  readonly type: RuleType;
  readonly params: Readonly<{
    pattern?: string;
    min?: number;
    max?: number;
    values?: readonly string[];
  }>;
  readonly severity: RuleSeverity;
  readonly createdAt: string;
}

export class RuleError extends Error {
  override readonly name = 'RuleError';
}

export interface CompiledRule {
  /** Counts rows that violate the rule. */
  readonly violationSql: string;
  /** Returns up to N offending values. */
  readonly sampleSql: string;
  readonly description: string;
}

const NUMERIC = (col: string) =>
  `TRY_CAST(regexp_replace(${col}, ${quoteLiteral('[^0-9.\\-]')}, '', 'g') AS DOUBLE)`;

/** Build the predicate identifying rows that BREAK the rule. */
function violationPredicate(rule: QualityRule, col: string): string {
  switch (rule.type) {
    case 'not_null':
      return `${col} IS NULL OR trim(${col}) = ''`;

    case 'regex': {
      const pattern = rule.params.pattern;
      if (!pattern) throw new RuleError('A regex rule needs a "pattern".');
      // Blank values are the not_null rule's business, not this one's.
      return `${col} IS NOT NULL AND trim(${col}) <> '' AND NOT regexp_matches(${col}, ${quoteLiteral(pattern)})`;
    }

    case 'range': {
      const { min, max } = rule.params;
      if (min === undefined && max === undefined) {
        throw new RuleError('A range rule needs "min", "max", or both.');
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new RuleError(`Range min (${min}) cannot exceed max (${max}).`);
      }
      const numeric = NUMERIC(col);
      const bounds = [
        min === undefined ? null : `${numeric} < ${min}`,
        max === undefined ? null : `${numeric} > ${max}`,
        // A value that is not a number at all fails a numeric range.
        `(${col} IS NOT NULL AND trim(${col}) <> '' AND ${numeric} IS NULL)`,
      ].filter((c): c is string => c !== null);
      return bounds.join(' OR ');
    }

    case 'in_set': {
      const values = rule.params.values;
      if (!values || values.length === 0) {
        throw new RuleError('An in_set rule needs a non-empty "values" list.');
      }
      const list = values.map((v) => quoteLiteral(v)).join(', ');
      return `${col} IS NOT NULL AND trim(${col}) <> '' AND ${col} NOT IN (${list})`;
    }

    case 'unique':
      // Handled separately: uniqueness is not a row-local predicate.
      throw new RuleError('unique is compiled separately.');

    default: {
      const exhaustive: never = rule.type;
      throw new RuleError(`Unknown rule type: ${String(exhaustive)}`);
    }
  }
}

function describe(rule: QualityRule): string {
  switch (rule.type) {
    case 'not_null':
      return `"${rule.column}" must always have a value`;
    case 'unique':
      return `"${rule.column}" must not repeat a value`;
    case 'regex':
      return `"${rule.column}" must match ${rule.params.pattern}`;
    case 'range': {
      const { min, max } = rule.params;
      if (min !== undefined && max !== undefined) {
        return `"${rule.column}" must be between ${min} and ${max}`;
      }
      return min !== undefined
        ? `"${rule.column}" must be at least ${min}`
        : `"${rule.column}" must be at most ${max}`;
    }
    case 'in_set':
      return `"${rule.column}" must be one of: ${(rule.params.values ?? []).join(', ')}`;
    default:
      return rule.name;
  }
}

export function compileRule(
  rule: QualityRule,
  table: string,
  columns: readonly string[],
): CompiledRule {
  // Membership check against the real schema, same boundary transformations use.
  const col = assertKnownColumn(rule.column, columns);
  const from = quoteIdent(table);

  if (rule.type === 'unique') {
    return {
      violationSql: `SELECT COALESCE(SUM(n - 1), 0) AS violations FROM (
                       SELECT COUNT(*) AS n FROM ${from}
                        WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
                        GROUP BY ${col} HAVING COUNT(*) > 1
                     )`,
      sampleSql: `SELECT ${col} AS v FROM ${from}
                   WHERE ${col} IS NOT NULL AND trim(${col}) <> ''
                   GROUP BY ${col} HAVING COUNT(*) > 1 LIMIT 5`,
      description: describe(rule),
    };
  }

  const predicate = violationPredicate(rule, col);
  return {
    violationSql: `SELECT COUNT(*) AS violations FROM ${from} WHERE ${predicate}`,
    sampleSql: `SELECT DISTINCT ${col} AS v FROM ${from} WHERE ${predicate} LIMIT 5`,
    description: describe(rule),
  };
}

export function validateRuleShape(rule: Omit<QualityRule, 'id' | 'createdAt'>): void {
  if (rule.name.trim().length === 0) throw new RuleError('A rule needs a name.');
  // Compiling against a throwaway schema surfaces parameter errors at creation
  // rather than at the first evaluation, when the user has moved on.
  compileRule(
    { ...rule, id: 'tmp', createdAt: new Date().toISOString() },
    'tmp_table',
    [rule.column],
  );
}
