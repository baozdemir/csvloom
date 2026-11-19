import {
  BAD_DELIMITERS,
  PLAIN_NUMBER,
  resolveUnparseConfig,
  type UnparseOptions,
} from './options.ts';
import type { UnparseConfig, UnparseInput } from './types.ts';

/**
 * Writes records as CSV text, as Papa Parse 5.7.1's unparse does (see
 * UnparseInput and UnparseConfig), but never modifies the input, and
 * escapeFormulae is on by default (Papa's default is off).
 *
 * @example
 * ```ts
 * import { unparse, excel } from 'csvloom';
 *
 * unparse([{ name: 'Ada', note: '=1+1' }]);
 * // 'name,note\r\nAda,"\'=1+1"': a value a spreadsheet would run is escaped
 * unparse(rows, excel); // a BOM, "\r\n" and ",", for Microsoft Excel
 * ```
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/compatibility.md
 */
export function unparse(input: UnparseInput, config?: UnparseConfig): string {
  const options = resolveUnparseConfig(config, 'main');
  const sepLine = options.sepLine ? `sep=${options.delimiter}${options.newline}` : '';
  return (options.bom ? '\ufeff' : '') + sepLine + unparseWith(input, options);
}

/** unparse options for a spreadsheet whose list separator is ",": unparse(rows, excel). */
export const excel = /* @__PURE__ */ Object.freeze({
  bom: true,
  newline: '\r\n',
  delimiter: ',',
  escapeFormulae: true,
});
/** unparse options for a spreadsheet whose list separator is ";": unparse(rows, excelSemicolon). */
export const excelSemicolon = /* @__PURE__ */ Object.freeze({
  bom: true,
  newline: '\r\n',
  delimiter: ';',
  escapeFormulae: true,
});

// The reads below follow Papa Parse 5.7.1's unparse step by step, so an input outside
// UnparseInput gives Papa's result or, in csvloom/papa, Papa's TypeError. The main entry
// throws a TypeError naming the input part instead.

/**
 * A value whose members are read as JavaScript reads them. serialize and safe index it directly
 * so that each read keeps its own inline cache; a shared helper would go megamorphic.
 */
type Indexed = Record<PropertyKey, unknown>;
/** value[key] as JavaScript reads it, for the reads made once per call. */
const at = (value: unknown, key: unknown): unknown =>
  (value as Record<PropertyKey, unknown>)[key as PropertyKey];
/** Object.keys, which throws for null and undefined. */
const keys = (value: unknown): string[] => Object.keys(value as object);
const parsed = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
const missing = (value: unknown) => value === null || value === undefined;
const kind = (value: unknown) => (value === null ? 'null' : typeof value);

/** Record row; in the main entry, a null or undefined one (Papa reads its properties) throws. */
function checkRecord(value: unknown, row: number, main: boolean): unknown {
  if (main && missing(value)) {
    throw new TypeError(
      `Unparse input record ${String(row)} must be an array or an object, got ${kind(value)}`,
    );
  }
  return value;
}

/** Papa's JsonToCsv input handling, with locals where Papa writes into the input. */
export function unparseWith(input: unknown, options: UnparseOptions): string {
  const value = parsed(input);
  const main = options.policy === 'main';
  if (main && missing(value)) {
    throw new TypeError(
      `Unparse input must be an array, an object or a JSON string, got ${kind(value)}`,
    );
  }
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    // Papa Parse 5.7.1: an empty array with columns writes their header.
    if (value.length === 0) return serialize(options.columns, value, options);
    if (Array.isArray(first)) return serialize(null, value, options);
    if (typeof first === 'object') {
      return serialize(options.columns ?? keys(checkRecord(first, 0, main)), value, options);
    }
  } else if (typeof value === 'object') {
    // What Papa's read of null.data throws.
    if (value === null) throw new TypeError("Cannot read properties of null (reading 'data')");
    const { data: given, fields: givenFields, meta } = value as Record<string, unknown>;
    let data = parsed(given);
    let fields = givenFields;
    if (Array.isArray(data)) {
      fields ||= (meta && at(meta, 'fields')) || options.columns;
      const first: unknown = data[0];
      fields ||= Array.isArray(first)
        ? fields
        : typeof first === 'object'
          ? keys(checkRecord(first, 0, main))
          : [];
      // Papa's [1, 2, 3] or ['abc'] is one record.
      if (!Array.isArray(first) && typeof first !== 'object') data = [data];
    }
    return serialize(fields || [], data || [], options);
  }
  throw new Error('Unable to serialize unrecognized input');
}

/**
 * serialize grows its output with +=, which V8 keeps as a rope whose nodes the collector moves
 * again and again once it is large. Every FLAT_UNITS units a RegExp test, which needs a flat
 * subject, flattens what was written so far, so those nodes die young.
 */
const FLAT_UNITS = 1 << 16;
const FLATTENS = /^/;

/** Papa's serialize. */
function serialize(fieldsGiven: unknown, dataGiven: unknown, options: UnparseOptions): string {
  const { header, delimiter, newline, skipEmptyLines } = options;
  const fields = parsed(fieldsGiven);
  const data = parsed(dataGiven) as Indexed;
  const hasHeader = Array.isArray(fields) && fields.length > 0;
  const keyed = !Array.isArray(data[0]);
  const quoting = quoteTest(delimiter, options.quoteChar);
  // quoteChar as a global RegExp: V8 builds the result of a RegExp replace in one piece, and
  // that of replaceAll with a string piece by piece.
  const quoteAll = quoting === null ? null : new RegExp(unitEscape(options.quoteChar), 'g');
  // done: the closed parts; csv: the rope being grown.
  let done = '';
  let csv = '';
  if (hasHeader && header) {
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) csv += delimiter;
      csv += safe(fields[i], i, options, quoting, quoteAll);
    }
    if ((data.length as number) > 0) csv += newline;
  }
  const main = options.policy === 'main';
  for (let row = 0; row < (data.length as number); row++) {
    const record = checkRecord(data[row], row, main) as Indexed;
    const maxCol = (hasHeader ? fields.length : record.length) as number;
    let emptyLine = false;
    const nullLine = hasHeader ? keys(record).length === 0 : record.length === 0;
    if (skipEmptyLines === 'greedy' && !hasHeader) {
      if (main && typeof record.join !== 'function') {
        throw new TypeError(
          `Unparse input record ${String(row)} must be an array with skipEmptyLines "greedy", got ${kind(record)}`,
        );
      }
      emptyLine = (record as unknown as unknown[]).join('').trim() === '';
    } else if (skipEmptyLines && !hasHeader && record.length === 1) {
      // Papa Parse 5.7.1: a record that holds only null or undefined is empty.
      const only = record[0];
      emptyLine = missing(only) || (only as Indexed).length === 0;
    }
    if (skipEmptyLines === 'greedy' && hasHeader) {
      const line: unknown[] = [];
      for (let c = 0; c < maxCol; c++) line.push(record[(keyed ? fields[c] : c) as PropertyKey]);
      emptyLine = line.join('').trim() === '';
    }
    if (!emptyLine) {
      for (let col = 0; col < maxCol; col++) {
        if (col > 0 && !nullLine) csv += delimiter;
        // Two reads, so a row's index and a record's key each keep their own inline cache.
        const value = hasHeader && keyed ? record[fields[col] as PropertyKey] : record[col];
        csv += safe(value, col, options, quoting, quoteAll);
      }
      if (row < (data.length as number) - 1 && (!skipEmptyLines || (maxCol > 0 && !nullLine))) {
        csv += newline;
      }
      if (csv.length > FLAT_UNITS) {
        FLATTENS.test(csv);
        done += csv;
        csv = '';
      }
    }
  }
  return done + csv;
}

/**
 * One test for every character that makes safe quote a value: BAD_DELIMITERS, the delimiter and
 * quoteChar, each as its UTF-16 unit. null when the delimiter or quoteChar is not one unit: safe
 * then tests as Papa does.
 */
function quoteTest(delimiter: string, quoteChar: string): RegExp | null {
  if (delimiter.length !== 1 || quoteChar.length !== 1) return null;
  return new RegExp(`[${[...BAD_DELIMITERS, delimiter, quoteChar].map(unitEscape).join('')}]`);
}

/** A UTF-16 unit as a RegExp escape, so no unit is read as RegExp syntax. */
const unitEscape = (unit: string) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** One value, quoted when needed, as Papa's safe does. */
function safe(
  value: unknown,
  column: number,
  options: UnparseOptions,
  quoting: RegExp | null,
  quoteAll: RegExp | null,
): string {
  if (value === undefined || value === null) return '';
  if ((value as Indexed).constructor === Date) {
    const date = value as Date;
    return isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const { quotes, quoteChar, escapedQuote, delimiter, escapeFormulae, exemptNumbers } = options;
  let str = value;
  let needsQuotes: unknown = false;
  if (
    escapeFormulae &&
    typeof value === 'string' &&
    formula(value, escapeFormulae, exemptNumbers)
  ) {
    str = `'${value}`;
    needsQuotes = true;
  }
  let strValue = (str as { toString(): string }).toString();
  // As in Papa Parse 5.7.1, every other value but a number, a bigint or a boolean is tested by
  // its string form: an array, a wrapper, another object, a function or a symbol.
  if (
    escapeFormulae &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint' &&
    typeof value !== 'boolean' &&
    formula(strValue, escapeFormulae, exemptNumbers)
  ) {
    // Papa's +, which reads a non-string's valueOf before its toString.
    strValue = "'" + strValue;
    needsQuotes = true;
  }
  // A toString may return any value; one that is no string takes Papa's steps below.
  if (quoting !== null && quoteAll !== null && typeof strValue === 'string') {
    // Papa's steps in one scan; what may run the caller's code comes first, as in Papa.
    const asked: unknown =
      needsQuotes ||
      quotes === true ||
      (typeof quotes === 'function' && quotes(str, column)) ||
      (Array.isArray(quotes) && quotes[column]);
    // '' is tested first: charCodeAt past the end makes V8 stop inlining the call.
    const last = strValue.length - 1;
    if (
      quoting.test(strValue) ||
      (last >= 0 && (strValue.charCodeAt(0) === 0x20 || strValue.charCodeAt(last) === 0x20))
    ) {
      return quoteChar + strValue.replace(quoteAll, escapedQuote) + quoteChar;
    }
    return asked ? quoteChar + strValue + quoteChar : strValue;
  }
  const escaped = strValue.replaceAll(quoteChar, escapedQuote);
  // In Papa's order, so the quotes function is not called once the answer is known.
  needsQuotes =
    needsQuotes ||
    quotes === true ||
    (typeof quotes === 'function' && quotes(str, column)) ||
    (Array.isArray(quotes) && quotes[column]) ||
    hasBad(escaped) ||
    escaped.includes(delimiter) ||
    strValue.includes(quoteChar) ||
    escaped.startsWith(' ') ||
    escaped.endsWith(' ');
  return needsQuotes ? quoteChar + escaped + quoteChar : escaped;
}

/**
 * Whether text holds one of BAD_DELIMITERS (Papa's hasAny). A loop, since some() on the frozen
 * array takes V8's generic path.
 */
function hasBad(text: string): boolean {
  for (let i = 0; i < BAD_DELIMITERS.length; i++) {
    if (text.includes(BAD_DELIMITERS[i] as string)) return true;
  }
  return false;
}

/**
 * Whether escapeFormulae prefixes text. The main rule decides on the first
 * unit, so a value that starts with any other character costs no RegExp call.
 */
function formula(text: string, pattern: RegExp, exemptNumbers: boolean): boolean {
  if (!exemptNumbers) return pattern.test(text);
  // exemptNumbers means pattern is MAIN_FORMULA, whose first characters are tested here without
  // a RegExp. '' is answered first: charCodeAt past the end makes V8 stop inlining the call.
  if (text === '') return false;
  switch (text.charCodeAt(0)) {
    case 0x09:
    case 0x0a:
    case 0x0d:
    case 0x2b:
    case 0x2d:
    case 0x3d:
    case 0x40:
    case 0xff0b:
    case 0xff0d:
    case 0xff1d:
    case 0xff20:
      return !PLAIN_NUMBER.test(text);
    default:
      return false;
  }
}
