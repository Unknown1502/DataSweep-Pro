/**
 * A minimal agent protocol shared by the scripted demo agent and the real
 * Claude-backed one.
 *
 * Both are generators that yield events and can be *resumed with a decision*.
 * That shape is the point: an agent here cannot apply a change without the
 * consumer handing back an approval, so the human-in-the-loop step is part of
 * the control flow rather than a convention each implementation must remember.
 */

export type AgentEvent =
  | { readonly type: 'say'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string; readonly args: unknown }
  | { readonly type: 'result'; readonly name: string; readonly summary: string }
  | {
      readonly type: 'approve';
      readonly toolName: string;
      readonly summary: string;
      readonly details: Record<string, unknown>;
    }
  | { readonly type: 'done'; readonly text: string }
  | { readonly type: 'error'; readonly text: string };

/**
 * Yields events; each `next(decision)` may carry the user's answer to a
 * preceding `approve` event.
 */
export type AgentRun = AsyncGenerator<AgentEvent, void, boolean | undefined>;

export interface Agent {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  /** Whether the agent needs an API key before it can run. */
  readonly needsKey: boolean;
  run(datasetId: string): AgentRun;
}
