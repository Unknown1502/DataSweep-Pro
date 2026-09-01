import { useWebMCP } from '@mcp-b/react-webmcp';
import { ALL_TOOLS } from '../lib/tools';
import type { ToolDefinition } from '../lib/tools/types';

/**
 * Publishes the app's tools on `document.modelContext`.
 *
 * One component per tool rather than a loop inside a single component: hooks
 * cannot be called in a loop whose length might vary, and this keeps each
 * registration's lifecycle independent.
 */
function RegisteredTool({ tool }: { tool: ToolDefinition }) {
  useWebMCP({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as never,
    annotations: tool.annotations,
    execute: (input: unknown) => tool.execute(input),
  });

  return null;
}

export function RegisterTools() {
  return (
    <>
      {ALL_TOOLS.map((tool) => (
        <RegisteredTool key={tool.name} tool={tool} />
      ))}
    </>
  );
}
