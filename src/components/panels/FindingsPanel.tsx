import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert, Wrench } from 'lucide-react';
import { unfence } from '../../lib/domain/injection';
import { callTool } from '../../lib/tools';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { SEVERITY_TONE, useFindings, type Finding } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Dialog, DialogContent } from '../ui/dialog';
import { Alert, Skeleton } from '../ui/misc';
import { ApprovalDialog, type PendingChange } from './ApprovalDialog';

/**
 * The findings list.
 *
 * Detail opens in a side sheet rather than expanding inline, so a dataset with
 * twenty findings stays scannable instead of turning into a page you have to
 * scroll past to reach the next one.
 */
export function FindingsPanel() {
  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);
  const { reports, scanning, error, scan, invalidate } = useFindings();

  const [detail, setDetail] = useState<Finding | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  if (!dataset) return null;
  const report = reports[dataset.id];
  const busy = scanning === dataset.id;

  /** Step one of the gate: ask what would change. Nothing is written. */
  async function proposeFix(finding: Finding) {
    if (!dataset || !finding.suggested_fix) return;
    setWorking(finding.id);
    setActionError(null);
    try {
      const args = {
        dataset_id: dataset.id,
        transformations: [
          {
            operation: finding.suggested_fix.operation,
            column: finding.suggested_fix.column,
            parameters: finding.suggested_fix.parameters,
          },
        ],
      };
      const result = (await callTool('apply_cleaning_transformations', args)) as {
        summary: string;
        details: Record<string, unknown>;
        confirmation_token: string;
      };
      setPending({
        args,
        summary: result.summary,
        details: result.details,
        token: result.confirmation_token,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  async function applyPending() {
    if (!dataset || !pending) return;
    setWorking('confirm');
    try {
      await callTool('apply_cleaning_transformations', {
        ...pending.args,
        confirmation_token: pending.token,
      });
      setPending(null);
      setDetail(null);
      invalidate(dataset.id);
      refresh();
      void scan(dataset.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-fg">
          Findings
          {report && (
            <span className="ml-2 font-mono text-[12px] font-normal text-fg-subtle tabular-nums">
              {report.issues.length}
            </span>
          )}
        </h2>
        <Button variant="outline" size="sm" onClick={() => void scan(dataset.id)} disabled={busy}>
          {busy ? 'Scanning…' : 'Re-scan'}
        </Button>
      </div>

      {error && (
        <Alert tone="danger">
          <AlertTriangle />
          <span>{error}</span>
        </Alert>
      )}

      {busy && !report && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {report && report.issues.length === 0 && (
        <Alert tone="success">
          <CheckCircle2 />
          <span>{report.summary}</span>
        </Alert>
      )}

      {report && report.issues.length > 0 && (
        <ul className="space-y-2">
          {report.issues.map((finding) => (
            <li key={finding.id}>
              <FindingRow
                finding={finding}
                busy={working === finding.id}
                disabled={working !== null}
                onExplain={() => setDetail(finding)}
                onFix={() => void proposeFix(finding)}
              />
            </li>
          ))}
        </ul>
      )}

      <FindingSheet finding={detail} onClose={() => setDetail(null)} />

      {pending && (
        <ApprovalDialog
          pending={pending}
          busy={working === 'confirm'}
          onCancel={() => setPending(null)}
          onConfirm={() => void applyPending()}
        />
      )}
    </div>
  );
}

function FindingRow({
  finding,
  busy,
  disabled,
  onExplain,
  onFix,
}: {
  finding: Finding;
  busy: boolean;
  disabled: boolean;
  onExplain: () => void;
  onFix: () => void;
}) {
  const pct = finding.total_rows === 0 ? 0 : (finding.affected_rows / finding.total_rows) * 100;
  const security = finding.type === 'injected_content';
  const noFix = finding.suggested_fix === null;

  return (
    <Card className={security ? 'border-danger-line' : undefined}>
      <CardContent className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SEVERITY_TONE[finding.severity]}>
              {security ? <ShieldAlert /> : null}
              {finding.severity}
            </Badge>
            <span className="font-mono text-[12px] text-fg-muted">{finding.type}</span>
            {finding.column && (
              <span className="font-mono text-[12px] text-primary">{finding.column}</span>
            )}
            <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
              {finding.affected_rows.toLocaleString()} rows · {pct.toFixed(pct < 10 ? 1 : 0)}%
            </span>
          </div>

          <p className="mt-1.5 text-[13px] leading-relaxed text-fg">{finding.description}</p>

          {noFix && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-warn-line bg-warn-dim px-2 py-1 text-[12px] text-fg">
              <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
              No automatic fix — needs human review
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={onExplain}>
            <HelpCircle />
            Why?
          </Button>
          {finding.suggested_fix && (
            <Button variant="primary" size="sm" onClick={onFix} disabled={disabled}>
              <Wrench />
              {busy ? 'Checking…' : 'Preview fix'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The deterministic explanation the application already computes. */
function FindingSheet({ finding, onClose }: { finding: Finding | null; onClose: () => void }) {
  return (
    <Dialog open={finding !== null} onOpenChange={(open) => !open && onClose()}>
      {finding && (
        <DialogContent
          side="right"
          title="Why this finding"
          description={`${finding.type}${finding.column ? ` · ${finding.column}` : ''}`}
        >
          <div className="space-y-4 p-4">
            <section>
              <div className="eyebrow mb-1.5">What was measured</div>
              <p className="font-mono text-[12px] leading-relaxed text-fg-muted">
                {finding.reasoning?.measurement ?? finding.description}
              </p>
            </section>

            {finding.reasoning?.severity_calculation && (
              <section>
                <div className="eyebrow mb-1.5">How it was graded</div>
                <p className="font-mono text-[12px] leading-relaxed text-fg-muted">
                  {finding.reasoning.severity_calculation}
                </p>
              </section>
            )}

            {finding.evidence && (
              <section>
                <div className="eyebrow mb-1.5">Evidence</div>
                <pre className="grid-scroll rounded-md border border-line bg-shell-900 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted">
                  {unfence(finding.evidence)}
                </pre>
              </section>
            )}

            <section>
              <div className="eyebrow mb-1.5">
                {finding.suggested_fix ? 'Suggested action' : 'Why no automatic fix'}
              </div>
              {finding.suggested_fix ? (
                <p className="text-[13px] leading-relaxed text-fg-muted">
                  {finding.suggested_fix.rationale}
                </p>
              ) : (
                <Alert tone="warn">
                  <AlertTriangle />
                  <span>
                    {finding.reasoning?.why_no_fix ??
                      'No automatic fix is offered. Applying one would require a judgement the ' +
                        'data cannot settle, and guessing risks silent corruption.'}
                  </span>
                </Alert>
              )}
            </section>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
