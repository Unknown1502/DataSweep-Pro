import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  FileSpreadsheet,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { SAMPLES } from '../../lib/samples';
import { useApp } from '../../store/app-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Dialog, DialogContent } from '../ui/dialog';
import { Alert } from '../ui/misc';
import type { Dataset } from '../../lib/engine/registry';

/**
 * The workspace hub.
 *
 * This replaces a landing-page hero. Once the application has loaded it should
 * read as a tool with work in it, not as a product page: what is open, what to
 * do next, and how to add more.
 */
export function FilesScreen() {
  const uploadFile = useApp((s) => s.uploadFile);
  const loadSample = useApp((s) => s.loadSample);
  const datasets = useApp((s) => s.datasets);
  const select = useApp((s) => s.select);
  const removeDataset = useApp((s) => s.removeDataset);
  const actionError = useApp((s) => s.actionError);
  const setActionError = useApp((s) => s.setActionError);

  /** The dataset the user asked to remove, held until they confirm. */
  const [pendingRemoval, setPendingRemoval] = useState<Dataset | null>(null);

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
    <div className="mx-auto w-full max-w-[1280px] px-5 py-6">
      <header className="mb-6">
        <div className="eyebrow">Workspace</div>
        <h1 className="mt-1 font-display text-[26px] leading-tight font-bold tracking-tight text-fg">
          Your data, under control.
        </h1>
        <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-fg-muted">
          Files are parsed and queried in this tab and never uploaded. An agent can inspect and
          clean them through structured tools, and every change it proposes is previewed, approved
          by you, and reversible.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {/* Upload */}
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
            className={cn(
              'rounded-lg border border-dashed px-6 py-8 text-center transition-colors',
              dragging
                ? 'border-primary bg-primary-dim'
                : 'border-line-strong bg-surface-800 hover:border-line-strong',
            )}
          >
            <Upload
              className={cn('mx-auto size-6', dragging ? 'text-primary' : 'text-fg-subtle')}
              aria-hidden="true"
            />
            <p className="mt-3 text-[15px] font-medium text-fg">Drop a CSV or JSON here</p>
            <p className="mt-1 text-[13px] text-fg-muted">or pick one from your machine</p>

            <input
              type="file"
              id="file-input"
              accept=".csv,.tsv,.json,.txt"
              className="sr-only"
              disabled={busy}
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button asChild variant="primary" size="lg">
                <label htmlFor="file-input" className="cursor-pointer">
                  {busy ? 'Loading…' : 'Choose a file'}
                </label>
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={() => void sample('messy-sales')}
              >
                Use sample dataset
              </Button>
            </div>

            <p className="mt-3 font-mono text-[11px] text-fg-subtle">
              CSV, TSV or JSON · up to 64 MB · stays on this device
            </p>
          </div>

          {error && (
            <Alert tone="danger">
              <AlertTriangle />
              <span>{error}</span>
            </Alert>
          )}

          {actionError && (
            <Alert tone="danger">
              <AlertTriangle />
              <span>{actionError}</span>
            </Alert>
          )}

          {/* Open datasets — the main content of this screen. */}
          <section aria-labelledby="open-datasets">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 id="open-datasets" className="text-[15px] font-semibold text-fg">
                Open datasets
              </h2>
              <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
                {datasets.length} loaded
              </span>
            </div>

            {datasets.length === 0 ? (
              <Card>
                <CardContent className="px-4 py-6">
                  <p className="text-[13px] text-fg-muted">
                    Nothing loaded yet. Add a file above, or start from the sample to see the whole
                    workflow in about a minute.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <ul className="grid gap-2.5 sm:grid-cols-2">
                {datasets.map((d) => {
                  const head = d.history[d.headIndex];
                  const isJson = d.name.toLowerCase().endsWith('.json');
                  return (
                    <li
                      key={d.id}
                      className="group relative rounded-lg border border-line bg-surface-800 transition-colors focus-within:border-line-strong hover:border-line-strong hover:bg-surface-700"
                    >
                      {/* The open action is a button and the remove action is a
                          sibling of it, not a child: a button inside a button is
                          invalid and the inner one is unreachable by keyboard. */}
                      <button
                        type="button"
                        onClick={() => select(d.id)}
                        className="w-full p-3.5 text-left"
                      >
                        <div className="flex items-start gap-2.5">
                          <FileSpreadsheet
                            className="mt-0.5 size-4 shrink-0 text-fg-subtle"
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate pr-7 text-[14px] font-medium text-fg">
                              {d.name}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <Badge>{isJson ? 'JSON' : 'CSV'}</Badge>
                              <Badge>
                                {(head?.rowCount ?? 0).toLocaleString()} rows
                              </Badge>
                              <Badge>{head?.columns.length ?? 0} cols</Badge>
                              {d.headIndex > 0 && (
                                <Badge tone="primary">
                                  {d.headIndex} step{d.headIndex === 1 ? '' : 's'}
                                </Badge>
                              )}
                              {d.skippedRows > 0 && (
                                <Badge tone="danger">
                                  <ShieldAlert />
                                  {d.skippedRows} skipped
                                </Badge>
                              )}
                            </div>
                          </div>
                          <ArrowRight
                            className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-colors group-hover:text-primary"
                            aria-hidden="true"
                          />
                        </div>
                      </button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setActionError(null);
                          setPendingRemoval(d);
                        }}
                        aria-label={`Remove ${d.name}`}
                        className="absolute top-2 right-2 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Samples */}
          <section aria-labelledby="samples">
            <h2 id="samples" className="mb-2.5 text-[15px] font-semibold text-fg">
              Sample data
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void sample(s.id)}
                  className="rounded-lg border border-line bg-surface-800 p-3.5 text-left transition-colors hover:border-line-strong hover:bg-surface-700 disabled:opacity-50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[14px] font-medium text-fg">{s.label}</span>
                    {s.id === 'poisoned-reviews' && (
                      <Badge tone="danger">
                        <ShieldAlert />
                        security
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{s.blurb}</p>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Start here */}
        <aside className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">Start here</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2.5">
                {[
                  ['Choose a dataset', 'It is scanned automatically, on device.'],
                  ['Review findings', 'Each one shows the measurement behind it.'],
                  ['Approve safe changes', 'Nothing is written until you say so.'],
                  ['Export reproducibly', 'SQL, pandas, dbt or a validation suite.'],
                ].map(([title, detail], i) => (
                  <li key={title} className="flex gap-2.5">
                    <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[10px] text-fg-subtle tabular-nums">
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-fg">{title}</span>
                      <span className="block text-[12px] leading-relaxed text-fg-muted">
                        {detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">For agents</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-[12px] leading-relaxed text-fg-muted">
                This page publishes its tools on{' '}
                <code className="font-mono text-primary">document.modelContext</code>. Bridge them
                to a desktop client with{' '}
                <code className="font-mono text-fg">npx @mcp-b/webmcp-local-relay</code>, then start
                with <code className="font-mono text-fg">list_datasets</code>.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Removal is confirmed, and the confirmation says what is actually lost.
          "Are you sure?" tells the user nothing they did not already know. */}
      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <DialogContent
          title="Remove this dataset?"
          className="max-w-[420px]"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingRemoval(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = pendingRemoval;
                  setPendingRemoval(null);
                  if (target) void removeDataset(target.id);
                }}
              >
                <Trash2 />
                Remove
              </Button>
            </div>
          }
        >
          <div className="space-y-3 p-4">
            <p className="text-[13px] leading-relaxed text-fg">
              <span className="font-medium">{pendingRemoval?.name}</span> and its{' '}
              {pendingRemoval?.history.length ?? 0} checkpoint
              {(pendingRemoval?.history.length ?? 0) === 1 ? '' : 's'} will be dropped from this
              tab.
            </p>
            <p className="text-[12px] leading-relaxed text-fg-muted">
              {(pendingRemoval?.headIndex ?? 0) > 0
                ? `The ${pendingRemoval?.headIndex} applied step(s) go with it, so export the pipeline first if you want to keep it. `
                : ''}
              Your original file on disk is untouched — nothing was ever uploaded. Loading it again
              starts fresh.
            </p>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
