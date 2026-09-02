import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeBranch,
  assertSafePath,
  assertSafeRepo,
  branchNameFor,
  buildManifest,
  destinationKey,
  ExportApprovalStore,
  ExportError,
  EXPORT_APPROVAL_TTL_MS,
  type ExportManifest,
} from '../../src/lib/integrations/manifest';
import {
  clearReceiptsForTesting,
  createDemoAdapter,
  createLiveAdapter,
  exportApprovals,
  publishExport,
  receiptFor,
} from '../../src/lib/integrations/github';

const FILES = [
  { path: 'models/orders.sql', type: 'sql' as const, content: 'select 1' },
  { path: 'docs/orders.md', type: 'documentation' as const, content: '# Orders' },
];

const SOURCE = {
  checkpointId: 'ds_abc123',
  stepsApplied: 2,
  rowsOriginal: 100,
  rowsCurrent: 98,
  qualityScore: 84,
};

function makeManifest(overrides: Partial<Parameters<typeof buildManifest>[0]> = {}) {
  return buildManifest({
    datasetId: 'ds_1',
    datasetName: 'orders.csv',
    destination: { provider: 'github', owner: 'acme', repo: 'pipelines', branch: 'datasweep/x' },
    files: FILES,
    includesSampleValues: false,
    sourceState: SOURCE,
    now: new Date('2026-01-15T10:00:00.000Z'),
    exportId: 'exp_fixed',
    ...overrides,
  });
}

describe('export manifest', () => {
  it('hashes deterministically for identical input', async () => {
    const a = await makeManifest();
    const b = await makeManifest();
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes hash when any artifact byte changes', async () => {
    const a = await makeManifest();
    const b = await makeManifest({
      files: [{ ...FILES[0]!, content: 'select 2' }, FILES[1]!],
    });
    expect(b.manifestHash).not.toBe(a.manifestHash);
  });

  it('changes hash when the destination changes', async () => {
    const a = await makeManifest();
    const b = await makeManifest({
      destination: {
        provider: 'github',
        owner: 'attacker',
        repo: 'pipelines',
        branch: 'datasweep/x',
      },
    });
    expect(b.manifestHash).not.toBe(a.manifestHash);
  });

  it('records the data policy as a fact on every manifest', async () => {
    const manifest = await makeManifest();
    expect(manifest.dataPolicy.includesRawRows).toBe(false);
    expect(manifest.dataPolicy.includesQuarantinedCells).toBe(false);
    expect(manifest.dataPolicy.includesSampleValues).toBe(false);
    expect(manifest.requestedBy).toBe('human');
  });

  it('hashes each artifact individually', async () => {
    const manifest = await makeManifest();
    for (const artifact of manifest.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBe(new TextEncoder().encode(artifact.content).length);
    }
  });

  it('rejects an export with no artifacts', async () => {
    await expect(makeManifest({ files: [] })).rejects.toThrow(ExportError);
  });

  it('rejects duplicate artifact paths', async () => {
    await expect(makeManifest({ files: [FILES[0]!, FILES[0]!] })).rejects.toThrow(/Duplicate/);
  });
});

describe('path and ref validation', () => {
  it.each([
    ['../../../etc/passwd', 'parent traversal'],
    ['models/../../secrets.env', 'traversal in the middle'],
    ['/etc/passwd', 'absolute path'],
    ['models\\windows.sql', 'backslash separator'],
    ['..', 'bare parent'],
    ['models/sub/../../../out.sql', 'deep traversal'],
    ['', 'empty'],
    ['models/a b.sql', 'space'],
    ['models/$(whoami).sql', 'shell metacharacters'],
    [`models/${'a'.repeat(300)}.sql`, 'over length'],
  ])('rejects %s (%s)', (path) => {
    expect(() => assertSafePath(path)).toThrow(ExportError);
  });

  it.each(['models/orders.sql', 'docs/data_quality.md', 'great_expectations/suite.json', 'a.txt'])(
    'accepts %s',
    (path) => {
      expect(assertSafePath(path)).toBe(path);
    },
  );

  it.each([
    'datasweep/x;rm -rf /',
    'datasweep/..',
    'datasweep/x..y',
    '-leading-dash-is-an-option',
    'refs/heads/x.lock',
    'branch name with spaces',
    'branch\nwith-newline',
  ])('rejects unsafe branch %j', (branch) => {
    expect(() => assertSafeBranch(branch)).toThrow(ExportError);
  });

  it('accepts a generated branch name', () => {
    const branch = branchNameFor('Q3 sales — final(2).csv', new Date('2026-01-15T00:00:00Z'));
    expect(branch).toBe('datasweep/q3-sales-final-2-2026-01-15');
    expect(assertSafeBranch(branch)).toBe(branch);
  });

  it.each([
    ['acme/../other', 'repo'],
    ['acme', 'pipe|line'],
    ['ac me', 'repo'],
    ['acme', ''],
  ])('rejects repository %s/%s', (owner, repo) => {
    expect(() => assertSafeRepo(owner, repo)).toThrow(ExportError);
  });

  it('refuses to build a manifest for an unsafe destination', async () => {
    await expect(
      makeManifest({
        destination: {
          provider: 'github',
          owner: 'acme',
          repo: 'pipelines',
          branch: '../../elsewhere',
        },
      }),
    ).rejects.toThrow(ExportError);
  });
});

describe('export approval', () => {
  let store: ExportApprovalStore;
  let manifest: ExportManifest;

  beforeEach(async () => {
    store = new ExportApprovalStore();
    manifest = await makeManifest();
  });

  it('accepts a fresh token for the manifest it was issued for', () => {
    const { token } = store.issue(manifest);
    expect(() => store.consume(token, manifest)).not.toThrow();
  });

  it('refuses an unknown token', () => {
    expect(() => store.consume('exa_not_a_real_token', manifest)).toThrow(/not recognised/);
  });

  it('refuses a second use of the same token', () => {
    const { token } = store.issue(manifest);
    store.consume(token, manifest);
    expect(() => store.consume(token, manifest)).toThrow(/already been used/);
  });

  it('refuses an expired token', () => {
    const now = Date.now();
    const { token } = store.issue(manifest, now);
    expect(() => store.consume(token, manifest, now + EXPORT_APPROVAL_TTL_MS + 1)).toThrow(
      /expired/,
    );
  });

  it('refuses a token when the payload changed after approval', async () => {
    const { token } = store.issue(manifest);
    const tampered = await makeManifest({
      files: [{ ...FILES[0]!, content: 'select * from customers' }, FILES[1]!],
    });
    expect(() => store.consume(token, tampered)).toThrow(/changed after it was approved/);
  });

  it('refuses a token redirected to a different repository', async () => {
    const { token } = store.issue(manifest);
    // Same artifacts, different destination — the case an approval must not cover.
    const redirected: ExportManifest = {
      ...manifest,
      destination: { ...manifest.destination, owner: 'attacker' },
    };
    expect(() => store.consume(token, redirected)).toThrow(/destination changed/i);
  });

  it('refuses a token redirected to a different branch', () => {
    const { token } = store.issue(manifest);
    const redirected: ExportManifest = {
      ...manifest,
      destination: { ...manifest.destination, branch: 'main' },
    };
    expect(() => store.consume(token, redirected)).toThrow(/destination changed/i);
  });

  it('keys destinations by every component', () => {
    expect(destinationKey(manifest.destination)).toBe('github:acme/pipelines#datasweep/x');
  });
});

describe('adapters', () => {
  beforeEach(() => {
    clearReceiptsForTesting();
    exportApprovals.clear();
  });

  it('demo mode makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const manifest = await makeManifest();
    const { token } = { token: exportApprovals.issue(manifest).token };

    const receipt = await publishExport(
      createDemoAdapter(),
      manifest,
      token,
      'title',
      'body',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(receipt.mode).toBe('demo');
    expect(receipt.pullRequestNumber).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });

  it('demo receipts are derived from the manifest, so they are stable', async () => {
    const manifest = await makeManifest();
    const a = await createDemoAdapter().publish(manifest, 't', 'b');
    const b = await createDemoAdapter().publish(manifest, 't', 'b');
    expect(a.pullRequestNumber).toBe(b.pullRequestNumber);
    expect(a.commitSha).toBe(b.commitSha);
  });

  it('live mode refuses to start without a token', () => {
    expect(() => createLiveAdapter('')).toThrow(ExportError);
    expect(() => createLiveAdapter('   ')).toThrow(ExportError);
  });

  it('publishing twice returns the first receipt instead of a second pull request', async () => {
    const manifest = await makeManifest();
    let calls = 0;
    const adapter = {
      mode: 'demo' as const,
      publish: async () => {
        calls += 1;
        return {
          mode: 'demo' as const,
          pullRequestNumber: 41 + calls,
          pullRequestUrl: 'https://github.com/acme/pipelines/pull/42',
          branch: manifest.destination.branch,
          commitSha: 'abc',
          createdAt: new Date().toISOString(),
          manifestHash: manifest.manifestHash,
          artifactCount: manifest.artifacts.length,
        };
      },
    };

    const first = await publishExport(
      adapter,
      manifest,
      exportApprovals.issue(manifest).token,
      't',
      'b',
    );
    // A retry after an ambiguous failure: same manifest, a fresh approval.
    const second = await publishExport(
      adapter,
      manifest,
      exportApprovals.issue(manifest).token,
      't',
      'b',
    );

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(receiptFor(manifest)).toEqual(first);
  });

  it('an invalid approval stops the publish before the adapter is reached', async () => {
    const manifest = await makeManifest();
    let reached = false;
    const adapter = {
      mode: 'demo' as const,
      publish: async () => {
        reached = true;
        throw new Error('should not run');
      },
    };

    await expect(publishExport(adapter, manifest, 'exa_forged', 't', 'b')).rejects.toThrow(
      /not recognised/,
    );
    expect(reached).toBe(false);
  });
});
