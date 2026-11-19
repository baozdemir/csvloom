import { detectDialect, sepLineDelimiter } from './detect.ts';
import { guessDelimiter, guessNewline, isEmptyRecord } from './dialect.ts';
import { positionsAt, recordStarts, START } from './locate.ts';
import { checkInput, resolveDetailedConfig, type Features, type ParseOptions } from './options.ts';
import { parseWith } from './parse.ts';
import { lineStart, scanRows, type ScanDialect } from './parser.ts';
import { mixedNewline, repairRows } from './repair.ts';
import { validateRowSync } from './schema.ts';
import type {
  DelimiterError,
  DetailedConfig,
  Detection,
  DynamicTyping,
  FeatureResult,
  FieldCountError,
  HeaderRow,
  Located,
  Newline,
  ParseError,
  ParseResult,
  Position,
  SchemaError,
  StandardSchemaV1,
  Transform,
  TypedValue,
} from './types.ts';

type Plain = DetailedConfig & { schema?: undefined };
type WithSchema<Output> = Omit<DetailedConfig, 'schema'> & {
  schema: StandardSchemaV1<unknown, Output>;
};
type MaybeSchema<Output> = Omit<DetailedConfig, 'schema'> & {
  schema?: StandardSchemaV1<unknown, Output> | undefined;
};

/**
 * parse with the features of DetailedConfig: positions on errors, repair with a change log, row
 * validation by a schema, and the "sep=" line. Without a feature key it returns what parse
 * returns. With one, the records are collected before the rows are built, which is slower than
 * parse.
 *
 * @example
 * ```ts
 * import { formatError, parseDetailed } from 'csvloom';
 *
 * const text = 'id;name;qty\n1;Ada;3\n2;Grace\n';
 * const result = parseDetailed(text, { detect: true, header: true, positions: true, skipEmptyLines: true });
 * result.meta.delimiter; // ';'
 * for (const error of result.errors) console.log(formatError(error));
 * // Too few fields: expected 3 fields but parsed 2 [TooFewFields] at line 3, column 1 (row 1, offset 20)
 * //   3 | 2;Grace
 * //     | ^
 * ```
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/features.md
 */
export function parseDetailed(
  input: string,
  config: Plain & { header: true; dynamicTyping?: false; transform?: undefined },
): FeatureResult<HeaderRow<string>>;
export function parseDetailed(
  input: string,
  config?: Plain & { header?: false; dynamicTyping?: false; transform?: undefined },
): FeatureResult<string[]>;
export function parseDetailed(
  input: string,
  config: Plain & { header: true; dynamicTyping: DynamicTyping; transform?: undefined },
): FeatureResult<HeaderRow<TypedValue>>;
export function parseDetailed(
  input: string,
  config: Plain & { header?: false; dynamicTyping: DynamicTyping; transform?: undefined },
): FeatureResult<TypedValue[]>;
export function parseDetailed(
  input: string,
  config: Plain & { header: true; transform: Transform },
): FeatureResult<HeaderRow<unknown>>;
export function parseDetailed(
  input: string,
  config: Plain & { header?: false; transform: Transform },
): FeatureResult<unknown[]>;
/** For a header, dynamicTyping or transform whose kind is known only at run time. */
export function parseDetailed(
  input: string,
  config?: Plain,
): FeatureResult<unknown[] | HeaderRow<unknown>>;
/** With a schema, the rows are its output and the errors may be Schema errors. */
export function parseDetailed<Output>(
  input: string,
  config: WithSchema<Output>,
): FeatureResult<Output, ParseError | SchemaError>;
/** For a schema that may be undefined; a variable typed DetailedConfig gives unknown rows. */
export function parseDetailed<Output>(
  input: string,
  config?: MaybeSchema<Output>,
): FeatureResult<Output | unknown[] | HeaderRow<unknown>, ParseError | SchemaError>;
export function parseDetailed(
  input: unknown,
  config?: unknown,
): ParseResult<unknown, unknown> | FeatureResult<unknown, ParseError | SchemaError> {
  const source = checkInput(input);
  const options = resolveDetailedConfig(config);
  return options.features === null
    ? parseWith(source, options)
    : parseFeatures(source, options, options.features);
}

const BREAKS: readonly Newline[] = ['\r\n', '\n', '\r'];

/**
 * Where the text after a "sep=" line starts, or 0 when the first line is not one: "sep=", one
 * unit that can be a delimiter, then newline (when omitted, "\r\n", "\n" or "\r") or the end of
 * the text.
 */
function sepLineEnd(text: string, newline: '' | Newline): number {
  for (const end of newline === '' ? BREAKS : [newline]) {
    if (sepLineDelimiter(text, end) !== undefined) return Math.min(text.length, 5 + end.length);
  }
  return 0;
}

/**
 * The feature path, which mirrors parseWith on the same helpers: one U+FEFF, the "sep=" line,
 * skipFirstNLines, the dialect, the scan, repair, the records, the schema, and positions for the
 * errors and the repairs. The start-up only removes prefixes, so input.length - text.length units
 * come before text.
 */
function parseFeatures(
  input: string,
  options: ParseOptions,
  features: Features,
): FeatureResult<unknown, ParseError | SchemaError> {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const { header, skipEmptyLines, preview, fastMode, rawComments } = options;
  let { quoteChar, escapeChar } = options;
  const typed = fieldTyper(options.dynamicTyping);
  const { transform } = options;
  const convert: FieldConverter | undefined =
    transform === undefined
      ? typed
      : typed === undefined
        ? (field, value) => transform(value, field)
        : (field, value) => typed(field, transform(value, field));
  // Under detect the detector reads the "sep=" line and the preamble, unless skipFirstNLines is
  // given: the line is then read here, before the skip, and the rest is the table.
  const skipGiven = features.given.has('skipFirstNLines');
  const byDetector = features.detect && !skipGiven;
  let sepDelimiter: string | undefined;
  const sepEnd =
    (features.sepLine || features.detect) && !byDetector ? sepLineEnd(text, options.newline) : 0;
  if (sepEnd > 0) {
    sepDelimiter = text.charAt(4);
    text = text.slice(sepEnd);
  }
  if (options.skipFirstNLines > 0) {
    text = skipLines(
      text,
      options.skipFirstNLines,
      options.newline || guessNewline(text, quoteChar),
    );
  }
  let detected: Detection | undefined;
  if (features.detect) {
    const fixed: Parameters<typeof detectDialect>[2] = {};
    const delimiterGiven =
      typeof options.delimiter === 'function'
        ? options.delimiter(text)
        : options.delimiter || sepDelimiter;
    if (delimiterGiven !== undefined) fixed.delimiter = delimiterGiven;
    if (options.newline !== '') fixed.newline = options.newline;
    if (features.given.has('quoteChar')) fixed.quoteChar = quoteChar;
    if (features.given.has('escapeChar')) fixed.escapeChar = escapeChar;
    // The main entry's candidates are strings (null is csvloom/papa's).
    const candidates = options.delimitersToGuess as readonly string[];
    detected = detectDialect(text, candidates, fixed, !byDetector);
    const before = input.length - text.length;
    text = text.slice(detected.start);
    detected.start += before;
    if (sepEnd > 0) detected.sepLine = true;
    ({ quoteChar, escapeChar } = detected);
  }
  // mixed-newline applies only when no newline was given and the text mixes two kinds. Under
  // preview, reading an unclosed quote's line again would scan past the limit, so unclosed-quote
  // is left out.
  const rules = new Set(features.repair);
  const mixed =
    rules.has('mixed-newline') && options.newline === ''
      ? mixedNewline(text, quoteChar)
      : undefined;
  if (mixed === undefined) rules.delete('mixed-newline');
  if (preview > 0) rules.delete('unclosed-quote');
  const newline = options.newline || (mixed ?? detected?.newline ?? guessNewline(text, quoteChar));
  let delimiter: string;
  let undetectable = false;
  if (detected !== undefined) delimiter = detected.delimiter;
  else if (typeof options.delimiter === 'function') delimiter = options.delimiter(text);
  else if (options.delimiter !== '') delimiter = options.delimiter;
  else if (sepDelimiter !== undefined) delimiter = sepDelimiter;
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
  if (rawComments === delimiter) throw new Error('Comment character same as delimiter');
  const dialect: ScanDialect = {
    delimiter,
    newline,
    quoteChar: fastMode === true ? '' : quoteChar,
    escapeChar,
    comments: options.comments,
    preview,
    fastMode:
      fastMode === true || (preview > 0 && fastMode !== false && text.indexOf(quoteChar) === -1),
  };
  const greedy = skipEmptyLines === 'greedy';
  const meta: FeatureResult<unknown>['meta'] = {
    delimiter,
    linebreak: newline,
    aborted: false,
    truncated: false,
    cursor: 0,
    renamedHeaders: null,
  };

  const scan = scanRows(text, dialect);
  const { rows } = scan;
  meta.cursor = scan.cursor;
  meta.truncated = scan.truncated;
  // repairRows and the loop below both name record 0; transformHeader still runs once per cell.
  const transformHeader = once(options.transformHeader);
  const scanned = rows.length;
  // A scan that preview ended has not read the last record of the input, except where preview
  // counts lines and the last line is that record: then the last record read starts at the end.
  const atEnd =
    !scan.truncated ||
    (scanned > 0 && recordStarts(text, dialect, [scanned - 1])[0] === text.length);
  const repaired =
    features.repair === null
      ? undefined
      : repairRows({
          text,
          // A record is found, and a line read again, without the limit of preview.
          dialect: { ...dialect, preview: 0, fastMode: false },
          rows,
          errors: scan.errors,
          width: undefined,
          header,
          transformHeader,
          skipEmptyLines,
          rules,
          atEnd,
          before: START,
        });
  // Under preview the rows are those parse returns for the repaired text: a record that was
  // split counts as the records it became.
  if (repaired !== undefined && preview > 0 && rows.length > scanned) {
    const keep = previewRows(text, dialect, rows.length, repaired.startsOf);
    if (keep < rows.length) {
      rows.length = keep;
      meta.truncated = true;
    }
  }

  // The rows built, and for each the index in rows of its record.
  let data: unknown[] = [];
  const origin: number[] = [];
  const fieldErrors: FieldCountError[] = [];
  let fields: unknown[] | undefined;
  let first = true;
  rows.forEach((values, k) => {
    if (header && fields === undefined) {
      // With skipEmptyLines, record 0 is named before it is tested, and the first record left
      // is the header, a later one as it is.
      let names: unknown[] = values;
      if (first) {
        first = false;
        const named = headerFields(values, transformHeader);
        // The main entry's transformHeader returns strings.
        meta.renamedHeaders = named.renamedHeaders as Record<string, string> | null;
        names = named.fields;
      }
      if (skipEmptyLines && isEmptyRecord(names, greedy)) return;
      fields = names;
      return;
    }
    if (skipEmptyLines && isEmptyRecord(values, greedy)) return;
    origin.push(k);
    if (fields === undefined) {
      data.push(convert === undefined ? values : values.map((value, j) => convert(j, value)));
      return;
    }
    if (values.length !== fields.length) {
      fieldErrors.push(fieldCountError(fields.length, values, data.length));
    }
    // specialRecord builds the same records as parseWith's faster template path.
    data.push(specialRecord(fields, values, convert));
  });
  if (header) meta.fields = (fields ?? []) as string[];
  if (detected !== undefined) meta.detected = detected;
  if (detected?.sepLine ?? sepEnd > 0) meta.sepLine = true;

  const errors: Array<Located<ParseError | SchemaError>> = scan.errors;
  if (undetectable) errors.push(undetectableError());
  for (const error of fieldErrors) errors.push(error);
  const { schema } = features;
  if (schema !== null) {
    const valid: unknown[] = [];
    data.forEach((row, i) => {
      const checked = validateRowSync(schema, row, i);
      if (Array.isArray(checked)) for (const error of checked) errors.push(error);
      else valid.push(checked.value);
    });
    data = valid;
  }

  // Each place in text: an error at its opening quote or record start, a repair at its span start.
  const places: Array<{ at: number; target: Partial<Position> }> = [];
  if (features.positions) {
    const rowOf = (error: FieldCountError | SchemaError) => origin[error.row] ?? 0;
    const byRow = errors.filter(
      (error) => error.type === 'FieldMismatch' || error.type === 'Schema',
    );
    const wanted = [...new Set(byRow.map(rowOf))].sort((a, b) => a - b);
    // No second scan without such an error.
    const starts =
      wanted.length === 0
        ? []
        : (repaired?.startsOf(wanted) ?? recordStarts(text, dialect, wanted));
    const startOf = new Map(wanted.map((k, j) => [k, starts[j] ?? 0]));
    for (const error of errors) {
      if (error.type === 'Quotes') places.push({ at: error.index - 1, target: error });
      else if (error.type !== 'Delimiter') {
        places.push({ at: startOf.get(rowOf(error)) ?? 0, target: error });
      }
    }
  }
  for (const entry of repaired?.entries ?? []) places.push({ at: entry.offset, target: entry });
  if (places.length > 0) {
    places.sort((a, b) => a.at - b.at);
    const shift = input.length - text.length;
    const positions = positionsAt(
      input,
      places.map(({ at }) => shift + at),
    );
    places.forEach(({ target }, i) => Object.assign(target, positions[i]));
  }

  const result: FeatureResult<unknown, ParseError | SchemaError> = { data, errors, meta };
  if (repaired !== undefined) {
    result.repairs = repaired.entries;
    result.repairCounts = repaired.counts;
  }
  return result;
}

/**
 * How many of count repaired rows a scan of the repaired text returns under dialect.preview.
 * Counting records: preview of them. Counting lines: the rows on the lines before line preview,
 * plus the first row after them when fewer than preview rows came before it. Pieces of a split
 * record share a line; every further line break between two rows ends a comment line.
 */
function previewRows(
  text: string,
  dialect: ScanDialect,
  count: number,
  startsOf: (rows: readonly number[]) => number[],
): number {
  const { preview, newline } = dialect;
  if (!dialect.fastMode || dialect.comments === '') return Math.min(count, preview);
  const starts = startsOf(Array.from({ length: Math.min(count, preview + 1) }, (_, i) => i));
  let line = 0;
  let from = 0;
  for (const [i, start] of starts.entries()) {
    let breaks = 0;
    for (let at = text.indexOf(newline, from); at !== -1 && at < start;) {
      breaks++;
      at = text.indexOf(newline, at + newline.length);
    }
    line += i === 0 ? breaks : Math.max(breaks, 1);
    if (line >= preview) return i < preview ? i + 1 : i;
    from = start;
  }
  return count;
}

/** transformHeader, called once per cell and index: a repeated call returns the first result. */
function once(transformHeader: ParseOptions['transformHeader']): ParseOptions['transformHeader'] {
  if (transformHeader === undefined) return undefined;
  const seen: Array<{ cell: string; name: unknown }> = [];
  return (cell, index) => {
    const known = seen[index];
    if (known?.cell === cell) return known.name;
    const name = transformHeader(cell, index);
    seen[index] = { cell, name };
    return name;
  };
}

// From here on: copies of helpers of src/parse.ts, documented there. A test keeps each one
// identical to its original.

const EXTRA_FIELDS = '__parsed_extra';
type FieldTyper = (field: unknown, value: unknown) => unknown;
type FieldConverter = (field: unknown, value: string) => unknown;

function skipLines(text: string, count: number, newline: string): string {
  // csvloom/papa: a newline such as [] splits at ''.
  if (newline === '') return text.slice(count);
  const start = lineStart(text, count, newline);
  return start === -1 ? '' : text.slice(start);
}

const undetectableError = (): DelimiterError => ({
  type: 'Delimiter',
  code: 'UndetectableDelimiter',
  message: "Unable to auto-detect delimiting character; defaulted to ','",
});

const toKey = (name: unknown): PropertyKey => (typeof name === 'symbol' ? name : String(name));

function specialRecord(
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

function fieldTyper(option: ParseOptions['dynamicTyping']): FieldTyper | undefined {
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

// 2 ** 53, written out: a bundler keeps an unused `2 ** 53`, as it cannot prove it pure.
const MAX_FLOAT = 9007199254740992;
const FLOAT = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/;
const ISO_DATE =
  /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;

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

function headerFields(
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

function fieldCountError(expected: number, values: readonly string[], row: number) {
  const parsed = values.length;
  const tooMany = parsed > expected;
  return {
    type: 'FieldMismatch',
    code: tooMany ? 'TooManyFields' : 'TooFewFields',
    message: `Too ${tooMany ? 'many' : 'few'} fields: expected ${String(expected)} fields but parsed ${String(parsed)}`,
    row,
  } satisfies FieldCountError;
}
