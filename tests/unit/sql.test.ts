import { describe, expect, it } from 'vitest';
import {
  UnsafeIdentifierError,
  assertKnownColumn,
  generateTableName,
  quoteIdent,
  quoteLiteral,
} from '../../src/lib/engine/sql';

describe('quoteIdent', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quoteIdent('order_date')).toBe('"order_date"');
  });

  it('preserves identifiers that need quoting to be legal at all', () => {
    // Real CSV headers look like this. Rejecting them would break the product,
    // so they must be quoted correctly rather than pattern-matched away.
    expect(quoteIdent('Order Date')).toBe('"Order Date"');
    expect(quoteIdent('total (USD)')).toBe('"total (USD)"');
    expect(quoteIdent('café')).toBe('"café"');
  });

  it('neutralizes an embedded double quote by doubling it', () => {
    // The one escape that matters: without it, a crafted column name could
    // close the quoted identifier and start writing SQL.
    expect(quoteIdent('evil"name')).toBe('"evil""name"');
  });

  it('renders a quote-escape injection attempt inert', () => {
    const attack = 'x" ; DROP TABLE users; --';
    const quoted = quoteIdent(attack);

    // Every embedded quote is doubled, so the identifier never terminates early.
    expect(quoted).toBe('"x"" ; DROP TABLE users; --"');
    // Sanity: the payload is inside the quoted region, not beside it.
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    expect(quoted.slice(1, -1).split('""').length).toBe(2);
  });

  it('rejects identifiers that cannot be safely quoted', () => {
    expect(() => quoteIdent('')).toThrow(UnsafeIdentifierError);
    expect(() => quoteIdent('has\0null')).toThrow(UnsafeIdentifierError);
    expect(() => quoteIdent('x'.repeat(256))).toThrow(UnsafeIdentifierError);
  });
});

describe('quoteLiteral', () => {
  it('wraps and escapes single quotes', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('renders a classic string-break injection inert', () => {
    expect(quoteLiteral("'; DROP TABLE datasets; --")).toBe("'''; DROP TABLE datasets; --'");
  });

  it('rejects embedded NUL', () => {
    expect(() => quoteLiteral('a\0b')).toThrow(UnsafeIdentifierError);
  });
});

describe('assertKnownColumn', () => {
  const schema = ['id', 'Order Date', 'amount'];

  it('returns the quoted column when it exists in the schema', () => {
    expect(assertKnownColumn('Order Date', schema)).toBe('"Order Date"');
  });

  it('rejects any column not present in the real schema', () => {
    // Membership in the actual schema is a stronger guarantee than a regex:
    // an agent can only ever name a column that genuinely exists.
    expect(() => assertKnownColumn('password', schema)).toThrow(UnsafeIdentifierError);
    expect(() => assertKnownColumn('amount; DROP TABLE x', schema)).toThrow(UnsafeIdentifierError);
  });

  it('is case-sensitive, matching DuckDB quoted-identifier semantics', () => {
    expect(() => assertKnownColumn('AMOUNT', schema)).toThrow(UnsafeIdentifierError);
  });

  it('names the offending column in the error, for a usable agent-facing message', () => {
    expect(() => assertKnownColumn('nope', schema)).toThrow(/nope/);
  });
});

describe('generateTableName', () => {
  it('produces an opaque, prefixed, SQL-safe name', () => {
    const name = generateTableName('ds');
    expect(name).toMatch(/^ds_[0-9a-f]{12}$/);
    expect(() => quoteIdent(name)).not.toThrow();
  });

  it('does not collide across calls', () => {
    const names = new Set(Array.from({ length: 500 }, () => generateTableName('ckpt')));
    expect(names.size).toBe(500);
  });

  it('rejects a prefix that would itself be unsafe', () => {
    expect(() => generateTableName('bad name')).toThrow(UnsafeIdentifierError);
  });
});
