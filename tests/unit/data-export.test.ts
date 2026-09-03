import { describe, expect, it } from 'vitest';
import { rowsToCsv, rowsToJson } from '../../src/lib/domain/data-export';

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

describe('rowsToCsv', () => {
  it('writes a header and rows, each terminated CRLF', () => {
    const csv = rowsToCsv(['id', 'name'], [{ id: 1, name: 'Ada' }, { id: 2, name: 'Alan' }]);
    expect(csv).toBe(`id,name${CRLF}1,Ada${CRLF}2,Alan${CRLF}`);
  });

  it('quotes a field containing a comma', () => {
    const csv = rowsToCsv(['note'], [{ note: 'a, b' }]);
    expect(csv).toContain('"a, b"');
  });

  it('quotes a field containing a double quote, and doubles it', () => {
    const csv = rowsToCsv(['note'], [{ note: 'she said "hi"' }]);
    expect(csv).toContain('"she said ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    const csv = rowsToCsv(['note'], [{ note: 'line one\nline two' }]);
    expect(csv).toContain('"line one\nline two"');
  });

  it('leaves an ordinary field unquoted', () => {
    const csv = rowsToCsv(['id'], [{ id: 42 }]);
    expect(csv.split(CRLF)[1]).toBe('42');
  });

  it('renders null and undefined as an empty field, not the string "null"', () => {
    const csv = rowsToCsv(['a', 'b'], [{ a: null, b: undefined }]);
    expect(csv.split(CRLF)[1]).toBe(',');
  });

  it('quotes the header row too', () => {
    const csv = rowsToCsv(['a "weird", column'], []);
    expect(csv.split(CRLF)[0]).toBe('"a ""weird"", column"');
  });

  it('follows the exact column order given, not object key order', () => {
    const csv = rowsToCsv(['b', 'a'], [{ a: 1, b: 2 }]);
    expect(csv.split(CRLF)[1]).toBe('2,1');
  });

  it('produces one line per row for an empty table', () => {
    expect(rowsToCsv(['a', 'b'], [])).toBe(`a,b${CRLF}`);
  });
});

describe('rowsToJson', () => {
  it('round-trips rows exactly', () => {
    const rows = [{ id: 1, name: 'Ada' }, { id: 2, name: null }];
    expect(JSON.parse(rowsToJson(rows))).toEqual(rows);
  });

  it('is pretty-printed for a human opening the file', () => {
    expect(rowsToJson([{ a: 1 }])).toContain('\n');
  });
});
