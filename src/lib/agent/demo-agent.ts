import { callTool } from '../tools';
import type { Agent, AgentRun } from './types';

/**
 * A deterministic agent that drives the real tools.
 *
 * It is not a language model and does not pretend to be one — it follows a
 * fixed plan. What it demonstrates is the part that actually matters and that a
 * model cannot fake: the tools are real, the confirmation gate is real, and no
 * change reaches the data without a human approving a measured preview.
 *
 * It exists because the alternative demo paths both have a setup cost (a relay
 * to install, or an API key to paste), and an evaluator who cannot get past
 * setup sees nothing at all.
 */

interface Issue {
  id: string;
  type: string;
  severity: string;
  column: string | null;
  description: string;
  suggested_fix: {
    operation: string;
    column: string | null;
    parameters: Record<string, unknown>;
    rationale: string;
  } | null;
}

/** Fixes the demo will offer. Outlier clipping is deliberately excluded. */
const SAFE_TO_PROPOSE = new Set([
  'remove_duplicates',
  'trim_whitespace',
  'standardize_dates',
  'parse_numbers',
  'normalize_case',
]);

export const demoAgent: Agent = {
  id: 'demo',
  label: 'Guided demo',
  blurb: 'A scripted agent that calls the real tools. No API key needed.',
  needsKey: false,

  async *run(datasetId: string): AgentRun {
    try {
      yield { type: 'say', text: 'Looking at what is loaded.' };
      yield { type: 'tool', name: 'list_datasets', args: {} };

      const listing = (await callTool('list_datasets', {})) as {
        datasets: { dataset_id: string; name: string; rows: number; columns: string[] }[];
      };
      const dataset = listing.datasets.find((d) => d.dataset_id === datasetId);
      if (!dataset) {
        yield { type: 'error', text: 'That dataset is no longer loaded.' };
        return;
      }

      yield {
        type: 'result',
        name: 'list_datasets',
        summary: `${dataset.name} — ${dataset.rows.toLocaleString()} rows, ${dataset.columns.length} columns.`,
      };

      yield { type: 'say', text: 'Scanning for quality problems. This only reads the data.' };
      yield {
        type: 'tool',
        name: 'detect_data_quality_issues',
        args: { dataset_id: datasetId },
      };

      const report = (await callTool('detect_data_quality_issues', {
        dataset_id: datasetId,
      })) as { quality_score: number; issues: Issue[]; summary: string };

      yield {
        type: 'result',
        name: 'detect_data_quality_issues',
        summary: report.summary,
      };

      const injected = report.issues.filter((i) => i.type === 'injected_content');
      if (injected.length > 0) {
        yield {
          type: 'say',
          text:
            `Before anything else: ${injected.length} column(s) contain text written to ` +
            `manipulate an AI agent — instructions telling me to ignore my task, call tools, or ` +
            `send your data somewhere. I am reading those cells as data only. They reached me ` +
            `inside a quarantine fence, so I could not act on them even if I misread them.`,
        };
      }

      const fixable = report.issues.filter(
        (i) => i.suggested_fix && SAFE_TO_PROPOSE.has(i.suggested_fix.operation),
      );

      if (fixable.length === 0) {
        yield {
          type: 'done',
          text:
            report.issues.length === 0
              ? `No issues found. Quality score ${report.quality_score}/100.`
              : `I found ${report.issues.length} issue(s), but none I would fix automatically — ` +
                `they need a judgement call from you. Review them in the panel.`,
        };
        return;
      }

      yield {
        type: 'say',
        text:
          `I can fix ${fixable.length} of these. I will show you exactly what each one changes ` +
          `before it touches anything.`,
      };

      let applied = 0;

      for (const issue of fixable) {
        const fix = issue.suggested_fix!;
        const args = {
          dataset_id: datasetId,
          transformations: [
            { operation: fix.operation, column: fix.column, parameters: fix.parameters },
          ],
        };

        yield { type: 'tool', name: 'apply_cleaning_transformations', args };

        const preview = (await callTool('apply_cleaning_transformations', args)) as {
          summary: string;
          details: Record<string, unknown>;
          confirmation_token: string;
        };

        const approved = yield {
          type: 'approve',
          toolName: 'apply_cleaning_transformations',
          summary: preview.summary,
          details: preview.details,
        };

        if (!approved) {
          yield { type: 'say', text: 'Skipped. Nothing was changed.' };
          continue;
        }

        await callTool('apply_cleaning_transformations', {
          ...args,
          confirmation_token: preview.confirmation_token,
        });
        applied += 1;

        yield {
          type: 'result',
          name: 'apply_cleaning_transformations',
          summary: `Applied. ${fix.rationale}`,
        };
      }

      if (applied === 0) {
        yield { type: 'done', text: 'Nothing applied. The data is exactly as you left it.' };
        return;
      }

      yield { type: 'tool', name: 'generate_impact_report', args: { dataset_id: datasetId } };
      const impact = (await callTool('generate_impact_report', {
        dataset_id: datasetId,
      })) as {
        rows_original: number;
        rows_current: number;
        current_quality_score: number;
        steps_applied: number;
      };

      yield {
        type: 'done',
        text:
          `Done. ${applied} change(s) applied across ${impact.steps_applied} step(s). ` +
          `${impact.rows_original.toLocaleString()} rows in, ` +
          `${impact.rows_current.toLocaleString()} out. Quality is now ` +
          `${impact.current_quality_score}/100. Every step is in the ledger on the left — ` +
          `click any entry to go back.`,
      };
    } catch (error) {
      yield {
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
