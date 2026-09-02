import type { Dataset } from '../engine/registry';
import type { TransformSpec } from './transforms';
import type { TransformOperation } from './quality/types';

/**
 * A pipeline is a dataset's edit history, lifted into something portable.
 *
 * The whole value of the app collapses if a cleaning session only exists in one
 * browser tab. The history already records every operation and its arguments,
 * so a pipeline is not a new thing to maintain — it is a projection of the
 * ledger, which means it cannot drift from what actually happened.
 */

export interface PipelineStep {
  readonly operation: TransformOperation;
  readonly column: string | null;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Human-readable, carried through to comments in exported code. */
  readonly description: string;
}

export interface Pipeline {
  readonly name: string;
  readonly version: string;
  readonly createdAt: string;
  /** Columns the pipeline expects to find on the input. */
  readonly requiredColumns: readonly string[];
  readonly steps: readonly PipelineStep[];
}

export const PIPELINE_VERSION = '1';

/** Extract the applied steps from a dataset's history, up to the live head. */
export function pipelineFromDataset(dataset: Dataset, name?: string): Pipeline {
  const steps: PipelineStep[] = [];

  // history[0] is the upload, which is not an operation. Steps beyond headIndex
  // were undone and are deliberately excluded — exporting work the user rolled
  // back would hand them a pipeline they explicitly rejected.
  for (const checkpoint of dataset.history.slice(1, dataset.headIndex + 1)) {
    const args = checkpoint.args;
    if (!Array.isArray(args)) continue;

    for (const raw of args) {
      if (!raw || typeof raw !== 'object') continue;
      const spec = raw as Partial<TransformSpec>;
      if (typeof spec.operation !== 'string') continue;

      steps.push({
        operation: spec.operation as TransformOperation,
        column: spec.column ?? null,
        parameters: spec.parameters ?? {},
        description: checkpoint.label,
      });
    }
  }

  // The time the last approved step ran, not the time this was exported.
  //
  // Both are truthful, but the wall clock made every export byte-different from
  // the one before it: the same pipeline exported twice produced two files that
  // differed only in a header comment. That defeats content hashing, and it
  // quietly contradicts the "reproducible" claim the export panel makes. The
  // checkpoint time is also the more useful figure — it says when the work
  // happened rather than when it was copied.
  const head = dataset.history[dataset.headIndex] ?? dataset.history[0];

  return {
    name: name ?? (dataset.name.replace(/\.[^.]+$/, '') || 'pipeline'),
    version: PIPELINE_VERSION,
    createdAt: head?.createdAt ?? new Date(0).toISOString(),
    requiredColumns: dataset.history[0]?.columns ?? [],
    steps,
  };
}

export interface CompatibilityReport {
  readonly compatible: boolean;
  /** 0..1. Fraction of the pipeline's required columns present in the target. */
  readonly score: number;
  readonly missingColumns: readonly string[];
  readonly extraColumns: readonly string[];
  readonly summary: string;
}

/**
 * Judge whether a pipeline can run against a dataset.
 *
 * Missing columns are the only hard blocker: a step naming a column that is not
 * there cannot run. Extra columns are fine and common — a pipeline written for
 * a five-column export should still work on next quarter's seven-column one.
 */
export function checkCompatibility(
  pipeline: Pipeline,
  targetColumns: readonly string[],
): CompatibilityReport {
  // Only columns the steps actually touch need to exist, not every column that
  // happened to be present when the pipeline was recorded.
  const used = new Set(
    pipeline.steps.map((s) => s.column).filter((c): c is string => c !== null),
  );

  const missing = [...used].filter((c) => !targetColumns.includes(c));
  const extra = targetColumns.filter((c) => !pipeline.requiredColumns.includes(c));
  const score = used.size === 0 ? 1 : (used.size - missing.length) / used.size;

  return {
    compatible: missing.length === 0,
    score,
    missingColumns: missing,
    extraColumns: extra,
    summary:
      missing.length === 0
        ? `All ${used.size} column${used.size === 1 ? '' : 's'} this pipeline needs are present.`
        : `Cannot run: ${missing.length} required column${missing.length === 1 ? '' : 's'} ` +
          `missing (${missing.join(', ')}). Rename or map them first.`,
  };
}

/** Steps as the transform compiler expects them. */
export function toSpecs(pipeline: Pipeline): TransformSpec[] {
  return pipeline.steps.map((s) => ({
    operation: s.operation,
    column: s.column,
    parameters: s.parameters,
  }));
}
