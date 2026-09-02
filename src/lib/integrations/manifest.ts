/**
 * The export manifest: an immutable, hash-bound description of exactly what
 * leaves this machine, where it goes, and who approved it.
 *
 * This is the same shape of control as the transformation confirmation gate,
 * applied one level out. There the risk was writing to your data; here it is
 * publishing it. The properties that matter are identical:
 *
 * - the approval is bound to a hash of the exact payload *and* destination, so
 *   approving one export cannot authorize a different one;
 * - it is single-use and expiring;
 * - it is redeemed by the integration layer, never handed to an agent.
 *
 * Nothing in this file touches the network. Building a manifest is a pure
 * description of an intent that has not happened yet.
 */

export type ArtifactType =
  | 'sql'
  | 'python'
  | 'dbt'
  | 'great_expectations'
  | 'json'
  | 'documentation';

export interface ExportArtifact {
  /** Repository-relative path. Validated: no traversal, no absolute paths. */
  readonly path: string;
  readonly type: ArtifactType;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExportDestination {
  readonly provider: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseBranch?: string;
}

export interface ExportManifest {
  readonly exportId: string;
  readonly createdAt: string;
  /** Only a human can start an export. Recorded so the ledger can say so. */
  readonly requestedBy: 'human';
  readonly datasetId: string;
  readonly datasetName: string;
  readonly destination: ExportDestination;
  readonly artifacts: readonly ExportArtifact[];
  readonly dataPolicy: {
    /** Always false. Raw rows have no route into an artifact. */
    readonly includesRawRows: false;
    /** Always false. Quarantined content is never exportable. */
    readonly includesQuarantinedCells: false;
    /** Whether the documentation carries real example cell values. */
    readonly includesSampleValues: boolean;
  };
  readonly sourceState: {
    readonly checkpointId: string;
    readonly stepsApplied: number;
    readonly rowsOriginal: number;
    readonly rowsCurrent: number;
    readonly qualityScore: number | null;
  };
  /** Hash over everything above. Any edit invalidates the approval. */
  readonly manifestHash: string;
}

export class ExportError extends Error {
  override readonly name = 'ExportError';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export { sha256Hex };

/**
 * Canonical JSON: keys sorted at every level.
 *
 * Two manifests describing the same export must hash identically regardless of
 * key order, or the approval would break for reasons no user could see.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Fields excluded from the hash, and why each one has to be.
 *
 * The hash answers one question — *what* is being sent and *where* — because
 * that is what an approval must bind to and what makes a duplicate detectable.
 * Three fields describe the attempt rather than the payload:
 *
 * - `manifestHash` cannot hash itself;
 * - `exportId` is random per build, so including it would give the same files
 *   to the same repository a different hash every time the dialog was reopened,
 *   which would silently defeat the duplicate-publication guard;
 * - `createdAt` is a clock reading, and the same export prepared a minute later
 *   is still the same export.
 *
 * Nothing that affects what leaves the machine is excluded.
 */
const UNHASHED = new Set(['manifestHash', 'exportId', 'createdAt']);

export async function computeManifestHash(
  manifest: Omit<ExportManifest, 'manifestHash'>,
): Promise<string> {
  const payload = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !UNHASHED.has(key)),
  );
  return sha256Hex(JSON.stringify(canonical(payload)));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Conservative: a path we generate, not one a user or agent supplies. */
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function assertSafePath(path: string): string {
  if (path.length === 0 || path.length > 255) {
    throw new ExportError(`Invalid artifact path: ${JSON.stringify(path)}`);
  }
  // Rejected explicitly rather than normalized away: a path that needed
  // normalizing is a path we did not intend to produce.
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new ExportError(`Unsafe artifact path: ${JSON.stringify(path)}`);
  }
  if (!SAFE_PATH.test(path)) {
    throw new ExportError(`Artifact path has unsupported characters: ${JSON.stringify(path)}`);
  }
  return path;
}

/** Git refs forbid a long list of sequences; this allows a safe subset. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,98}[A-Za-z0-9]$/;

export function assertSafeBranch(branch: string): string {
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new ExportError(`Unsafe branch name: ${JSON.stringify(branch)}`);
  }
  return branch;
}

const SAFE_REPO_PART = /^[A-Za-z0-9._-]{1,100}$/;

export function assertSafeRepo(owner: string, repo: string): void {
  if (!SAFE_REPO_PART.test(owner) || !SAFE_REPO_PART.test(repo)) {
    throw new ExportError(`Invalid repository: ${JSON.stringify(`${owner}/${repo}`)}`);
  }
}

/** A deterministic, safe branch name for a dataset and day. */
export function branchNameFor(datasetName: string, date = new Date()): string {
  const slug =
    datasetName
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'dataset';
  const day = date.toISOString().slice(0, 10);
  return `datasweep/${slug}-${day}`;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface BuildManifestInput {
  readonly datasetId: string;
  readonly datasetName: string;
  readonly destination: ExportDestination;
  readonly files: readonly { path: string; type: ArtifactType; content: string }[];
  readonly sourceState: ExportManifest['sourceState'];
  readonly includesSampleValues: boolean;
  /** Injectable for deterministic tests. */
  readonly now?: Date;
  readonly exportId?: string;
}

export async function buildManifest(input: BuildManifestInput): Promise<ExportManifest> {
  assertSafeRepo(input.destination.owner, input.destination.repo);
  assertSafeBranch(input.destination.branch);

  if (input.files.length === 0) {
    throw new ExportError('An export must contain at least one artifact.');
  }

  const seen = new Set<string>();
  const artifacts: ExportArtifact[] = [];

  for (const file of input.files) {
    const path = assertSafePath(file.path);
    if (seen.has(path)) {
      throw new ExportError(`Duplicate artifact path: ${JSON.stringify(path)}`);
    }
    seen.add(path);

    artifacts.push({
      path,
      type: file.type,
      content: file.content,
      sha256: await sha256Hex(file.content),
      bytes: new TextEncoder().encode(file.content).length,
    });
  }

  const now = input.now ?? new Date();
  const base: Omit<ExportManifest, 'manifestHash'> = {
    exportId: input.exportId ?? `exp_${await randomId()}`,
    createdAt: now.toISOString(),
    requestedBy: 'human',
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    destination: input.destination,
    artifacts,
    dataPolicy: {
      includesRawRows: false,
      includesQuarantinedCells: false,
      includesSampleValues: input.includesSampleValues,
    },
    sourceState: input.sourceState,
  };

  return { ...base, manifestHash: await computeManifestHash(base) };
}

async function randomId(): Promise<string> {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export const EXPORT_APPROVAL_TTL_MS = 5 * 60_000;

interface PendingApproval {
  readonly manifestHash: string;
  readonly destinationKey: string;
  readonly expiresAt: number;
  used: boolean;
}

export function destinationKey(d: ExportDestination): string {
  return `${d.provider}:${d.owner}/${d.repo}#${d.branch}`;
}

/**
 * Issues and redeems approvals for one exact export.
 *
 * Separate from the transformation `ConfirmationStore` on purpose: the two
 * authorize different classes of action, and a token minted for a local edit
 * must never be redeemable for a publish.
 */
export class ExportApprovalStore {
  readonly #pending = new Map<string, PendingApproval>();

  issue(manifest: ExportManifest, now = Date.now()): { token: string; expiresAt: string } {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = `exa_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const expiresAt = now + EXPORT_APPROVAL_TTL_MS;

    this.#pending.set(token, {
      manifestHash: manifest.manifestHash,
      destinationKey: destinationKey(manifest.destination),
      expiresAt,
      used: false,
    });

    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token: string, manifest: ExportManifest, now = Date.now()): void {
    const pending = this.#pending.get(token);

    if (!pending) {
      throw new ExportError('That export approval is not recognised. Review the export again.');
    }
    if (pending.used) {
      throw new ExportError(
        'That export approval has already been used. Each approval publishes exactly once.',
      );
    }
    if (now > pending.expiresAt) {
      this.#pending.delete(token);
      throw new ExportError('That export approval has expired. Review the export again.');
    }
    if (pending.manifestHash !== manifest.manifestHash) {
      throw new ExportError(
        'The export changed after it was approved. Review the new contents and approve those.',
      );
    }
    if (pending.destinationKey !== destinationKey(manifest.destination)) {
      throw new ExportError(
        'The destination changed after approval. Approve the export for its actual destination.',
      );
    }

    pending.used = true;
  }

  clear(): void {
    this.#pending.clear();
  }
}
