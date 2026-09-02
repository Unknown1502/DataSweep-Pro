import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  applyPreference,
  readPreference,
  writePreference,
  type ThemePreference,
} from '../../lib/theme';

/**
 * Light / System / Dark.
 *
 * Three explicit states rather than a two-way switch, because "follow my OS" is
 * a real preference and not the same as either fixed choice — a two-way toggle
 * silently opts the user out of their own system setting the first time they
 * touch it.
 *
 * Rendered as a radiogroup so the current state is announced as one selection
 * among three, not as three unrelated buttons.
 */

const OPTIONS: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'dark', label: 'Dark', icon: Moon },
];

export function ThemeToggle() {
  // Seeded from storage, which the entry module has already applied to the
  // document — so the first render agrees with what is on screen.
  const [preference, setPreference] = useState<ThemePreference>(() => readPreference());

  // On "system", the OS can change while the tab is open. Without this the page
  // would keep the theme it booted with until a reload.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyPreference('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference) {
    setPreference(next);
    applyPreference(next);
    writePreference(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-line bg-surface-900 p-0.5"
    >
      {OPTIONS.map(({ id, label, icon: Icon }) => {
        const active = preference === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(id)}
            title={`${label} theme`}
            className={cn(
              'flex size-6 items-center justify-center rounded-sm transition-colors',
              active
                ? 'bg-primary-dim text-primary'
                : 'text-fg-subtle hover:bg-surface-700 hover:text-fg-muted',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
