/**
 * Regex patterns used to bucket raw text values by format.
 *
 * These are written with `String.raw` for a reason that bites otherwise: in an
 * ordinary JS string, `\d` is an unrecognised escape and collapses to a bare
 * `d`, so the pattern silently stops matching digits and every column looks
 * consistent. `String.raw` keeps the backslash, and these are handed to DuckDB
 * (RE2) rather than to the JS engine.
 */

export interface FormatPattern {
  readonly id: string;
  /** Shown to the user, e.g. "DD/MM/YYYY". */
  readonly label: string;
  readonly regex: string;
}

export const DATE_PATTERNS: readonly FormatPattern[] = [
  { id: 'iso_datetime', label: 'YYYY-MM-DD HH:MM', regex: String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}` },
  { id: 'iso', label: 'YYYY-MM-DD', regex: String.raw`^\d{4}-\d{2}-\d{2}$` },
  { id: 'slash', label: 'D/M/YYYY or M/D/YYYY', regex: String.raw`^\d{1,2}/\d{1,2}/\d{2,4}$` },
  { id: 'dotted', label: 'D.M.YYYY', regex: String.raw`^\d{1,2}\.\d{1,2}\.\d{4}$` },
  { id: 'month_first', label: 'Mon D, YYYY', regex: String.raw`^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$` },
  { id: 'day_first', label: 'D Mon YYYY', regex: String.raw`^\d{1,2} [A-Za-z]{3,9},? \d{4}$` },
  { id: 'compact', label: 'YYYYMMDD', regex: String.raw`^\d{8}$` },
];

const CURRENCY_SYMBOLS = '$£€¥';

export const NUMBER_PATTERNS: readonly FormatPattern[] = [
  { id: 'plain', label: '1200.50', regex: String.raw`^-?\d+(\.\d+)?$` },
  { id: 'thousands_comma', label: '1,200.50', regex: String.raw`^-?\d{1,3}(,\d{3})+(\.\d+)?$` },
  { id: 'thousands_space', label: '1 200,50', regex: String.raw`^-?\d{1,3}( \d{3})+([.,]\d+)?$` },
  { id: 'european', label: '1.200,50', regex: String.raw`^-?\d{1,3}(\.\d{3})+(,\d+)?$` },
  { id: 'currency', label: `${CURRENCY_SYMBOLS[0]}1,200.50`, regex: `^[${CURRENCY_SYMBOLS}] ?-?[\d,. ]+$` },
  { id: 'percent', label: '12.5%', regex: String.raw`^-?\d+(\.\d+)?\s?%$` },
  { id: 'accounting_negative', label: '(1,200.50)', regex: String.raw`^\(\d[\d,. ]*\)$` },
];

/** A column is only judged on format consistency if most of it looks like that kind. */
export const FORMAT_CONFIDENCE_THRESHOLD = 0.6;
