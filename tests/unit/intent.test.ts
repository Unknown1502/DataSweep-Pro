import { describe, expect, it } from 'vitest';
import { effectLabel, readIntent } from '../../src/lib/domain/intent';

const PREVIEW = {
  rows_before: 21,
  rows_after: 20,
  rows_removed: 1,
  columns_before: ['id', 'order_date', 'amount'],
  columns_after: ['id', 'order_date', 'amount'],
  steps: [
    {
      operation: 'standardize_dates',
      column: 'order_date',
      description: 'Converts all 3 formats to ISO YYYY-MM-DD.',
      rows_affected: 5,
      rows_before: 21,
      rows_after: 21,
    },
  ],
};

describe('reading intent from a preview', () => {
  it('reports the steps the compiler emitted', () => {
    const intent = readIntent(PREVIEW)!;
    expect(intent.steps).toHaveLength(1);
    expect(intent.steps[0]).toEqual({
      operation: 'standardize_dates',
      column: 'order_date',
      description: 'Converts all 3 formats to ISO YYYY-MM-DD.',
      rowsAffected: 5,
    });
  });

  it('sums values touched across every step', () => {
    const intent = readIntent({
      ...PREVIEW,
      steps: [
        { operation: 'a', column: 'x', description: '', rows_affected: 5 },
        { operation: 'b', column: 'y', description: '', rows_affected: 12 },
      ],
    })!;
    expect(intent.valuesAffected).toBe(17);
  });

  it('names removing rows as the effect when rows go away', () => {
    const intent = readIntent(PREVIEW)!;
    expect(intent.effects).toContain('removes_rows');
    expect(intent.rowsRemoved).toBe(1);
  });

  it('names dropping a column, and says which one', () => {
    const intent = readIntent({
      ...PREVIEW,
      rows_after: 21,
      rows_removed: 0,
      columns_after: ['id', 'amount'],
    })!;
    expect(intent.effects).toContain('drops_columns');
    expect(intent.columnsRemoved).toEqual(['order_date']);
    expect(intent.columnsAdded).toEqual([]);
  });

  it('reports added columns', () => {
    const intent = readIntent({
      ...PREVIEW,
      rows_after: 21,
      rows_removed: 0,
      columns_after: ['id', 'order_date', 'amount', 'amount_clean'],
    })!;
    expect(intent.columnsAdded).toEqual(['amount_clean']);
  });

  it('treats a caveat as a reinterpretation, because that is what one means', () => {
    const intent = readIntent({
      ...PREVIEW,
      rows_after: 21,
      rows_removed: 0,
      caveats: ['Dates written as D/M/YYYY are assumed.'],
    })!;
    expect(intent.effects).toContain('reinterprets');
    expect(intent.caveats).toHaveLength(1);
  });

  it('falls back to editing in place when nothing is lost or reinterpreted', () => {
    const intent = readIntent({ ...PREVIEW, rows_after: 21, rows_removed: 0 })!;
    expect(intent.effects).toEqual(['edits_in_place']);
  });

  it('orders effects most-consequential first', () => {
    const intent = readIntent({
      ...PREVIEW,
      columns_after: ['id', 'amount'],
      caveats: ['something'],
    })!;
    // A reviewer should meet "removes rows" before "reinterprets values".
    expect(intent.effects).toEqual(['removes_rows', 'drops_columns', 'reinterprets']);
  });

  it('never invents a risk score', () => {
    const intent = readIntent(PREVIEW)!;
    // Every field has to be traceable to a measurement. A risk rating would be
    // the most persuasive thing on the dialog and the only unmeasured one.
    expect(Object.keys(intent).sort()).toEqual(
      [
        'caveats',
        'columnsAdded',
        'columnsRemoved',
        'effects',
        'rowsAfter',
        'rowsBefore',
        'rowsRemoved',
        'steps',
        'valuesAffected',
      ].sort(),
    );
    expect(JSON.stringify(intent)).not.toMatch(/risk|severity|score/i);
  });

  it('returns null for a payload that is not a transformation preview', () => {
    // Undo and join previews carry a different shape; summarizing them with
    // this vocabulary would describe something that was not measured.
    expect(readIntent({ from: { rows: 1 }, to: { rows: 2 } })).toBeNull();
    expect(readIntent({ steps: [] })).toBeNull();
    expect(readIntent({})).toBeNull();
  });

  it('skips malformed steps rather than throwing into the approval dialog', () => {
    const intent = readIntent({
      ...PREVIEW,
      steps: [null, { column: 'x' }, { operation: 'ok', column: 'y', rows_affected: 3 }],
    })!;
    expect(intent.steps).toHaveLength(1);
    expect(intent.steps[0]!.operation).toBe('ok');
    expect(intent.steps[0]!.description).toBe('');
  });

  it('labels every effect it can produce', () => {
    for (const kind of ['removes_rows', 'drops_columns', 'reinterprets', 'edits_in_place'] as const) {
      expect(effectLabel(kind).length).toBeGreaterThan(0);
    }
  });
});
