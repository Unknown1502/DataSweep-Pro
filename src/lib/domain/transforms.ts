import { assertKnownColumn, quoteIdent, quoteLiteral } from '../engine/sql';
import type { TransformOperation } from './quality/types';

export class TransformError extends Error {
  override readonly name = 'TransformError';
}

export interface TransformSpec {
  readonly operation: TransformOperation;
  /** `null` for table-wide operations. */
  readonly column: string | null;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface TransformContext {
  /** Physical table to read from, unquoted. */
  readonly sourceTable: string;
  readonly columns: readonly string[];
}

export interface CompiledTransform {
  /** A complete SELECT producing the transformed rows. */
  readonly sql: string;
  /** Columns the result will have, in order. */
  readonly resultColumns: readonly string[];
  /** Plain-language description, shown to the user before they approve. */
  readonly description: string;
  /**
   * A scalar query counting rows this operation will change. Used to build the
   * preview so the user sees impact before committing, not after.
   */
  readonly impactSql: string;
  /**
   * Set when the operation involves a judgement call the user should know
   * about — currently ambiguous date ordering and decimal separators.
   */
  readonly caveat?: string;
}

/** Rebuild the full projection, replacing one column's expression. */
function projectionWith(columns: readonly string[], target: string, expression: string): string {
  return columns
    .map((c) => (c === target ? `${expression} AS ${quoteIdent(c)}` : quoteIdent(c)))
    .join(', ');
}

function requireColumn(spec: TransformSpec, ctx: TransformContext): string {
  if (spec.column === null) {
    throw new TransformError(`Operation "${spec.operation}" requires a column.`);
  }
  // Membership check against the real schema — an agent can only name a column
  // that exists, so this is also the injection boundary for column arguments.
  assertKnownColumn(spec.column, ctx.columns);
  return spec.column;
}

const isBlank = (col: string) => `${col} IS NULL OR trim(${col}) = ''`;

/** Formats tried when standardizing dates. */
const DAY_FIRST_FORMATS = ['%d/%m/%Y', '%d.%m.%Y', '%d %b %Y', '%d %B %Y'];
const MONTH_FIRST_FORMATS = ['%m/%d/%Y', '%b %d %Y', '%B %d, %Y', '%b %d, %Y'];
const UNAMBIGUOUS_FORMATS = ['%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%Y%m%d', '%Y/%m/%d'];

const EUROPEAN_NUMBER = String.raw`^-?\d{1,3}(\.\d{3})+(,\d+)?$`;
const ACCOUNTING_NEGATIVE = String.raw`^\(.*\)$`;
const NON_NUMERIC = String.raw`[^0-9.\-]`;

export const QUARANTINE_FLAG = '__quarantined';

/**
 * Compile a transformation into the SQL that performs it.
 *
 * Two rules hold across every operation:
 *
 * - **Nothing is destroyed to make a column look tidy.** Values that cannot be
 *   parsed are left exactly as they were rather than nulled. A tidy column full
 *   of silently discarded data is worse than a visibly messy one.
 * - **Every operation reports its own impact** via `impactSql`, so the user is
 *   shown how many rows change *before* approving rather than after.
 */
export function compileTransform(spec: TransformSpec, ctx: TransformContext): CompiledTransform {
  const source = quoteIdent(ctx.sourceTable);
  const params = spec.parameters ?? {};
  const all = ctx.columns;

  switch (spec.operation) {
    case 'remove_duplicates': {
      return {
        sql: `SELECT DISTINCT * FROM ${source}`,
        resultColumns: all,
        description: 'Remove rows that are exact duplicates of another row, keeping one of each.',
        impactSql: `SELECT (SELECT COUNT(*) FROM ${source})
                         - (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM ${source})) AS n`,
      };
    }

    case 'trim_whitespace': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      return {
        sql: `SELECT ${projectionWith(all, column, `trim(${col})`)} FROM ${source}`,
        resultColumns: all,
        description: `Remove leading and trailing whitespace from "${column}".`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}
                     WHERE ${col} IS NOT NULL AND ${col} <> trim(${col})`,
      };
    }

    case 'normalize_case': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const mode = String(params['mode'] ?? 'lower');
      const fn =
        mode === 'upper' ? `upper(${col})` : mode === 'title' ? `initcap(${col})` : `lower(${col})`;
      return {
        sql: `SELECT ${projectionWith(all, column, fn)} FROM ${source}`,
        resultColumns: all,
        description: `Convert "${column}" to ${mode}case.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}
                     WHERE ${col} IS NOT NULL AND ${col} <> ${fn}`,
      };
    }

    case 'drop_column': {
      const column = requireColumn(spec, ctx);
      const remaining = all.filter((c) => c !== column);
      if (remaining.length === 0) {
        throw new TransformError('Refusing to drop the only remaining column.');
      }
      return {
        sql: `SELECT ${remaining.map(quoteIdent).join(', ')} FROM ${source}`,
        resultColumns: remaining,
        description: `Remove the "${column}" column.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}`,
      };
    }

    case 'drop_rows_with_missing': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      return {
        sql: `SELECT * FROM ${source} WHERE NOT (${isBlank(col)})`,
        resultColumns: all,
        description: `Remove rows where "${column}" is empty.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source} WHERE ${isBlank(col)}`,
      };
    }

    case 'fill_missing': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const strategy = String(params['strategy'] ?? 'placeholder');
      const numeric = `TRY_CAST(regexp_replace(${col}, ${quoteLiteral(NON_NUMERIC)}, '', 'g') AS DOUBLE)`;

      if (strategy === 'null_non_numeric') {
        const expr = `CASE WHEN ${numeric} IS NULL THEN NULL ELSE ${col} END`;
        return {
          sql: `SELECT ${projectionWith(all, column, expr)} FROM ${source}`,
          resultColumns: all,
          description: `Replace non-numeric placeholders in "${column}" with an explicit empty value.`,
          impactSql: `SELECT COUNT(*) AS n FROM ${source}
                       WHERE ${col} IS NOT NULL AND trim(${col}) <> '' AND ${numeric} IS NULL`,
        };
      }

      const value = String(params['value'] ?? 'Unknown');
      const expr = `CASE WHEN ${isBlank(col)} THEN ${quoteLiteral(value)} ELSE ${col} END`;
      return {
        sql: `SELECT ${projectionWith(all, column, expr)} FROM ${source}`,
        resultColumns: all,
        description: `Fill empty values in "${column}" with "${value}".`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source} WHERE ${isBlank(col)}`,
      };
    }

    case 'standardize_dates': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const dayFirst = params['dayFirst'] !== false;

      const ordered = [
        ...UNAMBIGUOUS_FORMATS,
        ...(dayFirst ? DAY_FIRST_FORMATS : MONTH_FIRST_FORMATS),
        ...(dayFirst ? MONTH_FIRST_FORMATS : DAY_FIRST_FORMATS),
      ];

      const attempts = ordered
        .map((f) => `strftime(TRY_STRPTIME(trim(${col}), ${quoteLiteral(f)}), '%Y-%m-%d')`)
        .join(', ');

      // The final COALESCE arm is the original value: a date we cannot parse is
      // left exactly as it was.
      const expr = `CASE WHEN ${isBlank(col)} THEN ${col} ELSE COALESCE(${attempts}, ${col}) END`;

      return {
        sql: `SELECT ${projectionWith(all, column, expr)} FROM ${source}`,
        resultColumns: all,
        description: `Convert "${column}" to ISO YYYY-MM-DD. Values that cannot be parsed are left unchanged.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}
                     WHERE NOT (${isBlank(col)}) AND ${col} <> COALESCE(${attempts}, ${col})`,
        caveat:
          `Dates written as ${dayFirst ? 'D/M/YYYY' : 'M/D/YYYY'} are assumed. ` +
          `A value like 01/02/2024 is genuinely ambiguous and will be read as ` +
          `${dayFirst ? '1 February' : 'January 2'}. Pass dayFirst to change this.`,
      };
    }

    case 'parse_numbers': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const stripped = `regexp_replace(${col}, ${quoteLiteral(NON_NUMERIC)}, '', 'g')`;
      const expr = `CASE
             WHEN ${isBlank(col)} THEN NULL
             WHEN regexp_matches(trim(${col}), ${quoteLiteral(EUROPEAN_NUMBER)})
               THEN CAST(TRY_CAST(replace(replace(trim(${col}), '.', ''), ',', '.') AS DOUBLE) AS VARCHAR)
             WHEN regexp_matches(trim(${col}), ${quoteLiteral(ACCOUNTING_NEGATIVE)})
               THEN CAST(-1 * TRY_CAST(${stripped} AS DOUBLE) AS VARCHAR)
             ELSE CAST(TRY_CAST(${stripped} AS DOUBLE) AS VARCHAR)
           END`;

      return {
        sql: `SELECT ${projectionWith(all, column, expr)} FROM ${source}`,
        resultColumns: all,
        description:
          `Strip currency symbols and thousands separators from "${column}", leaving a plain ` +
          `number. Accounting negatives such as (1,200) become -1200.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}
                     WHERE NOT (${isBlank(col)}) AND ${col} IS DISTINCT FROM ${expr}`,
        caveat:
          'European-style numbers (1.200,50) are detected by pattern. A bare value like 1.200 ' +
          'is ambiguous and is read as one thousand two hundred, not 1.2.',
      };
    }

    case 'clip_outliers': {
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const lower = Number(params['lower']);
      const upper = Number(params['upper']);
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
        throw new TransformError('clip_outliers requires numeric "lower" and "upper" parameters.');
      }
      if (lower > upper) {
        throw new TransformError(`clip_outliers lower (${lower}) must not exceed upper (${upper}).`);
      }

      const numeric = `TRY_CAST(regexp_replace(${col}, ${quoteLiteral(NON_NUMERIC)}, '', 'g') AS DOUBLE)`;
      const expr = `CASE
             WHEN ${numeric} IS NULL THEN ${col}
             WHEN ${numeric} < ${lower} THEN CAST(${lower} AS VARCHAR)
             WHEN ${numeric} > ${upper} THEN CAST(${upper} AS VARCHAR)
             ELSE ${col} END`;

      return {
        sql: `SELECT ${projectionWith(all, column, expr)} FROM ${source}`,
        resultColumns: all,
        description: `Cap values in "${column}" to the range ${lower} to ${upper}.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source}
                     WHERE ${numeric} IS NOT NULL AND (${numeric} < ${lower} OR ${numeric} > ${upper})`,
        caveat:
          'Clipping changes real measurements. Only do this when the extreme values are known ' +
          'to be data-entry errors rather than genuine observations.',
      };
    }

    case 'quarantine_rows': {
      // Flags rather than deletes: the rows stay queryable, but carry a marker
      // the tools use to keep their content away from the agent.
      const column = requireColumn(spec, ctx);
      const col = quoteIdent(column);
      const remaining = all.filter((c) => c !== QUARANTINE_FLAG);

      return {
        sql: `SELECT ${remaining.map(quoteIdent).join(', ')},
                     CASE WHEN ${col} IS NULL THEN false ELSE true END AS ${quoteIdent(QUARANTINE_FLAG)}
                FROM ${source}`,
        resultColumns: [...remaining, QUARANTINE_FLAG],
        description: `Mark rows flagged in "${column}" so their content is withheld from the agent.`,
        impactSql: `SELECT COUNT(*) AS n FROM ${source} WHERE ${col} IS NOT NULL`,
      };
    }

    default: {
      const exhaustive: never = spec.operation;
      throw new TransformError(`Unsupported operation: ${String(exhaustive)}`);
    }
  }
}
