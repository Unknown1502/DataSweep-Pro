import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreference,
  initTheme,
  readPreference,
  resolveTheme,
  writePreference,
} from '../../src/lib/theme';

/**
 * The theme layer is small but has two failure modes worth pinning: a browser
 * that throws on storage access (private mode does not merely return null), and
 * the bidirectional override — an explicit choice has to beat the OS in BOTH
 * directions, which is the part a naive `if (prefersDark)` gets wrong.
 */

function stubStorage(impl: Partial<Storage>) {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    ...impl,
  });
}

function stubDocument() {
  const attrs = new Map<string, string>();
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null,
    },
  });
  return attrs;
}

beforeEach(() => {
  stubStorage({});
  stubDocument();
});
afterEach(() => vi.unstubAllGlobals());

describe('reading the stored preference', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readPreference()).toBe('system');
  });

  it('returns a stored preference', () => {
    stubStorage({ getItem: () => 'dark' });
    expect(readPreference()).toBe('dark');
  });

  it('ignores a value that is not a preference', () => {
    // A stale or hand-edited key must not put the app in an unknown state.
    stubStorage({ getItem: () => 'solarized' });
    expect(readPreference()).toBe('system');
  });

  it('falls back to system when storage throws', () => {
    // Private mode throws on access rather than returning null; treating that
    // as a crash would turn a display preference into a blank page.
    stubStorage({
      getItem: () => {
        throw new Error('access denied');
      },
    });
    expect(readPreference()).toBe('system');
  });
});

describe('writing the preference', () => {
  it('stores an explicit choice', () => {
    const writes: [string, string][] = [];
    stubStorage({ setItem: (k, v) => writes.push([k, v]) });
    writePreference('light');
    expect(writes).toEqual([['datasweep:theme', 'light']]);
  });

  it('removes the key for system rather than storing the word', () => {
    // System is the absence of a preference, so the stored state matches the
    // DOM state: no attribute, no key.
    const removed: string[] = [];
    stubStorage({ removeItem: (k) => removed.push(k) });
    writePreference('system');
    expect(removed).toEqual(['datasweep:theme']);
  });

  it('does not throw when storage is unavailable', () => {
    stubStorage({
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => writePreference('dark')).not.toThrow();
  });
});

describe('applying a preference to the document', () => {
  it('sets the attribute for an explicit choice', () => {
    const attrs = stubDocument();
    applyPreference('dark');
    expect(attrs.get('data-theme')).toBe('dark');
    applyPreference('light');
    expect(attrs.get('data-theme')).toBe('light');
  });

  it('removes the attribute for system', () => {
    const attrs = stubDocument();
    applyPreference('dark');
    applyPreference('system');
    expect(attrs.has('data-theme')).toBe(false);
  });
});

describe('resolving what is actually shown', () => {
  it('returns an explicit choice regardless of the OS', () => {
    // The bidirectional case: light must win on a dark-set OS, and dark on a
    // light-set one.
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(resolveTheme('light')).toBe('light');
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('follows the OS on system', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(resolveTheme('system')).toBe('dark');
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(resolveTheme('system')).toBe('light');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('nope');
      },
    });
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('boot', () => {
  it('applies the stored preference and reports it', () => {
    stubStorage({ getItem: () => 'light' });
    const attrs = stubDocument();
    expect(initTheme()).toBe('light');
    expect(attrs.get('data-theme')).toBe('light');
  });

  it('leaves the document untouched for system', () => {
    const attrs = stubDocument();
    expect(initTheme()).toBe('system');
    expect(attrs.has('data-theme')).toBe(false);
  });
});
