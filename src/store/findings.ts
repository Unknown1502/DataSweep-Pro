import { create } from 'zustand';
import { callTool } from '../lib/tools';

export interface Finding {
  id: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  column: string | null;
  description: string;
  affected_rows: number;
  total_rows: number;
  evidence: string | null;
  reasoning?: {
    measurement: string;
    severity_calculation: string;
    why_this_fix?: string;
    why_no_fix?: string;
  };
  suggested_fix: {
    operation: string;
    column: string | null;
    parameters: Record<string, unknown>;
    rationale: string;
  } | null;
}

export interface CheckRun {
  check: string;
  start_offset_ms: number;
  duration_ms: number;
  findings: number;
  failed: boolean;
}

export interface ScanReport {
  dataset_id: string;
  quality_score: number;
  summary: string;
  issues: Finding[];
  rows_skipped_at_load: number;
  concurrency?: { total_ms: number; sum_of_check_ms: number; checks: CheckRun[] };
}

interface FindingsState {
  /** Keyed by dataset id, so switching datasets does not show a stale report. */
  reports: Record<string, ScanReport>;
  scanning: string | null;
  error: string | null;
  scan: (datasetId: string) => Promise<void>;
  invalidate: (datasetId: string) => void;
}

/**
 * One scan, shared by every pane that needs it.
 *
 * Overview, Findings and the nav facts all want the same report; letting each
 * fetch its own would run the analyzers three times over the same data and let
 * the three disagree while one of them was still in flight.
 */
export const useFindings = create<FindingsState>((set, get) => ({
  reports: {},
  scanning: null,
  error: null,

  scan: async (datasetId) => {
    if (get().scanning === datasetId) return;
    set({ scanning: datasetId, error: null });
    try {
      const report = (await callTool('detect_data_quality_issues', {
        dataset_id: datasetId,
      })) as ScanReport;
      set((state) => ({ reports: { ...state.reports, [datasetId]: report } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ scanning: null });
    }
  },

  invalidate: (datasetId) =>
    set((state) => {
      const next = { ...state.reports };
      delete next[datasetId];
      return { reports: next };
    }),
}));

export const SEVERITY_TONE = {
  high: 'danger',
  medium: 'warn',
  low: 'neutral',
} as const;
