import { z } from 'zod';
import { ALL_CHECKS } from '../domain/quality';

/**
 * Tool schemas, defined twice on purpose.
 *
 * The JSON Schema is what an agent is shown and what WebMCP registers. The Zod
 * schema is what actually runs at execution time. They are kept adjacent so
 * drift is visible in review, and the Zod side is the one that can be trusted —
 * a client is free to ignore the advertised schema, so validation cannot depend
 * on it having been honoured.
 *
 * Every object schema sets `additionalProperties: false`: unexpected keys are a
 * signal something is wrong, not something to quietly discard.
 */

const DATASET_ID_DESCRIPTION =
  'Opaque dataset identifier from list_datasets. Not a filename or table name.';

export const datasetIdJson = {
  type: 'string',
  maxLength: 64,
  description: DATASET_ID_DESCRIPTION,
} as const;

export const confirmationTokenJson = {
  type: 'string',
  maxLength: 64,
  description:
    'Token returned by a previous unconfirmed call to this same tool. Omit it to preview the ' +
    'change; supply it to apply the change the user approved.',
} as const;

// --- list_datasets ---------------------------------------------------------

export const listDatasetsJson = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const listDatasetsSchema = z.object({}).loose();

// --- preview_dataset -------------------------------------------------------

export const previewDatasetJson = {
  type: 'object',
  properties: {
    dataset_id: datasetIdJson,
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Number of rows to return. Capped at 100.',
    },
  },
  required: ['dataset_id'],
  additionalProperties: false,
} as const;

export const previewDatasetSchema = z.object({
  dataset_id: z.string().max(64),
  limit: z.number().int().min(1).max(100).default(10),
});

// --- detect_data_quality_issues --------------------------------------------

export const detectIssuesJson = {
  type: 'object',
  properties: {
    dataset_id: datasetIdJson,
    checks: {
      type: 'array',
      maxItems: ALL_CHECKS.length,
      items: { type: 'string', enum: [...ALL_CHECKS] },
      description: 'Which checks to run. Omit to run all of them.',
    },
  },
  required: ['dataset_id'],
  additionalProperties: false,
} as const;

export const detectIssuesSchema = z.object({
  dataset_id: z.string().max(64),
  checks: z.array(z.enum(ALL_CHECKS as [string, ...string[]])).optional(),
});

// --- apply_cleaning_transformations ----------------------------------------

const OPERATIONS = [
  'drop_rows_with_missing',
  'fill_missing',
  'remove_duplicates',
  'trim_whitespace',
  'normalize_case',
  'standardize_dates',
  'parse_numbers',
  'clip_outliers',
  'drop_column',
  'quarantine_rows',
] as const;

export const MAX_TRANSFORMATIONS = 25;

export const applyTransformationsJson = {
  type: 'object',
  properties: {
    dataset_id: datasetIdJson,
    transformations: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TRANSFORMATIONS,
      description: 'Operations applied in order, each to the result of the previous one.',
      items: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: [...OPERATIONS] },
          column: {
            type: ['string', 'null'],
            maxLength: 255,
            description: 'Column to act on. Use null for table-wide operations.',
          },
          parameters: { type: 'object', additionalProperties: true },
        },
        required: ['operation', 'column'],
        additionalProperties: false,
      },
    },
    confirmation_token: confirmationTokenJson,
  },
  required: ['dataset_id', 'transformations'],
  additionalProperties: false,
} as const;

export const applyTransformationsSchema = z.object({
  dataset_id: z.string().max(64),
  transformations: z
    .array(
      z.object({
        operation: z.enum(OPERATIONS),
        column: z.string().max(255).nullable(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(MAX_TRANSFORMATIONS),
  confirmation_token: z.string().max(64).optional(),
});

// --- undo_to_checkpoint ----------------------------------------------------

export const undoJson = {
  type: 'object',
  properties: {
    dataset_id: datasetIdJson,
    checkpoint_id: {
      type: 'string',
      maxLength: 64,
      description: 'Checkpoint to restore, from generate_impact_report or list_datasets.',
    },
    confirmation_token: confirmationTokenJson,
  },
  required: ['dataset_id', 'checkpoint_id'],
  additionalProperties: false,
} as const;

export const undoSchema = z.object({
  dataset_id: z.string().max(64),
  checkpoint_id: z.string().max(64),
  confirmation_token: z.string().max(64).optional(),
});

// --- generate_impact_report ------------------------------------------------

export const impactReportJson = {
  type: 'object',
  properties: { dataset_id: datasetIdJson },
  required: ['dataset_id'],
  additionalProperties: false,
} as const;

export const impactReportSchema = z.object({ dataset_id: z.string().max(64) });

/** Turn a Zod failure into a message an agent can act on. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(formatZodError(result.error));
  return result.data;
}
