import type { Pipeline } from './domain/pipeline';
import { PIPELINE_VERSION } from './domain/pipeline';

/**
 * Prebuilt pipelines for shapes of data that recur everywhere.
 *
 * Deliberately conservative: every template does things that are safe to do
 * without looking at the values first — trimming, deduplication, format
 * normalization. None of them drop rows or clip values, because a template
 * cannot know whether an outlier in *your* data is an error or the finding.
 */
export interface Template extends Pipeline {
  readonly id: string;
  readonly blurb: string;
}

const now = '2026-01-01T00:00:00.000Z';

export const TEMPLATES: readonly Template[] = [
  {
    id: 'sales-orders',
    name: 'Sales orders',
    blurb: 'Deduplicate, trim customer names, normalize order dates and money columns.',
    version: PIPELINE_VERSION,
    createdAt: now,
    requiredColumns: ['order_date', 'customer', 'amount'],
    steps: [
      {
        operation: 'remove_duplicates',
        column: null,
        parameters: {},
        description: 'Remove duplicated order rows',
      },
      {
        operation: 'trim_whitespace',
        column: 'customer',
        parameters: {},
        description: 'Trim customer names so they group correctly',
      },
      {
        operation: 'standardize_dates',
        column: 'order_date',
        parameters: { dayFirst: true },
        description: 'Normalize order dates to ISO',
      },
      {
        operation: 'parse_numbers',
        column: 'amount',
        parameters: {},
        description: 'Strip currency symbols from amounts',
      },
    ],
  },
  {
    id: 'survey-responses',
    name: 'Survey responses',
    blurb: 'Deduplicate submissions and normalize free-text answer casing and spacing.',
    version: PIPELINE_VERSION,
    createdAt: now,
    requiredColumns: ['respondent_id', 'response'],
    steps: [
      {
        operation: 'remove_duplicates',
        column: null,
        parameters: {},
        description: 'Remove duplicate submissions',
      },
      {
        operation: 'trim_whitespace',
        column: 'response',
        parameters: {},
        description: 'Trim response text',
      },
    ],
  },
  {
    id: 'contact-list',
    name: 'Contact list',
    blurb: 'Deduplicate, trim, and lowercase email addresses so they match reliably.',
    version: PIPELINE_VERSION,
    createdAt: now,
    requiredColumns: ['email'],
    steps: [
      {
        operation: 'remove_duplicates',
        column: null,
        parameters: {},
        description: 'Remove duplicate contacts',
      },
      {
        operation: 'trim_whitespace',
        column: 'email',
        parameters: {},
        description: 'Trim email addresses',
      },
      {
        operation: 'normalize_case',
        column: 'email',
        parameters: { mode: 'lower' },
        description: 'Lowercase emails so they compare correctly',
      },
    ],
  },
  {
    id: 'financial-ledger',
    name: 'Financial ledger',
    blurb: 'Normalize posting dates and parse amounts including accounting negatives.',
    version: PIPELINE_VERSION,
    createdAt: now,
    requiredColumns: ['posting_date', 'amount'],
    steps: [
      {
        operation: 'standardize_dates',
        column: 'posting_date',
        parameters: { dayFirst: true },
        description: 'Normalize posting dates to ISO',
      },
      {
        operation: 'parse_numbers',
        column: 'amount',
        parameters: {},
        description: 'Parse amounts, reading (1,200) as -1200',
      },
    ],
  },
  {
    id: 'product-catalog',
    name: 'Product catalog',
    blurb: 'Deduplicate SKUs, trim names, and parse prices into plain numbers.',
    version: PIPELINE_VERSION,
    createdAt: now,
    requiredColumns: ['sku', 'name', 'price'],
    steps: [
      {
        operation: 'remove_duplicates',
        column: null,
        parameters: {},
        description: 'Remove duplicate catalog rows',
      },
      {
        operation: 'trim_whitespace',
        column: 'name',
        parameters: {},
        description: 'Trim product names',
      },
      {
        operation: 'parse_numbers',
        column: 'price',
        parameters: {},
        description: 'Parse prices into plain numbers',
      },
    ],
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
