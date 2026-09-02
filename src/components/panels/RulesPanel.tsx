import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import { unfence } from '../../lib/domain/injection';
import type { RuleType } from '../../lib/domain/rules';
import { isPersistenceAvailable, removeRule } from '../../lib/rules-store';
import { callTool } from '../../lib/tools';
import { useSelectedDataset } from '../../store/app-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Alert, Input, Label, Select, Skeleton } from '../ui/misc';

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
 * User-defined validation.
 *
 * The storage caveat is stated in the panel rather than buried in docs: these
 * rules live in this browser. Someone who believes their team can see a rule
 * they wrote, and is wrong, is worse off than someone who knows there is no
 * sharing at all.
 */
export function RulesPanel() {
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

  /**
   * What the chosen rule type still needs, phrased for the person filling the
   * form.
   *
   * This used to be checked only by the engine, which meant "Add rule" was
   * clickable in states where it could not possibly succeed, and the refusal
   * came back as an internal message ("An in_set rule needs a non-empty
   * \"values\" list") rendered in a page-level alert, away from the field that
   * caused it. A control that cannot succeed should not invite the click.
   */
  const missing: string | null =
    type === 'regex' && !pattern.trim()
      ? 'Enter a pattern to match.'
      : type === 'range' && !min.trim() && !max.trim()
        ? 'Enter a minimum, a maximum, or both.'
        : type === 'in_set' &&
            values
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean).length === 0
          ? 'List the allowed values, separated by commas.'
          : null;

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

  const failing = results.filter((r) => r.applicable && r.passed === false).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-[14px]">New rule</CardTitle>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            {isPersistenceAvailable()
              ? 'Saved in this browser only — not shared with a team.'
              : 'Browser storage is unavailable, so rules will not survive a reload.'}
          </p>
        </CardHeader>

        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rule-column">Column</Label>
              <Select
                id="rule-column"
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                className="font-mono"
              >
                {(head?.columns ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="rule-type">Must</Label>
              <Select
                id="rule-type"
                value={type}
                onChange={(e) => setType(e.target.value as RuleType)}
              >
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>

            {type === 'regex' && (
              <div className="flex min-w-55 flex-1 flex-col gap-1">
                <Label htmlFor="rule-pattern">Pattern</Label>
                <Input
                  id="rule-pattern"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="^[A-Z]{2}-[0-9]+$"
                  className="font-mono"
                  aria-describedby={missing ? 'rule-missing' : undefined}
                />
              </div>
            )}

            {type === 'range' && (
              <>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-min">Min</Label>
                  <Input
                    id="rule-min"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                    className="w-24 font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-max">Max</Label>
                  <Input
                    id="rule-max"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    className="w-24 font-mono"
                  />
                </div>
              </>
            )}

            {type === 'in_set' && (
              <div className="flex min-w-55 flex-1 flex-col gap-1">
                <Label htmlFor="rule-values">Allowed values</Label>
                <Input
                  id="rule-values"
                  value={values}
                  onChange={(e) => setValues(e.target.value)}
                  placeholder="shipped, pending, cancelled"
                  className="font-mono"
                  aria-describedby={missing ? 'rule-missing' : undefined}
                />
              </div>
            )}

            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={busy || missing !== null}
              title={missing ?? undefined}
            >
              <Plus />
              Add rule
            </Button>
          </div>

          {/* Sits under the form it belongs to, not in a page-level banner —
              and reads as a requirement rather than an error, because the form
              resets after a successful save and a warning colour there would
              flag the success as a failure. */}
          {missing && (
            <p id="rule-missing" className="mt-2 text-[12px] text-fg-subtle">
              {missing}
            </p>
          )}

          <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
            {TYPES.find((t) => t.id === type)?.hint}. There is deliberately no free-form SQL rule
            type: accepting arbitrary SQL would reopen the injection surface the rest of the
            application closes.
          </p>
        </CardContent>
      </Card>

      {error && (
        <Alert tone="danger">
          <AlertTriangle />
          <span>{error}</span>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-[14px]">
            Rules
            <span className="ml-2 font-mono text-[12px] font-normal text-fg-subtle tabular-nums">
              {results.length}
            </span>
          </CardTitle>
          {failing > 0 && <Badge tone="danger">{failing} failing</Badge>}
        </CardHeader>

        <CardContent>
          {busy && results.length === 0 && <Skeleton className="h-16 w-full" />}

          {!busy && results.length === 0 && (
            <p className="text-[13px] text-fg-muted">
              No rules yet. Add one above to check it against this dataset immediately.
            </p>
          )}

          {results.length > 0 && (
            <ul className="divide-y divide-line">
              {results.map((rule) => (
                <li key={rule.rule_id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  {/* Status is an icon as well as a colour. */}
                  {!rule.applicable ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                  ) : rule.passed ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-medium text-fg">{rule.name}</span>
                      <span className="font-mono text-[11px] text-primary">{rule.column}</span>
                      <Badge
                        tone={
                          rule.severity === 'critical'
                            ? 'danger'
                            : rule.severity === 'warning'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {rule.severity}
                      </Badge>
                    </div>

                    <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                      {rule.applicable
                        ? `${rule.description} — ${
                            rule.passed
                              ? 'passing'
                              : `${(rule.violations ?? 0).toLocaleString()} violation(s)`
                          }`
                        : rule.reason}
                    </p>

                    {/* A not_null rule's offending values are empty by
                        definition, so an empty frame would read as a bug. */}
                    {rule.examples && unfence(rule.examples).trim().length > 0 && (
                      <pre className="grid-scroll mt-2 rounded-sm border border-line bg-shell-900 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
                        {unfence(rule.examples)}
                      </pre>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => drop(rule.rule_id)}
                    aria-label={`Remove rule ${rule.name}`}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {storageNote && (
            <p className="mt-3 border-t border-line pt-2.5 font-mono text-[11px] text-fg-subtle">
              {storageNote}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
