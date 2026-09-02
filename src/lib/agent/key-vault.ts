import type { ModelConnection, ProviderId } from './providers';

/**
 * Where model API keys live: a module-level map, and nowhere else.
 *
 * The same reasoning as the GitHub export vault. Keys are not React state, not
 * a Zustand store, not context — those are observable in devtools, trivially
 * serialized by any future "save my workspace" feature, and travel through
 * component props on their way to whatever needs them.
 *
 * A `ModelConnection` therefore carries no key. The UI can list, render and
 * store connections freely; only this module can turn one into a request.
 *
 * Consequences, stated rather than hidden: keys are gone on reload, which is
 * correct — a key that survives a reload has been written to disk somewhere.
 * Nothing here is encrypted, because a browser has nowhere to hide a key from
 * script running on its own origin. What this buys is a small, auditable
 * surface, not secrecy from the page itself.
 */

const keys = new Map<string, string>();

export function rememberKey(connectionId: string, key: string): void {
  keys.set(connectionId, key.trim());
}

export function hasKey(connectionId: string): boolean {
  return keys.has(connectionId);
}

export function forgetKey(connectionId: string): void {
  keys.delete(connectionId);
}

/**
 * Read a key for the one purpose it exists for: building a request.
 *
 * Kept deliberately awkward to reach and named so that any call site turns up
 * in a search. Nothing in the UI layer calls this.
 */
export function keyFor(connectionId: string): string {
  const key = keys.get(connectionId);
  if (!key) {
    throw new Error('That model has no key in this tab. Reconnect it to run again.');
  }
  return key;
}

/** A connection id that does not collide across providers or reloads. */
export function connectionId(provider: ProviderId, model: string): string {
  return `${provider}:${model}`;
}

export function isConnected(connection: ModelConnection): boolean {
  return hasKey(connection.id);
}
