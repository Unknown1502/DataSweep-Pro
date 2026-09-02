import { formatShortcut, type Shortcut } from '../../hooks/useKeyboardShortcuts';
import { Dialog, DialogContent } from '../ui/dialog';

export function ShortcutsHelp({
  shortcuts,
  open,
  onOpenChange,
}: {
  shortcuts: readonly Shortcut[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard" className="max-w-sm">
        <dl className="px-4 py-3">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.label}
              className={`flex items-baseline justify-between gap-4 py-1.5 ${
                shortcut.enabled === false ? 'opacity-40' : ''
              }`}
            >
              <dt className="text-[13px] text-fg">
                {shortcut.label}
                <span className="mt-0.5 block text-[11px] text-fg-subtle">
                  {shortcut.description}
                </span>
              </dt>
              <dd className="shrink-0 rounded-sm border border-line-strong bg-surface-700 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                {formatShortcut(shortcut)}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
