import { getToolContext } from './context';
import { CORE_TOOLS } from './core-tools';
import { PIPELINE_TOOLS } from './pipeline-tools';
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
export const ALL_TOOLS: readonly ToolDefinition[] = [...CORE_TOOLS, ...PIPELINE_TOOLS].map(
  (factory) => factory(getToolContext),
);

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);

/** Call a tool by name from the UI. Identical path to the one an agent uses. */
export async function callTool(name: string, input: unknown): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available: ${[...TOOLS_BY_NAME.keys()].join(', ')}.`,
    );
  }
  return tool.execute(input);
}
