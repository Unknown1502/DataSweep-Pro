import { getEngine } from '../engine/duckdb-browser';
import { DatasetRegistry } from '../engine/registry';
import { AuditLog, ConfirmationStore, RateLimiter, type ToolContext } from './guards';

/**
 * The single tool context for the running app.
 *
 * Held in a module rather than in React state on purpose: the WebMCP tools are
 * callable by an agent at any moment, including before React has mounted or
 * after a component has unmounted. Tying their dependencies to a component
 * lifecycle would make tool availability depend on what is currently rendered.
 */

/** Per-minute call ceilings. Read-heavy tools scan whole tables in the tab. */
const RATE_LIMITS: Record<string, number> = {
  list_datasets: 60,
  preview_dataset: 30,
  detect_data_quality_issues: 20,
  apply_cleaning_transformations: 10,
  undo_to_checkpoint: 20,
  generate_impact_report: 20,
  join_datasets: 10,
  execute_cleaning_pipeline: 10,
  export_transformation_pipeline: 20,
  apply_community_template: 10,
  detect_column_semantics: 20,
  generate_data_documentation: 10,
  create_quality_rule: 20,
  evaluate_quality_rules: 20,
  compare_checkpoints: 20,
};

export const registry = new DatasetRegistry();
export const audit = new AuditLog();
export const confirmations = new ConfirmationStore();
export const rateLimiter = new RateLimiter(RATE_LIMITS);

let context: ToolContext | null = null;
let booting: Promise<ToolContext> | null = null;

/** Boot DuckDB if needed and return the context. */
export async function initToolContext(): Promise<ToolContext> {
  if (context) return context;

  booting ??= (async () => {
    const engine = await getEngine();
    context = { engine, registry, audit, confirmations, rateLimiter };
    return context;
  })().catch((error: unknown) => {
    booting = null;
    throw error;
  });

  return booting;
}

/**
 * Synchronous accessor for tool execution.
 *
 * Throws a message aimed at whoever is reading it — an agent that calls a tool
 * before the engine is up needs to know it should retry, not that some internal
 * field was null.
 */
export function getToolContext(): ToolContext {
  if (!context) {
    throw new Error(
      'The data engine is still starting up. Wait a moment and try again — ' +
        'DuckDB loads on first use and takes a second or two.',
    );
  }
  return context;
}

export function isReady(): boolean {
  return context !== null;
}
