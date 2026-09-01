import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import { AuditLog, ConfirmationStore, RateLimiter, type ToolContext } from '../../src/lib/tools/guards';
import { CORE_TOOLS } from '../../src/lib/tools/core-tools';
import { PIPELINE_TOOLS } from '../../src/lib/tools/pipeline-tools';
import type { ToolDefinition } from '../../src/lib/tools/types';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

const ORDERS = [
  'order_date,customer,amount',
  '2024-01-15,Acme,1200',
  '15/02/2024,"Beta ","$1,450"',
  '2024-03-01,Gamma,980',
  '2024-03-01,Gamma,980',
].join(NL);

const REGIONS = ['customer,region', 'Acme,EMEA', 'Beta,APAC', 'Gamma,AMER'].join(NL);

describe('pipeline, template, export and join tools', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let tools: Map<string, ToolDefinition>;

  const call = (name: string, input: unknown) => tools.get(name)!.execute(input);

  /** Preview then confirm, the way an approving user drives a mutating tool. */
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
      [...CORE_TOOLS, ...PIPELINE_TOOLS].map((f) => f(() => ctx)).map((t) => [t.name, t]),
    );
  });

  const loadOrders = () => ingestCsv(engine, ctx.registry, 'orders.csv', ORDERS);

  describe('apply_community_template', () => {
    it('runs a matching template and records one checkpoint', async () => {
      const dataset = await loadOrders();
      const result = (await confirmed('apply_community_template', {
        dataset_id: dataset.id,
        template_id: 'sales-orders',
      })) as { rows_before: number; rows_after: number; steps_run: number };

      expect(result.rows_before).toBe(4);
      expect(result.rows_after).toBe(3); // the duplicate row is removed
      expect(result.steps_run).toBe(4);
      expect(ctx.registry.resolve(dataset.id).history).toHaveLength(2);
    });

    it('actually cleans the values', async () => {
      const dataset = await loadOrders();
      const result = (await confirmed('apply_community_template', {
        dataset_id: dataset.id,
        template_id: 'sales-orders',
      })) as { checkpoint_id: string };

      const rows = await engine.query(
        `SELECT * FROM "${result.checkpoint_id}" ORDER BY order_date`,
      );
      expect(rows.rows.map((r) => r['order_date'])).toEqual([
        '2024-01-15',
        '2024-02-15',
        '2024-03-01',
      ]);
      expect(rows.rows.map((r) => r['customer'])).toContain('Beta');
      expect(rows.rows.map((r) => Number(r['amount']))).toContain(1450);
    });

    it('refuses an incompatible template and names the missing columns', async () => {
      const dataset = await loadOrders();
      await expect(
        call('apply_community_template', {
          dataset_id: dataset.id,
          template_id: 'contact-list',
        }),
      ).rejects.toThrow(/email/);
    });

    it('rejects an unknown template id at validation', async () => {
      const dataset = await loadOrders();
      await expect(
        call('apply_community_template', { dataset_id: dataset.id, template_id: 'nope' }),
      ).rejects.toThrow();
    });
  });

  describe('export_transformation_pipeline', () => {
    it('exports SQL that reproduces the applied steps', async () => {
      const dataset = await loadOrders();
      await confirmed('apply_community_template', {
        dataset_id: dataset.id,
        template_id: 'sales-orders',
      });

      const result = (await call('export_transformation_pipeline', {
        dataset_id: dataset.id,
        format: 'sql',
      })) as { code: string; step_count: number };

      expect(result.step_count).toBe(4);
      expect(result.code).toContain('WITH');
      expect(result.code).toContain('step_1_remove_duplicates');
      expect(result.code).toContain('SELECT * FROM step_4_parse_numbers;');
    });

    it('exported SQL runs against the original table and gives the same rows', async () => {
      // The real test of an export: does it actually reproduce the result?
      const dataset = await loadOrders();
      const applied = (await confirmed('apply_community_template', {
        dataset_id: dataset.id,
        template_id: 'sales-orders',
      })) as { checkpoint_id: string; rows_after: number };

      const exported = (await call('export_transformation_pipeline', {
        dataset_id: dataset.id,
        format: 'sql',
      })) as { code: string };

      // Point the generated SQL at the original table and run it verbatim.
      const runnable = exported.code
        .split(NL)
        .filter((line) => !line.trim().startsWith('--'))
        .join(NL)
        .replace(/"raw_data"/g, `"${dataset.id}"`)
        .replace(/;\s*$/, '');

      const reproduced = await engine.query(runnable);
      const original = await engine.query(`SELECT * FROM "${applied.checkpoint_id}"`);

      expect(reproduced.numRows).toBe(applied.rows_after);
      expect(reproduced.rows).toEqual(original.rows);
    });

    it('exports a pandas script', async () => {
      const dataset = await loadOrders();
      await confirmed('apply_community_template', {
        dataset_id: dataset.id,
        template_id: 'sales-orders',
      });

      const result = (await call('export_transformation_pipeline', {
        dataset_id: dataset.id,
        format: 'python',
      })) as { code: string };

      expect(result.code).toContain('import pandas as pd');
      expect(result.code).toContain('drop_duplicates');
      expect(result.code).toContain('dtype="string"');
    });

    it('notes when there is nothing to export yet', async () => {
      const dataset = await loadOrders();
      const result = (await call('export_transformation_pipeline', {
        dataset_id: dataset.id,
      })) as { step_count: number; note?: string };

      expect(result.step_count).toBe(0);
      expect(result.note).toMatch(/passthrough/);
    });
  });

  describe('execute_cleaning_pipeline', () => {
    it('round-trips an exported JSON pipeline onto another dataset', async () => {
      const source = await loadOrders();
      await confirmed('apply_community_template', {
        dataset_id: source.id,
        template_id: 'sales-orders',
      });

      const exported = (await call('export_transformation_pipeline', {
        dataset_id: source.id,
        format: 'json',
      })) as { code: string };
      const pipeline = JSON.parse(exported.code);

      // A second dataset with the same shape, freshly loaded.
      const target = await ingestCsv(engine, ctx.registry, 'orders-q2.csv', ORDERS);

      const result = (await confirmed('execute_cleaning_pipeline', {
        dataset_id: target.id,
        pipeline: { name: pipeline.name, steps: pipeline.steps },
      })) as { rows_before: number; rows_after: number; steps_run: number };

      expect(result.rows_before).toBe(4);
      expect(result.rows_after).toBe(3);
      expect(result.steps_run).toBe(4);
    });

    it('refuses to run against a dataset missing a required column', async () => {
      const target = await ingestCsv(engine, ctx.registry, 'other.csv', 'a,b' + NL + '1,2');
      await expect(
        call('execute_cleaning_pipeline', {
          dataset_id: target.id,
          pipeline: {
            name: 'x',
            steps: [{ operation: 'trim_whitespace', column: 'customer' }],
          },
        }),
      ).rejects.toThrow(/customer/);
    });
  });

  describe('join_datasets', () => {
    it('reports match counts before joining and changes nothing', async () => {
      const orders = await loadOrders();
      const regions = await ingestCsv(engine, ctx.registry, 'regions.csv', REGIONS);
      const before = ctx.registry.list().length;

      const preview = (await call('join_datasets', {
        left_dataset_id: orders.id,
        right_dataset_id: regions.id,
        left_column: 'customer',
        right_column: 'customer',
      })) as { status: string; details: { matched_keys: number; result_rows: number } };

      expect(preview.status).toBe('confirmation_required');
      expect(preview.details.matched_keys).toBe(2); // Acme and Gamma; "Beta " has a space
      expect(ctx.registry.list()).toHaveLength(before);
    });

    it('creates a new dataset and leaves both inputs intact', async () => {
      const orders = await loadOrders();
      const regions = await ingestCsv(engine, ctx.registry, 'regions.csv', REGIONS);

      const result = (await confirmed('join_datasets', {
        left_dataset_id: orders.id,
        right_dataset_id: regions.id,
        left_column: 'customer',
        right_column: 'customer',
        how: 'left',
      })) as { dataset_id: string; rows: number; columns: string[] };

      expect(result.columns).toContain('region');
      expect(ctx.registry.head(orders.id).rowCount).toBe(4);
      expect(ctx.registry.head(regions.id).rowCount).toBe(3);
      expect(ctx.registry.has(result.dataset_id)).toBe(true);
    });

    it('warns when nothing matches instead of silently returning nothing', async () => {
      const orders = await loadOrders();
      const other = await ingestCsv(
        engine,
        ctx.registry,
        'unrelated.csv',
        'customer,region' + NL + 'Nobody,XX',
      );

      const preview = (await call('join_datasets', {
        left_dataset_id: orders.id,
        right_dataset_id: other.id,
        left_column: 'customer',
        right_column: 'customer',
      })) as { details: { result_rows: number; warning?: string } };

      expect(preview.details.result_rows).toBe(0);
      expect(preview.details.warning).toMatch(/No rows matched/);
    });

    it('names the available columns when the key does not exist', async () => {
      const orders = await loadOrders();
      const regions = await ingestCsv(engine, ctx.registry, 'regions.csv', REGIONS);

      await expect(
        call('join_datasets', {
          left_dataset_id: orders.id,
          right_dataset_id: regions.id,
          left_column: 'nope',
          right_column: 'customer',
        }),
      ).rejects.toThrow(/Available: order_date, customer, amount/);
    });
  });
});
