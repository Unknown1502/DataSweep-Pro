import type { Row } from '../engine/types';

/**
 * Serialize rows to CSV or JSON for direct download.
 *
 * Pure functions — no engine access, no I/O. The caller queries the live
 * checkpoint table and hands the result here.
 *
 * This is deliberately not reachable through any WebMCP tool. Every other
 * export (SQL, pandas, dbt, the GE suite, docs) describes the transformations;
 * this is the one place actual cell values leave as data rather than as code.
 * The tool surface is capped at 15 for agent-selection accuracy, and an agent
 * has no legitimate reason to pull a bulk row dump when `preview_dataset`
 * already gives it a bounded, quarantined sample — so this stays a button, not
 * a tool.
 *
 * Quarantine does not apply here the way it does everywhere else. The fence
 * exists to stop cell content from reaching an agent's instruction context; a
 * human downloading their own file back is not that threat model, and
 * wrapping every value in `<untrusted-data>` tags would hand back a CSV that
 * is not the CSV they uploaded.
 */

const NL = String.fromCharCode(13) + String.fromCharCode(10);

/** RFC 4180: quote a field only when it needs it, and double embedded quotes. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(columns: readonly string[], rows: readonly Row[]): string {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(','));
  }
  // Trailing CRLF: several spreadsheet tools mis-read a CSV whose last line
  // has no terminator as having one fewer row.
  return lines.join(NL) + NL;
}

export function rowsToJson(rows: readonly Row[]): string {
  return JSON.stringify(rows, null, 2);
}
