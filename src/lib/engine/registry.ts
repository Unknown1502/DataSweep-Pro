import { generateTableName, quoteIdent } from './sql';

/**
 * A point-in-time snapshot of a dataset. Each checkpoint is backed by a real
 * DuckDB table, which is what makes undo an O(1) pointer move rather than a
 * replay of inverse transformations.
 */
export interface Checkpoint {
  /** Opaque id, and also the physical table name. */
  readonly id: string;
  /** Short human/agent-readable description of what produced this state. */
  readonly label: string;
  /** Tool that produced it; `null` for the original upload. */
  readonly tool: string | null;
  readonly args: unknown;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly createdAt: string;
}

export interface Dataset {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /**
   * Append-only history. `history[0]` is always the original upload, so the
   * unmodified data is never destroyed by any sequence of transformations.
   */
  readonly history: readonly Checkpoint[];
  /**
   * Index into `history` that is currently "live". Undo/redo moves this pointer
   * rather than mutating data.
   */
  readonly headIndex: number;
  /**
   * Rows present in the source file that the parser could not read and
   * skipped. Non-zero means data was silently lost at ingest, which the
   * quality report must surface rather than leave for the user to discover.
   */
  readonly skippedRows: number;
  /**
   * Datasets this one was derived from — currently only set by a join.
   *
   * Without this the lineage view would have to infer relationships that are
   * not recorded anywhere, i.e. draw edges that do not exist. An empty array
   * means "loaded from a file", which is the honest default.
   */
  readonly parents: readonly string[];
}

export class UnknownDatasetError extends Error {
  override readonly name = 'UnknownDatasetError';
}

export class UnknownCheckpointError extends Error {
  override readonly name = 'UnknownCheckpointError';
}

/**
 * The identifier allowlist.
 *
 * Tool arguments name datasets by opaque id. `resolve()` either returns a
 * dataset this registry minted, or throws — so a crafted `dataset_id` such as
 * `'; DROP TABLE users; --` fails here, before any SQL is built, rather than
 * being sanitized downstream. No caller may construct a table name from a tool
 * argument by any other route.
 */
export class DatasetRegistry {
  readonly #datasets = new Map<string, Dataset>();

  /**
   * Register a newly ingested dataset.
   *
   * `tableId` lets the caller pass a name it already materialized — ingestion
   * has to create and inspect the table before it knows the row count and
   * columns. It must still come from {@link generateTableName}; the security
   * property is that table names are minted, never derived from user input.
   */
  create(
    name: string,
    initial: Omit<Checkpoint, 'id' | 'tool' | 'args' | 'label'>,
    tableId?: string,
    skippedRows = 0,
    parents: readonly string[] = [],
  ): Dataset {
    const id = tableId ?? generateTableName('ds');
    const checkpoint: Checkpoint = {
      ...initial,
      id,
      label: 'Original upload',
      tool: null,
      args: null,
    };

    const dataset: Dataset = {
      id,
      name,
      createdAt: checkpoint.createdAt,
      history: [checkpoint],
      headIndex: 0,
      skippedRows,
      parents,
    };

    this.#datasets.set(id, dataset);
    return dataset;
  }

  /** Resolve an untrusted id to a known dataset, or throw. */
  resolve(id: unknown): Dataset {
    if (typeof id !== 'string') {
      throw new UnknownDatasetError(`dataset_id must be a string (got ${typeof id}).`);
    }
    const dataset = this.#datasets.get(id);
    if (!dataset) {
      throw new UnknownDatasetError(
        `Unknown dataset_id ${JSON.stringify(id)}. ` +
          `Call list_datasets to see available datasets.`,
      );
    }
    return dataset;
  }

  /** The checkpoint currently live for a dataset. */
  head(id: unknown): Checkpoint {
    const dataset = this.resolve(id);
    const checkpoint = dataset.history[dataset.headIndex];
    if (!checkpoint) {
      // Unreachable while headIndex is maintained by this class alone.
      throw new UnknownCheckpointError(`Dataset ${dataset.id} has a dangling head pointer.`);
    }
    return checkpoint;
  }

  /**
   * The quoted, ready-to-interpolate table name for a dataset's live state.
   * This is the only sanctioned way to get a table name into SQL.
   */
  resolveTable(id: unknown): string {
    return quoteIdent(this.head(id).id);
  }

  list(): Dataset[] {
    return [...this.#datasets.values()];
  }

  has(id: string): boolean {
    return this.#datasets.has(id);
  }

  /**
   * Append a new state and make it live.
   *
   * If the head is not at the tip (the user undid, then applied something new),
   * the abandoned future is discarded — the same semantics as undo/redo in an
   * editor. The discarded tables are returned so the caller can drop them.
   */
  appendCheckpoint(
    id: unknown,
    checkpoint: Omit<Checkpoint, 'id'>,
  ): { dataset: Dataset; checkpoint: Checkpoint; discarded: Checkpoint[] } {
    const dataset = this.resolve(id);
    const kept = dataset.history.slice(0, dataset.headIndex + 1);
    const discarded = dataset.history.slice(dataset.headIndex + 1);

    const created: Checkpoint = { ...checkpoint, id: generateTableName('ckpt') };
    const history = [...kept, created];
    const updated: Dataset = { ...dataset, history, headIndex: history.length - 1 };

    this.#datasets.set(dataset.id, updated);
    return { dataset: updated, checkpoint: created, discarded: [...discarded] };
  }

  /**
   * Move the live pointer to an existing checkpoint. Data is not deleted, so
   * this is reversible in both directions.
   */
  moveHead(id: unknown, checkpointId: string): Dataset {
    const dataset = this.resolve(id);
    const index = dataset.history.findIndex((c) => c.id === checkpointId);
    if (index === -1) {
      throw new UnknownCheckpointError(
        `Unknown checkpoint ${JSON.stringify(checkpointId)} for dataset ${dataset.id}.`,
      );
    }

    const updated: Dataset = { ...dataset, headIndex: index };
    this.#datasets.set(dataset.id, updated);
    return updated;
  }

  /**
   * Remove a dataset. Returns every physical table that should be dropped.
   *
   * Every checkpoint's table is returned, not only the live one — undone states
   * are still materialized and would otherwise leak for the tab's lifetime.
   *
   * Refuses when another dataset was joined from this one. Lineage is a claim
   * about where data came from; letting a parent vanish would leave that claim
   * pointing at nothing, and a lineage view that quietly loses a node is worse
   * than one that will not let you break it.
   */
  remove(id: unknown): string[] {
    const dataset = this.resolve(id);

    const children = [...this.#datasets.values()].filter(
      (d) => d.id !== dataset.id && d.parents.includes(dataset.id),
    );
    if (children.length > 0) {
      throw new Error(
        `"${dataset.name}" was joined into ${children.map((c) => `"${c.name}"`).join(', ')}. ` +
          'Remove the joined dataset first — otherwise its lineage would point at a dataset ' +
          'that no longer exists.',
      );
    }

    this.#datasets.delete(dataset.id);
    return dataset.history.map((c) => c.id);
  }

  clear(): void {
    this.#datasets.clear();
  }
}
