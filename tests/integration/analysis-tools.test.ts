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
import { PIPELINE_TOOLS } from '../../src/lib/tools/pipeline-tools';
import { ANALYSIS_TOOLS } from '../../src/lib/tools/analysis-tools';
import { unfence } from '../../src/lib/domain/injection';
import type { ToolDefinition } from '../../src/lib/tools/types';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

const PEOPLE = [
  'person_id,email,signup_date,spend,tier',
  '1,ada@example.com,2024-01-15,120.50,gold',
  '2,alan@example.com,2024-02-20,80.00,silver',
  '3,grace@example.com,2024-03-11,240.75,gold',
  '4,edsger@example.com,2024-04-02,55.25,bronze',
  '5,barbara@example.com,2024-05-19,310.00,gold',
].join(NL);

describe('analysis tools', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let tools: Map<string, ToolDefinition>;

  const call = (name: string, input: unknown) => tools.get(name)!.execute(input);

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
      [...CORE_TOOLS, ...PIPELINE_TOOLS, ...ANALYSIS_TOOLS]
        .map((f) => f(() => ctx))
        .map((t) => [t.name, t]),
    );
  });

  const load = () => ingestCsv(engine, ctx.registry, 'people.csv', PEOPLE);

  describe('detect_column_semantics', () => {
    it('types every column and reports confidence', async () => {
      const ds = await load();
      const result = (await call('detect_column_semantics', { dataset_id: ds.id })) as {
        detections: { column: string; detected_type: string; confidence: number }[];
      };

      const byColumn = new Map(result.detections.map((d) => [d.column, d]));
      expect(byColumn.get('email')?.detected_type).toBe('email');
      expect(byColumn.get('person_id')?.detected_type).toBe('identifier');
      expect(byColumn.get('tier')?.detected_type).toBe('categorical');
      expect(byColumn.get('email')?.confidence).toBe(1);
    });

    it('rejects a column that does not exist, and lists what does', async () => {
      const ds = await load();
      await expect(
        call('detect_column_semantics', { dataset_id: ds.id, columns: ['nope'] }),
      ).rejects.toThrow(/Available: person_id, email/);
    });

    it('surfaces date ordering when it can be resolved', async () => {
      const csv = ['d,id', '25/01/2024,1', '03/02/2024,2'].join(NL);
      const ds = await ingestCsv(engine, ctx.registry, 'dates.csv', csv);

      const result = (await call('detect_column_semantics', { dataset_id: ds.id })) as {
        date_ordering: Record<string, { order: string; resolved: boolean }>;
      };
      expect(result.date_ordering['d']?.order).toBe('day_first');
      expect(result.date_ordering['d']?.resolved).toBe(true);
    });

    it('warns the agent off standardizing a contradictory column', async () => {
      const csv = ['d,id', '25/01/2024,1', '01/25/2024,2'].join(NL);
      const ds = await ingestCsv(engine, ctx.registry, 'bad.csv', csv);

      const result = (await call('detect_column_semantics', { dataset_id: ds.id })) as {
        date_ordering: Record<string, { order: string; resolved: boolean }>;
        next_step: string;
      };
      expect(result.date_ordering['d']?.order).toBe('contradictory');
      expect(result.date_ordering['d']?.resolved).toBe(false);
      expect(result.next_step).toMatch(/do not standardize dates/);
    });
  });

  describe('generate_data_documentation', () => {
    it('produces a document with every promised section', async () => {
      const ds = await load();
      const result = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
        columns_documented: number;
      };
      const md = unfence(result.documentation);

      expect(result.columns_documented).toBe(5);
      for (const heading of [
        '## Overview',
        '## Column dictionary',
        '## Data quality',
        '## How this data was cleaned',
        '## Known limitations',
        '## Recommended usage',
      ]) {
        expect(md).toContain(heading);
      }
    });

    it('is deterministic — same input, identical output', async () => {
      // The point of generating rather than prompting: no run-to-run drift, and
      // no chance of a plausible-sounding but invented column description.
      const ds = await load();
      const a = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
      };
      const b = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
      };
      expect(unfence(a.documentation)).toBe(unfence(b.documentation));
    });

    it('documents the applied cleaning steps', async () => {
      const ds = await load();
      const args = {
        dataset_id: ds.id,
        transformations: [{ operation: 'trim_whitespace', column: 'tier' }],
      };
      const preview = (await call('apply_cleaning_transformations', args)) as {
        confirmation_token: string;
      };
      await call('apply_cleaning_transformations', {
        ...args,
        confirmation_token: preview.confirmation_token,
      });

      const result = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
      };
      const md = unfence(result.documentation);
      expect(md).toContain('trim_whitespace');
      expect(md).toContain('previewed and approved');
    });

    it('reports skipped rows as a limitation rather than hiding them', async () => {
      const csv = ['id,note', '1,ok', '2,broken, comma', '3,ok'].join(NL);
      const ds = await ingestCsv(engine, ctx.registry, 'ragged.csv', csv);

      const result = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
      };
      expect(unfence(result.documentation)).toMatch(/missing entirely/);
    });

    it('says plainly when nothing has been cleaned', async () => {
      const ds = await load();
      const result = (await call('generate_data_documentation', { dataset_id: ds.id })) as {
        documentation: string;
      };
      expect(unfence(result.documentation)).toContain('exactly as loaded');
    });
  });

  describe('great_expectations export', () => {
    it('emits a loadable suite for the cleaned data', async () => {
      const ds = await load();
      const result = (await call('export_transformation_pipeline', {
        dataset_id: ds.id,
        format: 'great_expectations',
      })) as { code: string };

      const suite = JSON.parse(result.code);
      expect(suite.expectation_suite_name).toContain('suite');
      expect(suite.expectations.length).toBeGreaterThan(5);

      const types = suite.expectations.map((e: { expectation_type: string }) => e.expectation_type);
      expect(types).toContain('expect_table_columns_to_match_set');
      expect(types).toContain('expect_column_values_to_be_unique');
    });

    it('asserts not-null only for columns with no gaps', async () => {
      const csv = ['a,b', '1,x', '2,', '3,z'].join(NL);
      const ds = await ingestCsv(engine, ctx.registry, 'gaps.csv', csv);

      const result = (await call('export_transformation_pipeline', {
        dataset_id: ds.id,
        format: 'great_expectations',
      })) as { code: string };

      const notNull = JSON.parse(result.code)
        .expectations.filter(
          (e: { expectation_type: string }) =>
            e.expectation_type === 'expect_column_values_to_not_be_null',
        )
        .map((e: { kwargs: { column: string } }) => e.kwargs.column);

      expect(notNull).toContain('a');
      expect(notNull).not.toContain('b');
    });
  });
});
