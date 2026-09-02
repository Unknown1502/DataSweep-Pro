import { z } from 'zod';
import { exportPipeline, type ExportFormat } from '../domain/export';
import { toGreatExpectations } from '../domain/great-expectations';
import { detectColumnSemantics } from '../domain/quality/semantics';
import type { SemanticDetection } from '../domain/quality/semantics';
import { profileColumns } from '../engine/introspect';
import {
  checkCompatibility,
  pipelineFromDataset,
  toSpecs,
  type Pipeline,
} from '../domain/pipeline';
import { dropTables, runChain, sampleBeforeAfter } from '../engine/apply';
import { getColumns, getRowCount } from '../engine/introspect';
import { generateTableName, quoteIdent } from '../engine/sql';
import { quarantine } from '../domain/injection';
import { findTemplate, TEMPLATE_IDS, TEMPLATES } from '../templates';
import { withGuards, type ToolContext } from './guards';
import { datasetIdJson, confirmationTokenJson, parseOrThrow } from './schemas';
import type { ToolDefinition, ToolFactory } from './types';

const FORMATS = ['sql', 'python', 'dbt', 'json', 'great_expectations'] as const;

// ---------------------------------------------------------------------------
// export_transformation_pipeline
// ---------------------------------------------------------------------------

const exportSchema = z.object({
  dataset_id: z.string().max(64),
  format: z.enum(FORMATS).default('sql'),
});

export const exportTransformationPipeline: ToolFactory = (getContext): ToolDefinition => ({
  name: 'export_transformation_pipeline',
  description:
    'Turn the cleaning work into something the user can keep: SQL as chained CTEs, a pandas ' +
    'script, a dbt model, portable JSON, or a Great Expectations suite that guards future ' +
    'batches against the same problems. Steps the user undid are excluded. Use this when they ' +
    'ask how to reproduce or enforce the cleaning elsewhere.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      format: {
        type: 'string',
        enum: [...FORMATS],
        default: 'sql',
        description: 'Output language. Defaults to SQL.',
      },
    },
    required: ['dataset_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  execute: withGuards(
    {
      name: 'export_transformation_pipeline',
      mutating: false,
      validate: (input) => parseOrThrow(exportSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const dataset = ctx.registry.resolve(input.dataset_id);
        const pipeline = pipelineFromDataset(dataset);

        // A GE suite describes the data's *current* shape, so it needs the
        // cleaned state rather than the transformation list alone.
        let code: string;
        if (input.format === 'great_expectations') {
          const head = ctx.registry.head(input.dataset_id);
          const semantics: SemanticDetection[] = [];
          for (const column of head.columns) {
            semantics.push(await detectColumnSemantics(ctx.engine, head.id, column));
          }
          const profiles = await profileColumns(ctx.engine, head.id, head.columns, 1);

          code = toGreatExpectations({
            name: `${pipeline.name}_suite`,
            columns: head.columns,
            rowCount: head.rowCount,
            semantics,
            pipeline,
            completeColumns: profiles.filter((p) => p.nullCount === 0).map((p) => p.column),
          });
        } else {
          code = exportPipeline(pipeline, input.format as ExportFormat);
        }

        return {
          dataset_id: dataset.id,
          format: input.format,
          step_count: pipeline.steps.length,
          required_columns: pipeline.requiredColumns,
          code,
          ...(pipeline.steps.length === 0
            ? { note: 'No cleaning steps have been applied yet, so the export is a passthrough.' }
            : {}),
        };
      },
    },
    getContext,
  ),
});

// ---------------------------------------------------------------------------
// execute_cleaning_pipeline
// ---------------------------------------------------------------------------

const pipelineStepSchema = z.object({
  operation: z.string().max(64),
  column: z.string().max(255).nullable(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(500).optional(),
});

const executeSchema = z.object({
  dataset_id: z.string().max(64),
  pipeline: z.object({
    name: z.string().max(200).optional(),
    steps: z.array(pipelineStepSchema).min(1).max(50),
    requiredColumns: z.array(z.string().max(255)).optional(),
  }),
  confirmation_token: z.string().max(64).optional(),
});

function asPipeline(input: z.infer<typeof executeSchema>): Pipeline {
  return {
    name: input.pipeline.name ?? 'pipeline',
    version: '1',
    createdAt: new Date().toISOString(),
    requiredColumns: input.pipeline.requiredColumns ?? [],
    steps: input.pipeline.steps.map((s) => ({
      operation: s.operation as Pipeline['steps'][number]['operation'],
      column: s.column,
      parameters: s.parameters ?? {},
      description: s.description ?? s.operation,
    })),
  };
}

export const executeCleaningPipeline: ToolFactory = (getContext): ToolDefinition => ({
  name: 'execute_cleaning_pipeline',
  description:
    'Run a whole saved pipeline against a dataset in one call, instead of applying steps one ' +
    'at a time. Compatibility is checked first and the run is refused if a step names a column ' +
    'the dataset does not have. Without confirmation_token this is a dry run.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      pipeline: {
        type: 'object',
        description: 'A pipeline, as returned by export_transformation_pipeline with format json.',
        properties: {
          name: { type: 'string', maxLength: 200 },
          requiredColumns: { type: 'array', items: { type: 'string', maxLength: 255 } },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                operation: { type: 'string', maxLength: 64 },
                column: { type: ['string', 'null'], maxLength: 255 },
                parameters: { type: 'object', additionalProperties: true },
                description: { type: 'string', maxLength: 500 },
              },
              required: ['operation', 'column'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      confirmation_token: confirmationTokenJson,
    },
    required: ['dataset_id', 'pipeline'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  execute: withGuards(
    {
      name: 'execute_cleaning_pipeline',
      mutating: true,
      validate: (input) => parseOrThrow(executeSchema, input),

      preview: async (input, ctx) => {
        const head = ctx.registry.head(input.dataset_id);
        const pipeline = asPipeline(input);
        const compatibility = checkCompatibility(pipeline, head.columns);

        if (!compatibility.compatible) {
          throw new Error(
            `${compatibility.summary} This dataset has: ${head.columns.join(', ')}.`,
          );
        }

        const chain = await runChain(
          ctx.engine,
          head.id,
          head.columns,
          toSpecs(pipeline),
          'dryrun',
        );

        try {
          const finalRows = chain.steps.at(-1)?.rowsAfter ?? head.rowCount;
          return {
            summary:
              `Pipeline "${pipeline.name}" (${pipeline.steps.length} steps): ` +
              `${head.rowCount.toLocaleString()} rows in, ${finalRows.toLocaleString()} out. ` +
              'Nothing has been changed yet.',
            details: {
              compatibility: compatibility.summary,
              rows_before: head.rowCount,
              rows_after: finalRows,
              steps: chain.steps.map((s) => ({
                operation: s.operation,
                column: s.column,
                rows_affected: s.rowsAffected,
              })),
              caveats: chain.steps.flatMap((s) => (s.caveat ? [s.caveat] : [])),
            },
          };
        } finally {
          await dropTables(ctx.engine, [...chain.intermediates, chain.finalTable]);
        }
      },

      execute: async (input, ctx: ToolContext) => {
        const dataset = ctx.registry.resolve(input.dataset_id);
        const head = ctx.registry.head(input.dataset_id);
        const pipeline = asPipeline(input);

        const chain = await runChain(ctx.engine, head.id, head.columns, toSpecs(pipeline), 'ckpt');
        const finalRows = chain.steps.at(-1)?.rowsAfter ?? head.rowCount;

        const { checkpoint, discarded } = ctx.registry.appendCheckpoint(dataset.id, {
          label: `Pipeline: ${pipeline.name}`,
          tool: 'execute_cleaning_pipeline',
          args: toSpecs(pipeline),
          rowCount: finalRows,
          columns: chain.finalColumns,
          createdAt: new Date().toISOString(),
        });

        await ctx.engine.query(
          `CREATE TABLE ${quoteIdent(checkpoint.id)} AS SELECT * FROM ${quoteIdent(chain.finalTable)}`,
        );
        await dropTables(ctx.engine, [
          ...chain.intermediates,
          chain.finalTable,
          ...discarded.map((c) => c.id),
        ]);

        return {
          dataset_id: dataset.id,
          checkpoint_id: checkpoint.id,
          pipeline_name: pipeline.name,
          steps_run: chain.steps.length,
          rows_before: head.rowCount,
          rows_after: finalRows,
          columns: chain.finalColumns,
          reversible: true,
          undo_with: `undo_to_checkpoint(dataset_id="${dataset.id}", checkpoint_id="${head.id}")`,
        };
      },
    },
    getContext,
  ),
});

// ---------------------------------------------------------------------------
// apply_community_template
// ---------------------------------------------------------------------------

const templateSchema = z.object({
  dataset_id: z.string().max(64),
  template_id: z.enum(TEMPLATE_IDS as [string, ...string[]]),
  confirmation_token: z.string().max(64).optional(),
});

export const applyCommunityTemplate: ToolFactory = (getContext): ToolDefinition => ({
  name: 'apply_community_template',
  description:
    'Apply a prebuilt cleaning pipeline for a common kind of dataset. Available templates: ' +
    TEMPLATES.map((t) => `${t.id} (${t.blurb})`).join('; ') +
    '. Compatibility is scored against the dataset first. Without confirmation_token this is ' +
    'a dry run.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      template_id: {
        type: 'string',
        enum: [...TEMPLATE_IDS],
        description: 'Which template to apply.',
      },
      confirmation_token: confirmationTokenJson,
    },
    required: ['dataset_id', 'template_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  execute: withGuards(
    {
      name: 'apply_community_template',
      mutating: true,
      validate: (input) => parseOrThrow(templateSchema, input),

      preview: async (input, ctx) => {
        const head = ctx.registry.head(input.dataset_id);
        const template = findTemplate(input.template_id);
        if (!template) throw new Error(`Unknown template ${input.template_id}.`);

        const compatibility = checkCompatibility(template, head.columns);
        if (!compatibility.compatible) {
          throw new Error(
            `${compatibility.summary} This dataset has: ${head.columns.join(', ')}. ` +
              'Rename the columns to match, or apply the steps individually.',
          );
        }

        const chain = await runChain(
          ctx.engine,
          head.id,
          head.columns,
          toSpecs(template),
          'dryrun',
        );

        try {
          const finalRows = chain.steps.at(-1)?.rowsAfter ?? head.rowCount;
          return {
            summary:
              `Template "${template.name}" (${template.steps.length} steps): ` +
              `${head.rowCount.toLocaleString()} rows in, ${finalRows.toLocaleString()} out. ` +
              'Nothing has been changed yet.',
            details: {
              template_id: template.id,
              compatibility_score: compatibility.score,
              compatibility: compatibility.summary,
              rows_before: head.rowCount,
              rows_after: finalRows,
              steps: template.steps.map((s) => s.description),
              caveats: chain.steps.flatMap((s) => (s.caveat ? [s.caveat] : [])),
            },
          };
        } finally {
          await dropTables(ctx.engine, [...chain.intermediates, chain.finalTable]);
        }
      },

      execute: async (input, ctx: ToolContext) => {
        const dataset = ctx.registry.resolve(input.dataset_id);
        const head = ctx.registry.head(input.dataset_id);
        const template = findTemplate(input.template_id)!;

        const chain = await runChain(ctx.engine, head.id, head.columns, toSpecs(template), 'ckpt');
        const finalRows = chain.steps.at(-1)?.rowsAfter ?? head.rowCount;

        const { checkpoint, discarded } = ctx.registry.appendCheckpoint(dataset.id, {
          label: `Template: ${template.name}`,
          tool: 'apply_community_template',
          args: toSpecs(template),
          rowCount: finalRows,
          columns: chain.finalColumns,
          createdAt: new Date().toISOString(),
        });

        await ctx.engine.query(
          `CREATE TABLE ${quoteIdent(checkpoint.id)} AS SELECT * FROM ${quoteIdent(chain.finalTable)}`,
        );
        await dropTables(ctx.engine, [
          ...chain.intermediates,
          chain.finalTable,
          ...discarded.map((c) => c.id),
        ]);

        return {
          dataset_id: dataset.id,
          checkpoint_id: checkpoint.id,
          template_id: template.id,
          steps_run: chain.steps.length,
          rows_before: head.rowCount,
          rows_after: finalRows,
          reversible: true,
        };
      },
    },
    getContext,
  ),
});

// ---------------------------------------------------------------------------
// join_datasets
// ---------------------------------------------------------------------------

const JOIN_TYPES = ['inner', 'left', 'right', 'outer'] as const;

const joinSchema = z.object({
  left_dataset_id: z.string().max(64),
  right_dataset_id: z.string().max(64),
  left_column: z.string().max(255),
  right_column: z.string().max(255),
  how: z.enum(JOIN_TYPES).default('inner'),
  confirmation_token: z.string().max(64).optional(),
});

export const joinDatasets: ToolFactory = (getContext): ToolDefinition => ({
  name: 'join_datasets',
  description:
    'Join two loaded datasets on a key column, producing a new dataset. The originals are left ' +
    'untouched. Reports how many keys actually match before joining, so an accidental ' +
    'cross-product or an empty result is visible up front. Without confirmation_token this is ' +
    'a dry run.',
  inputSchema: {
    type: 'object',
    properties: {
      left_dataset_id: datasetIdJson,
      right_dataset_id: datasetIdJson,
      left_column: { type: 'string', maxLength: 255, description: 'Key column on the left.' },
      right_column: { type: 'string', maxLength: 255, description: 'Key column on the right.' },
      how: { type: 'string', enum: [...JOIN_TYPES], default: 'inner' },
      confirmation_token: confirmationTokenJson,
    },
    required: ['left_dataset_id', 'right_dataset_id', 'left_column', 'right_column'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, untrustedContentHint: true },
  execute: withGuards(
    {
      name: 'join_datasets',
      mutating: true,
      validate: (input) => parseOrThrow(joinSchema, input),

      preview: async (input, ctx) => {
        const { left, right, sql } = await buildJoin(input, ctx);

        // Estimate the result before building it. A join that silently produces
        // a hundred million rows is the single most common way to hang a tab.
        const estimate = await ctx.engine.query(
          `SELECT COUNT(*) AS n FROM (${sql}) LIMIT 1`,
        );
        const resultRows = Number(estimate.rows[0]?.['n'] ?? 0);
        const matched = await ctx.engine.query(
          `SELECT COUNT(DISTINCT l.${quoteIdent(input.left_column)}) AS n
             FROM ${quoteIdent(left.id)} l
             JOIN ${quoteIdent(right.id)} r
               ON l.${quoteIdent(input.left_column)} = r.${quoteIdent(input.right_column)}`,
        );

        return {
          summary:
            `${input.how} join produces ${resultRows.toLocaleString()} rows from ` +
            `${left.rowCount.toLocaleString()} x ${right.rowCount.toLocaleString()}. ` +
            `${Number(matched.rows[0]?.['n'] ?? 0).toLocaleString()} distinct keys match. ` +
            'Nothing has been changed yet.',
          details: {
            result_rows: resultRows,
            left_rows: left.rowCount,
            right_rows: right.rowCount,
            matched_keys: Number(matched.rows[0]?.['n'] ?? 0),
            warning:
              resultRows > left.rowCount * 2
                ? 'The result is much larger than the left input — the key may not be unique.'
                : resultRows === 0
                  ? 'No rows matched. Check the key columns, and whether they need trimming first.'
                  : undefined,
          },
        };
      },

      execute: async (input, ctx: ToolContext) => {
        const { sql } = await buildJoin(input, ctx);
        const table = generateTableName('ds');

        await ctx.engine.query(`CREATE TABLE ${quoteIdent(table)} AS ${sql}`);

        const [columns, rowCount] = await Promise.all([
          getColumns(ctx.engine, table),
          getRowCount(ctx.engine, table),
        ]);

        const leftName = ctx.registry.resolve(input.left_dataset_id).name;
        const rightName = ctx.registry.resolve(input.right_dataset_id).name;

        const dataset = ctx.registry.create(
          `${leftName} + ${rightName}`,
          { rowCount, columns, createdAt: new Date().toISOString() },
          table,
          0,
          // Recorded so lineage can show a real merge rather than guess at one.
          [input.left_dataset_id, input.right_dataset_id],
        );

        const sample = await sampleBeforeAfter(ctx.engine, table, table, 5);

        return {
          dataset_id: dataset.id,
          name: dataset.name,
          rows: rowCount,
          columns,
          sample: quarantine(JSON.stringify(sample.after.rows, null, 2)),
          note: 'Both source datasets are unchanged and still available.',
        };
      },
    },
    getContext,
  ),
});

async function buildJoin(
  input: z.infer<typeof joinSchema>,
  ctx: ToolContext,
): Promise<{ left: { id: string; rowCount: number }; right: { id: string; rowCount: number }; sql: string }> {
  const left = ctx.registry.head(input.left_dataset_id);
  const right = ctx.registry.head(input.right_dataset_id);

  if (!left.columns.includes(input.left_column)) {
    throw new Error(
      `Left dataset has no column "${input.left_column}". Available: ${left.columns.join(', ')}.`,
    );
  }
  if (!right.columns.includes(input.right_column)) {
    throw new Error(
      `Right dataset has no column "${input.right_column}". Available: ${right.columns.join(', ')}.`,
    );
  }

  // Columns present on both sides are prefixed so the result has unique names
  // rather than silently keeping whichever one the engine picked.
  const projection = [
    ...left.columns.map((c) => `l.${quoteIdent(c)} AS ${quoteIdent(c)}`),
    ...right.columns
      .filter((c) => c !== input.right_column)
      .map((c) =>
        left.columns.includes(c)
          ? `r.${quoteIdent(c)} AS ${quoteIdent(`right_${c}`)}`
          : `r.${quoteIdent(c)} AS ${quoteIdent(c)}`,
      ),
  ].join(', ');

  const joinType = { inner: 'INNER', left: 'LEFT', right: 'RIGHT', outer: 'FULL OUTER' }[input.how];

  return {
    left: { id: left.id, rowCount: left.rowCount },
    right: { id: right.id, rowCount: right.rowCount },
    sql:
      `SELECT ${projection} FROM ${quoteIdent(left.id)} l ` +
      `${joinType} JOIN ${quoteIdent(right.id)} r ` +
      `ON l.${quoteIdent(input.left_column)} = r.${quoteIdent(input.right_column)}`,
  };
}

export const PIPELINE_TOOLS: readonly ToolFactory[] = [
  exportTransformationPipeline,
  executeCleaningPipeline,
  applyCommunityTemplate,
  joinDatasets,
];
