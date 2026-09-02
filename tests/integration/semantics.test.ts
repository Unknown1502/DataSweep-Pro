import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import { detectColumnSemantics, resolveDateOrder } from '../../src/lib/domain/quality/semantics';
import { analyzeQuality } from '../../src/lib/domain/quality';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

describe('date order resolution', () => {
  let engine: SqlEngine;
  let registry: DatasetRegistry;

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });
  beforeEach(() => {
    registry = new DatasetRegistry();
  });

  const load = async (dates: string[]) => {
    const csv = ['d', ...dates].join(NL);
    const ds = await ingestCsv(engine, registry, 'd.csv', csv);
    return ds;
  };

  it('resolves day-first when a first component exceeds 12', async () => {
    // 25 cannot be a month, so the ordering is settled by the data.
    const ds = await load(['25/01/2024', '03/02/2024', '11/06/2024']);
    const result = await resolveDateOrder(engine, ds.id, 'd');

    expect(result.order).toBe('day_first');
    expect(result.firstOver12).toBe(1);
    expect(result.evidence).toMatch(/Resolved from the data, not assumed/);
  });

  it('resolves month-first when a second component exceeds 12', async () => {
    const ds = await load(['01/25/2024', '02/03/2024', '06/11/2024']);
    const result = await resolveDateOrder(engine, ds.id, 'd');

    expect(result.order).toBe('month_first');
    expect(result.secondOver12).toBe(1);
  });

  it('reports genuine ambiguity when every component is 12 or below', async () => {
    // 01/02/2024 really is undecidable. Saying so is the honest outcome.
    const ds = await load(['01/02/2024', '03/04/2024', '05/06/2024']);
    const result = await resolveDateOrder(engine, ds.id, 'd');

    expect(result.order).toBe('ambiguous');
    expect(result.examined).toBe(3);
    expect(result.evidence).toMatch(/cannot be determined/);
  });

  it('detects a column that contradicts itself', async () => {
    // The case that used to be invisible: both orderings present, so no single
    // setting parses the column correctly.
    const ds = await load(['25/01/2024', '01/25/2024', '03/04/2024']);
    const result = await resolveDateOrder(engine, ds.id, 'd');

    expect(result.order).toBe('contradictory');
    expect(result.firstOver12).toBe(1);
    expect(result.secondOver12).toBe(1);
  });

  it('handles dot separators too', async () => {
    const ds = await load(['25.01.2024', '03.02.2024']);
    expect((await resolveDateOrder(engine, ds.id, 'd')).order).toBe('day_first');
  });

  it('reports nothing to examine when no separated dates exist', async () => {
    const ds = await load(['2024-01-25', '2024-02-03']);
    const result = await resolveDateOrder(engine, ds.id, 'd');

    expect(result.examined).toBe(0);
    expect(result.order).toBe('ambiguous');
  });
});

describe('date order feeds the analyzer', () => {
  let engine: SqlEngine;
  let registry: DatasetRegistry;

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });
  beforeEach(() => {
    registry = new DatasetRegistry();
  });

  const report = async (dates: string[]) => {
    const csv = ['d,id', ...dates.map((d, i) => `${d},${i}`)].join(NL);
    const ds = await ingestCsv(engine, registry, 'd.csv', csv);
    const head = ds.history[0]!;
    return analyzeQuality(engine, {
      table: ds.id,
      columns: [...head.columns],
      rowCount: head.rowCount,
      checks: ['date_formats'],
    });
  };

  it('sets dayFirst false when the data says month-first', async () => {
    const r = await report(['2024-01-15', '01/25/2024', '02/03/2024']);
    const issue = r.issues.find((i) => i.type === 'inconsistent_date_format');

    expect(issue?.suggestedFix?.parameters['dayFirst']).toBe(false);
    expect(issue?.suggestedFix?.rationale).toMatch(/only be a day/);
  });

  it('sets dayFirst true when the data says day-first', async () => {
    const r = await report(['2024-01-15', '25/01/2024', '03/02/2024']);
    const issue = r.issues.find((i) => i.type === 'inconsistent_date_format');

    expect(issue?.suggestedFix?.parameters['dayFirst']).toBe(true);
  });

  it('raises a high-severity finding with NO auto-fix when the column contradicts itself', async () => {
    const r = await report(['25/01/2024', '01/25/2024', '03/04/2024']);
    const issue = r.issues.find((i) => i.type === 'contradictory_date_order');

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('high');
    // Offering a fix here would invite a silent corruption: there is no
    // setting that reads the whole column correctly.
    expect(issue?.suggestedFix).toBeNull();
    expect(issue?.description).toMatch(/silently mis-read/);
  });
});

describe('semantic type detection', () => {
  let engine: SqlEngine;
  let registry: DatasetRegistry;

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });
  beforeEach(() => {
    registry = new DatasetRegistry();
  });

  const detect = async (header: string, values: string[]) => {
    const ds = await ingestCsv(engine, registry, 's.csv', [header, ...values].join(NL));
    return detectColumnSemantics(engine, ds.id, header);
  };

  it('identifies email addresses', async () => {
    const d = await detect('contact', ['a@example.com', 'b@example.org', 'c@test.co.uk']);
    expect(d.detectedType).toBe('email');
    expect(d.confidence).toBe(1);
    expect(d.ambiguous).toBe(false);
  });

  it('identifies UUIDs ahead of generic text', async () => {
    const d = await detect('ref', [
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ]);
    expect(d.detectedType).toBe('uuid');
  });

  it('calls a fully-distinct integer column an identifier, not a measurement', async () => {
    // Summing an id is meaningless, so the distinction changes what we suggest.
    const d = await detect('order_id', ['1001', '1002', '1003', '1004']);
    expect(d.detectedType).toBe('identifier');
  });

  it('calls a repeating integer column an integer', async () => {
    const d = await detect('qty', ['1', '2', '2', '3', '1']);
    expect(d.detectedType).toBe('integer');
  });

  it('recognises a low-cardinality label column as categorical', async () => {
    const d = await detect('status', [
      'shipped', 'pending', 'shipped', 'shipped', 'pending',
      'cancelled', 'shipped', 'pending', 'shipped', 'shipped',
    ]);
    expect(d.detectedType).toBe('categorical');
    expect(d.distinctCount).toBe(3);
  });

  it('falls back to free text for prose', async () => {
    const d = await detect('note', [
      'Delivered on time and well packed',
      'Customer asked for a refund later',
      'Escalated to the regional manager',
    ]);
    expect(d.detectedType).toBe('free_text');
  });

  it('reports a mixed column as ambiguous rather than picking one', async () => {
    // Guessing silently is how a cleaning tool corrupts data while looking helpful.
    const d = await detect('mixed', [
      'a@example.com', 'not an email', 'also not', 'b@example.com', 'nope',
    ]);
    expect(d.ambiguous).toBe(true);
    expect(d.confidence).toBeLessThan(0.8);
    expect(d.alternatives.some((a) => a.type === 'email')).toBe(true);
  });

  it('recognises a 0/1 column as boolean once the distinct set is known', async () => {
    // Per-value matching cannot decide this: "1" alone is equally an integer.
    const d = await detect('is_active', ['1', '0', '1', '1', '0']);
    expect(d.detectedType).toBe('boolean');
  });

  it('still calls a 0-to-N column an integer', async () => {
    const d = await detect('score', ['0', '1', '2', '3', '0']);
    expect(d.detectedType).toBe('integer');
  });

  it('recognises word booleans', async () => {
    const d = await detect('flag', ['true', 'false', 'TRUE', 'no', 'yes']);
    expect(d.detectedType).toBe('boolean');
  });

  it('does not mistake 5-digit ids for postcodes', async () => {
    // Regression: the US ZIP pattern claimed "10001" and mislabelled every
    // 5-digit id column as a postal code.
    const d = await detect('order_id', ['10001', '10002', '10003', '10004']);
    expect(d.detectedType).toBe('identifier');
  });

  it('still recognises unambiguous postcodes', async () => {
    const uk = await detect('postcode', ['SW1A 1AA', 'EC2R 8AH', 'M1 1AE']);
    expect(uk.detectedType).toBe('postcode');

    const zip4 = await detect('zip', ['10001-1234', '90210-5678', '60601-0001']);
    expect(zip4.detectedType).toBe('postcode');
  });

  it('does not call a mostly-distinct column a category', async () => {
    // Regression: dropping the ratio check on small samples classified a
    // 20-distinct-value customer column as a category on 21 rows.
    const names = Array.from({ length: 20 }, (_, i) => `Customer ${i}`);
    const d = await detect('customer', [...names, 'Customer 0']);
    expect(d.detectedType).toBe('free_text');
  });

  it('still calls a genuine small vocabulary a category', async () => {
    const d = await detect('tier', ['gold', 'silver', 'gold', 'bronze', 'gold', 'silver']);
    expect(d.detectedType).toBe('categorical');
  });

  it('does not mistake a bare run of digits for a phone number', async () => {
    const d = await detect('code', ['1234567890', '9876543210', '5555555555']);
    expect(d.detectedType).not.toBe('phone');
  });
});
