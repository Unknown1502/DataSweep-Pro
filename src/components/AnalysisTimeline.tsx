export interface CheckRun {
  check: string;
  start_offset_ms: number;
  duration_ms: number;
  findings: number;
  failed: boolean;
}

export interface Concurrency {
  total_ms: number;
  sum_of_check_ms: number;
  checks: CheckRun[];
}

/**
 * What the analysis actually did, as a timeline.
 *
 * This is the honest version of "multiple agents working in parallel". Eight
 * checks genuinely run concurrently, and the bars are measured start offsets
 * and durations — you can see the overlap rather than take it on faith.
 *
 * What is deliberately *not* claimed: there is no coordination between these
 * checks, no message passing, and no conflict resolution. They are independent
 * by construction, which is precisely why running them concurrently is correct
 * and why coordinating them would add latency and nothing else.
 */
export function AnalysisTimeline({ concurrency }: { concurrency: Concurrency }) {
  const { checks, total_ms, sum_of_check_ms } = concurrency;
  if (checks.length === 0) return null;

  // Guard the divisor: a sub-millisecond batch would otherwise divide by zero
  // and render every bar at infinite width.
  const span = Math.max(total_ms, 1);
  const speedup = total_ms > 0 ? sum_of_check_ms / total_ms : 1;

  return (
    <div className="border-t border-ink-600 px-4 py-3">
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="eyebrow">Concurrent analysis</span>
        <span className="font-mono text-[10px] text-text-lo tabular-nums">
          {checks.length} checks · {sum_of_check_ms}ms of work in {total_ms}ms
          {speedup > 1.2 ? ` · ${speedup.toFixed(1)}× overlap` : ''}
        </span>
      </div>

      <div className="space-y-1">
        {checks.map((run) => {
          const left = (run.start_offset_ms / span) * 100;
          // Sub-millisecond checks still need to be visible.
          const width = Math.max((run.duration_ms / span) * 100, 1.5);

          return (
            <div key={run.check} className="flex items-center gap-2">
              <span className="w-[124px] shrink-0 truncate font-mono text-[10px] text-text-mid">
                {run.check}
              </span>

              <div className="relative h-3 flex-1 rounded-sm bg-ink-900">
                <div
                  className={`absolute top-0 h-full rounded-sm ${
                    run.failed ? 'bg-alarm' : run.findings > 0 ? 'bg-was' : 'bg-calm'
                  }`}
                  style={{ left: `${Math.min(left, 98.5)}%`, width: `${Math.min(width, 100 - left)}%` }}
                  title={`${run.check}: started +${run.start_offset_ms}ms, took ${run.duration_ms}ms`}
                />
              </div>

              <span className="w-[68px] shrink-0 text-right font-mono text-[10px] text-text-lo tabular-nums">
                {run.duration_ms}ms
              </span>
              <span className="w-[64px] shrink-0 text-right font-mono text-[10px] tabular-nums">
                {run.failed ? (
                  <span className="text-alarm">failed</span>
                ) : run.findings > 0 ? (
                  <span className="text-was">
                    {run.findings} found
                  </span>
                ) : (
                  <span className="text-text-lo">clean</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-text-lo">
        These checks are independent, so they run at the same time. They do not coordinate — there
        is nothing to coordinate about, which is why this is safe.
      </p>
    </div>
  );
}
