import { getToolContext } from './context';
import { callAs, type Actor } from './guards';
import { CORE_TOOLS } from './core-tools';
import { ANALYSIS_TOOLS } from './analysis-tools';
import { PIPELINE_TOOLS } from './pipeline-tools';
import { RULE_TOOLS } from './rule-tools';
import type { ToolDefinition } from './types';

export * from './types';
export * from './guards';

/**
 * Every tool the page registers, built once at module load.
 *
 * A stable array matters for React: `RegisterTools` renders one hook-bearing
 * component per entry, and the rules of hooks require that count to be
 * constant across renders.
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [...CORE_TOOLS, ...PIPELINE_TOOLS, ...ANALYSIS_TOOLS, ...RULE_TOOLS].map(
  (factory) => factory(getToolContext),
);

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Call a tool by name. Identical path to the one an agent uses.
 *
 * `actor` is recorded in the audit ledger so the history answers "who changed
 * my data", not merely "what changed". Calls arriving over
 * `document.modelContext` do not pass through here and are attributed to
 * 'external-mcp' by default.
 */
export async function callTool(
  name: string,
  input: unknown,
  actor: Actor = 'human',
): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available: ${[...TOOLS_BY_NAME.keys()].join(', ')}.`,
    );
  }
  return callAs(actor, () => tool.execute(input));
}
