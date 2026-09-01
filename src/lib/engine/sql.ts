/**
 * SQL construction primitives.
 *
 * Everything that interpolates a name or a value into SQL goes through this
 * file. The threat model is specific: an AI agent chooses the arguments to our
 * tools, and cell values inside an uploaded CSV are attacker-controlled text.
 * Neither is trusted input.
 *
 * The defense is layered rather than regex-based:
 *
 * 1. **Table names are never user-supplied.** They are generated here
 *    ({@link generateTableName}) and handed out as opaque IDs. A tool argument
 *    naming a table is resolved through the dataset registry, which either
 *    returns a name we minted or throws.
 * 2. **Column names are validated by membership in the real schema**
 *    ({@link assertKnownColumn}), not by pattern. This is strictly stronger: an
 *    agent can only name a column that actually exists. It also lets legitimate
 *    messy headers — `Order Date`, `total (USD)` — work, which a conservative
 *    regex would break.
 * 3. **Quoting is escape-correct** for anything that does reach SQL.
 *
 * Values in `WHERE`/`SET` positions should prefer bound parameters where the
 * caller can use them; {@link quoteLiteral} exists for the DDL and dynamic-SQL
 * paths where parameters are not permitted by the grammar.
 */

export class UnsafeIdentifierError extends Error {
  override readonly name = 'UnsafeIdentifierError';
}

const MAX_IDENT_LENGTH = 255;

/**
 * Quote a SQL identifier for DuckDB.
 *
 * DuckDB delimits identifiers with double quotes and escapes an embedded double
 * quote by doubling it. Doubling every `"` means the identifier can never
 * terminate early, so an embedded `"; DROP TABLE ...` stays inert text.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new UnsafeIdentifierError('Identifier must not be empty.');
  }
  if (name.length > MAX_IDENT_LENGTH) {
    throw new UnsafeIdentifierError(
      `Identifier exceeds ${MAX_IDENT_LENGTH} characters (got ${name.length}).`,
    );
  }
  if (name.includes('\0')) {
    throw new UnsafeIdentifierError('Identifier must not contain a NUL byte.');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quote a string literal for DuckDB, escaping embedded single quotes. */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new UnsafeIdentifierError('String literal must not contain a NUL byte.');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Assert that `column` is a real column of the dataset, then quote it.
 *
 * @param knownColumns the dataset's actual schema, read from DuckDB
 */
export function assertKnownColumn(column: string, knownColumns: readonly string[]): string {
  if (!knownColumns.includes(column)) {
    throw new UnsafeIdentifierError(
      `Unknown column ${JSON.stringify(column)}. ` +
        `Available columns: ${knownColumns.map((c) => JSON.stringify(c)).join(', ')}.`,
    );
  }
  return quoteIdent(column);
}

const SAFE_PREFIX = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * Mint an opaque table name. The random suffix means a table name is never
 * guessable from user-visible data, and never derived from user input at all.
 */
export function generateTableName(prefix: string): string {
  if (!SAFE_PREFIX.test(prefix)) {
    throw new UnsafeIdentifierError(
      `Table prefix must match ${String(SAFE_PREFIX)} (got ${JSON.stringify(prefix)}).`,
    );
  }

  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  return `${prefix}_${suffix}`;
}
