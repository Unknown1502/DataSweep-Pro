/**
 * Theme preference: light, dark, or follow the system.
 *
 * "System" is the absence of a `data-theme` attribute, not a third palette.
 * That is what lets the CSS do the work: the light tokens sit on bare `:root`,
 * the dark ones apply under `prefers-color-scheme: dark` *and* under an
 * explicit `[data-theme="dark"]`, so an explicit choice wins in both directions
 * and system needs no JavaScript at all once the attribute is cleared.
 *
 * This is the one thing in the app that IS persisted. It is a display
 * preference, not data and not a credential — losing it on every reload would
 * be a bug rather than a privacy win, which is the opposite of how the API keys
 * are treated a few files over.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'datasweep:theme';

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Every storage access is wrapped, because a browser in private mode throws on
 * access rather than returning null — the failure mode that turns a missing
 * preference into a blank page.
 */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // A tab that cannot persist the choice should still honour it for now.
  }
}

/** Reflect a preference onto the document. `system` removes the attribute. */
export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

/** What the page is actually showing right now, preference resolved. */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Apply the stored preference before React mounts.
 *
 * Called from the entry module rather than from a component: an effect runs
 * after the first paint, so a dark-preferring user would see one white frame
 * every load. This runs during module evaluation, before anything renders.
 */
export function initTheme(): ThemePreference {
  const preference = readPreference();
  applyPreference(preference);
  return preference;
}
