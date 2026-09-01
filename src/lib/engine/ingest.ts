import { countCsvRecords } from './csv-records';
import { getColumns, getRowCount } from './introspect';
import type { Dataset, DatasetRegistry } from './registry';
import { generateTableName, quoteIdent, quoteLiteral } from './sql';
import { type SqlEngine, SqlError } from './types';

export class IngestError extends Error {
  override readonly name = 'IngestError';
}

/** 64 MB. DuckDB-Wasm holds the table in browser memory, so this is a real ceiling. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface IngestOptions {
  /** Override delimiter detection. Omit to let DuckDB sniff it. */
  readonly delimiter?: string;
}

function assertSize(content: string, fileName: string): void {
  // Rough: JS strings are UTF-16, DuckDB stores UTF-8. Close enough for a guard.
  const bytes = new Blob([content]).size;
  if (bytes > MAX_FILE_BYTES) {
    throw new IngestError(
      `${fileName} is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${MAX_FILE_BYTES / 1024 / 1024} MB limit for in-browser processing.`,
    );
  }
  if (content.trim().length === 0) {
    throw new IngestError(`${fileName} is empty.`);
  }
}

/**
 * Load a CSV into DuckDB and register it.
 *
 * `all_varchar=true` is the important choice and it is deliberate: every column
 * lands as text. A cleaning tool must not let the database coerce or reject
 * malformed values on the way in — inconsistent dates, stray currency symbols
 * and empty strings are precisely what the user is here to find. Typing is a
 * transformation the user opts into later, not a silent precondition.
 *
 * `sample_size=-1` makes the header/delimiter sniff read the whole file rather
 * than the first 20 KB, which otherwise mis-detects files whose messiness
 * starts further down.
 */
export async function ingestCsv(
  engine: SqlEngine,
  registry: DatasetRegistry,
  fileName: string,
  content: string,
  options: IngestOptions = {},
): Promise<Dataset> {
  assertSize(content, fileName);

  // Strip a UTF-8 BOM: DuckDB would otherwise fold it into the first column
  // name, producing a column no user can address by the name they can see.
  const cleaned = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const tableId = generateTableName('ds');
  const virtualFile = `${tableId}.csv`;

  const readOptions = [
    'all_varchar=true',
    'header=true',
    'sample_size=-1',
    // Keep going on ragged rows; a malformed line is data to report, not a
    // reason to reject the user's file outright.
    'ignore_errors=true',
    ...(options.delimiter ? [`delim=${quoteLiteral(options.delimiter)}`] : []),
  ].join(', ');

  await engine.registerFileText(virtualFile, cleaned);
  try {
    await engine.query(
      `CREATE TABLE ${quoteIdent(tableId)} AS
         SELECT * FROM read_csv(${quoteLiteral(virtualFile)}, ${readOptions})`,
    );
  } catch (cause) {
    const detail = cause instanceof SqlError ? cause.message : String(cause);
    throw new IngestError(`Could not parse ${fileName} as CSV. ${detail}`);
  } finally {
    // The virtual file is only needed for the CREATE TABLE; the table owns the
    // data now. Leaving it registered would pin the whole file in memory twice.
    await engine.dropFile(virtualFile);
  }

  const [columns, rowCount] = await Promise.all([
    getColumns(engine, tableId),
    getRowCount(engine, tableId),
  ]);

  if (columns.length === 0) {
    throw new IngestError(`${fileName} produced no columns — is it a valid CSV?`);
  }

  // ignore_errors=true means unparseable lines were dropped without complaint.
  // Compare against what the file actually contained so the loss is reported.
  const expected = countCsvRecords(cleaned);
  const skipped = Math.max(0, expected - rowCount);

  return registry.create(
    fileName,
    { rowCount, columns, createdAt: new Date().toISOString() },
    tableId,
    skipped,
  );
}

/** Load a JSON array of objects. */
export async function ingestJson(
  engine: SqlEngine,
  registry: DatasetRegistry,
  fileName: string,
  content: string,
): Promise<Dataset> {
  assertSize(content, fileName);

  const tableId = generateTableName('ds');
  const virtualFile = `${tableId}.json`;

  await engine.registerFileText(virtualFile, content);
  try {
    await engine.query(
      `CREATE TABLE ${quoteIdent(tableId)} AS
         SELECT * FROM read_json(${quoteLiteral(virtualFile)},
           auto_detect=true, format='array', records=true)`,
    );
  } catch (cause) {
    const detail = cause instanceof SqlError ? cause.message : String(cause);
    throw new IngestError(
      `Could not parse ${fileName} as JSON. Expected an array of objects. ${detail}`,
    );
  } finally {
    await engine.dropFile(virtualFile);
  }

  const [columns, rowCount] = await Promise.all([
    getColumns(engine, tableId),
    getRowCount(engine, tableId),
  ]);

  return registry.create(
    fileName,
    { rowCount, columns, createdAt: new Date().toISOString() },
    tableId,
  );
}
