import { useEffect, useState } from 'react';
import { scanValue, toExcerpt } from '../lib/domain/injection';
import { getToolContext, isReady } from '../lib/tools/context';
import { quoteIdent } from '../lib/engine/sql';
import type { Row } from '../lib/engine/types';
import { useApp, useSelectedDataset } from '../store/app-store';

const PAGE = 50;

/**
 * The data itself.
 *
 * Cells matching an injection rule are marked inline rather than only counted
 * in the issue list: seeing which cell carries the payload, in place, is what
 * turns an abstract warning into something a person can act on.
 */
export function DataPreview() {
  const dataset = useSelectedDataset();
  const revision = useApp((s) => s.revision);
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headId = dataset?.history[dataset.headIndex]?.id;

  useEffect(() => {
    if (!headId || !isReady()) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { engine } = getToolContext();
        const result = await engine.query(
          `SELECT * FROM ${quoteIdent(headId)} LIMIT ${PAGE}`,
        );
        if (cancelled) return;
        setColumns(result.columns);
        setRows(result.rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [headId, revision]);

  if (!dataset) return null;
  const head = dataset.history[dataset.headIndex];

  return (
    <section className="panel contain-pane">
      <div className="flex items-center justify-between border-b border-ink-600 px-4 py-2.5">
        <span className="eyebrow">Data</span>
        <span className="font-mono text-[10px] text-text-lo tabular-nums">
          showing {Math.min(PAGE, head?.rowCount ?? 0)} of{' '}
          {(head?.rowCount ?? 0).toLocaleString()}
        </span>
      </div>

      {error && <p className="px-4 py-4 text-xs text-alarm">{error}</p>}
      {loading && <p className="px-4 py-4 text-xs text-text-lo">Loading rows…</p>}

      {!loading && !error && (
        <div className="grid-scroll max-h-[520px] overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-ink-850">
              <tr>
                <th className="border-b border-ink-600 px-2 py-1.5 font-mono text-[10px] font-normal text-text-lo">
                  #
                </th>
                {columns.map((column) => (
                  <th
                    key={column}
                    className="border-b border-ink-600 px-2.5 py-1.5 font-mono text-[10px] font-medium whitespace-nowrap text-text-mid"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="defer-rows hover:bg-ink-800">
                  <td className="px-2 py-1 font-mono text-[10px] text-text-lo tabular-nums">
                    {index + 1}
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

function Cell({ value }: { value: unknown }) {
  const flagged = scanValue(value);
  const isBlank = value === null || value === undefined || String(value).trim() === '';

  if (flagged.length > 0) {
    return (
      <td
        className="max-w-[380px] truncate border-l border-alarm/30 bg-alarm-dim px-2.5 py-1 font-mono text-[11px] text-text-hi"
        title={`Flagged: ${flagged.map((r) => r.description).join('; ')}`}
      >
        <span className="mr-1.5 font-sans text-[9px] tracking-wider text-alarm uppercase">
          flagged
        </span>
        {toExcerpt(String(value), 80)}
      </td>
    );
  }

  if (isBlank) {
    return (
      <td className="px-2.5 py-1 font-mono text-[11px] text-text-lo italic">empty</td>
    );
  }

  return (
    <td className="max-w-[380px] truncate px-2.5 py-1 font-mono text-[11px] whitespace-nowrap text-text-hi">
      {toExcerpt(String(value), 80)}
    </td>
  );
}
