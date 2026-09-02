import { formatShortcut, type Shortcut } from '../hooks/useKeyboardShortcuts';

export function ShortcutsHelp({
  shortcuts,
  onClose,
}: {
  shortcuts: readonly Shortcut[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/80 p-6"
      onClick={onClose}
    >
      <div className="panel w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <span className="eyebrow">Keyboard</span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

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
      </div>
    </div>
  );
}
