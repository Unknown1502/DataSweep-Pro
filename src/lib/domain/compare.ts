import { quoteIdent } from '../engine/sql';
import type { SqlEngine } from '../engine/types';

/**
 * Compare two checkpoints of the same dataset.
 *
 * The subtlety that makes a naive diff useless here: transformations edit values
 * **in place**. A set difference between before and after therefore reports every
 * edited row twice — once as removed, once as added — which is technically true
 * and practically worthless. "You changed 18 rows" reads as "you deleted 18 rows
 * and added 18 different ones".
 *
 * So a useful comparison needs a key column to match rows across the two sides.
 * One is auto-detected where possible, and where it is not, the report says so
 * plainly rather than presenting the misleading version as though it were a
 * real answer.
 */

export interface CellChange {
  readonly column: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface RowChange {
  readonly key: string;
  readonly changes: readonly CellChange[];
}

export interface ComparisonResult {
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly columnsAdded: readonly string[];
  readonly columnsRemoved: readonly string[];
  readonly commonColumns: readonly string[];
  /** The column used to match rows, or null if none could be used. */
  readonly keyColumn: string | null;
  readonly keySource: 'provided' | 'detected' | 'none';
  /** Rows present after but not before. Meaningful only with a key. */
  readonly rowsAdded: number;
  readonly rowsRemoved: number;
  /** Rows matched by key whose values differ. Null without a key. */
  readonly rowsModified: number | null;
  readonly sampleChanges: readonly RowChange[];
  /** Per-column count of modified cells. Empty without a key. */
  readonly changesByColumn: Readonly<Record<string, number>>;
  readonly summary: string;
  /** Set when the result is less informative than the caller may expect. */
  readonly caveat?: string;
}

/**
 * Find a column usable as a matching key: present on both sides and unique in
 * both. Uniqueness is checked rather than assumed, because an "id" column that
 * repeats would silently produce a fan-out and inflate every count.
 */
async function detectKey(
  engine: SqlEngine,
  before: string,
  after: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const column of candidates) {
    const col = quoteIdent(column);
    const result = await engine.query(
      `SELECT
         (SELECT COUNT(*) FROM ${quoteIdent(before)}) AS b_rows,
         (SELECT COUNT(DISTINCT ${col}) FROM ${quoteIdent(before)}) AS b_distinct,
         (SELECT COUNT(*) FROM ${quoteIdent(after)}) AS a_rows,
         (SELECT COUNT(DISTINCT ${col}) FROM ${quoteIdent(after)}) AS a_distinct,
         (SELECT COUNT(*) FROM ${quoteIdent(before)} WHERE ${col} IS NULL) AS b_nulls`,
    );
    const row = result.rows[0];
    if (!row) continue;

    const bRows = Number(row['b_rows'] ?? 0);
    const bDistinct = Number(row['b_distinct'] ?? 0);
    const aRows = Number(row['a_rows'] ?? 0);
    const aDistinct = Number(row['a_distinct'] ?? 0);
    const bNulls = Number(row['b_nulls'] ?? 0);

    if (bNulls > 0) continue;
    if (bRows > 0 && bDistinct === bRows && aRows > 0 && aDistinct === aRows) {
      return column;
    }
  }
  return null;
}

export interface CompareOptions {
  readonly beforeTable: string;
  readonly afterTable: string;
  readonly beforeColumns: readonly string[];
  readonly afterColumns: readonly string[];
  readonly keyColumn?: string | undefined;
  readonly sampleLimit?: number;
}

export async function compareCheckpoints(
  engine: SqlEngine,
  options: CompareOptions,
): Promise<ComparisonResult> {
  const { beforeTable, afterTable, beforeColumns, afterColumns } = options;
  const sampleLimit = options.sampleLimit ?? 10;

  const before = quoteIdent(beforeTable);
  const after = quoteIdent(afterTable);

  const commonColumns = beforeColumns.filter((c) => afterColumns.includes(c));
  const columnsAdded = afterColumns.filter((c) => !beforeColumns.includes(c));
  const columnsRemoved = beforeColumns.filter((c) => !afterColumns.includes(c));

  const counts = await engine.query(
    `SELECT (SELECT COUNT(*) FROM ${before}) AS b, (SELECT COUNT(*) FROM ${after}) AS a`,
  );
  const rowsBefore = Number(counts.rows[0]?.['b'] ?? 0);
  const rowsAfter = Number(counts.rows[0]?.['a'] ?? 0);

  let keyColumn: string | null = null;
  let keySource: ComparisonResult['keySource'] = 'none';

  if (options.keyColumn) {
    if (!commonColumns.includes(options.keyColumn)) {
      throw new Error(
        `Key column "${options.keyColumn}" is not present in both versions. ` +
          `Common columns: ${commonColumns.join(', ')}.`,
      );
    }
    keyColumn = options.keyColumn;
    keySource = 'provided';
  } else {
    keyColumn = await detectKey(engine, beforeTable, afterTable, commonColumns);
    if (keyColumn) keySource = 'detected';
  }

  if (!keyColumn) {
    // Without a key, rows can only be compared as whole tuples, which reports
    // every in-place edit as a deletion plus an insertion.
    const added = await engine.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT ${commonColumns.map(quoteIdent).join(', ')} FROM ${after}
         EXCEPT ALL
         SELECT ${commonColumns.map(quoteIdent).join(', ')} FROM ${before})`,
    );
    const removed = await engine.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT ${commonColumns.map(quoteIdent).join(', ')} FROM ${before}
         EXCEPT ALL
         SELECT ${commonColumns.map(quoteIdent).join(', ')} FROM ${after})`,
    );

    return {
      rowsBefore,
      rowsAfter,
      columnsAdded,
      columnsRemoved,
      commonColumns,
      keyColumn: null,
      keySource: 'none',
      rowsAdded: Number(added.rows[0]?.['n'] ?? 0),
      rowsRemoved: Number(removed.rows[0]?.['n'] ?? 0),
      rowsModified: null,
      sampleChanges: [],
      changesByColumn: {},
      summary:
        `${rowsBefore.toLocaleString()} rows before, ${rowsAfter.toLocaleString()} after. ` +
        'Row-level changes could not be matched up.',
      caveat:
        'No column is unique in both versions, so rows cannot be matched across them. ' +
        'A value edited in place therefore appears as one removed row and one added row, ' +
        'not as a modification. Pass a key column to get a true change count.',
    };
  }

  const key = quoteIdent(keyColumn);
  const comparable = commonColumns.filter((c) => c !== keyColumn);

  const membership = await engine.query(
    `SELECT
       (SELECT COUNT(*) FROM ${after} a
         WHERE NOT EXISTS (SELECT 1 FROM ${before} b WHERE b.${key} = a.${key})) AS added,
       (SELECT COUNT(*) FROM ${before} b
         WHERE NOT EXISTS (SELECT 1 FROM ${after} a WHERE a.${key} = b.${key})) AS removed`,
  );
  const rowsAdded = Number(membership.rows[0]?.['added'] ?? 0);
  const rowsRemoved = Number(membership.rows[0]?.['removed'] ?? 0);

  // IS DISTINCT FROM rather than <>, so a value becoming NULL counts as a
  // change instead of evaluating to NULL and being dropped.
  const differs = comparable
    .map((c) => `b.${quoteIdent(c)} IS DISTINCT FROM a.${quoteIdent(c)}`)
    .join(' OR ');

  let rowsModified = 0;
  const changesByColumn: Record<string, number> = {};
  const sampleChanges: RowChange[] = [];

  if (comparable.length > 0) {
    const modified = await engine.query(
      `SELECT COUNT(*) AS n FROM ${before} b JOIN ${after} a ON b.${key} = a.${key}
        WHERE ${differs}`,
    );
    rowsModified = Number(modified.rows[0]?.['n'] ?? 0);

    const perColumn = comparable
      .map(
        (c) =>
          `COUNT(*) FILTER (WHERE b.${quoteIdent(c)} IS DISTINCT FROM a.${quoteIdent(c)}) AS ${quoteIdent(c)}`,
      )
      .join(', ');
    const columnCounts = await engine.query(
      `SELECT ${perColumn} FROM ${before} b JOIN ${after} a ON b.${key} = a.${key}`,
    );
    const countRow = columnCounts.rows[0];
    for (const column of comparable) {
      const n = Number(countRow?.[column] ?? 0);
      if (n > 0) changesByColumn[column] = n;
    }

    if (rowsModified > 0) {
      const selects = comparable
        .flatMap((c) => [
          `b.${quoteIdent(c)} AS ${quoteIdent(`b_${c}`)}`,
          `a.${quoteIdent(c)} AS ${quoteIdent(`a_${c}`)}`,
        ])
        .join(', ');

      const samples = await engine.query(
        `SELECT b.${key} AS __key, ${selects}
           FROM ${before} b JOIN ${after} a ON b.${key} = a.${key}
          WHERE ${differs}
          LIMIT ${Math.max(1, Math.floor(sampleLimit))}`,
      );

      for (const row of samples.rows) {
        const changes: CellChange[] = [];
        for (const column of comparable) {
          const beforeValue = row[`b_${column}`];
          const afterValue = row[`a_${column}`];
          if (beforeValue === afterValue) continue;
          changes.push({
            column,
            before: beforeValue === null || beforeValue === undefined ? null : String(beforeValue),
            after: afterValue === null || afterValue === undefined ? null : String(afterValue),
          });
        }
        if (changes.length > 0) {
          sampleChanges.push({ key: String(row['__key'] ?? ''), changes });
        }
      }
    }
  }

  const parts = [
    rowsAdded > 0 ? `${rowsAdded.toLocaleString()} added` : null,
    rowsRemoved > 0 ? `${rowsRemoved.toLocaleString()} removed` : null,
    rowsModified > 0 ? `${rowsModified.toLocaleString()} modified` : null,
  ].filter((p): p is string => p !== null);

  return {
    rowsBefore,
    rowsAfter,
    columnsAdded,
    columnsRemoved,
    commonColumns,
    keyColumn,
    keySource,
    rowsAdded,
    rowsRemoved,
    rowsModified,
    sampleChanges,
    changesByColumn,
    summary:
      parts.length === 0
        ? 'No differences between these two versions.'
        : `${parts.join(', ')} (matched on "${keyColumn}").`,
    ...(comparable.length === 0
      ? { caveat: 'The two versions share only the key column, so no values could be compared.' }
      : {}),
  };
}
