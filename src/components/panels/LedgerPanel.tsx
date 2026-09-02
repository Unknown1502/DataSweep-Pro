import { CornerUpLeft, Dot } from 'lucide-react';
import { cn } from '../../lib/cn';
import { callTool } from '../../lib/tools';
import { ACTOR_LABELS } from '../../lib/tools/guards';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { ActorBadge } from './ActorBadge';

/**
 * The ledger: checkpoints you can travel to, and the tool calls that produced
 * them, read as one record.
 *
 * Undo moves a pointer over materialized tables, so travelling is instant and
 * works in both directions — a checkpoint after the current one is dimmed but
 * still reachable.
 */
export function LedgerPanel() {
  const dataset = useSelectedDataset();
  const activity = useApp((s) => s.activity);
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);
  const invalidate = useFindings((s) => s.invalidate);

  if (!dataset) return null;

  async function travelTo(checkpointId: string) {
    if (!dataset) return;
    setActionError(null);
    try {
      // The same two-phase gate an agent goes through. A click here is the
      // review, so the token is redeemed straight away.
      const args = { dataset_id: dataset.id, checkpoint_id: checkpointId };
      const preview = (await callTool('undo_to_checkpoint', args)) as {
        confirmation_token: string;
      };
      await callTool('undo_to_checkpoint', {
        ...args,
        confirmation_token: preview.confirmation_token,
      });
      invalidate(dataset.id);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  const calls = activity.slice(-30).reverse();

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="min-w-0">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-[14px]">Checkpoints</CardTitle>
          <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
            {dataset.headIndex + 1} of {dataset.history.length}
          </span>
        </CardHeader>
        <CardContent>
          <ol className="relative space-y-0">
            {dataset.history.map((checkpoint, index) => {
              const current = index === dataset.headIndex;
              const future = index > dataset.headIndex;
              const previous = dataset.history[index - 1];
              const delta = previous ? checkpoint.rowCount - previous.rowCount : 0;

              return (
                <li key={checkpoint.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {/* Spine */}
                  {index < dataset.history.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute top-6 bottom-0 left-[9px] w-px bg-line"
                    />
                  )}

                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative z-10 mt-1 flex size-[19px] shrink-0 items-center justify-center rounded-full border',
                      current
                        ? 'border-primary bg-primary-dim'
                        : future
                          ? 'border-line bg-surface-800'
                          : 'border-line-strong bg-surface-700',
                    )}
                  >
                    {current && <Dot className="size-4 text-primary" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          'text-[13px]',
                          future ? 'text-fg-subtle' : 'font-medium text-fg',
                        )}
                      >
                        {checkpoint.label}
                      </span>
                      {current && <Badge tone="primary">current</Badge>}
                      {future && <Badge>undone</Badge>}
                      {checkpoint.tool === null && <Badge>original</Badge>}
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-fg-subtle tabular-nums">
                      <span>{checkpoint.rowCount.toLocaleString()} rows</span>
                      {delta !== 0 && (
                        <span className={delta < 0 ? 'text-warn' : 'text-success'}>
                          {delta > 0 ? '+' : ''}
                          {delta.toLocaleString()}
                        </span>
                      )}
                      {checkpoint.tool && <span className="truncate">{checkpoint.tool}</span>}
                    </div>

                    {!current && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1.5 -ml-2"
                        onClick={() => void travelTo(checkpoint.id)}
                      >
                        <CornerUpLeft />
                        {future ? 'Restore this state' : 'Go back to here'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-[14px]">Tool calls</CardTitle>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="text-[13px] text-fg-muted">
              Nothing has run yet. Every call is recorded here with who made it.
            </p>
          ) : (
            <ul className="space-y-2">
              {calls.map((entry) => (
                <li key={entry.id} className="defer-rows flex items-start gap-2.5">
                  <ActorBadge actor={entry.actor} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] text-fg-muted">{entry.tool}</div>
                    <div className="font-mono text-[10px] text-fg-subtle">
                      {ACTOR_LABELS[entry.actor]}
                      {entry.outcome === 'awaiting_confirmation' && ' · awaiting approval'}
                      {entry.outcome === 'rejected' && ' · refused'}
                      {entry.outcome === 'error' && ' · failed'}
                      {entry.mutated && ' · changed data'}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-fg-subtle tabular-nums">
                    {entry.durationMs}ms
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
