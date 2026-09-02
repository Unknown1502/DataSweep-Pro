import { cn } from '../../lib/cn';
import type { CheckRun } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

/**
 * Measured execution evidence, not a celebration.
 *
 * The bars are real start offsets and durations. What is deliberately not
 * claimed: these checks do not coordinate. They are independent by
 * construction, which is exactly why running them at once is correct.
 */
export function ConcurrencyCard({
  concurrency,
}: {
  concurrency: { total_ms: number; sum_of_check_ms: number; checks: CheckRun[] };
}) {
  const { checks, total_ms, sum_of_check_ms } = concurrency;
  if (checks.length === 0) return null;

  const span = Math.max(total_ms, 1);
  const overlap = total_ms > 0 ? sum_of_check_ms / total_ms : 1;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-[14px]">Scan execution</CardTitle>
        <Badge>measured locally</Badge>
      </CardHeader>
      <CardContent>
        <p className="mb-3 font-mono text-[11px] text-fg-subtle tabular-nums">
          {checks.length} checks · {sum_of_check_ms}ms of work in {total_ms}ms
          {overlap > 1.2 ? ` · ${overlap.toFixed(1)}x overlap` : ''}
        </p>

        <div className="space-y-1">
          {checks.map((run) => {
            const left = (run.start_offset_ms / span) * 100;
            const width = Math.max((run.duration_ms / span) * 100, 1.5);
            return (
              <div key={run.check} className="flex items-center gap-2">
                <span className="w-[118px] shrink-0 truncate font-mono text-[10px] text-fg-muted">
                  {run.check}
                </span>
                <div className="relative h-2.5 flex-1 rounded-[3px] bg-shell-900">
                  <div
                    className={cn(
                      'absolute top-0 h-full rounded-[3px]',
                      run.failed ? 'bg-danger' : run.findings > 0 ? 'bg-warn' : 'bg-success',
                    )}
                    style={{
                      left: `${Math.min(left, 98.5)}%`,
                      width: `${Math.min(width, 100 - left)}%`,
                    }}
                    title={`${run.check}: started +${run.start_offset_ms}ms, took ${run.duration_ms}ms`}
                  />
                </div>
                <span className="w-[52px] shrink-0 text-right font-mono text-[10px] text-fg-subtle tabular-nums">
                  {run.duration_ms}ms
                </span>
                <span className="w-[58px] shrink-0 text-right font-mono text-[10px] tabular-nums">
                  {run.failed ? (
                    <span className="text-danger">failed</span>
                  ) : run.findings > 0 ? (
                    <span className="text-warn">{run.findings} found</span>
                  ) : (
                    <span className="text-fg-subtle">clean</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
          These checks are independent, so they run at the same time. They do not coordinate —
          there is nothing to coordinate about, which is why this is safe.
        </p>
      </CardContent>
    </Card>
  );
}
