import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  FileJson2,
  FileText,
  GitBranch,
  GitPullRequest,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildGitHubExport } from '../../lib/integrations/build-export';
import {
  exportApprovals,
  publishExport,
  receiptFor,
  type ExportMode,
  type ExportReceipt,
} from '../../lib/integrations/github';
import { branchNameFor, type ArtifactType, type ExportManifest } from '../../lib/integrations/manifest';
import {
  adapterFor,
  configuredMode,
  hasExportToken,
  setExportToken,
} from '../../lib/integrations/token-vault';
import { audit } from '../../lib/tools/context';
import { useApp } from '../../store/app-store';
import type { Dataset } from '../../lib/engine/registry';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Alert, Input, Label } from '../ui/misc';

/**
 * Publishing the cleaning work to a pull request.
 *
 * This is the only place in the application where anything leaves the machine,
 * which is why it is gated more tightly than anything else. Three properties do
 * the work:
 *
 * 1. **The payload is fixed before it is approved.** A manifest is built and
 *    hashed, then shown in full — every path, byte count and content hash — and
 *    the approval is bound to that hash and that destination. Changing either
 *    invalidates it.
 * 2. **What is *not* sent is stated as plainly as what is.** A privacy claim
 *    that only lists inclusions is not checkable.
 * 3. **A retry cannot open a second pull request.** The receipt is cached
 *    against the manifest hash, so an ambiguous network failure resolves to the
 *    original PR rather than a duplicate.
 *
 * No WebMCP tool reaches any of this. An agent can prepare everything an export
 * needs and still cannot start one — this button is the only entry point.
 */

const ICONS: Record<ArtifactType, LucideIcon> = {
  sql: FileCode2,
  dbt: FileCode2,
  python: FileCode2,
  json: FileJson2,
  great_expectations: ShieldCheck,
  documentation: FileText,
};

type Stage = 'configure' | 'preflight' | 'publishing' | 'done' | 'failed';

interface Props {
  dataset: Dataset;
  qualityScore: number | null;
  quarantinedRows: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GitHubExportDialog({
  dataset,
  qualityScore,
  quarantinedRows,
  open,
  onOpenChange,
}: Props) {
  const mode: ExportMode = configuredMode();
  const recordExport = useApp((s) => s.recordExport);

  const [stage, setStage] = useState<Stage>('configure');
  const [owner, setOwner] = useState(mode === 'demo' ? 'your-org' : '');
  const [repo, setRepo] = useState(mode === 'demo' ? 'analytics-pipelines' : '');
  const [token, setToken] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [approval, setApproval] = useState<{ token: string; expiresAt: string } | null>(null);
  const [receipt, setReceipt] = useState<ExportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const branch = useMemo(() => branchNameFor(dataset.name), [dataset.name]);

  // A closed dialog is a spent approval. Carrying a reviewed manifest into the
  // next opening would let a second export inherit the first one's consent.
  useEffect(() => {
    if (open) return;
    setStage('configure');
    setManifest(null);
    setApproval(null);
    setReceipt(null);
    setError(null);
    setAcknowledged(false);
  }, [open]);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'live' && !hasExportToken()) setExportToken(token);

      const built = await buildGitHubExport({
        dataset,
        owner: owner.trim(),
        repo: repo.trim(),
        branch,
        qualityScore,
        quarantinedRows,
      });

      const already = receiptFor(built.manifest);
      if (already) {
        // These exact artifacts already went to this exact destination.
        setManifest(built.manifest);
        setReceipt(already);
        setStage('done');
        return;
      }

      setManifest(built.manifest);
      setTitle((current) => current || built.prTitle);
      setSummary((current) => current || built.prBody);
      setApproval(exportApprovals.issue(built.manifest));
      setStage('preflight');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!manifest || !approval) return;
    setStage('publishing');
    setError(null);

    const startedAt = new Date().toISOString();
    const start = performance.now();
    const destination = `${manifest.destination.owner}/${manifest.destination.repo}`;

    try {
      const issued = await publishExport(
        adapterFor(mode),
        manifest,
        approval.token,
        title.trim() || `DataSweep export: ${dataset.name}`,
        summary,
      );

      setReceipt(issued);
      recordExport(manifest, issued);

      // The same ledger every tool call lands in, so one read answers "what has
      // happened to my data" including the moment part of it left.
      audit.append({
        tool: 'publish_export',
        args: {
          destination,
          branch: manifest.destination.branch,
          manifest_hash: manifest.manifestHash,
          artifacts: manifest.artifacts.length,
          mode: issued.mode,
        },
        outcome: 'ok',
        startedAt,
        durationMs: Math.round(performance.now() - start),
        message: `#${issued.pullRequestNumber} · ${issued.pullRequestUrl}`,
        mutated: false,
        actor: 'human',
      });

      setStage('done');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      audit.append({
        tool: 'publish_export',
        args: { destination, manifest_hash: manifest.manifestHash },
        outcome: 'error',
        startedAt,
        durationMs: Math.round(performance.now() - start),
        message,
        mutated: false,
        actor: 'human',
      });
      setStage('failed');
    }
  }

  const destinationReady =
    owner.trim().length > 0 &&
    repo.trim().length > 0 &&
    (mode === 'demo' || token.trim().length > 0 || hasExportToken());

  const totalBytes = manifest?.artifacts.reduce((sum, a) => sum + a.bytes, 0) ?? 0;

  // Rendered inline rather than as nested components: a component defined in
  // this body is a new type on every render, so React would unmount and remount
  // the inputs and the field being typed into would lose focus each keystroke.
  let footer: React.ReactNode;
  if (stage === 'done') {
    footer = (
      <div className="flex justify-end">
        <Button onClick={() => onOpenChange(false)}>Close</Button>
      </div>
    );
  } else if (stage === 'failed') {
    footer = (
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button onClick={() => setStage('configure')}>Start over</Button>
      </div>
    );
  } else if (stage === 'preflight') {
    footer = (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => setStage('configure')}>
          Back
        </Button>
        <Button onClick={() => void publish()} disabled={!acknowledged}>
          <GitPullRequest />
          {mode === 'demo' ? 'Create pull request (demo)' : 'Create pull request'}
        </Button>
      </div>
    );
  } else {
    footer = (
      <div className="flex justify-end">
        <Button
          onClick={() => void review()}
          disabled={!destinationReady || busy || stage === 'publishing'}
        >
          <ShieldCheck />
          {busy ? 'Assembling files...' : 'Review what will be sent'}
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Publish to GitHub"
        description={
          mode === 'demo'
            ? 'Demo mode. Every step below runs for real except the request itself.'
            : 'Live mode. This opens a real pull request on a repository you control.'
        }
        className="max-w-160"
        footer={footer}
      >
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={mode === 'live' ? 'warn' : 'neutral'}>
              <GitBranch />
              {mode === 'live' ? 'live mode' : 'demo mode'}
            </Badge>
            {mode === 'demo' && (
              <span className="text-[12px] text-fg-muted">No network request is made.</span>
            )}
          </div>

          {/* --- Configure ------------------------------------------------- */}
          {stage === 'configure' && (
            <div className="space-y-3.5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="gh-owner">Owner</Label>
                  <Input
                    id="gh-owner"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="your-org"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="gh-repo">Repository</Label>
                  <Input
                    id="gh-repo"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="analytics-pipelines"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="gh-branch">Branch</Label>
                <Input
                  id="gh-branch"
                  value={branch}
                  readOnly
                  aria-describedby="gh-branch-note"
                  className="mt-1 font-mono text-[12px] text-fg-muted"
                />
                <p id="gh-branch-note" className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                  Generated from the dataset name and today's date, then validated as a git ref.
                  Not editable: a branch name is a path, and this one is built rather than typed.
                </p>
              </div>

              {mode === 'live' && (
                <div>
                  <Label htmlFor="gh-token">Fine-grained access token</Label>
                  <Input
                    id="gh-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="github_pat_..."
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 font-mono"
                  />
                  <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                    Needs <span className="font-mono text-fg">Contents: read and write</span> and{' '}
                    <span className="font-mono text-fg">Pull requests: read and write</span>,
                    scoped to this repository only. Held in memory for this tab: never written to
                    storage, never placed in a tool argument, and gone when you reload.
                  </p>
                </div>
              )}

              <Alert tone="neutral">
                <ShieldCheck />
                <span>
                  Nothing is sent yet. The next step assembles the files, hashes them, and shows
                  you exactly what would go — including what would not.
                </span>
              </Alert>

              {error && (
                <Alert tone="danger">
                  <AlertTriangle />
                  {error}
                </Alert>
              )}
            </div>
          )}

          {/* --- Preflight ------------------------------------------------- */}
          {stage === 'preflight' && manifest && (
            <div className="space-y-4">
              <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[110px_minmax(0,1fr)]">
                <dt className="text-fg-subtle">Repository</dt>
                <dd className="font-mono text-fg">
                  {manifest.destination.owner}/{manifest.destination.repo}
                </dd>
                <dt className="text-fg-subtle">Branch</dt>
                <dd className="font-mono text-fg">{manifest.destination.branch}</dd>
                <dt className="text-fg-subtle">Manifest</dt>
                <dd className="font-mono text-[11px] break-all text-fg-muted">
                  {manifest.manifestHash}
                </dd>
              </dl>

              <div>
                <div className="eyebrow mb-2">
                  Will send · {manifest.artifacts.length} files · {totalBytes.toLocaleString()} B
                </div>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {manifest.artifacts.map((artifact) => {
                    const Icon = ICONS[artifact.type];
                    return (
                      <li key={artifact.path} className="flex items-center gap-2.5 px-3 py-2">
                        <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                          {artifact.path}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-fg-subtle tabular-nums">
                          {artifact.bytes.toLocaleString()} B · {artifact.sha256.slice(0, 8)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div>
                <div className="eyebrow mb-2">Will not send</div>
                <ul className="space-y-2 rounded-md border border-line bg-surface-700 px-3 py-2.5 text-[13px] leading-relaxed text-fg-muted">
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="mt-0.5 size-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="text-fg">Raw dataset rows.</span> No artifact contains cell
                      values — every export describes transformations, not data.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="mt-0.5 size-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="text-fg">Quarantined cells.</span>{' '}
                      {quarantinedRows > 0
                        ? `${quarantinedRows} row(s) carrying injected content stay in this tab.`
                        : 'Injected content has no route into an artifact.'}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="mt-0.5 size-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="text-fg">Example values.</span> The data dictionary is
                      generated without its sample-values column, which is real cell content.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck
                      className="mt-0.5 size-3.5 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="text-fg">Your token.</span> It goes to api.github.com as an
                      Authorization header and appears in no file, no log and no error message.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="grid gap-3">
                <div>
                  <Label htmlFor="gh-title">Pull request title</Label>
                  <Input
                    id="gh-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="gh-summary">Description</Label>
                  <textarea
                    id="gh-summary"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    className="grid-scroll mt-1 w-full rounded-sm border border-line-strong bg-shell-900 p-2.5 font-mono text-[11.5px] leading-relaxed text-fg-muted"
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-surface-700 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 size-3.5"
                />
                <span className="text-[13px] leading-relaxed text-fg">
                  I have reviewed the {manifest.artifacts.length} files above and want them
                  published to{' '}
                  <span className="font-mono">
                    {manifest.destination.owner}/{manifest.destination.repo}
                  </span>
                  .
                  {approval && (
                    <span className="mt-0.5 block text-[11px] text-fg-subtle">
                      This approval covers these exact files and this destination, expires at{' '}
                      {new Date(approval.expiresAt).toLocaleTimeString()}, and publishes once.
                    </span>
                  )}
                </span>
              </label>
            </div>
          )}

          {/* --- Publishing ------------------------------------------------ */}
          {stage === 'publishing' && (
            <Alert tone="info">
              <GitPullRequest />
              <span>
                Publishing. Do not close this dialog — the receipt is what tells us whether the
                pull request exists if the connection drops mid-request.
              </span>
            </Alert>
          )}

          {/* --- Done ------------------------------------------------------ */}
          {stage === 'done' && receipt && (
            <div className="space-y-3.5">
              <Alert tone="success">
                <CheckCircle2 />
                <span>
                  Pull request #{receipt.pullRequestNumber}{' '}
                  {receipt.mode === 'demo' ? 'prepared' : 'opened'} on {receipt.branch}.
                  {receipt.mode === 'demo' &&
                    ' Demo mode: no request was made, and the number is derived from the manifest hash.'}
                </span>
              </Alert>

              <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[110px_minmax(0,1fr)]">
                <dt className="text-fg-subtle">Pull request</dt>
                <dd>
                  {receipt.mode === 'live' ? (
                    <a
                      href={receipt.pullRequestUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 font-mono text-primary underline underline-offset-2"
                    >
                      #{receipt.pullRequestNumber}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="font-mono text-fg-muted">
                      #{receipt.pullRequestNumber} (not created)
                    </span>
                  )}
                </dd>
                <dt className="text-fg-subtle">Branch</dt>
                <dd className="font-mono text-fg">{receipt.branch}</dd>
                <dt className="text-fg-subtle">Commit</dt>
                <dd className="font-mono text-fg-muted">{receipt.commitSha.slice(0, 12)}</dd>
                <dt className="text-fg-subtle">Created</dt>
                <dd className="font-mono text-fg-muted">
                  {new Date(receipt.createdAt).toLocaleString()}
                </dd>
                <dt className="text-fg-subtle">Files</dt>
                <dd className="font-mono text-fg-muted">{receipt.artifactCount}</dd>
                <dt className="text-fg-subtle">Manifest</dt>
                <dd className="font-mono text-[11px] break-all text-fg-muted">
                  {receipt.manifestHash.slice(0, 32)}
                </dd>
              </dl>

              <p className="text-[12px] leading-relaxed text-fg-muted">
                Recorded in the Ledger with the time, the destination and this receipt. Publishing
                the same files to the same place again returns this receipt rather than opening a
                second pull request.
              </p>
            </div>
          )}

          {/* --- Failed ---------------------------------------------------- */}
          {stage === 'failed' && (
            <div className="space-y-3.5">
              <Alert tone="danger">
                <AlertTriangle />
                {error ?? 'The export did not complete.'}
              </Alert>
              <p className="text-[13px] leading-relaxed text-fg-muted">
                Nothing in your dataset changed. If the request reached GitHub before the
                connection failed, retrying is still safe: the approval is spent, but the manifest
                hash is remembered, so a retry returns the original pull request rather than
                opening a second one.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
