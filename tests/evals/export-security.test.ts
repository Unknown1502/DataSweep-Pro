import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adapterFor,
  clearExportToken,
  configuredMode,
  hasExportToken,
  setExportToken,
} from '../../src/lib/integrations/token-vault';
import { ExportError } from '../../src/lib/integrations/manifest';

/**
 * Behavioural checks on the one path that leaves the machine.
 *
 * These assert what the code does, not that it throws. A test written as
 * `rejects.toThrow()` passes when the code fails for entirely the wrong reason,
 * which is how a security control rots without anyone noticing.
 */

const SRC = join(import.meta.dirname, '..', '..', 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('no credential is present in, or reachable from, the source', () => {
  const files = sourceFiles(SRC);

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('contains no literal GitHub token anywhere', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // A real token committed to source would match. The placeholder in the
      // token field is `github_pat_...`, which does not.
      expect(text, file).not.toMatch(/\b(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]{20,}/);
      expect(text, file).not.toMatch(/\bsk-ant-[A-Za-z0-9-]{20,}/);
    }
  });

  it('never writes an export token to browser storage', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const storageWrites = text.match(/(localStorage|sessionStorage)\.setItem\([^)]*\)/g) ?? [];
      for (const write of storageWrites) {
        expect(write, file).not.toMatch(/token|secret|credential|password|auth/i);
      }
    }
  });

  it('sends the token in a header and never in a URL', () => {
    const github = readFileSync(join(SRC, 'lib', 'integrations', 'github.ts'), 'utf8');
    expect(github).toContain('Authorization: `Bearer ${token}`');
    // Every request path is built from `${API}${path}`; a token interpolated
    // into either would put it in a URL, where it reaches logs and referrers.
    expect(github).not.toMatch(/\$\{API\}[^`]*\$\{token\}/);
    expect(github).not.toMatch(/[?&](access_token|token|api_key)=/);
  });

  it('never attaches the failing request to an error', () => {
    const github = readFileSync(join(SRC, 'lib', 'integrations', 'github.ts'), 'utf8');
    // A fetch failure's `cause` carries the Request, and the Request carries the
    // Authorization header. Re-throwing with `{ cause }` would leak it into any
    // error reporter that serializes the chain.
    expect(github).not.toMatch(/cause\s*[:}]/);
    expect(github).not.toMatch(/console\.(log|error|warn|debug)/);
  });

  it('keeps the vault out of React state and props', () => {
    const vault = readFileSync(join(SRC, 'lib', 'integrations', 'token-vault.ts'), 'utf8');
    // The raw value is never returned; callers get a configured adapter.
    expect(vault).not.toMatch(/export function (get|read)ExportToken/);
    expect(vault).toContain('export function adapterFor');

    const dialog = readFileSync(
      join(SRC, 'components', 'panels', 'GitHubExportDialog.tsx'),
      'utf8',
    );
    // The dialog holds what was typed only long enough to hand it to the vault.
    expect(dialog).toContain('setExportToken(token)');
    expect(dialog).toContain('type="password"');
    // It is never put into the manifest, the audit entry, or the PR body.
    expect(dialog).not.toMatch(/token[,:]\s*token\b/);
    expect(dialog).not.toMatch(/args:\s*\{[^}]*\btoken\b/s);
  });

  it('registers no tool that could carry a credential or a destination', () => {
    const toolSources = files.filter((f) => f.includes(join('lib', 'tools')));
    for (const file of toolSources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/api\.github\.com|fetch\s*\(/);
    }
  });
});

describe('the token vault', () => {
  afterEach(() => clearExportToken());

  it('starts empty', () => {
    expect(hasExportToken()).toBe(false);
  });

  it('refuses a value that is not shaped like a GitHub token', () => {
    for (const bad of ['', '   ', 'hunter2', 'Bearer abc', 'github_pat_short']) {
      expect(() => setExportToken(bad)).toThrow(ExportError);
    }
    expect(hasExportToken()).toBe(false);
  });

  it('accepts a plausible fine-grained token and reports only its presence', () => {
    setExportToken(`github_pat_${'A1b2C3d4E5'.repeat(3)}`);
    expect(hasExportToken()).toBe(true);
    // There is no accessor that returns the value — the adapter is the only
    // thing the vault hands back.
    expect(adapterFor('live').mode).toBe('live');
  });

  it('clears completely', () => {
    setExportToken(`ghp_${'A1b2C3d4E5'.repeat(3)}`);
    clearExportToken();
    expect(hasExportToken()).toBe(false);
    expect(() => adapterFor('live')).toThrow(/token/i);
  });

  it('fails safely in live mode with no token, before any request', () => {
    expect(hasExportToken()).toBe(false);
    expect(() => adapterFor('live')).toThrow(ExportError);
  });

  it('gives demo mode an adapter that never consults the vault', () => {
    expect(hasExportToken()).toBe(false);
    expect(adapterFor('demo').mode).toBe('demo');
  });

  it('defaults to demo when nothing is configured', () => {
    // A deployment that sets no variable cannot make a request it did not mean
    // to; live has to be asked for.
    expect(configuredMode()).toBe('demo');
  });
});
