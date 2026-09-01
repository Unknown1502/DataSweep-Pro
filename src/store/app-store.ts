import { create } from 'zustand';
import { ingestCsv, ingestJson } from '../lib/engine/ingest';
import type { Dataset } from '../lib/engine/registry';
import type { AuditEntry } from '../lib/tools/guards';
import { initToolContext, registry } from '../lib/tools/context';

export type BootStatus = 'booting' | 'ready' | 'failed';

interface AppState {
  status: BootStatus;
  bootError: string | null;

  /** Bumped whenever the registry mutates, to re-derive the dataset list. */
  revision: number;
  datasets: Dataset[];
  selectedId: string | null;

  actionError: string | null;

  activity: AuditEntry[];

  boot: () => Promise<void>;
  pushActivity: (entry: AuditEntry) => void;
  uploadFile: (file: File) => Promise<void>;
  loadSample: (name: string, csv: string) => Promise<void>;
  select: (id: string | null) => void;
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
  activity: [],

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

  select: (id) => set({ selectedId: id, actionError: null }),

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
