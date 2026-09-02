import type { QualityRule } from './domain/rules';

/**
 * Persistence for user-defined rules.
 *
 * `localStorage` is per-browser, not per-team. The UI says so plainly rather
 * than implying rules are shared, because a rule someone believes their
 * colleagues can see, and which they cannot, is worse than no persistence.
 *
 * Every access is wrapped: in a private window, or with site data blocked,
 * `localStorage` **throws on property access** rather than returning null. An
 * unguarded read there takes down the whole panel.
 */

const KEY = 'datasweep.rules.v1';

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    // Touch it: mere existence does not prove it is usable.
    const probe = '__datasweep_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function isPersistenceAvailable(): boolean {
  return storage() !== null;
}

export function loadRules(): QualityRule[] {
  const s = storage();
  if (!s) return [];

  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Stored data is as untrusted as any other input — a hand-edited or
    // half-written entry must not break loading the rest.
    return parsed.filter((r): r is QualityRule => {
      if (!r || typeof r !== 'object') return false;
      const rule = r as Partial<QualityRule>;
      return (
        typeof rule.id === 'string' &&
        typeof rule.name === 'string' &&
        typeof rule.column === 'string' &&
        typeof rule.type === 'string'
      );
    });
  } catch {
    return [];
  }
}

/** Returns false when persistence is unavailable, so the UI can say so. */
export function saveRules(rules: readonly QualityRule[]): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify(rules));
    return true;
  } catch {
    // Quota exceeded, or storage revoked mid-session.
    return false;
  }
}

export function addRule(rule: QualityRule): boolean {
  return saveRules([...loadRules(), rule]);
}

export function removeRule(id: string): boolean {
  return saveRules(loadRules().filter((r) => r.id !== id));
}

export function clearRules(): boolean {
  return saveRules([]);
}
