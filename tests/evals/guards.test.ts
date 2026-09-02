import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEngine } from '../helpers/duckdb-node';
import { ingestCsv } from '../../src/lib/engine/ingest';
import { DatasetRegistry } from '../../src/lib/engine/registry';
import {
  AuditLog,
  CONFIRMATION_TTL_MS,
  ConfirmationStore,
  RateLimiter,
  ToolError,
  type ToolContext,
  fingerprintArgs,
  callAs,
  withGuards,
} from '../../src/lib/tools/guards';
import type { SqlEngine } from '../../src/lib/engine/types';

const NL = String.fromCharCode(10);

/**
 * Security evals for the tool guard layer.
 *
 * These deliberately assert on observable behaviour — row counts, audit
 * entries — rather than on "it threw". A test that only asserts `rejects.toThrow()`
 * passes when the code throws for entirely the wrong reason, which is how a
 * security control rots without anyone noticing.
 */
describe('tool guards', () => {
  let engine: SqlEngine;
  let ctx: ToolContext;
  let datasetId: string;

  beforeAll(async () => {
    engine = await createTestEngine();
  });
  afterAll(async () => {
    await engine?.close();
  });

  beforeEach(async () => {
    const registry = new DatasetRegistry();
    const dataset = await ingestCsv(
      engine,
      registry,
      'data.csv',
      ['id,name', '1,a', '2,b', '3,c'].join(NL),
    );
    datasetId = dataset.id;

    ctx = {
      engine,
      registry,
      audit: new AuditLog(),
      confirmations: new ConfirmationStore(),
      rateLimiter: new RateLimiter({}),
    };
  });

  const rowCount = async () =>
    Number(
      (await engine.query(`SELECT COUNT(*) AS n FROM "${datasetId}"`)).rows[0]?.['n'] ?? -1,
    );

  /** A destructive tool that really does delete rows when it runs. */
  const makeDestructiveTool = () =>
    withGuards(
      {
        name: 'delete_everything',
        mutating: true,
        validate: (input) => input as { dataset_id: string },
        preview: async (input) => ({
          summary: `Would delete all rows from ${input.dataset_id}.`,
          details: { rows: await rowCount() },
        }),
        execute: async (input, c) => {
          await c.engine.query(`DELETE FROM "${c.registry.resolve(input.dataset_id).id}"`);
          return { deleted: true };
        },
      },
      () => ctx,
    );

  describe('two-phase confirmation', () => {
    it('performs NO write when called without a token', async () => {
      const tool = makeDestructiveTool();
      const before = await rowCount();

      const result = await tool({ dataset_id: datasetId });

      // The load-bearing assertion: the data is untouched.
      expect(await rowCount()).toBe(before);
      expect(result).toMatchObject({ status: 'confirmation_required' });
      expect(result).toHaveProperty('confirmation_token');
    });

    it('tells the agent explicitly that nothing has changed yet', async () => {
      const tool = makeDestructiveTool();
      const result = (await tool({ dataset_id: datasetId })) as { next_step: string };
      expect(result.next_step).toMatch(/nothing has been changed/i);
    });

    it('performs the write once the token is supplied', async () => {
      const tool = makeDestructiveTool();
      const issued = (await tool({ dataset_id: datasetId })) as { confirmation_token: string };

      await tool({ dataset_id: datasetId, confirmation_token: issued.confirmation_token });

      expect(await rowCount()).toBe(0);
    });

    it('rejects a replayed token and leaves data intact', async () => {
      const tool = makeDestructiveTool();
      const issued = (await tool({ dataset_id: datasetId })) as { confirmation_token: string };
      const args = { dataset_id: datasetId, confirmation_token: issued.confirmation_token };

      await tool(args);
      expect(await rowCount()).toBe(0);

      // Re-ingest so a second execution would be observable.
      await engine.query(`INSERT INTO "${datasetId}" VALUES ('9', 'z')`);
      await expect(tool(args)).rejects.toThrow(/already been used/i);
      expect(await rowCount()).toBe(1);
    });

    it('refuses a token issued for different arguments', async () => {
      // Without argument binding, an agent could preview something harmless and
      // reuse the token to authorize a destructive call.
      const registry = ctx.registry;
      const other = await ingestCsv(engine, registry, 'other.csv', ['id,name', '1,a'].join(NL));

      const tool = makeDestructiveTool();
      const issued = (await tool({ dataset_id: other.id })) as { confirmation_token: string };

      await expect(
        tool({ dataset_id: datasetId, confirmation_token: issued.confirmation_token }),
      ).rejects.toThrow(/arguments changed/i);

      expect(await rowCount()).toBe(3);
    });

    it('refuses a token issued for a different tool', async () => {
      const issued = ctx.confirmations.issue('some_other_tool', { dataset_id: datasetId });
      const tool = makeDestructiveTool();

      await expect(
        tool({ dataset_id: datasetId, confirmation_token: issued.token }),
      ).rejects.toThrow(/issued for some_other_tool/);
      expect(await rowCount()).toBe(3);
    });

    it('refuses an expired token', async () => {
      const store = new ConfirmationStore();
      const now = Date.now();
      const issued = store.issue('t', { a: 1 }, now);

      expect(() => store.consume(issued.token, 't', { a: 1 }, now + CONFIRMATION_TTL_MS + 1)).toThrow(
        /expired/i,
      );
    });

    it('refuses an invented token', async () => {
      const tool = makeDestructiveTool();
      await expect(
        tool({ dataset_id: datasetId, confirmation_token: 'cnf_deadbeef' }),
      ).rejects.toThrow(/not recognised/i);
      expect(await rowCount()).toBe(3);
    });

    it('read-only tools are not gated', async () => {
      const tool = withGuards(
        {
          name: 'count_rows',
          mutating: false,
          validate: (i) => i as Record<string, unknown>,
          execute: async () => ({ n: await rowCount() }),
        },
        () => ctx,
      );

      expect(await tool({})).toEqual({ n: 3 });
    });

    it('refuses to build a mutating tool with no preview', () => {
      // A configuration error, caught at construction rather than at the moment
      // an unreviewed destructive call goes through.
      expect(() =>
        withGuards(
          {
            name: 'bad',
            mutating: true,
            validate: (i) => i,
            execute: async () => ({}),
          },
          () => ctx,
        ),
      ).toThrow(/must supply a preview/);
    });
  });

  describe('argument fingerprinting', () => {
    it('is insensitive to key order', () => {
      expect(fingerprintArgs({ a: 1, b: 2 })).toBe(fingerprintArgs({ b: 2, a: 1 }));
    });

    it('excludes the token itself', () => {
      expect(fingerprintArgs({ a: 1, confirmation_token: 'x' })).toBe(fingerprintArgs({ a: 1 }));
    });

    it('distinguishes different values', () => {
      expect(fingerprintArgs({ a: 1 })).not.toBe(fingerprintArgs({ a: 2 }));
    });

    it('distinguishes nested differences', () => {
      expect(fingerprintArgs({ t: [{ op: 'trim' }] })).not.toBe(
        fingerprintArgs({ t: [{ op: 'drop' }] }),
      );
    });
  });

  describe('rate limiting', () => {
    it('blocks calls past the limit and says when to retry', () => {
      const limiter = new RateLimiter({ heavy: 2 });
      const now = Date.now();

      limiter.check('heavy', now);
      limiter.check('heavy', now + 100);
      expect(() => limiter.check('heavy', now + 200)).toThrow(/limited to 2 calls per minute/);
      expect(() => limiter.check('heavy', now + 200)).toThrow(/Retry in about/);
    });

    it('allows calls again once the window slides past', () => {
      const limiter = new RateLimiter({ heavy: 1 });
      const now = Date.now();

      limiter.check('heavy', now);
      expect(() => limiter.check('heavy', now + 1000)).toThrow();
      expect(() => limiter.check('heavy', now + 61_000)).not.toThrow();
    });

    it('does not limit tools without a configured limit', () => {
      const limiter = new RateLimiter({});
      for (let i = 0; i < 100; i++) limiter.check('free');
    });
  });

  describe('audit log', () => {
    it('records the preview and the confirmed execution as separate entries', async () => {
      const tool = makeDestructiveTool();
      const issued = (await tool({ dataset_id: datasetId })) as { confirmation_token: string };
      await tool({ dataset_id: datasetId, confirmation_token: issued.confirmation_token });

      const entries = ctx.audit.entries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.outcome).toBe('awaiting_confirmation');
      expect(entries[0]?.mutated).toBe(false);
      expect(entries[1]?.outcome).toBe('ok');
      expect(entries[1]?.mutated).toBe(true);
    });

    it('records rejected calls, so refusals are visible rather than silent', async () => {
      const tool = makeDestructiveTool();
      await expect(
        tool({ dataset_id: datasetId, confirmation_token: 'cnf_nope' }),
      ).rejects.toThrow();

      const entries = ctx.audit.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.outcome).toBe('rejected');
      expect(entries[0]?.mutated).toBe(false);
    });

    it('notifies subscribers as calls happen', async () => {
      const seen: string[] = [];
      ctx.audit.subscribe((e) => seen.push(e.outcome));

      const tool = makeDestructiveTool();
      await tool({ dataset_id: datasetId });

      expect(seen).toEqual(['awaiting_confirmation']);
    });
  });

  describe('actor attribution', () => {
    const readTool = () =>
      withGuards(
        {
          name: 'count_rows',
          mutating: false,
          validate: (i) => i,
          execute: async () => ({ n: await rowCount() }),
        },
        () => ctx,
      );

    it('attributes an unwrapped call to an external MCP client', async () => {
      // Calls arriving over document.modelContext do not pass through callAs,
      // so the conservative default is that they came from outside.
      await readTool()({});
      expect(ctx.audit.entries()[0]?.actor).toBe('external-mcp');
    });

    it('records the actor a call was made as', async () => {
      const tool = readTool();
      await callAs('human', () => tool({}));
      await callAs('claude-agent', () => tool({}));
      await callAs('demo-agent', () => tool({}));

      expect(ctx.audit.entries().map((e) => e.actor)).toEqual([
        'human',
        'claude-agent',
        'demo-agent',
      ]);
    });

    it('does not leak an actor to a later unwrapped call', async () => {
      // The module-level actor must be cleared synchronously, or every
      // subsequent external call would be misattributed to the last UI action.
      const tool = readTool();
      await callAs('human', () => tool({}));
      await tool({});

      expect(ctx.audit.entries().map((e) => e.actor)).toEqual(['human', 'external-mcp']);
    });

    it('attributes rejected calls too, so refusals name who tried', async () => {
      const tool = makeDestructiveTool();
      await expect(
        callAs('claude-agent', () => tool({ dataset_id: datasetId, confirmation_token: 'nope' })),
      ).rejects.toThrow();

      expect(ctx.audit.entries()[0]?.actor).toBe('claude-agent');
      expect(ctx.audit.entries()[0]?.outcome).toBe('rejected');
    });
  });

  describe('validation', () => {
    it('surfaces a validation failure with a machine-readable code', async () => {
      const tool = withGuards(
        {
          name: 'strict',
          mutating: false,
          validate: () => {
            throw new Error('dataset_id is required');
          },
          execute: async () => ({}),
        },
        () => ctx,
      );

      await expect(tool({})).rejects.toMatchObject({
        code: 'validation_failed',
        message: 'dataset_id is required',
      });
      await expect(tool({})).rejects.toBeInstanceOf(ToolError);
    });

    it('validates before any confirmation token is issued', async () => {
      // Otherwise an agent could harvest tokens with junk arguments.
      const tool = withGuards(
        {
          name: 'checked',
          mutating: true,
          validate: () => {
            throw new Error('bad input');
          },
          preview: async () => ({ summary: 'never reached', details: {} }),
          execute: async () => ({}),
        },
        () => ctx,
      );

      await expect(tool({ junk: true })).rejects.toThrow('bad input');
      expect(ctx.audit.entries()[0]?.outcome).toBe('rejected');
    });
  });
});
