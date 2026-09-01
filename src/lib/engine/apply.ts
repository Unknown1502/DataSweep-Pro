import { compileTransform, type TransformSpec } from '../domain/transforms';
import { getRowCount } from './introspect';
import { generateTableName, quoteIdent } from './sql';
import type { QueryResult, SqlEngine } from './types';

export interface ChainStep {
  readonly operation: string;
  readonly column: string | null;
  readonly description: string;
  readonly caveat?: string;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  /** Rows the operation reported it would change, from its own impact query. */
  readonly rowsAffected: number;
  readonly durationMs: number;
  /** Physical table holding this step's result. */
  readonly table: string;
}

export interface ChainResult {
  readonly finalTable: string;
  readonly finalColumns: readonly string[];
  readonly steps: readonly ChainStep[];
  /** Tables created along the way that are not the final result. */
  readonly intermediates: readonly string[];
}

/**
 * Apply transformations in sequence, materializing each step as its own table.
 *
 * Materializing rather than composing one giant nested SELECT is deliberate:
 * each step's row count becomes observable, so the user can see *which*
 * operation removed the rows rather than only that rows disappeared somewhere.
 *
 * The source table is never modified. This is what allows the same function to
 * serve both the dry run and the real execution — the only difference is
 * whether the caller keeps the final table or drops it.
 */
export async function runChain(
  engine: SqlEngine,
  sourceTable: string,
  columns: readonly string[],
  specs: readonly TransformSpec[],
  tablePrefix = 'step',
): Promise<ChainResult> {
  let current = sourceTable;
  let currentColumns = [...columns];
  const steps: ChainStep[] = [];
  const created: string[] = [];

  for (const spec of specs) {
    const started = Date.now();
    const compiled = compileTransform(spec, {
      sourceTable: current,
      columns: currentColumns,
    });

    const rowsBefore = await getRowCount(engine, current);

    // The operation's own impact query, run against its input.
    let rowsAffected = 0;
    try {
      const impact = await engine.query(compiled.impactSql);
      rowsAffected = Number(impact.rows[0]?.['n'] ?? 0);
    } catch {
      // An impact query that cannot run must not block the transformation
      // itself; the row delta below still tells the user what happened.
      rowsAffected = 0;
    }

    const next = generateTableName(tablePrefix);
    await engine.query(`CREATE TABLE ${quoteIdent(next)} AS ${compiled.sql}`);
    created.push(next);

    const rowsAfter = await getRowCount(engine, next);

    steps.push({
      operation: spec.operation,
      column: spec.column,
      description: compiled.description,
      ...(compiled.caveat === undefined ? {} : { caveat: compiled.caveat }),
      rowsBefore,
      rowsAfter,
      rowsAffected,
      durationMs: Date.now() - started,
      table: next,
    });

    current = next;
    currentColumns = [...compiled.resultColumns];
  }

  return {
    finalTable: current,
    finalColumns: currentColumns,
    steps,
    intermediates: created.filter((t) => t !== current),
  };
}

/** Best-effort cleanup. A leftover table is untidy, not incorrect. */
export async function dropTables(engine: SqlEngine, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    try {
      await engine.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    } catch {
      // Ignore: dropping is cleanup, and failing to clean up must never turn a
      // successful transformation into a reported failure.
    }
  }
}

export interface BeforeAfter {
  readonly before: QueryResult;
  readonly after: QueryResult;
}

/** Matching row samples from two tables, for the side-by-side diff. */
export async function sampleBeforeAfter(
  engine: SqlEngine,
  beforeTable: string,
  afterTable: string,
  limit = 8,
): Promise<BeforeAfter> {
  const [before, after] = await Promise.all([
    engine.query(`SELECT * FROM ${quoteIdent(beforeTable)} LIMIT ${limit}`),
    engine.query(`SELECT * FROM ${quoteIdent(afterTable)} LIMIT ${limit}`),
  ]);
  return { before, after };
}
