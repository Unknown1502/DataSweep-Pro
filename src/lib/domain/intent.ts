/**
 * What a pending change intends to do, read out of the dry run that already
 * happened.
 *
 * Every field here is derived from the preview payload — the operation the
 * compiler emitted, the description it wrote, and the row counts the scratch
 * tables actually produced. Nothing is estimated and nothing is narrated.
 *
 * **There is deliberately no risk score.** A "Risk: Medium" badge would be the
 * most persuasive thing on the approval dialog and the only unmeasured thing on
 * it, which is exactly the wrong combination — a number invented to look
 * authoritative next to numbers that were earned. What a reviewer actually
 * needs is what the change *touches*, and that is knowable: whether rows go
 * away, whether a column goes away, whether values are reinterpreted rather
 * than merely reformatted. Those are stated instead, each traceable to a
 * measurement.
 */

export interface IntentStep {
  readonly operation: string;
  readonly column: string | null;
  readonly description: string;
  /** Values the dry run actually changed. */
  readonly rowsAffected: number;
}

export type EffectKind = 'removes_rows' | 'drops_columns' | 'reinterprets' | 'edits_in_place';

export interface ChangeIntent {
  readonly steps: readonly IntentStep[];
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly rowsRemoved: number;
  readonly columnsAdded: readonly string[];
  readonly columnsRemoved: readonly string[];
  /** Values touched across every step. */
  readonly valuesAffected: number;
  readonly caveats: readonly string[];
  readonly effects: readonly EffectKind[];
}

const EFFECT_LABELS: Record<EffectKind, string> = {
  removes_rows: 'Removes rows',
  drops_columns: 'Drops a column',
  reinterprets: 'Reinterprets values, not just their format',
  edits_in_place: 'Edits values in place',
};

export function effectLabel(kind: EffectKind): string {
  return EFFECT_LABELS[kind];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Read a preview payload into an intent.
 *
 * Returns null when the payload is not a transformation preview — undo and join
 * previews carry a different shape, and inventing a shared summary for them
 * would describe something that was not measured.
 */
export function readIntent(details: Readonly<Record<string, unknown>>): ChangeIntent | null {
  const rawSteps = details['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const steps: IntentStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue;
    const step = raw as Record<string, unknown>;
    if (typeof step['operation'] !== 'string') continue;
    steps.push({
      operation: step['operation'],
      column: typeof step['column'] === 'string' ? step['column'] : null,
      description: typeof step['description'] === 'string' ? step['description'] : '',
      rowsAffected: Number(step['rows_affected'] ?? 0),
    });
  }
  if (steps.length === 0) return null;

  const rowsBefore = Number(details['rows_before'] ?? 0);
  const rowsAfter = Number(details['rows_after'] ?? 0);
  const rowsRemoved = Number(details['rows_removed'] ?? Math.max(0, rowsBefore - rowsAfter));

  const before = stringArray(details['columns_before']);
  const after = stringArray(details['columns_after']);
  const columnsAdded = after.filter((c) => !before.includes(c));
  const columnsRemoved = before.filter((c) => !after.includes(c));

  const caveats = stringArray(details['caveats']);

  // Ordered most-consequential first, so the first thing read is the thing
  // most likely to make someone decline.
  const effects: EffectKind[] = [];
  if (rowsRemoved > 0) effects.push('removes_rows');
  if (columnsRemoved.length > 0) effects.push('drops_columns');
  // A caveat is the compiler saying this step resolves an ambiguity — a date
  // ordering, a decimal separator — so the output means something slightly
  // different from the input rather than merely looking different.
  if (caveats.length > 0) effects.push('reinterprets');
  if (effects.length === 0) effects.push('edits_in_place');

  return {
    steps,
    rowsBefore,
    rowsAfter,
    rowsRemoved,
    columnsAdded,
    columnsRemoved,
    valuesAffected: steps.reduce((sum, s) => sum + s.rowsAffected, 0),
    caveats,
    effects,
  };
}
