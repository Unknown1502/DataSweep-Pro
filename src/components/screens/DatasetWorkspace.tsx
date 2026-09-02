import { useEffect } from 'react';
import { AlertTriangle, Redo2, ShieldAlert, Undo2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Hint, Separator } from '../ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Alert } from '../ui/misc';
import { useApp, useSelectedDataset, type WorkspaceView } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { useTimeTravel } from '../../hooks/useTimeTravel';
import { WORKSPACE_TABS } from '../shell/navigation';
import { OverviewPanel } from '../panels/OverviewPanel';
import { FindingsPanel } from '../panels/FindingsPanel';
import { DataPreview } from '../panels/DataPanel';
import { LedgerPanel } from '../panels/LedgerPanel';
import { LineagePanel } from '../panels/LineagePanel';
import { RulesPanel } from '../panels/RulesPanel';
import { ExportsPanel } from '../panels/ExportsPanel';

/**
 * The dataset workspace.
 *
 * Panes are tabs rather than a single scrolling column: showing findings,
 * data, ledger, lineage, rules and exports at once produced a page you had to
 * scroll past to reach anything.
 */
export function DatasetWorkspace() {
  const dataset = useSelectedDataset();
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const actionError = useApp((s) => s.actionError);
  const setActionError = useApp((s) => s.setActionError);
  const { reports, scanning, scan } = useFindings();
  const { step, canUndo, canRedo } = useTimeTravel();

  const datasetId = dataset?.id ?? null;

  // Scan as soon as a dataset appears, rather than waiting to be asked.
  useEffect(() => {
    if (!datasetId) return;
    const { reports: current, scanning: busy } = useFindings.getState();
    if (current[datasetId] || busy === datasetId) return;
    void scan(datasetId);
  }, [datasetId, scan]);

  if (!dataset) return null;

  const head = dataset.history[dataset.headIndex];
  const report = reports[dataset.id];
  const busy = scanning === dataset.id;
  const isJson = dataset.name.toLowerCase().endsWith('.json');

  const quarantined = (report?.issues ?? [])
    .filter((i) => i.type === 'injected_content')
    .reduce((sum, i) => sum + i.affected_rows, 0);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1320px] flex-col px-5 py-4">
      {/* Dataset header */}
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[20px] leading-tight font-bold text-fg">
            {dataset.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>{isJson ? 'JSON' : 'CSV'}</Badge>
            <Badge>{(head?.rowCount ?? 0).toLocaleString()} rows</Badge>
            <Badge>{head?.columns.length ?? 0} columns</Badge>
            {report && (
              <Badge
                tone={
                  report.quality_score >= 85
                    ? 'success'
                    : report.quality_score >= 60
                      ? 'warn'
                      : 'danger'
                }
              >
                quality {report.quality_score}/100
              </Badge>
            )}
            {busy && <Badge tone="primary">scanning…</Badge>}
            {quarantined > 0 ? (
              <Badge tone="danger">
                <ShieldAlert />
                {quarantined} quarantined
              </Badge>
            ) : report ? (
              <Badge tone="success">no injected content</Badge>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Hint label={canUndo ? 'Undo — Ctrl/Cmd+Z' : 'Nothing to undo'}>
            {/* A disabled button swallows pointer events, so the tooltip needs
                a wrapper that still receives them. */}
            <span>
              <Button
                variant="outline"
                size="icon"
                disabled={!canUndo}
                onClick={() => void step(-1)}
                aria-label="Undo"
              >
                <Undo2 />
              </Button>
            </span>
          </Hint>
          <Hint label={canRedo ? 'Redo — Ctrl/Cmd+Shift+Z' : 'Nothing to redo'}>
            <span>
              <Button
                variant="outline"
                size="icon"
                disabled={!canRedo}
                onClick={() => void step(1)}
                aria-label="Redo"
              >
                <Redo2 />
              </Button>
            </span>
          </Hint>
          <Separator orientation="vertical" className="mx-1 h-6" />
          <Button variant="primary" size="sm" onClick={() => setView('exports')}>
            Export
          </Button>
        </div>
      </header>

      {actionError && (
        <Alert tone="danger" className="mb-3">
          <AlertTriangle />
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            className="font-mono text-[11px] text-fg-subtle hover:text-fg"
            onClick={() => setActionError(null)}
          >
            dismiss
          </button>
        </Alert>
      )}

      <Tabs
        value={view}
        onValueChange={(v) => setView(v as WorkspaceView)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList>
          {WORKSPACE_TABS.map((tab) => {
            const Icon = tab.icon;
            const count =
              tab.id === 'findings' && report ? report.issues.length : undefined;
            return (
              <TabsTrigger key={tab.id} value={tab.id}>
                <Icon />
                {tab.label}
                {count !== undefined && count > 0 && (
                  <span className="ml-0.5 font-mono text-[10px] text-fg-subtle tabular-nums">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto pt-4">
          <TabsContent value="overview">
            <OverviewPanel />
          </TabsContent>
          <TabsContent value="findings">
            <FindingsPanel />
          </TabsContent>
          <TabsContent value="data">
            <DataPreview />
          </TabsContent>
          <TabsContent value="ledger">
            <LedgerPanel />
          </TabsContent>
          <TabsContent value="lineage">
            <LineagePanel />
          </TabsContent>
          <TabsContent value="rules">
            <RulesPanel />
          </TabsContent>
          <TabsContent value="exports">
            <ExportsPanel />
          </TabsContent>
          <TabsContent value="docs">
            <ExportsPanel initialFormat="docs" />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
