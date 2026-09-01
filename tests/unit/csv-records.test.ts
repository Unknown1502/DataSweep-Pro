import { describe, expect, it } from 'vitest';
import { countCsvRecords } from '../../src/lib/engine/csv-records';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

describe('countCsvRecords', () => {
  it('counts data rows, excluding the header', () => {
    expect(countCsvRecords(['a,b', '1,2', '3,4'].join(NL))).toBe(2);
  });

  it('ignores a trailing newline', () => {
    expect(countCsvRecords(['a,b', '1,2', ''].join(NL))).toBe(1);
  });

  it('ignores several trailing blank lines', () => {
    expect(countCsvRecords(['a,b', '1,2', '', '', ''].join(NL))).toBe(1);
  });

  it('handles CRLF line endings', () => {
    expect(countCsvRecords(['a,b', '1,2', '3,4'].join(CR + NL))).toBe(2);
  });

  it('does not count newlines inside a quoted field', () => {
    // A quoted field may legitimately span lines; counting those as records
    // would report phantom skipped rows on perfectly valid files.
    const csv = ['a,b', '1,"line one', 'line two"', '2,x'].join(NL);
    expect(countCsvRecords(csv)).toBe(2);
  });

  it('treats a doubled quote as an escaped quote, not a delimiter change', () => {
    const csv = ['a', '"say ""hi"", then go"', 'plain'].join(NL);
    expect(countCsvRecords(csv)).toBe(2);
  });

  it('counts a final line with no trailing newline', () => {
    expect(countCsvRecords('a,b' + NL + '1,2')).toBe(1);
  });

  it('returns 0 for a header-only file', () => {
    expect(countCsvRecords('a,b')).toBe(0);
    expect(countCsvRecords('a,b' + NL)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(countCsvRecords('')).toBe(0);
  });

  it('detects the row a naive parser would silently drop', () => {
    // The real case this exists for: an unquoted comma makes the line ragged.
    // The file claims 3 records; DuckDB with ignore_errors loads 2.
    const csv = ['a,b', '1,ok', '2,broken, extra', '3,ok'].join(NL);
    expect(countCsvRecords(csv)).toBe(3);
  });
});
