import type { DatasetRegistry } from '../engine/registry';
import type { SqlEngine } from '../engine/types';

/**
 * The security middleware every tool is wrapped in.
 *
 * Four independent controls, deliberately not collapsed into one "is this
 * safe?" check, because they fail in different ways and a single boolean would
 * hide which one tripped:
 *
 * 1. Two-phase confirmation for anything that mutates data.
 * 2. Per-tool rate limiting.
 * 3. Append-only audit of every call.
 * 4. Input validation, supplied per tool.
 *
 * The identifier allowlist is the fifth control and lives in `DatasetRegistry`,
 * because it must apply to every path that reaches SQL, not only tool calls.
 */

export class ToolError extends Error {
  override readonly name = 'ToolError';
  constructor(
    message: string,
    /** Machine-readable reason, so a UI can branch without parsing prose. */
    readonly code:
      | 'validation_failed'
      | 'confirmation_required'
      | 'confirmation_invalid'
      | 'rate_limited'
      | 'execution_failed',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type Outcome = 'ok' | 'error' | 'awaiting_confirmation' | 'rejected';

/**
 * Who initiated a call.
 *
 * The honest core of "agents as auditable team members": not a fabricated
 * identity directory, just accurate provenance for work that actually happened.
 * When several parties can drive the same tools, "what changed my data" is only
 * answerable if each entry records who asked.
 */
export type Actor = 'human' | 'demo-agent' | 'claude-agent' | 'model-agent' | 'external-mcp';

export const ACTOR_LABELS: Record<Actor, string> = {
  human: 'You',
  'demo-agent': 'Guided demo',
  'claude-agent': 'Claude',
  // A model the user connected themselves. Kept separate from 'claude-agent'
  // because the ledger's job is to answer who changed the data, and recording
  // a GPT or Llama run as "Claude" would be the one thing it must not do.
  'model-agent': 'Connected model',
  'external-mcp': 'External MCP client',
};

/**
 * Set for the duration of one synchronous call into a tool.
 *
 * A module-level variable is safe here only because it is read on the first
 * line of `guarded()`, before any await, in the same microtask as the caller.
 * Anything reached after an await must use the captured value, never re-read
 * this. Calls arriving over `document.modelContext` never pass through
 * `callAs`, so they correctly fall through to 'external-mcp'.
 */
let pendingActor: Actor | null = null;

export function callAs<T>(actor: Actor, fn: () => T): T {
  pendingActor = actor;
  try {
    return fn();
  } finally {
    pendingActor = null;
  }
}

export interface AuditEntry {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: Outcome;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly message?: string;
  /** True when this call actually changed data. */
  readonly mutated: boolean;
  /** Who initiated it. */
  readonly actor: Actor;
}

/**
 * Append-only record of every tool call. Feeds the Activity panel and the
 * impact report, and is the evidence trail behind any claim this app makes
 * about what the agent did.
 */
export class AuditLog {
  #entries: AuditEntry[] = [];
  #listeners = new Set<(entry: AuditEntry) => void>();
  #counter = 0;

  append(entry: Omit<AuditEntry, 'id'>): AuditEntry {
    const full: AuditEntry = { ...entry, id: `evt_${++this.#counter}` };
    this.#entries.push(full);
    for (const listener of this.#listeners) listener(full);
    return full;
  }

  entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  subscribe(listener: (entry: AuditEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    this.#entries = [];
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter.
 *
 * A fixed window would let an agent fire 2x the limit across a window boundary;
 * with DuckDB queries that scan whole tables, that burst is exactly what makes
 * the tab unresponsive.
 */
export class RateLimiter {
  readonly #calls = new Map<string, number[]>();
  readonly #windowMs = 60_000;

  constructor(private readonly limits: Readonly<Record<string, number>>) {}

  check(tool: string, now = Date.now()): void {
    const limit = this.limits[tool];
    if (limit === undefined) return;

    const recent = (this.#calls.get(tool) ?? []).filter((t) => now - t < this.#windowMs);

    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      const retryIn = Math.ceil((this.#windowMs - (now - oldest)) / 1000);
      throw new ToolError(
        `${tool} is limited to ${limit} calls per minute. Retry in about ${retryIn}s.`,
        'rate_limited',
      );
    }

    recent.push(now);
    this.#calls.set(tool, recent);
  }

  reset(): void {
    this.#calls.clear();
  }
}

// ---------------------------------------------------------------------------
// Two-phase confirmation
// ---------------------------------------------------------------------------

/** How long a confirmation token stays valid. */
export const CONFIRMATION_TTL_MS = 5 * 60_000;

interface PendingConfirmation {
  readonly tool: string;
  readonly fingerprint: string;
  readonly expiresAt: number;
  used: boolean;
}

/**
 * Deterministic fingerprint of a call's arguments.
 *
 * Object keys are sorted so that logically identical arguments in a different
 * order produce the same fingerprint. `confirmation_token` is excluded, since
 * the token cannot be part of what it attests to.
 */
export function fingerprintArgs(args: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'confirmation_token')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(args));
}

/**
 * Issues and redeems single-use confirmation tokens.
 *
 * The token is bound to the exact arguments it was issued for. Without that
 * binding an agent could request a preview of something harmless, then reuse
 * the returned token to authorize a destructive call — which would make the
 * whole confirmation step decorative.
 */
export class ConfirmationStore {
  readonly #pending = new Map<string, PendingConfirmation>();

  issue(tool: string, args: unknown, now = Date.now()): { token: string; expiresAt: string } {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = `cnf_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const expiresAt = now + CONFIRMATION_TTL_MS;

    this.#pending.set(token, {
      tool,
      fingerprint: fingerprintArgs(args),
      expiresAt,
      used: false,
    });

    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Redeem a token, or throw explaining precisely why it was rejected. */
  consume(token: string, tool: string, args: unknown, now = Date.now()): void {
    const pending = this.#pending.get(token);

    if (!pending) {
      throw new ToolError(
        'That confirmation token is not recognised. Call the tool without a token to preview ' +
          'the change and receive a new one.',
        'confirmation_invalid',
      );
    }
    if (pending.used) {
      throw new ToolError(
        'That confirmation token has already been used. Each token authorizes exactly one change.',
        'confirmation_invalid',
      );
    }
    if (now > pending.expiresAt) {
      this.#pending.delete(token);
      throw new ToolError(
        'That confirmation token has expired. Preview the change again to get a fresh one.',
        'confirmation_invalid',
      );
    }
    if (pending.tool !== tool) {
      throw new ToolError(
        `That confirmation token was issued for ${pending.tool}, not ${tool}.`,
        'confirmation_invalid',
      );
    }
    if (pending.fingerprint !== fingerprintArgs(args)) {
      throw new ToolError(
        'The arguments changed since this confirmation was issued. Preview the new change and ' +
          'confirm that instead.',
        'confirmation_invalid',
      );
    }

    pending.used = true;
  }

  /** Drop expired entries so the map cannot grow without bound. */
  sweep(now = Date.now()): void {
    for (const [token, pending] of this.#pending) {
      if (now > pending.expiresAt || pending.used) this.#pending.delete(token);
    }
  }

  clear(): void {
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly engine: SqlEngine;
  readonly registry: DatasetRegistry;
  readonly audit: AuditLog;
  readonly confirmations: ConfirmationStore;
  readonly rateLimiter: RateLimiter;
}

/** What a mutating tool returns when it has not yet been confirmed. */
export interface PreviewResult {
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface GuardedToolConfig<TInput, TOutput> {
  readonly name: string;
  /** Whether a successful call changes data. Drives the confirmation gate. */
  readonly mutating: boolean;
  readonly rateLimitPerMinute?: number;
  /** Parse and validate raw input, or throw. */
  readonly validate: (input: unknown) => TInput;
  /** Describe the change without performing it. Required when `mutating`. */
  readonly preview?: (input: TInput, ctx: ToolContext) => Promise<PreviewResult>;
  readonly execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

export interface ConfirmationRequired {
  readonly status: 'confirmation_required';
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly confirmation_token: string;
  readonly expires_at: string;
  readonly next_step: string;
}

function hasToken(input: unknown): string | null {
  if (input && typeof input === 'object' && 'confirmation_token' in input) {
    const token = (input as { confirmation_token?: unknown }).confirmation_token;
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return null;
}

/**
 * Wrap a tool implementation with validation, rate limiting, the confirmation
 * gate, and auditing.
 *
 * A mutating tool called without a token performs a dry run and returns a
 * preview plus a token. Nothing is written on that path — the gate is enforced
 * here in code, not by convention in each tool.
 */
export function withGuards<TInput, TOutput>(
  config: GuardedToolConfig<TInput, TOutput>,
  getContext: () => ToolContext,
) {
  if (config.mutating && !config.preview) {
    throw new Error(
      `Tool ${config.name} mutates data and must supply a preview() for the confirmation gate.`,
    );
  }

  return async function guarded(rawInput: unknown): Promise<TOutput | ConfirmationRequired> {
    // Read before any await: see the note on `pendingActor`.
    const actor: Actor = pendingActor ?? 'external-mcp';

    const ctx = getContext();
    const startedAt = new Date().toISOString();
    const start = Date.now();

    const record = (outcome: Outcome, mutated: boolean, message?: string) =>
      ctx.audit.append({
        tool: config.name,
        args: rawInput,
        outcome,
        startedAt,
        durationMs: Date.now() - start,
        mutated,
        actor,
        ...(message === undefined ? {} : { message }),
      });

    try {
      ctx.rateLimiter.check(config.name);

      let input: TInput;
      try {
        input = config.validate(rawInput);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new ToolError(detail, 'validation_failed');
      }

      if (config.mutating) {
        const token = hasToken(rawInput);

        if (token === null) {
          const preview = await config.preview!(input, ctx);
          const issued = ctx.confirmations.issue(config.name, rawInput);
          record('awaiting_confirmation', false, preview.summary);

          return {
            status: 'confirmation_required',
            summary: preview.summary,
            details: preview.details,
            confirmation_token: issued.token,
            expires_at: issued.expiresAt,
            next_step:
              'Show this summary to the user. If they approve, call this tool again with the ' +
              'same arguments plus confirmation_token. Nothing has been changed yet.',
          };
        }

        ctx.confirmations.consume(token, config.name, rawInput);
      }

      const result = await config.execute(input, ctx);
      record('ok', config.mutating);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(error instanceof ToolError ? 'rejected' : 'error', false, message);
      throw error;
    }
  };
}
