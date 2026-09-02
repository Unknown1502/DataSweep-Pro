import { useCallback, useState } from 'react';
import { SAMPLES } from '../lib/samples';
import { useApp, useSelectedDataset } from '../store/app-store';
import { QualityPanel } from './QualityPanel';
import { DataPreview } from './DataPreview';
import { ExportPanel } from './ExportPanel';
import { LineageView } from './LineageView';
import { RulesPanel } from './RulesPanel';

export function Workspace() {
  const dataset = useSelectedDataset();
  const actionError = useApp((s) => s.actionError);
  const setActionError = useApp((s) => s.setActionError);
  const [exporting, setExporting] = useState(false);
  const [showLineage, setShowLineage] = useState(false);
  const [showRules, setShowRules] = useState(false);

  if (!dataset) return <EmptyState />;

  const appliedSteps = dataset.headIndex;

  return (
    <div className="mx-auto max-w-[1400px] p-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-display text-[17px] leading-tight font-bold text-text-hi">
            {dataset.name}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-text-lo">
            {appliedSteps === 0
              ? 'no changes applied'
              : `${appliedSteps} step${appliedSteps === 1 ? '' : 's'} applied`}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setShowRules(true)}>
            Rules
          </button>
          <button className="btn" onClick={() => setShowLineage(true)}>
            Lineage
          </button>
          <button className="btn" onClick={() => setExporting(true)}>
            Export
          </button>
        </div>
      </div>

      {exporting && <ExportPanel onClose={() => setExporting(false)} />}
      {showLineage && <LineageView onClose={() => setShowLineage(false)} />}
      {showRules && <RulesPanel onClose={() => setShowRules(false)} />}
      {actionError && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-alarm/40 bg-alarm-dim px-3 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-text-hi">{actionError}</span>
          <button
            className="font-mono text-[10px] text-text-mid hover:text-text-hi"
            onClick={() => setActionError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <QualityPanel />
      <DataPreview />
    </div>
  );
}

/**
 * The empty state is an invitation to act, not an apology for being empty.
 * The two samples are the fastest route to a working demo, and the second one
 * is the security story.
 */
function EmptyState() {
  const uploadFile = useApp((s) => s.uploadFile);
  const loadSample = useApp((s) => s.loadSample);
  const datasets = useApp((s) => s.datasets);
  const select = useApp((s) => s.select);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        await uploadFile(file);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [uploadFile],
  );

  async function sample(id: string) {
    const found = SAMPLES.find((s) => s.id === id);
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      await loadSample(found.name, found.csv);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[820px] px-6 py-14">
      <h1 className="font-display text-[34px] leading-[1.1] font-extrabold tracking-[-0.02em] text-text-hi">
        Clean data with an agent
        <br />
        <span className="text-text-mid">without losing the audit trail.</span>
      </h1>

      <p className="mt-4 max-w-[52ch] text-[13px] leading-relaxed text-text-mid">
        Your file is parsed and queried entirely in this tab. Nothing is uploaded. An AI agent can
        find and fix quality problems through the same tools you use — and every change it proposes
        is previewed, approved by you, and reversible.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`mt-9 rounded-md border border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-now bg-now-dim' : 'border-ink-500 bg-ink-850'
        }`}
      >
        <input
          type="file"
          id="file-input"
          accept=".csv,.tsv,.json,.txt"
          className="sr-only"
          disabled={busy}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <label htmlFor="file-input" className="btn btn-primary cursor-pointer">
          {busy ? 'Loading…' : 'Choose a file'}
        </label>
        <p className="mt-3 font-mono text-[11px] text-text-lo">
          or drop a CSV or JSON here · up to 64 MB
        </p>
      </div>

      {error && (
        <p className="mt-3 rounded-sm border border-alarm/40 bg-alarm-dim px-3 py-2 text-xs text-text-hi">
          {error}
        </p>
      )}

      {datasets.length > 0 && (
        <div className="mt-10">
          <div className="eyebrow mb-3">Already loaded</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {datasets.map((d) => {
              const head = d.history[d.headIndex];
              return (
                <button
                  key={d.id}
                  onClick={() => select(d.id)}
                  className="panel flex items-baseline justify-between gap-3 p-3 text-left transition-colors hover:border-ink-400"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-hi">
                    {d.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-lo tabular-nums">
                    {(head?.rowCount ?? 0).toLocaleString()} rows
                    {d.headIndex > 0 ? ` · ${d.headIndex} step${d.headIndex === 1 ? '' : 's'}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-10">
        <div className="eyebrow mb-3">Or start from a sample</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onClick={() => void sample(s.id)}
              className="panel group p-4 text-left transition-colors hover:border-ink-400 disabled:opacity-50"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-text-hi">{s.label}</span>
                {s.id === 'poisoned-reviews' && (
                  <span className="rounded-sm bg-alarm-dim px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-alarm uppercase">
                    security
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-mid">{s.blurb}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-10 border-t border-ink-600 pt-5">
        <div className="eyebrow mb-2">For agents</div>
        <p className="max-w-[60ch] text-xs leading-relaxed text-text-mid">
          This page publishes its tools on{' '}
          <code className="font-mono text-now">document.modelContext</code>. Connect Claude Code or
          Claude Desktop by running{' '}
          <code className="font-mono text-text-hi">npx @mcp-b/webmcp-local-relay</code>, then start
          with <code className="font-mono text-text-hi">list_datasets</code>. Open the tool
          inspector to see every schema.
        </p>
      </div>
    </div>
  );
}
