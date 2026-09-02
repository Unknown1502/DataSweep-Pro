import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Hint } from '../ui/misc';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { NAV_SECTIONS } from './navigation';

/**
 * Primary navigation.
 *
 * This replaces the previous left panel, which showed the ledger and therefore
 * sat empty on the file screen — the one screen where a user most needs to know
 * what the product can do. Navigation is useful before any data is loaded;
 * a ledger is not.
 */
export function NavRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dataset = useSelectedDataset();
  const view = useApp((s) => s.view);
  const selectedId = useApp((s) => s.selectedId);
  const setView = useApp((s) => s.setView);
  const select = useApp((s) => s.select);
  const datasets = useApp((s) => s.datasets);
  const activity = useApp((s) => s.activity);

  const head = dataset?.history[dataset.headIndex];
  const lastAction = activity.at(-1);

  function go(id: string) {
    if (id === 'files') select(null);
    else setView(id as never);
    onClose();
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-shell-900/70 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <nav
        aria-label="Primary"
        className={cn(
          'contain-pane w-[236px] shrink-0 flex-col border-r border-line bg-shell-800',
          open ? 'fixed inset-y-0 left-0 z-40 flex' : 'hidden',
          'lg:static lg:z-auto lg:flex',
        )}
      >
        <div className="flex items-center justify-between px-3 py-2 lg:hidden">
          <span className="eyebrow">Navigate</span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close navigation">
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.heading} className="mb-4">
              <div className="eyebrow px-2 pb-1.5">{section.heading}</div>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isFiles = item.id === 'files';
                  const active = isFiles ? !selectedId : !!selectedId && view === item.id;
                  const disabled = item.requiresDataset && !selectedId;

                  const button = (
                    <button
                      type="button"
                      onClick={() => go(item.id)}
                      disabled={disabled}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] transition-colors',
                        active
                          ? 'bg-primary-dim font-medium text-fg'
                          : 'text-fg-muted hover:bg-surface-700 hover:text-fg',
                        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                      )}
                    >
                      {/* An active indicator that is a shape, not only a hue. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-y-1 left-0 w-0.5 rounded-full',
                          active ? 'bg-primary' : 'bg-transparent',
                        )}
                      />
                      <Icon className={cn('size-4', active ? 'text-primary' : 'text-fg-subtle')} />
                      {item.label}
                    </button>
                  );

                  return (
                    <li key={item.id}>
                      {disabled ? (
                        <Hint label="Open a dataset first">
                          {/* A disabled button swallows pointer events, so the
                              tooltip needs a wrapper that still receives them. */}
                          <span className="block">{button}</span>
                        </Hint>
                      ) : (
                        button
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Workspace facts. Every figure here is measured; none is a projection. */}
        <div className="shrink-0 border-t border-line px-3 py-3">
          <div className="eyebrow pb-2">Workspace</div>
          <dl className="space-y-1.5 text-[12px]">
            <Fact label="Datasets" value={String(datasets.length)} />
            <Fact
              label="Rows"
              value={head ? head.rowCount.toLocaleString() : '—'}
            />
            <Fact label="Steps applied" value={dataset ? String(dataset.headIndex) : '—'} />
            <Fact
              label="Last action"
              value={lastAction ? lastAction.tool.replace(/_/g, ' ') : 'none yet'}
              mono
            />
          </dl>
        </div>
      </nav>
    </>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          'truncate text-right text-fg-muted tabular-nums',
          mono && 'font-mono text-[11px]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
