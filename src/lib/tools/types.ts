import type { ToolContext } from './guards';

/**
 * A registered tool, in a shape that serves three consumers at once:
 * `useWebMCP` registration, the in-app Tool Inspector, and the demo agent.
 *
 * Keeping one definition rather than three is what guarantees the schema a
 * judge inspects is the schema the agent is actually offered.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema. WebMCP no longer accepts raw Zod object maps. */
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
    /**
     * Set on any tool whose output can contain user cell values. Tells the
     * client that the payload includes data an attacker may control.
     */
    readonly untrustedContentHint?: boolean;
  };
  readonly execute: (input: unknown) => Promise<unknown>;
}

export type ToolFactory = (getContext: () => ToolContext) => ToolDefinition;
