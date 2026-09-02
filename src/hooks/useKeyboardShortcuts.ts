import { useEffect } from 'react';

export interface Shortcut {
  /** Lowercase `event.key`. */
  readonly key: string;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly label: string;
  readonly description: string;
  readonly run: () => void;
  /** When false the binding is inert but still listed, greyed out. */
  readonly enabled?: boolean;
}

/** Typing in a field must never trigger an app shortcut. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Bind keyboard shortcuts.
 *
 * Handlers are passed in and act on React state directly, rather than the
 * common shortcut of querying the DOM for a button and calling `.click()`.
 * Synthesising clicks couples the bindings to markup that will move, breaks
 * silently when it does, and cannot express a disabled action — a disabled
 * button ignores a click, so the key would appear to do nothing with no
 * explanation.
 */
export function useKeyboardShortcuts(shortcuts: readonly Shortcut[]): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditable(event.target)) return;

      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      for (const shortcut of shortcuts) {
        if (shortcut.enabled === false) continue;
        if (key !== shortcut.key) continue;
        if (Boolean(shortcut.meta) !== meta) continue;
        // Only enforce shift when the binding cares; otherwise Shift+? and ?
        // would need separate entries on every layout.
        if (shortcut.shift !== undefined && shortcut.shift !== event.shiftKey) continue;

        event.preventDefault();
        shortcut.run();
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts]);
}

/** Render a binding the way this platform writes it. */
export function formatShortcut(shortcut: Shortcut): string {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const parts: string[] = [];
  if (shortcut.meta) parts.push(isMac ? '⌘' : 'Ctrl');
  if (shortcut.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(shortcut.key === 'escape' ? 'Esc' : shortcut.key.toUpperCase());
  return parts.join(isMac ? '' : '+');
}
