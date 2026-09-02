import { AlertTriangle, CheckCircle2, ShieldAlert, Wrench } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Alert, Meter, Skeleton, Stat } from '../ui/misc';
import { ActorBadge } from './ActorBadge';
import { ConcurrencyCard } from './ConcurrencyCard';

export function OverviewPanel() {
  const dataset = useSelectedDataset();
  const activity = useApp((s) => s.activity);
  const setView = useApp((s) => s.setView);
  const { reports, scanning } = useFindings();

  if (!dataset) return null;

  const head = dataset.history[dataset.headIndex];
  const report = reports[dataset.id];
  const busy = scanning === dataset.id;

  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of report?.issues ?? []) counts[issue.severity] += 1;
  const total = counts.high + counts.medium + counts.low;

  const quarantined = (report?.issues ?? [])
    .filter((i) => i.type === 'injected_content')
    .reduce((sum, i) => sum + i.affected_rows, 0);

  const topFix = (report?.issues ?? []).find((i) => i.suggested_fix !== null);
  const recent = activity.slice(-3).reverse();

  const scoreTone =
    !report ? 'default' : report.quality_score >= 85 ? 'success' : report.quality_score >= 60 ? 'warn' : 'danger';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        {/* Quality */}
        <Card>
          <CardContent className="px-4 py-4">
            {busy && !report ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <Stat
                    label="Quality"
                    value={report ? report.quality_score : '—'}
                    suffix={report ? '/100' : undefined}
                    tone={scoreTone}
                  />
                  <Stat label="Rows" value={(head?.rowCount ?? 0).toLocaleString()} />
                  <Stat label="Columns" value={head?.columns.length ?? 0} />
                  <Stat label="Findings" value={report ? report.issues.length : '—'} />
                  <Stat
                    label="Quarantined"
                    value={report ? quarantined : '—'}
                    tone={quarantined > 0 ? 'danger' : 'default'}
                    hint="Rows containing text aimed at an AI agent"
                  />
                  {report?.concurrency && (
                    <Stat
                      label="Last scan"
                      value={report.concurrency.total_ms}
                      suffix="ms"
                      hint="Measured wall-clock for the whole scan"
                    />
                  )}
                </div>

                {report && (
                  <div className="mt-4">
                    <Meter
                      value={report.quality_score}
                      tone={scoreTone === 'default' ? 'primary' : scoreTone}
                      label={`Quality score ${report.quality_score} of 100`}
                    />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Rows lost at load outrank everything else: they are not in the data. */}
        {dataset.skippedRows > 0 && (
          <Alert tone="danger">
            <ShieldAlert />
            <span>
              <strong>{dataset.skippedRows.toLocaleString()} row(s) could not be parsed</strong> and
              were skipped at load. They are not present in this dataset or in any figure above.
            </span>
          </Alert>
        )}

        {/* Findings summary */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-[14px]">Findings</CardTitle>
            {report && report.issues.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setView('findings')}>
                Review findings
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {busy && !report && <Skeleton className="h-10 w-full" />}

            {report && total === 0 && (
              <Alert tone="success">
                <CheckCircle2 />
                <span>{report.summary}</span>
              </Alert>
            )}

            {report && total > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {counts.high > 0 && <Badge tone="danger">{counts.high} high</Badge>}
                  {counts.medium > 0 && <Badge tone="warn">{counts.medium} medium</Badge>}
                  {counts.low > 0 && <Badge>{counts.low} low</Badge>}
                </div>

                {/* Proportional bar. Widths are shares of the real counts. */}
                <div
                  className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-600"
                  role="img"
                  aria-label={`${counts.high} high, ${counts.medium} medium, ${counts.low} low severity findings`}
                >
                  {(
                    [
                      ['high', counts.high, 'bg-danger'],
                      ['medium', counts.medium, 'bg-warn'],
                      ['low', counts.low, 'bg-fg-subtle'],
                    ] as const
                  ).map(([key, n, colour]) =>
                    n === 0 ? null : (
                      <div
                        key={key}
                        className={cn('h-full', colour)}
                        style={{ width: `${(n / total) * 100}%` }}
                      />
                    ),
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* The next action worth taking, drawn from the scan rather than invented. */}
        {topFix?.suggested_fix && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-[14px]">Suggested next change</CardTitle>
              <Badge tone="success">reversible</Badge>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="primary">{topFix.suggested_fix.operation}</Badge>
                {topFix.suggested_fix.column && (
                  <span className="font-mono text-[12px] text-primary">
                    {topFix.suggested_fix.column}
                  </span>
                )}
                <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
                  {topFix.affected_rows.toLocaleString()} rows affected
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-fg-muted">
                {topFix.suggested_fix.rationale}
              </p>
              <Button variant="primary" size="sm" onClick={() => setView('findings')}>
                <Wrench />
                Preview in findings
              </Button>
            </CardContent>
          </Card>
        )}

        {report?.concurrency && <ConcurrencyCard concurrency={report.concurrency} />}
      </div>

      {/* Recent activity */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-[14px]">Recent activity</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setView('ledger')}>
              Ledger
            </Button>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-[13px] text-fg-muted">
                Nothing has run yet. Actions appear here as they happen, with who ran them.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {recent.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2.5">
                    <ActorBadge actor={entry.actor} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-fg-muted">
                        {entry.tool}
                      </div>
                      <div className="font-mono text-[11px] text-fg-subtle tabular-nums">
                        {entry.mutated ? 'changed data · ' : ''}
                        {entry.durationMs}ms
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {quarantined > 0 && (
          <Alert tone="danger">
            <AlertTriangle />
            <span>
              {quarantined} row(s) contain text written to manipulate an AI agent. It is quarantined
              before reaching one — review before sharing this dataset.
            </span>
          </Alert>
        )}
      </div>
    </div>
  );
}
