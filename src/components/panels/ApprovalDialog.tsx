import { AlertTriangle, ArrowRight, Undo2 } from 'lucide-react';
import { effectLabel, readIntent } from '../../lib/domain/intent';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Alert } from '../ui/misc';

export interface PendingChange {
  readonly args: Record<string, unknown>;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly token: string;
}

/**
 * The approval gate, made visible.
 *
 * The numbers here were produced by actually running the transformation against
 * scratch tables and then dropping them, so what is approved is what happens —
 * not an estimate of it.
 */
export function ApprovalDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingChange;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const caveats = Array.isArray(pending.details['caveats'])
    ? (pending.details['caveats'] as string[])
    : [];
  const before = Number(pending.details['rows_before'] ?? 0);
  const after = Number(pending.details['rows_after'] ?? 0);

  // The compiler already wrote what each step does and the dry run already
  // counted what it touched; both were in the payload and neither was shown.
  const intent = readIntent(pending.details);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        title="Approve this change"
        className="max-w-xl"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-fg-subtle">
              <Undo2 className="size-3.5" aria-hidden="true" />
              Reversible from the ledger afterwards
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={onConfirm} disabled={busy}>
                {busy ? 'Applying…' : 'Apply change'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 p-4">
          <p className="text-[14px] leading-relaxed text-fg">{pending.summary}</p>

          {intent && (
            <div>
              <div className="eyebrow mb-2">
                What this does{intent.steps.length > 1 ? ` · ${intent.steps.length} steps` : ''}
              </div>
              <ol className="space-y-2.5">
                {intent.steps.map((step, i) => (
                  <li key={`${step.operation}-${step.column}-${i}`} className="flex gap-2.5">
                    {intent.steps.length > 1 && (
                      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[10px] text-fg-subtle tabular-nums">
                        {i + 1}
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-[12px] text-primary">{step.operation}</span>
                        {step.column && (
                          <span className="font-mono text-[12px] text-fg-muted">
                            on {step.column}
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
                          {step.rowsAffected.toLocaleString()} value
                          {step.rowsAffected === 1 ? '' : 's'} affected
                        </span>
                      </div>
                      {step.description && (
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">
                          {step.description}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex items-center gap-5 rounded-md border border-line bg-shell-900 px-4 py-3">
            <div>
              <div className="eyebrow">Now</div>
              {/* The prior state recedes rather than taking a colour of its own. */}
              <div className="font-mono text-[16px] text-fg-muted tabular-nums">
                {before.toLocaleString()} rows
              </div>
            </div>
            <ArrowRight className="size-4 text-fg-subtle" aria-hidden="true" />
            <div>
              <div className="eyebrow">Becomes</div>
              <div className="font-mono text-[16px] text-primary tabular-nums">
                {after.toLocaleString()} rows
              </div>
            </div>

            {intent && (
              <div className="ml-auto text-right">
                <div className="eyebrow">Effect</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                  {intent.effects.map(effectLabel).join(' · ')}
                </div>
              </div>
            )}
          </div>

          {intent && (intent.columnsAdded.length > 0 || intent.columnsRemoved.length > 0) && (
            <p className="font-mono text-[11px] text-fg-muted">
              {intent.columnsAdded.length > 0 && `+ ${intent.columnsAdded.join(', ')}`}
              {intent.columnsAdded.length > 0 && intent.columnsRemoved.length > 0 && '  '}
              {intent.columnsRemoved.length > 0 && (
                <span className="text-warn">− {intent.columnsRemoved.join(', ')}</span>
              )}
            </p>
          )}

          {caveats.length > 0 && (
            <div className="space-y-2">
              {caveats.map((caveat) => (
                <Alert key={caveat} tone="warn">
                  <AlertTriangle />
                  <span>{caveat}</span>
                </Alert>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
