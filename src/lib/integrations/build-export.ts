import { unfence } from '../domain/injection';
import { callTool } from '../tools';
import type { Dataset } from '../engine/registry';
import { branchNameFor, buildManifest, type ArtifactType, type ExportManifest } from './manifest';

/**
 * Assemble the artifacts that make up a GitHub export.
 *
 * Everything here is *generated* output — SQL, a script, a model, a validation
 * suite, documentation, the transformation ledger. There is no path by which a
 * raw row reaches this set:
 *
 * - the pipeline exports describe transformations, not values;
 * - the Great Expectations suite describes shapes, not contents;
 * - the documentation is requested with `include_samples: false`, because its
 *   example-values column is real cell content;
 * - the ledger records operations, row counts and actors, not rows.
 *
 * Quarantined content is unreachable from all six by construction, which is
 * what lets the manifest state `includesQuarantinedCells: false` as a fact
 * rather than an intention.
 */

export interface ExportBuildResult {
  readonly manifest: ExportManifest;
  readonly prTitle: string;
  readonly prBody: string;
}

interface ExportFile {
  path: string;
  type: ArtifactType;
  content: string;
}

export type ToolCaller = (name: string, input: unknown) => Promise<unknown>;

export interface BuildExportOptions {
  readonly dataset: Dataset;
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  readonly qualityScore: number | null;
  readonly quarantinedRows: number;
  readonly now?: Date;
  /**
   * How to reach the tools. Defaults to the app's own dispatcher.
   *
   * Injectable so a test can drive this against a real DuckDB instance without
   * the browser-only module context — the production path is unchanged, which
   * is the point: a test that exercised a different assembly would prove
   * nothing about what actually gets published.
   */
  readonly call?: ToolCaller;
}

export async function buildGitHubExport(
  options: BuildExportOptions,
): Promise<ExportBuildResult> {
  const { dataset } = options;
  const call: ToolCaller = options.call ?? ((name, input) => callTool(name, input));
  const head = dataset.history[dataset.headIndex];
  const original = dataset.history[0];
  const slug = dataset.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'dataset';

  const [sql, python, dbt, json, expectations, docs] = await Promise.all([
    exportPipeline(call, dataset.id, 'sql'),
    exportPipeline(call, dataset.id, 'python'),
    exportPipeline(call, dataset.id, 'dbt'),
    exportPipeline(call, dataset.id, 'json'),
    exportPipeline(call, dataset.id, 'great_expectations'),
    exportDocs(call, dataset.id),
  ]);

  const ledger = JSON.stringify(
    {
      datasetName: dataset.name,
      exportedFrom: {
        checkpointId: head?.id ?? null,
        stepsApplied: dataset.headIndex,
      },
      // Row counts and operations only. No cell values.
      history: dataset.history.map((checkpoint, index) => ({
        checkpointId: checkpoint.id,
        label: checkpoint.label,
        tool: checkpoint.tool,
        rowCount: checkpoint.rowCount,
        columns: checkpoint.columns,
        createdAt: checkpoint.createdAt,
        isCurrent: index === dataset.headIndex,
        wasUndone: index > dataset.headIndex,
      })),
      rowsSkippedAtLoad: dataset.skippedRows,
    },
    null,
    2,
  );

  const files: ExportFile[] = [
    { path: `models/${slug}.sql`, type: 'sql', content: sql },
    { path: `scripts/${slug}.py`, type: 'python', content: python },
    { path: `dbt/models/${slug}.sql`, type: 'dbt', content: dbt },
    { path: `pipeline/${slug}.json`, type: 'json', content: json },
    {
      path: `great_expectations/${slug}_suite.json`,
      type: 'great_expectations',
      content: expectations,
    },
    { path: `docs/${slug}_data_quality.md`, type: 'documentation', content: docs },
    { path: `artifacts/${slug}_ledger.json`, type: 'json', content: ledger },
  ];

  const branch = options.branch ?? branchNameFor(dataset.name, options.now);

  const manifest = await buildManifest({
    datasetId: dataset.id,
    datasetName: dataset.name,
    destination: { provider: 'github', owner: options.owner, repo: options.repo, branch },
    files,
    includesSampleValues: false,
    sourceState: {
      checkpointId: head?.id ?? '',
      stepsApplied: dataset.headIndex,
      rowsOriginal: original?.rowCount ?? 0,
      rowsCurrent: head?.rowCount ?? 0,
      qualityScore: options.qualityScore,
    },
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    manifest,
    prTitle: `DataSweep: cleaning pipeline for ${dataset.name}`,
    prBody: buildPrBody(manifest, options.quarantinedRows),
  };
}

/**
 * The pull request description.
 *
 * Deterministic and auditable: every line is a figure taken from the manifest,
 * so a reviewer can check the description against the diff rather than trust it.
 */
function buildPrBody(manifest: ExportManifest, quarantinedRows: number): string {
  const nl = String.fromCharCode(10);
  const { sourceState, artifacts, dataPolicy } = manifest;

  const lines = [
    '## DataSweep export',
    '',
    `- **Source dataset:** ${manifest.datasetName}`,
    `- **Rows at load:** ${sourceState.rowsOriginal.toLocaleString()}`,
    `- **Rows after cleaning:** ${sourceState.rowsCurrent.toLocaleString()}`,
    `- **Approved transformations:** ${sourceState.stepsApplied}`,
    ...(sourceState.qualityScore !== null
      ? [`- **Quality score:** ${sourceState.qualityScore}/100`]
      : []),
    `- **Rows carrying injected content:** ${quarantinedRows}`,
    `- **Approved by:** a human, in the browser, before this export was created`,
    `- **Manifest hash:** \`${manifest.manifestHash.slice(0, 16)}\``,
    '',
    '### Included',
    '',
    ...artifacts.map(
      (a) => `- \`${a.path}\` — ${a.bytes.toLocaleString()} B, \`${a.sha256.slice(0, 12)}\``,
    ),
    '',
    '### Not included',
    '',
    '- Raw dataset rows',
    '- Quarantined prompt-injection cells',
    ...(dataPolicy.includesSampleValues ? [] : ['- Example cell values in the documentation']),
    '- Any credential',
    '- Any transformation that was not approved',
    '',
    '---',
    '',
    'The SQL is produced by the same compiler that executed the transformations, so it is the',
    'query that ran rather than a reimplementation of it.',
  ];

  return lines.join(nl);
}

async function exportPipeline(
  call: ToolCaller,
  datasetId: string,
  format: string,
): Promise<string> {
  const result = (await call('export_transformation_pipeline', {
    dataset_id: datasetId,
    format,
  })) as { code: string };
  return result.code;
}

async function exportDocs(call: ToolCaller, datasetId: string): Promise<string> {
  const result = (await call('generate_data_documentation', {
    dataset_id: datasetId,
    // The reason this option exists: example values are raw cell content.
    include_samples: false,
  })) as { documentation: string };
  return unfence(result.documentation);
}
