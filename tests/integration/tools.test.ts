import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import { AuditLog, ConfirmationStore, RateLimiter, type ToolContext } from '../../src/lib/tools/guards';
import { CORE_TOOLS } from '../../src/lib/tools/core-tools';
import type { ToolDefinition } from '../../src/lib/tools/types';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

const MESSY = [
  'order_id,order_date,customer,amount',
  '1,2024-01-15,Acme,1200',
  '2,15/02/2024,"Beta ",1450',
  '3,2024-03-01,Gamma,980',
  '3,2024-03-01,Gamma,980',
  '4,Mar 15 2024,Delta,1100',
].join(NL);

/**
 * Exercises the tools exactly as an agent would: only through their public
 * `execute`, with no privileged access to internals.
 */
describe('WebMCP tools, end to end', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let tools: Map<string, ToolDefinition>;

  const call = (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No such tool: ${name}`);
    return tool.execute(input);
  };

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
    tools = new Map(CORE_TOOLS.map((factory) => factory(() => ctx)).map((t) => [t.name, t]));
  });

  const load = () => ingestCsv(engine, ctx.registry, 'orders.csv', MESSY);

  describe('discovery', () => {
    it('tells the agent what to do when nothing is loaded', async () => {
      const result = (await call('list_datasets', {})) as { count: number; hint?: string };
      expect(result.count).toBe(0);
      expect(result.hint).toMatch(/upload/i);
    });

    it('lists a loaded dataset with the id other tools need', async () => {
      const dataset = await load();
      const result = (await call('list_datasets', {})) as {
        datasets: { dataset_id: string; rows: number; columns: string[] }[];
      };

      expect(result.datasets).toHaveLength(1);
      expect(result.datasets[0]?.dataset_id).toBe(dataset.id);
      expect(result.datasets[0]?.rows).toBe(5);
      expect(result.datasets[0]?.columns).toContain('order_date');
    });

    it('rejects a forged dataset_id and names the recovery path', async () => {
      await expect(call('preview_dataset', { dataset_id: 'ds_forged000000' })).rejects.toThrow(
        /list_datasets/,
      );
    });
  });

  describe('preview_dataset', () => {
    it('returns rows inside a quarantine fence', async () => {
      const dataset = await load();
      const result = (await call('preview_dataset', {
        dataset_id: dataset.id,
        limit: 2,
      })) as { rows: string; returned: number };

      expect(result.returned).toBe(2);
      expect(result.rows).toMatch(/<untrusted-data nonce="[0-9a-f]{16}">/);
      expect(result.rows).toMatch(/not instructions/i);
      expect(result.rows).toContain('Acme');
    });

    it('enforces the row cap declared in its schema', async () => {
      const dataset = await load();
      await expect(call('preview_dataset', { dataset_id: dataset.id, limit: 5000 })).rejects.toThrow(
        /limit/,
      );
    });
  });

  describe('detect_data_quality_issues', () => {
    it('finds the seeded problems and suggests usable fixes', async () => {
      const dataset = await load();
      const result = (await call('detect_data_quality_issues', {
        dataset_id: dataset.id,
      })) as {
        quality_score: number;
        issues: { type: string; column: string | null; suggested_fix: { operation: string } | null }[];
      };

      const types = result.issues.map((i) => i.type);
      expect(types).toContain('duplicate_rows');
      expect(types).toContain('inconsistent_date_format');
      expect(types).toContain('whitespace');
      expect(result.quality_score).toBeLessThan(100);

      // The suggested fix must be directly usable as a transformation.
      const dupes = result.issues.find((i) => i.type === 'duplicate_rows');
      expect(dupes?.suggested_fix?.operation).toBe('remove_duplicates');
    });

    it('changes nothing', async () => {
      const dataset = await load();
      const before = await engine.query(`SELECT COUNT(*) AS n FROM "${dataset.id}"`);
      await call('detect_data_quality_issues', { dataset_id: dataset.id });
      const after = await engine.query(`SELECT COUNT(*) AS n FROM "${dataset.id}"`);
      expect(after.rows[0]?.['n']).toBe(before.rows[0]?.['n']);
    });
  });

  describe('apply_cleaning_transformations', () => {
    it('dry-runs by default and leaves the data untouched', async () => {
      const dataset = await load();

      const result = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
      })) as {
        status: string;
        confirmation_token: string;
        details: { rows_before: number; rows_after: number };
      };

      expect(result.status).toBe('confirmation_required');
      expect(result.details.rows_before).toBe(5);
      expect(result.details.rows_after).toBe(4);

      // Still one checkpoint: nothing was committed.
      expect(ctx.registry.resolve(dataset.id).history).toHaveLength(1);
      expect(ctx.registry.head(dataset.id).rowCount).toBe(5);
    });

    it('reports measured numbers, not estimates', async () => {
      const dataset = await load();
      const preview = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
      })) as { confirmation_token: string; details: { rows_after: number } };

      const applied = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
        confirmation_token: preview.confirmation_token,
      })) as { rows_after: number };

      // The dry run promised a number; the real run must deliver exactly it.
      expect(applied.rows_after).toBe(preview.details.rows_after);
    });

    it('applies a multi-step chain and records one checkpoint', async () => {
      const dataset = await load();
      const transformations = [
        { operation: 'remove_duplicates', column: null },
        { operation: 'trim_whitespace', column: 'customer' },
        { operation: 'standardize_dates', column: 'order_date' },
      ];

      const preview = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations,
      })) as { confirmation_token: string };

      const result = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations,
        confirmation_token: preview.confirmation_token,
      })) as { checkpoint_id: string; rows_after: number; steps: unknown[] };

      expect(result.steps).toHaveLength(3);
      expect(result.rows_after).toBe(4);
      expect(ctx.registry.resolve(dataset.id).history).toHaveLength(2);

      const rows = await engine.query(
        `SELECT * FROM "${result.checkpoint_id}" ORDER BY order_id`,
      );
      expect(rows.rows.map((r) => r['order_date'])).toEqual([
        '2024-01-15',
        '2024-02-15',
        '2024-03-01',
        '2024-03-15',
      ]);
      expect(rows.rows[1]?.['customer']).toBe('Beta');
    });

    it('surfaces the date-ambiguity caveat in the preview', async () => {
      const dataset = await load();
      const preview = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'standardize_dates', column: 'order_date' }],
      })) as { details: { caveats?: string[] } };

      expect(preview.details.caveats?.join(' ')).toMatch(/ambiguous/i);
    });

    it('rejects an unknown column instead of guessing', async () => {
      const dataset = await load();
      await expect(
        call('apply_cleaning_transformations', {
          dataset_id: dataset.id,
          transformations: [{ operation: 'trim_whitespace', column: 'no_such_column' }],
        }),
      ).rejects.toThrow(/Unknown column/);
    });

    it('rejects an empty transformation list', async () => {
      const dataset = await load();
      await expect(
        call('apply_cleaning_transformations', { dataset_id: dataset.id, transformations: [] }),
      ).rejects.toThrow();
    });
  });

  describe('undo_to_checkpoint', () => {
    it('restores the previous state without deleting the newer one', async () => {
      const dataset = await load();
      const original = dataset.history[0]!;

      const preview = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
      })) as { confirmation_token: string };
      const applied = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
        confirmation_token: preview.confirmation_token,
      })) as { checkpoint_id: string };

      expect(ctx.registry.head(dataset.id).rowCount).toBe(4);

      const undoPreview = (await call('undo_to_checkpoint', {
        dataset_id: dataset.id,
        checkpoint_id: original.id,
      })) as { confirmation_token: string };
      await call('undo_to_checkpoint', {
        dataset_id: dataset.id,
        checkpoint_id: original.id,
        confirmation_token: undoPreview.confirmation_token,
      });

      expect(ctx.registry.head(dataset.id).rowCount).toBe(5);

      // Redo: the cleaned state was never destroyed.
      const redoPreview = (await call('undo_to_checkpoint', {
        dataset_id: dataset.id,
        checkpoint_id: applied.checkpoint_id,
      })) as { confirmation_token: string };
      await call('undo_to_checkpoint', {
        dataset_id: dataset.id,
        checkpoint_id: applied.checkpoint_id,
        confirmation_token: redoPreview.confirmation_token,
      });

      expect(ctx.registry.head(dataset.id).rowCount).toBe(4);
    });

    it('lists valid checkpoints when given a bad one', async () => {
      const dataset = await load();
      await expect(
        call('undo_to_checkpoint', { dataset_id: dataset.id, checkpoint_id: 'ckpt_nope' }),
      ).rejects.toThrow(/Available:/);
    });
  });

  describe('generate_impact_report', () => {
    it('reports the history and labels its effort figure as an estimate', async () => {
      const dataset = await load();
      const preview = (await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
      })) as { confirmation_token: string };
      await call('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [{ operation: 'remove_duplicates', column: null }],
        confirmation_token: preview.confirmation_token,
      });

      const report = (await call('generate_impact_report', { dataset_id: dataset.id })) as {
        rows_original: number;
        rows_current: number;
        steps_applied: number;
        history: unknown[];
        measured: {
          rows_in: number;
          rows_out: number;
          tool_calls_total: number;
          tool_time_ms: number;
          tool_calls_by_actor: Record<string, number>;
          steps: { rows_before: number; rows_after: number; rows_changed: number }[];
        };
        estimated: { manual_minutes_saved: number; basis: string; caveat: string };
      };

      expect(report.rows_original).toBe(5);
      expect(report.rows_current).toBe(4);
      expect(report.steps_applied).toBe(1);
      expect(report.history).toHaveLength(2);
      // Measured facts come from the ledger and the database.
      expect(report.measured.rows_in).toBe(5);
      expect(report.measured.rows_out).toBe(4);
      expect(report.measured.tool_calls_total).toBeGreaterThan(0);
      expect(report.measured.tool_time_ms).toBeGreaterThanOrEqual(0);
      expect(report.measured.steps).toHaveLength(1);
      expect(report.measured.steps[0]?.rows_changed).toBe(1);

      // The one assumption is quarantined in its own object, so it cannot be
      // mistaken for something observed.
      expect(report.estimated.basis).toMatch(/cleaning step/);
      expect(report.estimated.caveat).toMatch(/not a measurement/i);
      expect(report.measured).not.toHaveProperty('manual_minutes_saved');
    });

    it('attributes tool calls to whoever made them', async () => {
      const dataset = await load();
      await call('detect_data_quality_issues', { dataset_id: dataset.id });

      const report = (await call('generate_impact_report', { dataset_id: dataset.id })) as {
        measured: { tool_calls_by_actor: Record<string, number> };
      };
      // Nothing here went through callAs, so these are external-client calls.
      expect(Object.keys(report.measured.tool_calls_by_actor)).toContain('external-mcp');
    });
  });

  describe('tool surface', () => {
    it('declares untrustedContentHint on every tool that can return cell values', () => {
      for (const name of ['preview_dataset', 'detect_data_quality_issues']) {
        expect(tools.get(name)?.annotations.untrustedContentHint).toBe(true);
      }
    });

    it('marks read-only tools as such', () => {
      for (const name of ['list_datasets', 'preview_dataset', 'detect_data_quality_issues']) {
        expect(tools.get(name)?.annotations.readOnlyHint).toBe(true);
      }
      expect(tools.get('apply_cleaning_transformations')?.annotations.readOnlyHint).toBe(false);
    });

    it('every schema forbids unexpected properties', () => {
      for (const tool of tools.values()) {
        expect(tool.inputSchema['additionalProperties']).toBe(false);
      }
    });

    it('every tool describes what it does in enough detail to be chosen correctly', () => {
      for (const tool of tools.values()) {
        expect(tool.description.length).toBeGreaterThan(60);
      }
    });
  });
});
