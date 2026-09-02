import { z } from 'zod';
import { generateDocumentation } from '../domain/docs';
import { quarantine } from '../domain/injection';
import { pipelineFromDataset } from '../domain/pipeline';
import { analyzeQuality } from '../domain/quality';
import { detectColumnSemantics, resolveDateOrder } from '../domain/quality/semantics';
import type { SemanticDetection } from '../domain/quality/semantics';
import { profileColumns } from '../engine/introspect';
import { withGuards, type ToolContext } from './guards';
import { datasetIdJson, parseOrThrow } from './schemas';
import type { ToolDefinition, ToolFactory } from './types';

// ---------------------------------------------------------------------------
// detect_column_semantics
// ---------------------------------------------------------------------------

const semanticsSchema = z.object({
  dataset_id: z.string().max(64),
  columns: z.array(z.string().max(255)).max(200).optional(),
});

export const detectColumnSemanticsTool: ToolFactory = (getContext): ToolDefinition => ({
  name: 'detect_column_semantics',
  description:
    'Work out what each column actually contains — email, URL, UUID, phone, postcode, currency, ' +
    'date, boolean, identifier, category or free text — with a confidence score. Also resolves ' +
    'whether slash-separated dates are day-first or month-first by looking for components above ' +
    '12, so date conversion stops being a guess. Columns it cannot type confidently are reported ' +
    'as ambiguous rather than assigned a type.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      columns: {
        type: 'array',
        maxItems: 200,
        items: { type: 'string', maxLength: 255 },
        description: 'Columns to examine. Omit to examine all of them.',
      },
    },
    required: ['dataset_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  execute: withGuards(
    {
      name: 'detect_column_semantics',
      mutating: false,
      validate: (input) => parseOrThrow(semanticsSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const head = ctx.registry.head(input.dataset_id);
        const requested = input.columns ?? head.columns;

        const unknown = requested.filter((c) => !head.columns.includes(c));
        if (unknown.length > 0) {
          throw new Error(
            `Unknown column(s): ${unknown.join(', ')}. Available: ${head.columns.join(', ')}.`,
          );
        }

        const detections: SemanticDetection[] = [];
        for (const column of requested) {
          detections.push(await detectColumnSemantics(ctx.engine, head.id, column));
        }

        // Date ordering is only meaningful for date-ish columns.
        const dateOrders: Record<string, unknown> = {};
        for (const detection of detections) {
          if (detection.detectedType !== 'date' && detection.detectedType !== 'datetime') continue;
          const order = await resolveDateOrder(ctx.engine, head.id, detection.column);
          if (order.examined === 0) continue;
          dateOrders[detection.column] = {
            order: order.order,
            evidence: order.evidence,
            resolved: order.order === 'day_first' || order.order === 'month_first',
          };
        }

        return {
          dataset_id: input.dataset_id,
          columns_analyzed: detections.length,
          detections: detections.map((d) => ({
            column: d.column,
            detected_type: d.detectedType,
            label: d.label,
            confidence: Math.round(d.confidence * 100) / 100,
            ambiguous: d.ambiguous,
            distinct_values: d.distinctCount,
            alternatives: d.alternatives.map((a) => ({
              type: a.type,
              share: Math.round(a.share * 100) / 100,
            })),
          })),
          ambiguous_columns: detections.filter((d) => d.ambiguous).map((d) => d.column),
          date_ordering: dateOrders,
          next_step:
            'Use detected_type to choose transformations. For a column whose date_ordering says ' +
            '"contradictory", do not standardize dates — the column mixes orderings and no single ' +
            'setting reads it correctly.',
        };
      },
    },
    getContext,
  ),
});

// ---------------------------------------------------------------------------
// generate_data_documentation
// ---------------------------------------------------------------------------

const docsSchema = z.object({
  dataset_id: z.string().max(64),
  include_timestamp: z.boolean().default(false),
});

export const generateDataDocumentation: ToolFactory = (getContext): ToolDefinition => ({
  name: 'generate_data_documentation',
  description:
    'Produce a Markdown data dictionary and methodology document: an overview, per-column types ' +
    'and statistics, outstanding quality issues, the exact cleaning steps applied, known ' +
    'limitations, and recommended usage. Everything is derived from measured data — no figure ' +
    'in it is estimated or generated.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      include_timestamp: {
        type: 'boolean',
        default: false,
        description: 'Stamp the generation time. Off by default so output is reproducible.',
      },
    },
    required: ['dataset_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  execute: withGuards(
    {
      name: 'generate_data_documentation',
      mutating: false,
      rateLimitPerMinute: 10,
      validate: (input) => parseOrThrow(docsSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const dataset = ctx.registry.resolve(input.dataset_id);
        const head = ctx.registry.head(input.dataset_id);

        const [profiles, report] = await Promise.all([
          profileColumns(ctx.engine, head.id, head.columns),
          analyzeQuality(ctx.engine, {
            table: head.id,
            columns: head.columns,
            rowCount: head.rowCount,
          }),
        ]);

        const semantics: SemanticDetection[] = [];
        for (const column of head.columns) {
          semantics.push(await detectColumnSemantics(ctx.engine, head.id, column));
        }

        const markdown = generateDocumentation({
          dataset,
          profiles,
          semantics,
          issues: report.issues,
          qualityScore: report.score,
          pipeline: pipelineFromDataset(dataset),
          ...(input.include_timestamp ? { generatedAt: new Date().toISOString() } : {}),
        });

        return {
          dataset_id: dataset.id,
          format: 'markdown',
          columns_documented: profiles.length,
          // Contains real cell values as examples, so it is fenced.
          documentation: quarantine(markdown),
        };
      },
    },
    getContext,
  ),
});

export const ANALYSIS_TOOLS: readonly ToolFactory[] = [
  detectColumnSemanticsTool,
  generateDataDocumentation,
];
