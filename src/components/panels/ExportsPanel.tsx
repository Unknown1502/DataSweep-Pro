import { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileJson,
  FileText,
  GitBranch,
  GitPullRequest,
  Table2,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { unfence } from '../../lib/domain/injection';
import { GE_TARGET_VERSION } from '../../lib/domain/great-expectations';
import { configuredMode } from '../../lib/integrations/token-vault';
import { callTool } from '../../lib/tools';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Alert, Skeleton } from '../ui/misc';
import { GitHubExportDialog } from './GitHubExportDialog';

interface Format {
  id: string;
  label: string;
  icon: LucideIcon;
  blurb: string;
  language: string;
  /** True when the same input always produces the same output. */
  deterministic: boolean;
}

const FORMATS: readonly Format[] = [
  {
    id: 'sql',
    label: 'SQL',
    icon: Table2,
    blurb: 'Chained CTEs, one per applied step.',
    language: 'sql',
    deterministic: true,
  },
  {
    id: 'python',
    label: 'pandas',
    icon: FileCode2,
    blurb: 'A script that reads as text and applies each step.',
    language: 'python',
    deterministic: true,
  },
  {
    id: 'dbt',
    label: 'dbt',
    icon: FileCode2,
    blurb: 'The same SQL as a model, referencing a source.',
    language: 'sql',
    deterministic: true,
  },
  {
    id: 'json',
    label: 'JSON',
    icon: FileJson,
    blurb: 'Portable pipeline, replayable on another dataset.',
    language: 'json',
    deterministic: true,
  },
  {
    id: 'great_expectations',
    label: 'Expectations',
    icon: ShieldCheck,
    blurb: `A suite guarding future batches. Targets GX ${GE_TARGET_VERSION}.`,
    language: 'json',
    deterministic: true,
  },
  {
    id: 'docs',
    label: 'Documentation',
    icon: FileText,
    blurb: 'Data dictionary and methodology, generated from measured data.',
    language: 'markdown',
    deterministic: true,
  },
];

const EXTENSIONS: Record<string, string> = {
  sql: 'sql',
  python: 'py',
  dbt: 'sql',
  json: 'json',
  great_expectations: 'json',
  docs: 'md',
};

/**
 * Take the work with you.
 *
 * A cleaning session that only exists in one browser tab is a demo. The SQL is
 * produced by the same compiler that executed the steps, so it is the query
 * that ran rather than a reimplementation that could disagree with it.
 */
export function ExportsPanel({ initialFormat = 'sql' }: { initialFormat?: string } = {}) {
  const dataset = useSelectedDataset();
  const [format, setFormat] = useState(initialFormat);
  const [code, setCode] = useState('');
  const [steps, setSteps] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const report = useFindings((s) => (dataset ? s.reports[dataset.id] : undefined));
  const exports = useApp((s) => s.exports);
  const published = dataset ? exports.filter((e) => e.datasetId === dataset.id) : [];
  const mode = configuredMode();

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (format === 'docs') {
          const result = (await callTool('generate_data_documentation', {
            dataset_id: dataset.id,
          })) as { documentation: string };
          if (cancelled) return;
          // The fence is for agents; a person reading the panel wants the doc.
          setCode(unfence(result.documentation));
          setSteps(0);
          return;
        }

        const result = (await callTool('export_transformation_pipeline', {
          dataset_id: dataset.id,
          format,
        })) as { code: string; step_count: number };
        if (cancelled) return;
        setCode(result.code);
        setSteps(result.step_count);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataset, format]);

  if (!dataset) return null;
  const active = FORMATS.find((f) => f.id === format);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function download() {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dataset!.name.replace(/\.[^.]+$/, '')}.${EXTENSIONS[format] ?? 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Derived exactly as the workspace header derives it, so the two cannot
  // disagree about how much of this dataset is quarantined.
  const quarantinedRows = (report?.issues ?? [])
    .filter((i) => i.type === 'injected_content')
    .reduce((sum, i) => sum + i.affected_rows, 0);

  return (
    <div className="space-y-4">
      {/* One destination, on purpose. A field that accepts any URL is a field
          an agent can point anywhere; this one has exactly one shape. */}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-700"
          >
            <GitBranch className="size-4 text-fg-muted" />
          </span>

          <div className="min-w-[220px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-medium text-fg">Publish to a pull request</h3>
              <Badge tone={mode === 'live' ? 'warn' : 'neutral'}>
                {mode === 'live' ? 'live mode' : 'demo mode'}
              </Badge>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
              Opens a branch carrying the SQL, the pandas script, the dbt model, the expectation
              suite, the data dictionary and the transformation ledger — reviewable as a diff.
              {mode === 'demo'
                ? ' Demo mode assembles and hashes everything without making a request.'
                : ' Live mode uses a fine-grained token you supply, held in memory for this tab.'}
            </p>
            <p className="mt-1 text-[12px] text-fg-subtle">
              No raw rows, no quarantined cells. You see the full file list and approve it before
              anything is sent.
            </p>
          </div>

          <Button onClick={() => setPublishing(true)} className="shrink-0">
            <GitPullRequest />
            Export to GitHub
          </Button>
        </CardContent>

        {published.length > 0 && (
          <div className="border-t border-line px-4 py-3">
            <div className="eyebrow mb-2">Published from this dataset</div>
            <ul className="space-y-2">
              {published.map((record) => (
                <li key={record.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                  <span className="font-mono text-[12px] text-fg">{record.destination}</span>
                  {record.receipt.mode === 'live' ? (
                    <a
                      href={record.receipt.pullRequestUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 font-mono text-[12px] text-primary underline underline-offset-2"
                    >
                      #{record.receipt.pullRequestNumber}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="font-mono text-[12px] text-fg-subtle">
                      #{record.receipt.pullRequestNumber} (demo)
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-fg-subtle tabular-nums">
                    {record.manifestHash.slice(0, 12)} · {new Date(record.at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <GitHubExportDialog
        dataset={dataset}
        qualityScore={report?.quality_score ?? null}
        quarantinedRows={quarantinedRows}
        open={publishing}
        onOpenChange={setPublishing}
      />

      <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {FORMATS.map((f) => {
          const Icon = f.icon;
          const selected = f.id === format;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => setFormat(f.id)}
                aria-pressed={selected}
                className={cn(
                  'flex h-full w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
                  selected
                    ? 'border-primary bg-primary-dim'
                    : 'border-line bg-surface-800 hover:border-line-strong hover:bg-surface-700',
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    className={cn('size-4', selected ? 'text-primary' : 'text-fg-subtle')}
                    aria-hidden="true"
                  />
                  <span className="text-[14px] font-medium text-fg">{f.label}</span>
                  {selected && <Check className="ml-auto size-3.5 text-primary" />}
                </span>
                <span className="text-[12px] leading-relaxed text-fg-muted">{f.blurb}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Badge>{active?.language}</Badge>
          {active?.deterministic && <Badge tone="success">reproducible</Badge>}
          <span className="font-mono text-[11px] text-fg-subtle tabular-nums">
            {format === 'docs'
              ? 'generated from measured data'
              : `${steps} applied step${steps === 1 ? '' : 's'} · undone steps excluded`}
          </span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void copy()} disabled={!code}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="outline" size="sm" onClick={download} disabled={!code}>
            <Download />
            Download
          </Button>
        </div>

        <CardContent className="p-4">
          {loading && (
            <div className="space-y-2">
              {['w-2/3', 'w-1/2', 'w-5/6', 'w-1/3', 'w-3/4', 'w-2/5'].map((w, i) => (
                <Skeleton key={i} className={cn('h-3', w)} />
              ))}
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          {!loading && !error && (
            <pre className="grid-scroll max-h-115 overflow-y-auto font-mono text-[11.5px] leading-relaxed whitespace-pre text-fg-muted">
              {code}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
