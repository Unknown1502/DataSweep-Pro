import { useMemo } from 'react';
import { callTool } from '../lib/tools';
import type { AuditEntry } from '../lib/tools/guards';
import { useApp, useSelectedDataset } from '../store/app-store';

/**
 * The Ledger Rail — the signature element.
 *
 * Two things that are usually separate panels are one artifact here: the
 * checkpoint history you can travel through, and the live stream of tool calls.
 * They belong together because they are the same story told at two
 * granularities — what the agent tried, and what actually stuck. Reading down
 * the rail tells you everything that has happened to your data, in order.
 */
export function LedgerRail() {
  const dataset = useSelectedDataset();
  const activity = useApp((s) => s.activity);
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);

  const recentCalls = useMemo(() => activity.slice(-14).reverse(), [activity]);

  async function travelTo(checkpointId: string) {
    if (!dataset) return;
    setActionError(null);
    try {
      // The same two-phase gate an agent goes through. The user's click is the
      // approval, so the confirmation is redeemed immediately rather than
      // surfaced — the gate exists to stop *unreviewed* changes, and this one
      // was reviewed by the person doing the clicking.
      const args = { dataset_id: dataset.id, checkpoint_id: checkpointId };
      const preview = (await callTool('undo_to_checkpoint', args)) as {
        confirmation_token: string;
      };
      await callTool('undo_to_checkpoint', {
        ...args,
        confirmation_token: preview.confirmation_token,
      });
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside className="contain-pane flex w-[268px] shrink-0 flex-col border-r border-ink-600 bg-ink-850">
      <div className="flex items-center justify-between border-b border-ink-600 px-3 py-2">
        <span className="eyebrow">Ledger</span>
        {dataset && (
          <span className="font-mono text-[10px] text-text-lo">
            {dataset.headIndex + 1}/{dataset.history.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!dataset ? (
          <p className="px-3 py-4 text-xs text-text-lo">
            Load a dataset to start the record. Every change is entered here and can be read
            backwards.
          </p>
        ) : (
          <ol className="py-1">
            {dataset.history.map((checkpoint, index) => {
              const isCurrent = index === dataset.headIndex;
              const isFuture = index > dataset.headIndex;

              return (
                <li key={checkpoint.id}>
                  <button
                    onClick={() => void travelTo(checkpoint.id)}
                    disabled={isCurrent}
                    className={`group flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                      isCurrent ? 'bg-now-dim' : 'hover:bg-ink-800'
                    }`}
                    title={isCurrent ? 'Current state' : 'Restore this state'}
                  >
                    <span
                      className={`mt-px font-mono text-[10px] tabular-nums ${
                        isCurrent ? 'text-now' : isFuture ? 'text-text-lo' : 'text-was'
                      }`}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-xs ${
                          isFuture ? 'text-text-lo' : 'text-text-hi'
                        }`}
                      >
                        {checkpoint.label}
                      </span>
                      <span className="mt-0.5 block font-mono text-[10px] text-text-lo tabular-nums">
                        {checkpoint.rowCount.toLocaleString()} rows
                        {checkpoint.tool === null ? ' · original' : ''}
                        {isFuture ? ' · undone' : ''}
                      </span>
                    </span>

                    {isCurrent && (
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-now" />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {recentCalls.length > 0 && (
          <>
            <div className="mt-2 border-t border-ink-600 px-3 py-2">
              <span className="eyebrow">Tool calls</span>
            </div>
            <ol className="pb-2">
              {recentCalls.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}

const OUTCOME_STYLE: Record<AuditEntry['outcome'], { dot: string; note: string }> = {
  ok: { dot: 'bg-calm', note: '' },
  awaiting_confirmation: { dot: 'bg-was', note: 'awaiting approval' },
  rejected: { dot: 'bg-alarm', note: 'refused' },
  error: { dot: 'bg-alarm', note: 'failed' },
};

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const style = OUTCOME_STYLE[entry.outcome];

  return (
    <li className="defer-rows flex items-start gap-2.5 px-3 py-1.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-text-mid">{entry.tool}</span>
        {(style.note || entry.mutated) && (
          <span className="block font-mono text-[10px] text-text-lo">
            {style.note}
            {entry.mutated ? 'changed data' : ''}
          </span>
        )}
      </span>
      <span className="mt-px font-mono text-[10px] text-text-lo tabular-nums">
        {entry.durationMs}ms
      </span>
    </li>
  );
}
