import { useCallback, useEffect, useState } from 'react';
import { unfence } from '../lib/domain/injection';
import type { RuleType } from '../lib/domain/rules';
import { isPersistenceAvailable, removeRule } from '../lib/rules-store';
import { callTool } from '../lib/tools';
import { useSelectedDataset } from '../store/app-store';

interface RuleResult {
  rule_id: string;
  name: string;
  column: string;
  severity: string;
  applicable: boolean;
  reason?: string;
  description?: string;
  violations?: number;
  passed?: boolean;
  examples?: string | null;
}

const TYPES: { id: RuleType; label: string; hint: string }[] = [
  { id: 'not_null', label: 'Never empty', hint: 'Every row must have a value' },
  { id: 'unique', label: 'No duplicates', hint: 'Values must not repeat' },
  { id: 'regex', label: 'Matches pattern', hint: 'RE2 regular expression' },
  { id: 'range', label: 'Within range', hint: 'Numeric bounds' },
  { id: 'in_set', label: 'One of', hint: 'Comma-separated allowed values' },
];

/**
 * User-defined rules.
 *
 * The storage caveat is stated in the panel rather than buried in docs: these
 * rules live in this browser. Someone who believes their team can see a rule
 * they wrote, and is wrong, is worse off than someone who knows there is no
 * sharing at all.
 */
export function RulesPanel({ onClose }: { onClose: () => void }) {
  const dataset = useSelectedDataset();
  const [results, setResults] = useState<RuleResult[]>([]);
  const [storageNote, setStorageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [column, setColumn] = useState('');
  const [type, setType] = useState<RuleType>('not_null');
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [values, setValues] = useState('');

  const head = dataset?.history[dataset.headIndex];

  const evaluate = useCallback(async () => {
    if (!dataset) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await callTool('evaluate_quality_rules', { dataset_id: dataset.id })) as {
        results: RuleResult[];
        storage: string;
      };
      setResults(result.results);
      setStorageNote(result.storage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [dataset]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  useEffect(() => {
    if (!column && head?.columns[0]) setColumn(head.columns[0]);
  }, [column, head]);

  async function create() {
    if (!dataset || !column) return;
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {};
      if (type === 'regex') params['pattern'] = pattern;
      if (type === 'range') {
        if (min.trim()) params['min'] = Number(min);
        if (max.trim()) params['max'] = Number(max);
      }
      if (type === 'in_set') {
        params['values'] = values
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      }

      await callTool('create_quality_rule', {
        dataset_id: dataset.id,
        name: name.trim() || `${column} ${type}`,
        column,
        type,
        params,
      });

      setName('');
      setPattern('');
      setMin('');
      setMax('');
      setValues('');
      await evaluate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function drop(id: string) {
    removeRule(id);
    void evaluate();
  }

  if (!dataset) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-6"
      onClick={onClose}
    >
      <div
        className="panel flex h-[min(720px,88vh)] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <div>
            <div className="eyebrow">Quality rules</div>
            <p className="mt-0.5 font-mono text-[10px] text-text-lo">
              {isPersistenceAvailable()
                ? 'Saved in this browser only — not shared with a team.'
                : 'Browser storage unavailable; rules will not survive a reload.'}
            </p>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Rule builder */}
        <div className="border-b border-ink-600 px-4 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="eyebrow">Column</span>
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                className="rounded-sm border border-ink-500 bg-ink-700 px-2 py-1 font-mono text-[11px] text-text-hi"
              >
                {(head?.columns ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="eyebrow">Must</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as RuleType)}
                className="rounded-sm border border-ink-500 bg-ink-700 px-2 py-1 text-[11px] text-text-hi"
              >
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            {type === 'regex' && (
              <label className="flex flex-1 flex-col gap-1">
                <span className="eyebrow">Pattern</span>
                <input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="^[A-Z]{2}-[0-9]+$"
                  className="w-full rounded-sm border border-ink-500 bg-ink-900 px-2 py-1 font-mono text-[11px] text-text-hi placeholder:text-text-lo"
                />
              </label>
            )}

            {type === 'range' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="eyebrow">Min</span>
                  <input
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                    className="w-20 rounded-sm border border-ink-500 bg-ink-900 px-2 py-1 font-mono text-[11px] text-text-hi"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="eyebrow">Max</span>
                  <input
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    className="w-20 rounded-sm border border-ink-500 bg-ink-900 px-2 py-1 font-mono text-[11px] text-text-hi"
                  />
                </label>
              </>
            )}

            {type === 'in_set' && (
              <label className="flex flex-1 flex-col gap-1">
                <span className="eyebrow">Allowed values</span>
                <input
                  value={values}
                  onChange={(e) => setValues(e.target.value)}
                  placeholder="shipped, pending, cancelled"
                  className="w-full rounded-sm border border-ink-500 bg-ink-900 px-2 py-1 font-mono text-[11px] text-text-hi placeholder:text-text-lo"
                />
              </label>
            )}

            <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
              Add rule
            </button>
          </div>

          <p className="mt-2 text-[10px] text-text-lo">
            {TYPES.find((t) => t.id === type)?.hint}. There is no free-form SQL rule type: accepting
            arbitrary SQL would reopen the injection surface the rest of the app closes.
          </p>
        </div>

        {error && (
          <p className="border-b border-ink-600 px-4 py-2 text-xs text-alarm">{error}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {results.length === 0 && !busy && (
            <p className="px-4 py-6 text-xs text-text-lo">
              No rules yet. Add one above to check it against this dataset immediately.
            </p>
          )}

          <ul className="divide-y divide-ink-600">
            {results.map((rule) => (
              <li key={rule.rule_id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                      !rule.applicable ? 'bg-ink-400' : rule.passed ? 'bg-calm' : 'bg-alarm'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs text-text-hi">{rule.name}</span>
                      <span className="font-mono text-[10px] text-now">{rule.column}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-text-mid">
                      {rule.applicable
                        ? `${rule.description} — ${
                            rule.passed
                              ? 'passing'
                              : `${(rule.violations ?? 0).toLocaleString()} violation(s)`
                          }`
                        : rule.reason}
                    </p>
                    {/*
                      A not_null rule's offending values are empty by
                      definition, so there is nothing to show. Rendering the
                      box anyway leaves an empty frame that reads as a bug.
                    */}
                    {rule.examples && unfence(rule.examples).trim().length > 0 && (
                      <pre className="mt-1.5 overflow-x-auto rounded-sm border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[10px] whitespace-pre-wrap text-text-mid">
                        {unfence(rule.examples)}
                      </pre>
                    )}
                  </div>
                  <button
                    className="shrink-0 font-mono text-[10px] text-text-lo hover:text-alarm"
                    onClick={() => drop(rule.rule_id)}
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {storageNote && (
          <div className="border-t border-ink-600 px-4 py-2">
            <span className="font-mono text-[10px] text-text-lo">{storageNote}</span>
          </div>
        )}
      </div>
    </div>
  );
}
