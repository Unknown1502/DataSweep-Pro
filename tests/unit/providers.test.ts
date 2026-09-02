import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  providerById,
  providerForKey,
  type ModelConnection,
} from '../../src/lib/agent/providers';
import {
  connectionId,
  forgetKey,
  hasKey,
  isConnected,
  keyFor,
  rememberKey,
} from '../../src/lib/agent/key-vault';

describe('provider registry', () => {
  it('gives every provider the fields the UI and the adapter need', () => {
    for (const provider of PROVIDERS) {
      expect(provider.baseUrl, provider.id).toMatch(/^https:\/\//);
      expect(provider.keysUrl, provider.id).toMatch(/^https:\/\//);
      expect(provider.models.length, provider.id).toBeGreaterThan(0);
      expect(['anthropic', 'openai']).toContain(provider.protocol);
    }
  });

  it('has no duplicate ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves by id and rejects an unknown one', () => {
    expect(providerById('openai').label).toBe('OpenAI');
    // @ts-expect-error deliberately passing an id that is not in the union
    expect(() => providerById('made-up')).toThrow(/Unknown provider/);
  });

  it('never carries a credential in the registry itself', () => {
    const text = JSON.stringify(PROVIDERS);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(text).not.toMatch(/api[_-]?key["']?\s*:\s*["'][^"']+/i);
  });
});

describe('identifying a key by its prefix', () => {
  it('matches the most specific prefix, not merely the first', () => {
    // The case this exists for: OpenAI's "sk-" is a prefix of Anthropic's
    // "sk-ant-", so a shortest-match check reported an Anthropic key as OpenAI
    // and the mistake only surfaced later as a bare 401.
    expect(providerForKey('sk-ant-api03-xxxxxxxxxxxx')?.id).toBe('anthropic');
    expect(providerForKey('sk-or-v1-xxxxxxxxxxxx')?.id).toBe('openrouter');
    expect(providerForKey('sk-proj-xxxxxxxxxxxx')?.id).toBe('openai');
    expect(providerForKey('gsk_xxxxxxxxxxxx')?.id).toBe('groq');
  });

  it('returns null for a key it cannot place', () => {
    expect(providerForKey('AIzaSyWhatever')).toBeNull();
    expect(providerForKey('')).toBeNull();
  });
});

describe('the key vault', () => {
  const connection: ModelConnection = {
    id: connectionId('openai', 'gpt-5.1'),
    provider: 'openai',
    model: 'gpt-5.1',
    addedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => forgetKey(connection.id));

  it('starts empty and reports only presence', () => {
    expect(hasKey(connection.id)).toBe(false);
    expect(isConnected(connection)).toBe(false);
  });

  it('holds a key and hands it back only to a deliberate reader', () => {
    rememberKey(connection.id, '  sk-proj-secret  ');
    expect(hasKey(connection.id)).toBe(true);
    // Trimmed, so a stray paste newline does not become part of the header.
    expect(keyFor(connection.id)).toBe('sk-proj-secret');
  });

  it('forgets completely', () => {
    rememberKey(connection.id, 'sk-proj-secret');
    forgetKey(connection.id);
    expect(hasKey(connection.id)).toBe(false);
    expect(() => keyFor(connection.id)).toThrow(/no key in this tab/);
  });

  it('keeps keys separate per connection', () => {
    const other = connectionId('groq', 'llama-3.3-70b-versatile');
    rememberKey(connection.id, 'sk-proj-one');
    rememberKey(other, 'gsk_two');
    expect(keyFor(connection.id)).toBe('sk-proj-one');
    expect(keyFor(other)).toBe('gsk_two');
    forgetKey(other);
  });

  it('gives each provider+model its own id so two can coexist', () => {
    expect(connectionId('openai', 'gpt-5.1')).not.toBe(connectionId('openai', 'gpt-5'));
    expect(connectionId('openai', 'gpt-5.1')).not.toBe(connectionId('groq', 'gpt-5.1'));
  });

  it('keeps the credential out of the connection object entirely', () => {
    rememberKey(connection.id, 'sk-proj-secret');
    // A ModelConnection is held in React state and rendered; a key on it would
    // travel through props and into devtools.
    expect(JSON.stringify(connection)).not.toContain('sk-proj-secret');
    expect(Object.keys(connection)).toEqual(['id', 'provider', 'model', 'addedAt']);
  });
});
