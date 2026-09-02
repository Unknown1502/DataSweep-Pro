import { create } from 'zustand';
import { dropTables } from '../lib/engine/apply';
import { ingestCsv, ingestJson } from '../lib/engine/ingest';
import type { ExportReceipt } from '../lib/integrations/github';
import type { ExportManifest } from '../lib/integrations/manifest';
import type { Dataset } from '../lib/engine/registry';
import type { AuditEntry } from '../lib/tools/guards';
import { initToolContext, registry } from '../lib/tools/context';

export type BootStatus = 'booting' | 'ready' | 'failed';

/**
 * Which pane of the dataset workspace is showing.
 *
 * One piece of state drives both the left navigation and the tab strip, so the
 * two can never disagree about where the user is.
 */
export type WorkspaceView =
  | 'overview'
  | 'findings'
  | 'data'
  | 'ledger'
  | 'lineage'
  | 'rules'
  | 'exports'
  | 'docs';

/**
 * One external publication, as the ledger records it.
 *
 * Carries everything needed to answer "what left this machine, when, at whose
 * instruction, and where did it land" without holding the artifacts themselves.
 */
export interface ExportRecord {
  readonly id: string;
  readonly datasetId: string;
  readonly datasetName: string;
  readonly at: string;
  readonly actor: 'human';
  readonly destination: string;
  readonly manifestHash: string;
  readonly artifactPaths: readonly string[];
  readonly receipt: ExportReceipt;
}

interface AppState {
  status: BootStatus;
  bootError: string | null;

  /** Bumped whenever the registry mutates, to re-derive the dataset list. */
  revision: number;
  datasets: Dataset[];
  selectedId: string | null;

  actionError: string | null;

  view: WorkspaceView;
  activity: AuditEntry[];
  /** External publications, newest last. Never persisted. */
  exports: ExportRecord[];

  boot: () => Promise<void>;
  pushActivity: (entry: AuditEntry) => void;
  recordExport: (manifest: ExportManifest, receipt: ExportReceipt) => void;
  removeDataset: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  loadSample: (name: string, csv: string) => Promise<void>;
  select: (id: string | null) => void;
  setView: (view: WorkspaceView) => void;
  refresh: () => void;
  setActionError: (message: string | null) => void;
}

export const useApp = create<AppState>((set, get) => ({
  status: 'booting',
  bootError: null,
  revision: 0,
  datasets: [],
  selectedId: null,
  actionError: null,
  view: 'overview',
  activity: [],
  exports: [],

  boot: async () => {
    try {
      await initToolContext();
      set({ status: 'ready' });
    } catch (error) {
      set({
        status: 'failed',
        bootError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  uploadFile: async (file: File) => {
    const ctx = await initToolContext();
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json');

    const dataset = isJson
      ? await ingestJson(ctx.engine, registry, file.name, text)
      : await ingestCsv(ctx.engine, registry, file.name, text);

    get().refresh();
    get().select(dataset.id);
  },

  /**
   * Forget a dataset and free the tables behind it.
   *
   * The registry decides whether it may go; this only carries out the drop and
   * tidies up what pointed at it. The export ledger is deliberately left alone:
   * it records that a publication happened, and that remains true after the
   * dataset is gone.
   */
  removeDataset: async (id: string) => {
    const ctx = await initToolContext();
    try {
      const tables = registry.remove(id);
      await dropTables(ctx.engine, tables);
    } catch (error) {
      set({ actionError: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (get().selectedId === id) get().select(null);
    get().refresh();
  },

  loadSample: async (name: string, csv: string) => {
    const ctx = await initToolContext();
    const dataset = await ingestCsv(ctx.engine, registry, name, csv);
    get().refresh();
    get().select(dataset.id);
  },

  /**
   * Appending is separate from boot() and idempotent per entry id.
   *
   * Subscribing inside boot() was a bug: React re-invokes effects (StrictMode
   * does it deliberately in development), so each extra subscription appended
   * every tool call to the ledger again. The id guard makes a duplicate
   * subscription harmless rather than merely unlikely.
   */
  pushActivity: (entry) =>
    set((state) =>
      state.activity.some((e) => e.id === entry.id)
        ? state
        : { activity: [...state.activity, entry].slice(-500) },
    ),

  /**
   * Record a publication that has already happened.
   *
   * Called only after a receipt exists, so the ledger never shows an export
   * that did not complete. Keyed by manifest hash: a retry that returns the
   * cached receipt updates nothing rather than logging a second publication.
   */
  recordExport: (manifest, receipt) =>
    set((state) =>
      state.exports.some((e) => e.manifestHash === manifest.manifestHash)
        ? state
        : {
            exports: [
              ...state.exports,
              {
                id: `exp_${manifest.manifestHash.slice(0, 12)}`,
                datasetId: manifest.datasetId,
                datasetName: manifest.datasetName,
                at: receipt.createdAt,
                actor: 'human',
                destination:
                  `${manifest.destination.owner}/${manifest.destination.repo}` +
                  ` · ${manifest.destination.branch}`,
                manifestHash: manifest.manifestHash,
                artifactPaths: manifest.artifacts.map((a) => a.path),
                receipt,
              },
            ],
          },
    ),

  // Opening a different dataset always lands on Overview: carrying a pane like
  // "Lineage" across datasets shows a view of something the user did not ask
  // about.
  select: (id) => set({ selectedId: id, actionError: null, view: 'overview' }),

  setView: (view) => set({ view }),

  refresh: () =>
    set((state) => ({ revision: state.revision + 1, datasets: registry.list() })),

  setActionError: (actionError) => set({ actionError }),
}));

/** The currently selected dataset, or null. */
export function useSelectedDataset(): Dataset | null {
  const id = useApp((s) => s.selectedId);
  // Depend on revision so a checkpoint append re-renders consumers.
  useApp((s) => s.revision);
  if (!id || !registry.has(id)) return null;
  return registry.resolve(id);
}
