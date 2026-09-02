import { createDemoAdapter, createLiveAdapter, type ExportMode, type GitHubAdapter } from './github';
import { ExportError } from './manifest';

/**
 * Where the GitHub token lives: a module-level variable, and nowhere else.
 *
 * Deliberately not React state, not a Zustand store, not context. Those are
 * observable — a store shows up in devtools, is trivially serialized by a
 * future "save my session" feature, and travels through component props on its
 * way to whatever needs it. A module variable has none of those exits.
 *
 * The raw value is never returned to a caller. Anything that needs to *use* the
 * token asks this module for a configured adapter, so the string exists only in
 * two places: this closure, and the Authorization header of the request.
 *
 * Consequences, stated rather than hidden:
 *
 * - the token is gone on reload, which is correct — a token surviving a reload
 *   has been written to disk somewhere;
 * - nothing here is encrypted, because a browser has nowhere to hide a key from
 *   script running on its own origin. What this buys is a small, auditable
 *   surface, not secrecy from the page itself.
 */

let token: string | null = null;

/** Fine-grained PATs are `github_pat_…`; classic ones are `ghp_…`. */
const PLAUSIBLE = /^(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]{20,}$/;

export function setExportToken(value: string): void {
  const trimmed = value.trim();
  if (!PLAUSIBLE.test(trimmed)) {
    throw new ExportError(
      'That does not look like a GitHub token. A fine-grained token starts with ' +
        '"github_pat_"; a classic one starts with "ghp_".',
    );
  }
  token = trimmed;
}

export function hasExportToken(): boolean {
  return token !== null;
}

export function clearExportToken(): void {
  token = null;
}

/**
 * The only way to obtain something that can talk to GitHub.
 *
 * Demo mode never touches the vault, so demo cannot accidentally send a token
 * anywhere; live mode without a token fails here rather than at the request.
 */
export function adapterFor(mode: ExportMode): GitHubAdapter {
  if (mode === 'demo') return createDemoAdapter();
  if (token === null) {
    throw new ExportError('Add a GitHub token before publishing in live mode.');
  }
  return createLiveAdapter(token);
}

/**
 * The mode the build was configured for.
 *
 * Demo unless `VITE_GITHUB_EXPORT_MODE=live` is set at build time. Defaulting
 * to demo means a deployment that forgot to configure anything cannot make a
 * network request it did not intend to.
 */
export function configuredMode(): ExportMode {
  const raw = import.meta.env['VITE_GITHUB_EXPORT_MODE'];
  return raw === 'live' ? 'live' : 'demo';
}
