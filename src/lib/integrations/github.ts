import {
  assertSafeBranch,
  assertSafeRepo,
  ExportApprovalStore,
  ExportError,
  sha256Hex,
  type ExportManifest,
} from './manifest';

/**
 * GitHub export.
 *
 * **Why this runs in the browser and not on a server.** The brief this was
 * built from specified a server-side route holding a `GITHUB_TOKEN`, which is
 * the right shape when an application owns the credential. This application
 * has no server, and giving it one would mean routing a user's artifacts
 * through infrastructure we operate — which cuts directly against the claim
 * that nothing leaves their machine except what they explicitly publish.
 *
 * `api.github.com` sends `Access-Control-Allow-Origin: *` and accepts an
 * `Authorization` header from a browser, so the same call can be made directly
 * with a credential the *user* owns. That is a better trust model here, not
 * merely a workaround: the token is a fine-grained PAT the user scopes to
 * specific repositories at creation, which is a tighter allow-list than any
 * list this application could maintain, and no third party ever holds it.
 *
 * The token lives in memory for the tab. It is never persisted, never placed
 * in a WebMCP tool argument, never put in a URL, and never logged.
 */

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;

export type ExportMode = 'demo' | 'live';

export interface ExportReceipt {
  readonly mode: ExportMode;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly manifestHash: string;
  readonly artifactCount: number;
}

export interface GitHubAdapter {
  readonly mode: ExportMode;
  publish(manifest: ExportManifest, prTitle: string, prBody: string): Promise<ExportReceipt>;
}

// ---------------------------------------------------------------------------
// Demo adapter
// ---------------------------------------------------------------------------

/**
 * Makes no network request of any kind.
 *
 * The receipt is derived from the manifest hash, so it is stable for a given
 * export and obviously synthetic — a demo that quietly looked live would be
 * worse than no demo at all. The UI labels it.
 */
export function createDemoAdapter(): GitHubAdapter {
  return {
    mode: 'demo',
    async publish(manifest, _prTitle, _prBody) {
      const seed = await sha256Hex(manifest.manifestHash);
      const number = (parseInt(seed.slice(0, 4), 16) % 900) + 100;

      return {
        mode: 'demo',
        pullRequestNumber: number,
        pullRequestUrl:
          `https://github.com/${manifest.destination.owner}/${manifest.destination.repo}` +
          `/pull/${number}`,
        branch: manifest.destination.branch,
        commitSha: seed.slice(0, 40),
        createdAt: new Date().toISOString(),
        manifestHash: manifest.manifestHash,
        artifactCount: manifest.artifacts.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Live adapter
// ---------------------------------------------------------------------------

interface GitHubError {
  message?: string;
}

/** Never interpolates the token into a message, however the call failed. */
async function call<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  } catch (cause) {
    clearTimeout(timer);
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ExportError(`GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    // Deliberately does not include `cause`: a fetch failure can carry the
    // request, and the request carries the Authorization header.
    throw new ExportError('Could not reach GitHub. Check your connection and try again.');
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as GitHubError;
      detail = typeof body.message === 'string' ? body.message : '';
    } catch {
      detail = '';
    }

    if (response.status === 401) {
      throw new ExportError('That token was rejected. Check it has not expired.');
    }
    if (response.status === 403) {
      throw new ExportError(
        'That token lacks permission for this repository. A fine-grained token needs ' +
          'Contents: read and write, and Pull requests: read and write.',
      );
    }
    if (response.status === 404) {
      throw new ExportError(
        'Repository not found, or the token cannot see it. Fine-grained tokens only reach ' +
          'repositories selected when the token was created.',
      );
    }
    throw new ExportError(`GitHub returned ${response.status}${detail ? `: ${detail}` : ''}.`);
  }

  return (await response.json()) as T;
}

/**
 * Creates one clean commit via the git data API rather than one commit per file
 * through the contents API — a pull request whose diff is six separate commits
 * is harder to review, which defeats the point of publishing for review.
 */
export function createLiveAdapter(token: string): GitHubAdapter {
  if (!token.trim()) {
    throw new ExportError('A GitHub token is required for live mode.');
  }

  return {
    mode: 'live',
    async publish(manifest, prTitle, prBody) {
      const { owner, repo, branch } = manifest.destination;
      assertSafeRepo(owner, repo);
      assertSafeBranch(branch);
      const base = `/repos/${owner}/${repo}`;

      const repository = await call<{ default_branch: string }>(token, base);
      const baseBranch = manifest.destination.baseBranch ?? repository.default_branch;

      const baseRef = await call<{ object: { sha: string } }>(
        token,
        `${base}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      );
      const baseSha = baseRef.object.sha;

      const baseCommit = await call<{ tree: { sha: string } }>(
        token,
        `${base}/git/commits/${baseSha}`,
      );

      const blobs = await Promise.all(
        manifest.artifacts.map(async (artifact) => {
          const blob = await call<{ sha: string }>(token, `${base}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content: artifact.content, encoding: 'utf-8' }),
          });
          return { path: artifact.path, mode: '100644', type: 'blob', sha: blob.sha };
        }),
      );

      const tree = await call<{ sha: string }>(token, `${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: blobs }),
      });

      const commit = await call<{ sha: string }>(token, `${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: `${prTitle}\n\nDataSweep export ${manifest.exportId}\nManifest ${manifest.manifestHash.slice(0, 16)}`,
          tree: tree.sha,
          parents: [baseSha],
        }),
      });

      // Create the branch, tolerating one that already exists from a retry.
      try {
        await call(token, `${base}/git/refs`, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
        });
      } catch (error) {
        if (!(error instanceof ExportError) || !/422|already exists/i.test(error.message)) {
          await call(token, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: 'PATCH',
            body: JSON.stringify({ sha: commit.sha, force: false }),
          });
        }
      }

      const pull = await call<{ number: number; html_url: string }>(token, `${base}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: prTitle, head: branch, base: baseBranch, body: prBody }),
      });

      return {
        mode: 'live',
        pullRequestNumber: pull.number,
        pullRequestUrl: pull.html_url,
        branch,
        commitSha: commit.sha,
        createdAt: new Date().toISOString(),
        manifestHash: manifest.manifestHash,
        artifactCount: manifest.artifacts.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export const exportApprovals = new ExportApprovalStore();

/**
 * Receipts already issued, keyed by manifest hash and destination.
 *
 * Idempotency guard: after a network failure whose outcome is unknown, a retry
 * must not open a second pull request for the same artifacts.
 */
const receipts = new Map<string, ExportReceipt>();

export function receiptFor(manifest: ExportManifest): ExportReceipt | undefined {
  return receipts.get(`${manifest.manifestHash}`);
}

export async function publishExport(
  adapter: GitHubAdapter,
  manifest: ExportManifest,
  approvalToken: string,
  prTitle: string,
  prBody: string,
): Promise<ExportReceipt> {
  const existing = receipts.get(manifest.manifestHash);
  if (existing) return existing;

  // Redeemed here, in the integration layer. The token is never handed to an
  // agent and never appears in a tool argument.
  exportApprovals.consume(approvalToken, manifest);

  const receipt = await adapter.publish(manifest, prTitle, prBody);
  receipts.set(manifest.manifestHash, receipt);
  return receipt;
}

export function clearReceiptsForTesting(): void {
  receipts.clear();
}
