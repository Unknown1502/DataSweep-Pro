import { useState } from 'react';
import { unfence } from '../lib/domain/injection';
import { callTool } from '../lib/tools';
import { useApp, useSelectedDataset } from '../store/app-store';

interface ToolIssue {
  id: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  column: string | null;
  description: string;
  affected_rows: number;
  total_rows: number;
  evidence: string | null;
  suggested_fix: {
    operation: string;
    column: string | null;
    parameters: Record<string, unknown>;
    rationale: string;
  } | null;
}

interface ToolReport {
  quality_score: number;
  summary: string;
  issues: ToolIssue[];
}

const SEVERITY_STYLE: Record<string, string> = {
  high: 'text-alarm border-alarm/40 bg-alarm-dim',
  medium: 'text-was border-was/40 bg-was-dim',
  low: 'text-text-mid border-ink-500 bg-ink-700',
};

export function QualityPanel() {
  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);

  const [report, setReport] = useState<ToolReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    issue: ToolIssue;
    summary: string;
    details: Record<string, unknown>;
    token: string;
  } | null>(null);

  if (!dataset) return null;
  const head = dataset.history[dataset.headIndex];

  async function analyze() {
    if (!dataset) return;
    setAnalyzing(true);
    setActionError(null);
    try {
      // The identical tool an agent calls, so the run appears in the ledger.
      const result = (await callTool('detect_data_quality_issues', {
        dataset_id: dataset.id,
      })) as ToolReport;
      setReport(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  }

  /** Step one of the gate: ask the tool what it would do. Nothing changes. */
  async function proposeFix(issue: ToolIssue) {
    if (!dataset || !issue.suggested_fix) return;
    setApplying(issue.id);
    setActionError(null);
    try {
      const result = (await callTool('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [
          {
            operation: issue.suggested_fix.operation,
            column: issue.suggested_fix.column,
            parameters: issue.suggested_fix.parameters,
          },
        ],
      })) as { summary: string; details: Record<string, unknown>; confirmation_token: string };

      setConfirming({
        issue,
        summary: result.summary,
        details: result.details,
        token: result.confirmation_token,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(null);
    }
  }

  /** Step two: the user has read the preview and approved it. */
  async function confirmFix() {
    if (!dataset || !confirming?.issue.suggested_fix) return;
    const { issue, token } = confirming;
    setApplying(issue.id);
    try {
      await callTool('apply_cleaning_transformations', {
        dataset_id: dataset.id,
        transformations: [
          {
            operation: issue.suggested_fix!.operation,
            column: issue.suggested_fix!.column,
            parameters: issue.suggested_fix!.parameters,
          },
        ],
        confirmation_token: token,
      });
      setConfirming(null);
      setReport(null);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(null);
    }
  }

  return (
    <section className="mb-5">
      <div className="panel">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-ink-600 px-4 py-3.5">
          <Stat label="Rows" value={(head?.rowCount ?? 0).toLocaleString()} />
          <Stat label="Columns" value={String(head?.columns.length ?? 0)} />
          {report && (
            <>
              <Stat
                label="Quality"
                value={`${report.quality_score}`}
                suffix="/100"
                tone={report.quality_score >= 85 ? 'good' : report.quality_score >= 60 ? 'warn' : 'bad'}
              />
              <Stat label="Issues" value={String(report.issues.length)} />
            </>
          )}

          <div className="flex-1" />

          <button className="btn btn-primary" onClick={() => void analyze()} disabled={analyzing}>
            {analyzing ? 'Scanning…' : report ? 'Re-scan' : 'Scan for issues'}
          </button>
        </div>

        {!report && !analyzing && (
          <p className="px-4 py-6 text-xs text-text-mid">
            Scan checks for missing values, duplicate rows, inconsistent date and number formats,
            stray whitespace, outliers, and text aimed at an AI agent. It only reads — nothing
            changes until you approve a fix.
          </p>
        )}

        {report && report.issues.length === 0 && (
          <p className="px-4 py-6 text-xs text-calm">{report.summary}</p>
        )}

        {report && report.issues.length > 0 && (
          <ul className="divide-y divide-ink-600">
            {report.issues.map((issue) => (
              <li key={issue.id} className="defer-rows px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <span
                    className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] tracking-wider uppercase ${
                      SEVERITY_STYLE[issue.severity]
                    }`}
                  >
                    {issue.severity}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-text-lo">{issue.type}</span>
                      {issue.column && (
                        <span className="font-mono text-[11px] text-now">{issue.column}</span>
                      )}
                    </div>

                    <p className="mt-1 text-xs leading-relaxed text-text-hi">
                      {issue.description}
                    </p>

                    {issue.evidence && (
                      <pre className="mt-2 overflow-x-auto rounded-sm border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-text-mid">
                        {unfence(issue.evidence)}
                      </pre>
                    )}

                    {issue.suggested_fix && (
                      <p className="mt-2 text-[11px] text-text-mid">
                        <span className="text-text-lo">Fix: </span>
                        {issue.suggested_fix.rationale}
                      </p>
                    )}
                  </div>

                  {issue.suggested_fix && (
                    <button
                      className="btn shrink-0"
                      onClick={() => void proposeFix(issue)}
                      disabled={applying !== null}
                    >
                      {applying === issue.id ? 'Checking…' : 'Preview fix'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          summary={confirming.summary}
          details={confirming.details}
          busy={applying !== null}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirmFix()}
        />
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const color =
    tone === 'good' ? 'text-calm' : tone === 'warn' ? 'text-was' : tone === 'bad' ? 'text-alarm' : 'text-text-hi';

  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className={`font-display text-[19px] leading-tight font-bold tabular-nums ${color}`}>
        {value}
        {suffix && <span className="text-[12px] font-normal text-text-lo">{suffix}</span>}
      </div>
    </div>
  );
}

/**
 * The approval gate, made visible.
 *
 * The numbers shown here were measured by actually running the transformation
 * against scratch tables, not estimated — so what the user approves is what
 * they get.
 */
function ConfirmDialog({
  summary,
  details,
  busy,
  onCancel,
  onConfirm,
}: {
  summary: string;
  details: Record<string, unknown>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const caveats = Array.isArray(details['caveats']) ? (details['caveats'] as string[]) : [];
  const before = Number(details['rows_before'] ?? 0);
  const after = Number(details['rows_after'] ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-6">
      <div className="panel w-full max-w-xl">
        <div className="border-b border-ink-600 px-4 py-3">
          <div className="eyebrow">Approve this change</div>
        </div>

        <div className="px-4 py-4">
          <p className="text-[13px] leading-relaxed text-text-hi">{summary}</p>

          <div className="mt-4 flex items-center gap-6">
            <div>
              <div className="eyebrow">Was</div>
              <div className="font-mono text-[15px] text-was tabular-nums">
                {before.toLocaleString()} rows
              </div>
            </div>
            <div className="text-text-lo">&rarr;</div>
            <div>
              <div className="eyebrow">Becomes</div>
              <div className="font-mono text-[15px] text-now tabular-nums">
                {after.toLocaleString()} rows
              </div>
            </div>
          </div>

          {caveats.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {caveats.map((caveat) => (
                <li
                  key={caveat}
                  className="rounded-sm border border-was/40 bg-was-dim px-2.5 py-2 text-[11px] leading-relaxed text-text-hi"
                >
                  {caveat}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-ink-600 px-4 py-3">
          <span className="font-mono text-[10px] text-text-lo">
            Reversible from the ledger afterwards
          </span>
          <div className="flex gap-2">
            <button className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Applying…' : 'Apply change'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
