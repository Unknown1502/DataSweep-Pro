import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import {
  AuditLog,
  ConfirmationStore,
  RateLimiter,
  type ToolContext,
} from '../../src/lib/tools/guards';
import { RULE_TOOLS } from '../../src/lib/tools/rule-tools';
import { compileRule, RuleError, type QualityRule } from '../../src/lib/domain/rules';
import { isPersistenceAvailable, loadRules } from '../../src/lib/rules-store';
import { UnsafeIdentifierError } from '../../src/lib/engine/sql';
import type { ToolDefinition } from '../../src/lib/tools/types';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

const ORDERS = [
  'order_id,email,status,amount',
  '1,ada@example.com,shipped,120',
  '2,not-an-email,shipped,80',
  '3,grace@example.com,unknown_status,240',
  '4,edsger@example.com,pending,',
  '4,edsger@example.com,pending,55',
].join(NL);

/** An in-memory localStorage good enough for the store's probe/read/write. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

/** Mimics a private window: property access itself throws. */
function throwingStorage(): Storage {
  return new Proxy({} as Storage, {
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

function setStorage(value: Storage | undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('quality rules', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let tools: Map<string, ToolDefinition>;

  const call = (name: string, input: unknown) => tools.get(name)!.execute(input);

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
    setStorage(undefined);
  });

  beforeEach(() => {
    setStorage(memoryStorage());
    ctx = {
      engine,
      registry: new DatasetRegistry(),
      audit: new AuditLog(),
      confirmations: new ConfirmationStore(),
      rateLimiter: new RateLimiter({}),
    };
    tools = new Map(RULE_TOOLS.map((f) => f(() => ctx)).map((t) => [t.name, t]));
  });

  afterEach(() => setStorage(undefined));

  const load = () => ingestCsv(engine, ctx.registry, 'orders.csv', ORDERS);

  describe('rule types', () => {
    it('not_null counts blanks as well as true nulls', async () => {
      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'amount present',
        column: 'amount',
        type: 'not_null',
      })) as { violations_now: number };

      expect(result.violations_now).toBe(1);
    });

    it('unique counts the excess rows, not the duplicated groups', async () => {
      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'order id unique',
        column: 'order_id',
        type: 'unique',
      })) as { violations_now: number };

      expect(result.violations_now).toBe(1);
    });

    it('regex ignores blanks, leaving those to not_null', async () => {
      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'valid email',
        column: 'email',
        type: 'regex',
        params: { pattern: '^[^@ ]+@[^@ ]+[.][^@ ]+$' },
      })) as { violations_now: number };

      expect(result.violations_now).toBe(1); // only "not-an-email"
    });

    it('range flags out-of-bounds and non-numeric alike', async () => {
      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'sensible amount',
        column: 'amount',
        type: 'range',
        params: { min: 100, max: 500 },
      })) as { violations_now: number };

      // 80 and 55 are below the floor; the blank is not a number.
      expect(result.violations_now).toBe(2);
    });

    it('in_set flags values outside the allowed vocabulary', async () => {
      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'known status',
        column: 'status',
        type: 'in_set',
        params: { values: ['shipped', 'pending', 'cancelled'] },
      })) as { violations_now: number };

      expect(result.violations_now).toBe(1); // unknown_status
    });
  });

  describe('rule validation', () => {
    const rule = (over: Partial<QualityRule>): QualityRule => ({
      id: 'r',
      name: 'n',
      column: 'amount',
      type: 'range',
      params: {},
      severity: 'warning',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });

    it('rejects a rule naming a column that does not exist', () => {
      expect(() => compileRule(rule({ column: 'nope' }), 't', ['amount'])).toThrow(
        UnsafeIdentifierError,
      );
    });

    it('rejects SQL smuggled through the column name', () => {
      expect(() =>
        compileRule(rule({ column: 'amount"; DROP TABLE x; --' }), 't', ['amount']),
      ).toThrow(UnsafeIdentifierError);
    });

    it('rejects a range with no bounds', () => {
      expect(() => compileRule(rule({ params: {} }), 't', ['amount'])).toThrow(RuleError);
    });

    it('rejects an inverted range', () => {
      expect(() =>
        compileRule(rule({ params: { min: 100, max: 1 } }), 't', ['amount']),
      ).toThrow(/cannot exceed/);
    });

    it('rejects an empty in_set', () => {
      expect(() =>
        compileRule(rule({ type: 'in_set', params: { values: [] } }), 't', ['amount']),
      ).toThrow(RuleError);
    });

    it('rejects a regex rule with no pattern', () => {
      expect(() => compileRule(rule({ type: 'regex', params: {} }), 't', ['amount'])).toThrow(
        RuleError,
      );
    });
  });

  describe('evaluate_quality_rules', () => {
    it('reports failures with examples', async () => {
      const ds = await load();
      await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'known status',
        column: 'status',
        type: 'in_set',
        params: { values: ['shipped', 'pending'] },
        severity: 'critical',
      });

      const result = (await call('evaluate_quality_rules', { dataset_id: ds.id })) as {
        rules_total: number;
        rules_failing: number;
        critical_failures: number;
        results: { passed: boolean; examples: string | null }[];
      };

      expect(result.rules_total).toBe(1);
      expect(result.rules_failing).toBe(1);
      expect(result.critical_failures).toBe(1);
      expect(result.results[0]?.examples).toContain('unknown_status');
      // Offending values are cell content, so they leave fenced.
      expect(result.results[0]?.examples).toMatch(/<untrusted-data/);
    });

    it('marks a rule for a missing column inapplicable, never as passing', async () => {
      // Counting it as a pass would produce a false all-clear.
      const ds = await load();
      await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'email present',
        column: 'email',
        type: 'not_null',
      });

      const other = await ingestCsv(engine, ctx.registry, 'other.csv', 'a,b' + NL + '1,2');
      const result = (await call('evaluate_quality_rules', { dataset_id: other.id })) as {
        rules_applicable: number;
        rules_failing: number;
        results: { applicable: boolean; reason?: string; passed?: boolean }[];
      };

      expect(result.rules_applicable).toBe(0);
      expect(result.rules_failing).toBe(0);
      expect(result.results[0]?.applicable).toBe(false);
      expect(result.results[0]?.passed).toBeUndefined();
      expect(result.results[0]?.reason).toMatch(/no column "email"/);
    });

    it('reports a clean pass', async () => {
      const ds = await load();
      await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'order id present',
        column: 'order_id',
        type: 'not_null',
      });

      const result = (await call('evaluate_quality_rules', { dataset_id: ds.id })) as {
        rules_failing: number;
        results: { passed: boolean; examples: string | null }[];
      };
      expect(result.rules_failing).toBe(0);
      expect(result.results[0]?.passed).toBe(true);
      expect(result.results[0]?.examples).toBeNull();
    });
  });

  describe('storage that refuses to work', () => {
    it('degrades instead of crashing when localStorage throws on access', async () => {
      // A private window does not return null — touching the property throws.
      setStorage(throwingStorage());

      expect(isPersistenceAvailable()).toBe(false);
      expect(loadRules()).toEqual([]);

      const ds = await load();
      const result = (await call('create_quality_rule', {
        dataset_id: ds.id,
        name: 'amount present',
        column: 'amount',
        type: 'not_null',
      })) as { violations_now: number; persisted: boolean; note?: string };

      // The rule still ran; only persistence was lost, and it says so.
      expect(result.violations_now).toBe(1);
      expect(result.persisted).toBe(false);
      expect(result.note).toMatch(/not saved/i);
    });

    it('says so when listing rules with storage unavailable', async () => {
      const ds = await load();
      setStorage(throwingStorage());

      const result = (await call('evaluate_quality_rules', { dataset_id: ds.id })) as {
        rules_total: number;
        storage: string;
      };
      expect(result.rules_total).toBe(0);
      expect(result.storage).toMatch(/unavailable/);
    });

    it('survives corrupt stored data', async () => {
      const storage = memoryStorage();
      storage.setItem('datasweep.rules.v1', '{not json');
      setStorage(storage);
      expect(loadRules()).toEqual([]);

      storage.setItem('datasweep.rules.v1', JSON.stringify([{ junk: true }, null, 42]));
      expect(loadRules()).toEqual([]);
    });
  });
});
