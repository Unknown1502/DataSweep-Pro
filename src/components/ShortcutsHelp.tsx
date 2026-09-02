import { formatShortcut, type Shortcut } from '../hooks/useKeyboardShortcuts';
import { Modal } from './Modal';

export function ShortcutsHelp({
  shortcuts,
  onClose,
}: {
  shortcuts: readonly Shortcut[];
  onClose: () => void;
}) {
  return (
    <Modal title="Keyboard" onClose={onClose} width="max-w-sm">
      <dl className="px-4 py-3">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.label}
              className={`flex items-baseline justify-between gap-4 py-1.5 ${
                shortcut.enabled === false ? 'opacity-40' : ''
              }`}
            >
              <dt className="text-xs text-text-hi">
                {shortcut.label}
                <span className="mt-0.5 block text-[10px] text-text-lo">
                  {shortcut.description}
                </span>
              </dt>
              <dd className="shrink-0 rounded-sm border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-text-mid">
                {formatShortcut(shortcut)}
              </dd>
            </div>
        ))}
      </dl>
    </Modal>
  );
}
