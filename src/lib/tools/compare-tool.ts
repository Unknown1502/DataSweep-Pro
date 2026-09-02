import { z } from 'zod';
import { compareCheckpoints } from '../domain/compare';
import { quarantine } from '../domain/injection';
import { withGuards, type ToolContext } from './guards';
import { datasetIdJson, parseOrThrow } from './schemas';
import type { ToolDefinition, ToolFactory } from './types';

const compareSchema = z.object({
  dataset_id: z.string().max(64),
  from_checkpoint_id: z.string().max(64),
  to_checkpoint_id: z.string().max(64),
  key_column: z.string().max(255).optional(),
  sample_limit: z.number().int().min(1).max(50).default(10),
});

/**
 * Row-level comparison between two states of the same dataset.
 *
 * Deliberately scoped to checkpoints of one dataset rather than to two
 * arbitrary datasets: versions here *are* checkpoints, and comparing unrelated
 * tables would produce a schema diff dressed up as a change report.
 */
export const compareCheckpointsTool: ToolFactory = (getContext): ToolDefinition => ({
  name: 'compare_checkpoints',
  description:
    'Show exactly what changed between two versions of a dataset: rows added, removed and ' +
    'modified, which columns changed, and cell-level before/after examples. Rows are matched by ' +
    'a unique key column, auto-detected if you do not name one. Without a usable key the report ' +
    'says so rather than reporting every edit as a delete plus an insert.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      from_checkpoint_id: {
        type: 'string',
        maxLength: 64,
        description: 'The earlier version, from list_datasets history.',
      },
      to_checkpoint_id: {
        type: 'string',
        maxLength: 64,
        description: 'The later version.',
      },
      key_column: {
        type: 'string',
        maxLength: 255,
        description: 'Column identifying a row across versions. Auto-detected if omitted.',
      },
      sample_limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['dataset_id', 'from_checkpoint_id', 'to_checkpoint_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  execute: withGuards(
    {
      name: 'compare_checkpoints',
      mutating: false,
      rateLimitPerMinute: 20,
      validate: (input) => parseOrThrow(compareSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const dataset = ctx.registry.resolve(input.dataset_id);

        const from = dataset.history.find((c) => c.id === input.from_checkpoint_id);
        const to = dataset.history.find((c) => c.id === input.to_checkpoint_id);

        for (const [label, found, id] of [
          ['from_checkpoint_id', from, input.from_checkpoint_id],
          ['to_checkpoint_id', to, input.to_checkpoint_id],
        ] as const) {
          if (!found) {
            throw new Error(
              `Unknown ${label} "${id}". Available: ` +
                dataset.history.map((c) => `${c.id} (${c.label})`).join(', '),
            );
          }
        }

        const result = await compareCheckpoints(ctx.engine, {
          beforeTable: from!.id,
          afterTable: to!.id,
          beforeColumns: from!.columns,
          afterColumns: to!.columns,
          keyColumn: input.key_column,
          sampleLimit: input.sample_limit,
        });

        return {
          dataset_id: dataset.id,
          from: { checkpoint_id: from!.id, label: from!.label, rows: from!.rowCount },
          to: { checkpoint_id: to!.id, label: to!.label, rows: to!.rowCount },
          summary: result.summary,
          key_column: result.keyColumn,
          key_source: result.keySource,
          rows_added: result.rowsAdded,
          rows_removed: result.rowsRemoved,
          rows_modified: result.rowsModified,
          columns_added: result.columnsAdded,
          columns_removed: result.columnsRemoved,
          changes_by_column: result.changesByColumn,
          // Cell values, so fenced.
          sample_changes:
            result.sampleChanges.length > 0
              ? quarantine(JSON.stringify(result.sampleChanges, null, 2))
              : null,
          ...(result.caveat ? { caveat: result.caveat } : {}),
        };
      },
    },
    getContext,
  ),
});

export const COMPARE_TOOLS: readonly ToolFactory[] = [compareCheckpointsTool];
