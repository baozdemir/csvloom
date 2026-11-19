import { guessDelimiter, guessNewline, isEmptyRecord } from './dialect.ts';
import { checkInput, resolveParseConfig, type ParseOptions } from './options.ts';
import { lineStart, scanRows, type ScanDialect } from './parser.ts';
import type {
  DelimiterError,
  DynamicTyping,
  FieldCountError,
  HeaderRow,
  ParseConfig,
  ParseError,
  ParseMeta,
  ParseResult,
  Transform,
  TypedValue,
} from './types.ts';

export const EXTRA_FIELDS = '__parsed_extra';
/** Widest header for which a record template is used; V8 keeps at most 1020 fast properties. */
const TEMPLATE_MAX_WIDTH = 1000;

/** A field's value after dynamicTyping, given its name (header) or index. */
export type FieldTyper = (field: unknown, value: unknown) => unknown;
/** A field's value after transform and dynamicTyping. */
export type FieldConverter = (field: unknown, value: string) => unknown;

/**
 * Parses CSV text that is already in memory. Exactly one leading U+FEFF is an
 * encoding marker and is removed; with header, so is one at the start of each
 * header cell; every other U+FEFF is data. A line break at the end of the input
 * yields a final [''] record, as in Papa Parse 5.7.1. An omitted delimiter or
 * newline is detected as Papa detects it.
 *
 * @example
 * ```ts
 * import { parse } from 'csvloom';
 *
 * const { data, errors, meta } = parse('name,city\nAda,"London, UK"\n', {
 *   header: true,
 *   skipEmptyLines: true,
 * });
 * // data: [{ name: 'Ada', city: 'London, UK' }], errors: [], meta.fields: ['name', 'city']
 * ```
 * @see https://github.com/baozdemir/csvloom#readme
 */
export function parse(
  input: string,
  config: ParseConfig & { header: true; dynamicTyping?: false; transform?: undefined },
): ParseResult<HeaderRow<string>>;
export function parse(
  input: string,
  config?: ParseConfig & { header?: false; dynamicTyping?: false; transform?: undefined },
): ParseResult<string[]>;
export function parse(
  input: string,
  config: ParseConfig & { header: true; dynamicTyping: DynamicTyping; transform?: undefined },
): ParseResult<HeaderRow<TypedValue>>;
export function parse(
  input: string,
  config: ParseConfig & { header?: false; dynamicTyping: DynamicTyping; transform?: undefined },
): ParseResult<TypedValue[]>;
export function parse(
  input: string,
  config: ParseConfig & { header: true; transform: Transform },
): ParseResult<HeaderRow<unknown>>;
export function parse(
  input: string,
  config: ParseConfig & { header?: false; transform: Transform },
): ParseResult<unknown[]>;
/** For a header, dynamicTyping or transform whose kind is known only at run time. */
export function parse(
  input: string,
  config?: ParseConfig,
): ParseResult<unknown[] | HeaderRow<unknown>>;
export function parse(
  input: unknown,
  config: unknown,
): ParseResult<unknown[] | HeaderRow<unknown>, unknown> {
  const source = checkInput(input);
  return parseWith(source, resolveParseConfig(config, 'main'));
}

/**
 * The parse both entries share, after each has checked its input and resolved
 * its config: one leading U+FEFF of input is removed here.
 */
export function parseWith(
  input: string,
  options: ParseOptions,
): ParseResult<unknown[] | HeaderRow<unknown>, unknown> {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const { quoteChar, header, skipEmptyLines, preview, fastMode, rawComments, transformHeader } =
    options;
  // csvloom/papa: Papa's newline detection throws for a quoteChar that is not a string.
  const failure = options.quoteFailure;
  if (failure?.onDetect && options.newline === '') throw new TypeError(failure.onDetect);
  const typed = fieldTyper(options.dynamicTyping);
  const { transform } = options;
  // Papa transforms a field before it types it.
  const convert: FieldConverter | undefined =
    transform === undefined
      ? typed
      : typed === undefined
        ? (field, value) => transform(value, field)
        : (field, value) => typed(field, transform(value, field));
  // Papa guesses a newline of its own for the skip, then again for the text left.
  if (options.skipFirstNLines > 0) {
    const lines = options.skipNewline ?? (options.newline || guessNewline(text, quoteChar));
    text = skipLines(text, options.skipFirstNLines, lines);
  }
  const newline = options.newline || guessNewline(text, quoteChar);
  let delimiter: string;
  let undetectable = false;
  if (typeof options.delimiter === 'function') delimiter = options.delimiter(text);
  else if (options.delimiter !== '') delimiter = options.delimiter;
  else {
    const guess = guessDelimiter(
      text,
      newline,
      skipEmptyLines,
      rawComments,
      options.delimitersToGuess,
    );
    undetectable = guess === undefined;
    delimiter = guess ?? ',';
  }
  // Papa compares comments as given with the delimiter in use: here a returned one or the
  // fallback ','.
  if (rawComments === delimiter) throw new Error('Comment character same as delimiter');
  if (
    failure &&
    text !== '' &&
    fastMode !== true &&
    (fastMode === false || text.includes(failure.quote))
  ) {
    throw new TypeError(failure.onFullPath);
  }
  const dialect: ScanDialect = {
    delimiter,
    newline,
    quoteChar: fastMode === true ? '' : quoteChar,
    escapeChar: options.escapeChar,
    comments: options.comments,
    preview,
    // Papa's quote-free split path counts preview differently; without preview the result is
    // the same, so the text is searched for a quote only when preview is set.
    fastMode:
      fastMode === true || (preview > 0 && fastMode !== false && text.indexOf(quoteChar) === -1),
  };
  const greedy = skipEmptyLines === 'greedy';
  const meta: ParseMeta<unknown> = {
    delimiter,
    linebreak: newline,
    aborted: false,
    truncated: false,
    cursor: 0,
    renamedHeaders: null,
  };
  if (!header) {
    // Converted records are new arrays, as the scanner reuses its own; empty records are
    // removed before converting, as in Papa.
    const typedRows: unknown[][] = [];
    const scan =
      convert === undefined
        ? scanRows(text, dialect)
        : scanRows(text, dialect, (values) => {
            if (skipEmptyLines && isEmptyRecord(values, greedy)) return;
            typedRows.push(values.map((value, j) => convert(j, value)));
          });
    const errors: ParseError[] = scan.errors;
    if (undetectable) errors.push(undetectableError());
    meta.cursor = scan.cursor;
    meta.truncated = scan.truncated;
    if (convert !== undefined) return { data: typedRows, errors, meta };
    if (!skipEmptyLines) return { data: scan.rows, errors, meta };
    const data = scan.rows.filter((row) => !isEmptyRecord(row, greedy));
    return { data, errors, meta };
  }

  let fields: unknown[] | undefined;
  let width = 0;
  let plain = true;
  let template: HeaderRow<unknown> | undefined;
  const data: HeaderRow<unknown>[] = [];
  // Papa reports every quote error before every field-count error.
  const fieldErrors: FieldCountError[] = [];
  const addRecord = (values: readonly string[]) => {
    if (fields === undefined) {
      const header = headerFields(values, transformHeader);
      fields = header.fields;
      meta.renamedHeaders = header.renamedHeaders;
      meta.fields = fields;
      width = fields.length;
      plain = isPlain(fields, convert);
      template = plain ? recordTemplate(fields as string[]) : undefined;
      return;
    }
    let record: HeaderRow<unknown>;
    if (plain) {
      const n = values.length < width ? values.length : width;
      if (template !== undefined && n === width) {
        record = { ...template };
        for (let j = 0; j < width; j++) record[(fields as string[])[j] ?? ''] = values[j] ?? '';
      } else {
        // A short record has only the fields it contains.
        record = {};
        for (let j = 0; j < n; j++) record[(fields as string[])[j] ?? ''] = values[j] ?? '';
      }
      if (values.length > width) record[EXTRA_FIELDS] = values.slice(width);
    } else record = specialRecord(fields, values, convert);
    if (values.length !== width) fieldErrors.push(fieldCountError(width, values, data.length));
    data.push(record);
  };
  let first = true;
  // With skipEmptyLines only. As in Papa, record 0 is renamed before empty records are removed;
  // when it is removed, the next record left is the header as is. Quote-error rows still count
  // the removed records.
  const removeEmpty = (values: readonly string[]) => {
    if (fields !== undefined) {
      if (!isEmptyRecord(values, greedy)) addRecord(values);
      return;
    }
    let names: unknown[];
    if (first) {
      first = false;
      const header = headerFields(values, transformHeader);
      meta.renamedHeaders = header.renamedHeaders;
      names = header.fields;
    } else names = values.slice();
    if (isEmptyRecord(names, greedy)) return;
    fields = names;
    meta.fields = fields;
    width = fields.length;
    plain = isPlain(fields, convert);
    template = plain ? recordTemplate(fields as string[]) : undefined;
  };
  const scan = scanRows(text, dialect, skipEmptyLines ? removeEmpty : addRecord);
  const errors: ParseError[] = scan.errors;
  if (undetectable) errors.push(undetectableError());
  meta.cursor = scan.cursor;
  meta.truncated = scan.truncated;
  meta.fields ??= [];
  for (const error of fieldErrors) errors.push(error);
  return { data, errors, meta };
}

/** Papa's skipFirstNLines: split at newline, drop count lines, join the rest, ignoring quotes. */
function skipLines(text: string, count: number, newline: string): string {
  // csvloom/papa: a newline such as [] splits at ''.
  if (newline === '') return text.slice(count);
  const start = lineStart(text, count, newline);
  return start === -1 ? '' : text.slice(start);
}

/** Papa adds it after the quote errors and before the field-count errors. */
export const undetectableError = (): DelimiterError => ({
  type: 'Delimiter',
  code: 'UndetectableDelimiter',
  message: "Unable to auto-detect delimiting character; defaulted to ','",
});

/**
 * Whether records are built by assignment: no transform or typing, and string
 * names other than __proto__ and __parsed_extra.
 */
export const isPlain = (fields: readonly unknown[], convert: FieldConverter | undefined) =>
  convert === undefined &&
  fields.every((name) => typeof name === 'string' && name !== '__proto__' && name !== EXTRA_FIELDS);

/** The property key JavaScript makes of a header name that is not a string (csvloom/papa). */
const toKey = (name: unknown): PropertyKey => (typeof name === 'symbol' ? name : String(name));

/**
 * An object with every header name as an own property, built once per parse. V8 clones it in one
 * step and keeps the clone in fast mode, where assigning 18 or more keys to {} one by one ends in
 * dictionary mode. Undefined above TEMPLATE_MAX_WIDTH, and when a header name is a read-only or
 * accessor property of Object.prototype, where a clone would differ from assignment.
 */
export function recordTemplate(fields: readonly string[]): HeaderRow<unknown> | undefined {
  if (fields.length > TEMPLATE_MAX_WIDTH) return undefined;
  for (const field of fields) {
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, field);
    if (inherited !== undefined && inherited.writable !== true) return undefined;
  }
  return Object.fromEntries(fields.map((field) => [field, '']));
}

/**
 * Builds a record as Papa's processRow does, for transform or dynamicTyping, or a header name that
 * is __proto__, __parsed_extra or not a string. "__proto__" is defined as an own property, since
 * assigning it would set the prototype. A column whose header is __parsed_extra goes into the
 * extra-fields array, as in Papa.
 */
export function specialRecord(
  fields: readonly unknown[],
  values: readonly string[],
  convert: FieldConverter | undefined,
): HeaderRow<unknown> {
  const record: HeaderRow<unknown> = {};
  for (let j = 0; j < values.length; j++) {
    const field = j < fields.length ? fields[j] : EXTRA_FIELDS;
    const value = convert === undefined ? (values[j] ?? '') : convert(field, values[j] ?? '');
    if (field === EXTRA_FIELDS) {
      const extra = record[EXTRA_FIELDS];
      if (Array.isArray(extra)) extra.push(value);
      else record[EXTRA_FIELDS] = [value];
      continue;
    }
    const key = typeof field === 'string' ? field : toKey(field);
    if (key === '__proto__') {
      Object.defineProperty(record, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else (record as Record<PropertyKey, unknown>)[key] = value;
  }
  return record;
}

/**
 * Papa's choice of the fields to type, except that a name is never looked up on a prototype: true
 * types every field, a map its own keys set to true, and a function is asked once per field per
 * parse (again while it returns undefined) and types on true. Undefined when nothing is typed.
 */
export function fieldTyper(option: ParseOptions['dynamicTyping']): FieldTyper | undefined {
  if (option === false) return undefined;
  if (option === true) return (_field, value) => typedValue(value);
  if (typeof option === 'function') {
    const asked = new Map<unknown, unknown>();
    return (field, value) => {
      let answer = asked.get(field);
      if (answer === undefined) {
        answer = option(field);
        asked.set(field, answer);
      }
      return answer === true ? typedValue(value) : value;
    };
  }
  return (field, value) =>
    Object.hasOwn(option, field as PropertyKey) && option[field as string] === true
      ? typedValue(value)
      : value;
}

const MAX_FLOAT = 2 ** 53;
// Papa Parse's patterns, verbatim.
const FLOAT = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/;
const ISO_DATE =
  /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;

/**
 * Papa's parseDynamic conversion, its tests in order. A non-string from transform goes to each
 * test as given, as in Papa: the patterns and parseFloat convert it with ToString (a Symbol throws
 * a TypeError) and the Date constructor with ToPrimitive (valueOf first).
 */
function typedValue(value: unknown): unknown {
  if (value === 'true' || value === 'TRUE') return true;
  if (value === 'false' || value === 'FALSE') return false;
  // Typed as a string only: the value is passed on unconverted.
  const raw = value as string;
  if (FLOAT.test(raw)) {
    const number = parseFloat(raw);
    // Papa converts once more for the result; only a non-string can tell the difference.
    if (number > -MAX_FLOAT && number < MAX_FLOAT) {
      return typeof value === 'string' ? number : parseFloat(raw);
    }
  }
  if (ISO_DATE.test(raw)) return new Date(raw);
  return value === '' ? null : value;
}

/**
 * Papa Parse 5.7.0's processing of the header record: each cell loses one leading U+FEFF and goes
 * through transformHeader(cell, index); then the Nth repeat of a name becomes name_S with the
 * smallest S >= N that is neither a cell as written nor a name already given. Unlike Papa, nothing
 * is logged. A transformHeader result that is not a string (csvloom/papa only) is the name as
 * returned, its repeats counted by property key as in Papa. A name's suffix search resumes where
 * its last one stopped, which keeps the work linear in the header length.
 */
export function headerFields(
  cells: readonly string[],
  transformHeader: ((header: string, index: number) => unknown) | undefined,
): { fields: unknown[]; renamedHeaders: Record<string, unknown> | null } {
  const fields: unknown[] = [];
  const repeats = new Map<PropertyKey, number>();
  const nextSuffix = new Map<PropertyKey, number>();
  const used = new Set<unknown>(cells);
  let renamedHeaders: Record<string, unknown> | null = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] ?? '';
    let name: unknown = cell.charCodeAt(0) === 0xfeff ? cell.slice(1) : cell;
    if (transformHeader !== undefined) name = transformHeader(name as string, i);
    const key = typeof name === 'string' ? name : toKey(name);
    const count = repeats.get(key);
    if (count === undefined) {
      repeats.set(key, 1);
      fields.push(name);
    } else {
      const base = String(name);
      let suffix = Math.max(count, nextSuffix.get(key) ?? 0);
      let renamed = `${base}_${String(suffix)}`;
      while (used.has(renamed)) renamed = `${base}_${String(++suffix)}`;
      used.add(renamed);
      repeats.set(key, count + 1);
      nextSuffix.set(key, suffix + 1);
      fields.push(renamed);
      renamedHeaders ??= {};
      renamedHeaders[renamed] = name;
    }
    used.add(name);
  }
  return { fields, renamedHeaders };
}

export function fieldCountError(expected: number, values: readonly string[], row: number) {
  const parsed = values.length;
  const tooMany = parsed > expected;
  return {
    type: 'FieldMismatch',
    code: tooMany ? 'TooManyFields' : 'TooFewFields',
    message: `Too ${tooMany ? 'many' : 'few'} fields: expected ${String(expected)} fields but parsed ${String(parsed)}`,
    row,
  } satisfies FieldCountError;
}
