/**
 * Count the data records a CSV file *claims* to contain.
 *
 * Ingestion uses `ignore_errors=true` so that one malformed line cannot reject
 * an entire file — which is right, but it means bad rows vanish without a word.
 * A tool whose whole job is finding data problems must not quietly lose rows,
 * so this gives us an expected count to compare the loaded count against.
 *
 * A newline only ends a record when it is outside quotes; a quoted field may
 * legitimately span lines. Doubled quotes ("") are an escaped quote, not a
 * delimiter change.
 */
export function countCsvRecords(text: string, hasHeader = true): number {
  if (text.length === 0) return 0;

  let records = 0;
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++; // escaped quote inside a quoted field
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === '\n' && !inQuotes) records++;
  }

  // A final line with no trailing newline is still a record.
  if (!text.endsWith('\n') && !text.endsWith('\r')) records++;

  // Blank trailing lines are not records.
  const trailing = text.length - text.replace(/[\r\n]+$/, '').length;
  if (trailing > 1) records -= trailing - 1;

  return Math.max(0, records - (hasHeader ? 1 : 0));
}
