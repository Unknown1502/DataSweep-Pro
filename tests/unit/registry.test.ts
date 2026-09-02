import { beforeEach, describe, expect, it } from 'vitest';
import {
  DatasetRegistry,
  UnknownCheckpointError,
  UnknownDatasetError,
} from '../../src/lib/engine/registry';

function seed(registry: DatasetRegistry, name = 'sales.csv') {
  return registry.create(name, {
    rowCount: 100,
    columns: ['id', 'Order Date', 'amount'],
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  });
}

describe('DatasetRegistry — identifier allowlist', () => {
  let registry: DatasetRegistry;

  beforeEach(() => {
    registry = new DatasetRegistry();
  });

  it('mints an opaque id that is not derived from the filename', () => {
    const dataset = seed(registry, 'Q4 revenue FINAL (2).csv');
    expect(dataset.id).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(dataset.id).not.toContain('revenue');
  });

  it('rejects a SQL injection payload as a dataset_id', () => {
    seed(registry);
    // The point of the allowlist: this fails at resolve, before any SQL exists.
    expect(() => registry.resolve("'; DROP TABLE datasets; --")).toThrow(UnknownDatasetError);
  });

  it('rejects non-string ids without coercing them', () => {
    expect(() => registry.resolve(12345)).toThrow(UnknownDatasetError);
    expect(() => registry.resolve(null)).toThrow(UnknownDatasetError);
    expect(() => registry.resolve({ toString: () => 'ds_deadbeefcafe' })).toThrow(
      UnknownDatasetError,
    );
  });

  it('points the agent at the recovery path in the error message', () => {
    expect(() => registry.resolve('ds_000000000000')).toThrow(/list_datasets/);
  });

  it('only ever returns table names it minted itself', () => {
    const dataset = seed(registry);
    expect(registry.resolveTable(dataset.id)).toBe(`"${dataset.id}"`);
  });
});

describe('DatasetRegistry — checkpoint history', () => {
  let registry: DatasetRegistry;

  beforeEach(() => {
    registry = new DatasetRegistry();
  });

  it('starts with the original upload as the only checkpoint', () => {
    const dataset = seed(registry);
    expect(dataset.history).toHaveLength(1);
    expect(dataset.headIndex).toBe(0);
    expect(dataset.history[0]?.tool).toBeNull();
    expect(dataset.history[0]?.label).toBe('Original upload');
  });

  it('appends a checkpoint and makes it live', () => {
    const dataset = seed(registry);
    const { checkpoint } = registry.appendCheckpoint(dataset.id, {
      label: 'remove_duplicates',
      tool: 'apply_cleaning_transformations',
      args: { operation: 'remove_duplicates' },
      rowCount: 94,
      columns: ['id', 'Order Date', 'amount'],
      createdAt: new Date().toISOString(),
    });

    expect(checkpoint.id).toMatch(/^ckpt_[0-9a-f]{12}$/);
    expect(registry.head(dataset.id).id).toBe(checkpoint.id);
    expect(registry.head(dataset.id).rowCount).toBe(94);
  });

  it('never destroys the original upload', () => {
    const dataset = seed(registry);
    for (let i = 0; i < 5; i++) {
      registry.appendCheckpoint(dataset.id, {
        label: `step ${i}`,
        tool: 'apply_cleaning_transformations',
        args: {},
        rowCount: 100 - i,
        columns: ['id'],
        createdAt: new Date().toISOString(),
      });
    }

    const current = registry.resolve(dataset.id);
    expect(current.history).toHaveLength(6);
    expect(current.history[0]?.label).toBe('Original upload');
    expect(current.history[0]?.rowCount).toBe(100);
  });

  it('rewinds by moving the head pointer, leaving data intact', () => {
    const dataset = seed(registry);
    const original = dataset.history[0]!;
    const { checkpoint } = registry.appendCheckpoint(dataset.id, {
      label: 'dedupe',
      tool: 'apply_cleaning_transformations',
      args: {},
      rowCount: 94,
      columns: ['id'],
      createdAt: new Date().toISOString(),
    });

    expect(registry.head(dataset.id).rowCount).toBe(94);

    registry.moveHead(dataset.id, original.id);
    expect(registry.head(dataset.id).rowCount).toBe(100);

    // Redo is possible because nothing was deleted.
    registry.moveHead(dataset.id, checkpoint.id);
    expect(registry.head(dataset.id).rowCount).toBe(94);
  });

  it('discards the abandoned future when work continues after an undo', () => {
    const dataset = seed(registry);
    const original = dataset.history[0]!;

    const first = registry.appendCheckpoint(dataset.id, {
      label: 'step A',
      tool: 't',
      args: {},
      rowCount: 90,
      columns: ['id'],
      createdAt: new Date().toISOString(),
    }).checkpoint;

    registry.moveHead(dataset.id, original.id);

    const { discarded } = registry.appendCheckpoint(dataset.id, {
      label: 'step B',
      tool: 't',
      args: {},
      rowCount: 80,
      columns: ['id'],
      createdAt: new Date().toISOString(),
    });

    // Editor undo/redo semantics: branching off discards the old branch, and
    // reports it so the caller can drop the orphaned tables.
    expect(discarded.map((c) => c.id)).toEqual([first.id]);
    expect(registry.resolve(dataset.id).history.map((c) => c.label)).toEqual([
      'Original upload',
      'step B',
    ]);
  });

  it('rejects an unknown checkpoint id', () => {
    const dataset = seed(registry);
    expect(() => registry.moveHead(dataset.id, 'ckpt_000000000000')).toThrow(
      UnknownCheckpointError,
    );
  });

  it('refuses to remove a dataset another was joined from', () => {
    const parent = seed(registry);
    const other = registry.create('right.csv', {
      rowCount: 2,
      columns: ['id'],
      createdAt: new Date().toISOString(),
    });
    // A joined dataset records where it came from; removing a parent would
    // leave that record pointing at nothing.
    const joined = registry.create(
      'joined.csv',
      { rowCount: 2, columns: ['id'], createdAt: new Date().toISOString() },
      undefined,
      0,
      [parent.id, other.id],
    );

    expect(() => registry.remove(parent.id)).toThrow(/joined into "joined.csv"/);
    expect(registry.has(parent.id)).toBe(true);

    // Removing the child first releases the parent.
    registry.remove(joined.id);
    expect(() => registry.remove(parent.id)).not.toThrow();
    expect(registry.has(parent.id)).toBe(false);
  });

  it('returns every physical table to drop on removal', () => {
    const dataset = seed(registry);
    const { checkpoint } = registry.appendCheckpoint(dataset.id, {
      label: 'x',
      tool: 't',
      args: {},
      rowCount: 1,
      columns: ['id'],
      createdAt: new Date().toISOString(),
    });

    expect(registry.remove(dataset.id).sort()).toEqual([dataset.id, checkpoint.id].sort());
    expect(registry.has(dataset.id)).toBe(false);
  });
});
