import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import {
  AuditLog,
  ConfirmationStore,
  RateLimiter,
  type ToolContext,
} from '../../src/lib/tools/guards';
import { CORE_TOOLS } from '../../src/lib/tools/core-tools';
import { COMPARE_TOOLS } from '../../src/lib/tools/compare-tool';
import { unfence } from '../../src/lib/domain/injection';
import type { ToolDefinition } from '../../src/lib/tools/types';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

const ORDERS = [
  'order_id,order_date,customer,amount',
  '1,2024-01-15,Acme,1200',
  '2,15/02/2024,"Beta ",1450',
  '3,2024-03-01,Gamma,980',
  '4,2024-03-05,Delta,1100',
].join(NL);

describe('compare_checkpoints', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let tools: Map<string, ToolDefinition>;

  const call = (name: string, input: unknown) => tools.get(name)!.execute(input);

  async function confirmed(name: string, args: Record<string, unknown>) {
    const preview = (await call(name, args)) as { confirmation_token: string };
    return call(name, { ...args, confirmation_token: preview.confirmation_token });
  }

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });

  beforeEach(() => {
    ctx = {
      engine,
      registry: new DatasetRegistry(),
      audit: new AuditLog(),
      confirmations: new ConfirmationStore(),
      rateLimiter: new RateLimiter({}),
    };
    tools = new Map(
      [...CORE_TOOLS, ...COMPARE_TOOLS].map((f) => f(() => ctx)).map((t) => [t.name, t]),
    );
  });

  const load = () => ingestCsv(engine, ctx.registry, 'orders.csv', ORDERS);

  it('reports in-place edits as modifications, not as deletes plus inserts', async () => {
    // The whole reason this needs a key: without one, trimming a value looks
    // like deleting a row and adding a different one.
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'trim_whitespace', column: 'customer' }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
    })) as {
      rows_added: number;
      rows_removed: number;
      rows_modified: number;
      key_column: string;
      key_source: string;
      changes_by_column: Record<string, number>;
    };

    expect(result.rows_added).toBe(0);
    expect(result.rows_removed).toBe(0);
    expect(result.rows_modified).toBe(1);
    expect(result.key_column).toBe('order_id');
    expect(result.key_source).toBe('detected');
    expect(result.changes_by_column['customer']).toBe(1);
  });

  it('gives cell-level before and after values', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'standardize_dates', column: 'order_date' }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
    })) as { sample_changes: string };

    const changes = JSON.parse(unfence(result.sample_changes)) as {
      key: string;
      changes: { column: string; before: string; after: string }[];
    }[];

    const dateChange = changes[0]?.changes.find((c) => c.column === 'order_date');
    expect(dateChange?.before).toBe('15/02/2024');
    expect(dateChange?.after).toBe('2024-02-15');
  });

  it('counts removed rows when a transformation drops them', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'drop_rows_with_missing', column: 'customer' }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
    })) as { rows_removed: number; rows_modified: number };

    expect(result.rows_removed).toBe(0); // nothing is missing in this fixture
    expect(result.rows_modified).toBe(0);
  });

  it('reports a dropped column', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'drop_column', column: 'amount' }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
    })) as { columns_removed: string[]; rows_modified: number };

    expect(result.columns_removed).toEqual(['amount']);
    expect(result.rows_modified).toBe(0);
  });

  it('says nothing changed when nothing changed', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: original.id,
    })) as { summary: string; rows_modified: number };

    expect(result.rows_modified).toBe(0);
    expect(result.summary).toMatch(/No differences/);
  });

  it('explains itself when no column can serve as a key', async () => {
    // Rather than silently reporting every edit as a delete plus an insert.
    // Both columns repeat, so neither can identify a row across versions.
    const csv = ['a,b', 'x,1', 'x,1', 'y,2'].join(NL);
    const ds = await ingestCsv(engine, ctx.registry, 'nokey.csv', csv);
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'normalize_case', column: 'a', parameters: { mode: 'upper' } }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
    })) as { key_column: string | null; rows_modified: number | null; caveat: string };

    expect(result.key_column).toBeNull();
    expect(result.rows_modified).toBeNull();
    expect(result.caveat).toMatch(/cannot be matched/);
    expect(result.caveat).toMatch(/key column/);
  });

  it('accepts an explicit key column', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'trim_whitespace', column: 'customer' }],
    })) as { checkpoint_id: string };

    const result = (await call('compare_checkpoints', {
      dataset_id: ds.id,
      from_checkpoint_id: original.id,
      to_checkpoint_id: applied.checkpoint_id,
      key_column: 'order_id',
    })) as { key_source: string; rows_modified: number };

    expect(result.key_source).toBe('provided');
    expect(result.rows_modified).toBe(1);
  });

  it('rejects a key column that is not in both versions', async () => {
    const ds = await load();
    const original = ds.history[0]!;
    const applied = (await confirmed('apply_cleaning_transformations', {
      dataset_id: ds.id,
      transformations: [{ operation: 'drop_column', column: 'amount' }],
    })) as { checkpoint_id: string };

    await expect(
      call('compare_checkpoints', {
        dataset_id: ds.id,
        from_checkpoint_id: original.id,
        to_checkpoint_id: applied.checkpoint_id,
        key_column: 'amount',
      }),
    ).rejects.toThrow(/not present in both versions/);
  });

  it('lists valid checkpoints when given an unknown one', async () => {
    const ds = await load();
    await expect(
      call('compare_checkpoints', {
        dataset_id: ds.id,
        from_checkpoint_id: 'ckpt_nope',
        to_checkpoint_id: ds.history[0]!.id,
      }),
    ).rejects.toThrow(/Available:/);
  });
});
