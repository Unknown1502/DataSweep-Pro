import { useCallback, useEffect, useMemo, useState } from 'react';
import { scanValue, toExcerpt } from '../../lib/domain/injection';
import { getToolContext, isReady } from '../../lib/tools/context';
import { assertKnownColumn, quoteIdent, quoteLiteral } from '../../lib/engine/sql';
import type { Row } from '../../lib/engine/types';
import { useApp, useSelectedDataset } from '../../store/app-store';

const PAGE_SIZE = 50;

type SortDirection = 'asc' | 'desc';

/**
 * The data itself, with sorting, filtering and paging done **in SQL**.
 *
 * The obvious alternative is to pull the table into React state and let a
 * client-side table library sort it. That would be slower and would cap the
 * openable file size at whatever fits in JS memory — while DuckDB is sitting
 * right there, able to sort and filter millions of rows without materializing
 * them. Pushing the work down is the whole reason for having a database in the
 * tab.
 *
 * Column names reach SQL only via `assertKnownColumn`, the same membership
 * check the transformations use, and the search term only as a quoted literal.
 */
export function DataPreview() {
  const dataset = useSelectedDataset();
  const revision = useApp((s) => s.revision);

  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<{ column: string; direction: SortDirection } | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);

  const headId = dataset?.history[dataset.headIndex]?.id;
  const headColumns = useMemo(
    () => dataset?.history[dataset.headIndex]?.columns ?? [],
    [dataset],
  );

  // Debounce so a query is not issued per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);

  // A sort or filter that no longer applies to the current schema must not
  // survive a transformation that dropped the column.
  useEffect(() => {
    if (sort && !headColumns.includes(sort.column)) setSort(null);
  }, [headColumns, sort]);

  const buildWhere = useCallback(
    (available: readonly string[]): string => {
      const term = debounced.trim();
      if (term.length === 0) return '';

      // Escape LIKE wildcards so a literal % typed by the user matches a %.
      const escaped = term.replace(/([\\%_])/g, '\\$1');
      const pattern = quoteLiteral(`%${escaped}%`);
      const clauses = available.map(
        (c) => `CAST(${quoteIdent(c)} AS VARCHAR) ILIKE ${pattern} ESCAPE '\\'`,
      );
      return `WHERE ${clauses.join(' OR ')}`;
    },
    [debounced],
  );

  useEffect(() => {
    if (!headId || !isReady() || headColumns.length === 0) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { engine } = getToolContext();
        const table = quoteIdent(headId);
        const where = buildWhere(headColumns);

        /*
         * Sort numerically first, then lexically.
         *
         * Every column is VARCHAR by design, so a plain text sort puts 875000
         * before 980.50 — technically correct and useless to anyone sorting a
         * money column. Ordering by the parsed number first and the raw text
         * second does the right thing for both kinds of column in one
         * expression: in a numeric column the cast succeeds and drives the
         * order, and in a text column every cast is NULL so it falls through
         * to the text comparison. Values that cannot be parsed sort last
         * rather than being hidden.
         */
        let orderBy = '';
        if (sort) {
          const col = assertKnownColumn(sort.column, headColumns);
          const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
          const numeric = `TRY_CAST(regexp_replace(${col}, ${quoteLiteral('[^0-9.\-]')}, '', 'g') AS DOUBLE)`;
          orderBy = `ORDER BY ${numeric} ${direction} NULLS LAST, ${col} ${direction} NULLS LAST`;
        }

        const countResult = await engine.query(
          `SELECT COUNT(*) AS n FROM ${table} ${where}`,
        );
        const matched = Number(countResult.rows[0]?.['n'] ?? 0);

        const result = await engine.query(
          `SELECT * FROM ${table} ${where} ${orderBy}
             LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
        );

        if (cancelled) return;
        setColumns(result.columns);
        setRows(result.rows);
        setTotal(matched);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [headId, revision, headColumns, buildWhere, sort, page]);

  if (!dataset) return null;

  const head = dataset.history[dataset.headIndex];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtering = debounced.trim().length > 0;

  function toggleSort(column: string) {
    setPage(0);
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: 'asc' };
      if (current.direction === 'asc') return { column, direction: 'desc' };
      return null; // third click clears, so the original order is reachable
    });
  }

  return (
    <section className="panel contain-pane">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Data</span>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter rows…"
          aria-label="Filter rows"
          className="w-40 rounded-sm border border-line-strong bg-shell-900 px-2 py-1 font-mono text-[11px] text-fg placeholder:text-fg-subtle sm:w-56"
        />

        <div className="flex-1" />

        <span className="font-mono text-[10px] text-fg-subtle tabular-nums">
          {filtering
            ? `${total.toLocaleString()} of ${(head?.rowCount ?? 0).toLocaleString()} match`
            : `${(head?.rowCount ?? 0).toLocaleString()} rows`}
          {pages > 1 && ` · page ${page + 1}/${pages}`}
        </span>

        {pages > 1 && (
          <div className="flex gap-1">
            <button
              className="btn px-2 py-1"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Prev
            </button>
            <button
              className="btn px-2 py-1"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="px-4 py-4 text-xs text-danger">
          {error}
        </p>
      )}

      {loading && rows.length === 0 && <TableSkeleton columns={headColumns.length || 5} />}

      {!error && (rows.length > 0 || !loading) && (
        <div className="grid-scroll max-h-[520px] overflow-y-auto" aria-busy={loading}>
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-shell-800">
              <tr>
                <th
                  scope="col"
                  className="border-b border-line px-2 py-1.5 font-mono text-[10px] font-normal text-fg-subtle"
                >
                  #
                </th>
                {columns.map((column) => {
                  const active = sort?.column === column;
                  return (
                    <th key={column} scope="col" className="border-b border-line p-0">
                      <button
                        onClick={() => toggleSort(column)}
                        aria-sort={
                          active
                            ? sort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className={`flex w-full items-center gap-1 px-2.5 py-1.5 text-left font-mono text-[10px] font-medium whitespace-nowrap transition-colors hover:text-fg ${
                          active ? 'text-primary' : 'text-fg-muted'
                        }`}
                        title={`Sort by ${column}`}
                      >
                        {column}
                        <span aria-hidden="true" className="text-[9px]">
                          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-4 py-8 text-center text-xs text-fg-subtle"
                  >
                    {filtering ? `Nothing matches "${debounced}".` : 'This dataset has no rows.'}
                  </td>
                </tr>
              )}

              {rows.map((row, index) => (
                <tr key={index} className="defer-rows hover:bg-surface-800">
                  <td className="px-2 py-1 font-mono text-[10px] text-fg-subtle tabular-nums">
                    {page * PAGE_SIZE + index + 1}
                  </td>
                  {columns.map((column) => (
                    <Cell key={column} value={row[column]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Shaped like the table it stands in for, so nothing shifts when data lands. */
function TableSkeleton({ columns }: { columns: number }) {
  return (
    <div className="p-4" aria-busy="true" aria-label="Loading rows">
      <div className="mb-3 flex gap-3">
        {Array.from({ length: Math.min(columns, 6) }, (_, i) => (
          <div key={i} className="h-3 flex-1 animate-pulse rounded-sm bg-surface-700" />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, r) => (
        <div key={r} className="mb-2 flex gap-3">
          {Array.from({ length: Math.min(columns, 6) }, (_, c) => (
            <div
              key={c}
              className="h-3 flex-1 animate-pulse rounded-sm bg-surface-800"
              style={{ animationDelay: `${(r * 3 + c) * 40}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Cell({ value }: { value: unknown }) {
  const flagged = scanValue(value);
  const isBlank = value === null || value === undefined || String(value).trim() === '';

  if (flagged.length > 0) {
    return (
      <td
        className="max-w-[380px] truncate border-l border-danger/30 bg-danger-dim px-2.5 py-1 font-mono text-[11px] text-fg"
        title={`Flagged: ${flagged.map((r) => r.description).join('; ')}`}
      >
        <span className="mr-1.5 font-sans text-[9px] tracking-wider text-danger uppercase">
          flagged
        </span>
        {toExcerpt(String(value), 80)}
      </td>
    );
  }

  if (isBlank) {
    return <td className="px-2.5 py-1 font-mono text-[11px] text-fg-subtle italic">empty</td>;
  }

  return (
    <td className="max-w-[380px] truncate px-2.5 py-1 font-mono text-[11px] whitespace-nowrap text-fg">
      {toExcerpt(String(value), 80)}
    </td>
  );
}
