import { isDeepStrictEqual } from 'node:util';
import Papa from 'papaparse';
import { mulberry32 } from '../bench/fixtures.ts';
import { parse as papaEntryParse, unparse as papaEntryUnparse } from '../src/papa.ts';
import { parse } from '../src/parse.ts';
import type {
  HeaderRow,
  Newline,
  PapaParseConfig,
  ParseConfig,
  ParseResult,
  UnparseConfig,
} from '../src/types.ts';
import { unparse } from '../src/unparse.ts';

// Compares csvloom with Papa Parse 5.7.1 on the same input, for test/compatibility.test.ts and
// longer fuzz runs. Equality: data by strict deep equality plus record key order, errors and meta
// exactly.

export const DELIMITERS: readonly string[] = [',', ';', '\t'];
export const NEWLINES: readonly string[] = ['\n', '\r\n', '\r'];
/** A delimiter the main entry accepts (D2-k, P3-c). */
export const isDelimiter = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  value !== '"' &&
  value !== '\ufeff' &&
  !/[\r\n]/.test(value);
export const isNewline = (value: unknown): value is Newline =>
  typeof value === 'string' && NEWLINES.includes(value);

/** A config with an explicit delimiter and newline, as the fuzz dialects have. */
export type Dialect = ParseConfig & { delimiter: string; newline: Newline };

/** Every supported dialect, with and without headers. */
export const DIALECTS: readonly Dialect[] = DELIMITERS.flatMap((delimiter) =>
  NEWLINES.flatMap((newline) =>
    [false, true].map((header) => ({ delimiter, newline, header }) as Dialect),
  ),
);

export interface Case {
  input: string;
  config: ParseConfig;
}

/** An entry's parse: csvloom's main entry or csvloom/papa. */
export type EngineParse = (
  input: string,
  config: ParseConfig,
) => ParseResult<unknown[] | HeaderRow<unknown>, unknown>;
export const mainParse: EngineParse = (input, config) => parse(input, config);
/**
 * The fuzz and fixture configs are ones both entries accept. csvloom/papa declares its result
 * as @types/papaparse does; what it returns is the main entry's result, which these tests compare.
 */
export const papaParse: EngineParse = (input, config) =>
  papaEntryParse(input, config as PapaParseConfig) as ReturnType<EngineParse>;

/**
 * isDeepStrictEqual, except that two Dates with the same getTime(), NaN
 * included, are equal on every Node (Node 22.23.4 finds two invalid Dates
 * unequal; 24.22.1 and 26.12.1 equal). Only reached on a difference: it walks
 * arrays and plain objects, and anything else must be strictly equal.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (isDeepStrictEqual(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const proto: unknown = Object.getPrototypeOf(a);
  if (proto !== Object.getPrototypeOf(b)) return false;
  if (proto === Date.prototype) {
    const time = (a as Date).getTime();
    return (
      Object.is(time, (b as Date).getTime()) && Object.keys(a).length + Object.keys(b).length === 0
    );
  }
  if (proto !== Array.prototype && proto !== Object.prototype && proto !== null) return false;
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
  if (Object.getOwnPropertySymbols(a).length + Object.getOwnPropertySymbols(b).length > 0) {
    return false;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => Object.hasOwn(y, key) && sameData(x[key], y[key]))
  );
}

/** A description of the first difference, or null when the results are equal. */
export function difference(actual: unknown, expected: unknown): string | null {
  const a = actual as Papa.ParseResult<unknown>;
  const e = expected as Papa.ParseResult<unknown>;
  if (!sameData(a.data, e.data)) return 'data';
  for (let i = 0; i < e.data.length; i++) {
    const want = e.data[i];
    if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
      if (!isDeepStrictEqual(Object.keys(a.data[i] ?? {}), Object.keys(want))) {
        return `key order of record ${String(i)}`;
      }
    }
  }
  if (!isDeepStrictEqual(a.errors, e.errors)) return 'errors';
  if (!isDeepStrictEqual(a.meta, e.meta)) return 'meta';
  return null;
}

/**
 * Header results not compared, with the reason; their records are still
 * compared without headers (exceptions, golden tests in
 * test/papa-deviations.test.ts):
 * - D2-c: Papa drops a __proto__ column; csvloom keeps it as an own property.
 * - D2-d: Papa does not type a column named like a member of its typing object
 *   (Boolean.prototype for true, Object.prototype for the function form, which
 *   it then does not call for that name); csvloom types it as asked.
 */
export const EXCEPTIONS: ReadonlySet<string> = new Set(['D2-c', 'D2-d']);

/** The header names Papa leaves untyped although the config types them (D2-d). */
function untypedByPapa({ header, dynamicTyping }: ParseConfig, fields: readonly unknown[]) {
  if (!header) return [];
  const members =
    dynamicTyping === true
      ? Boolean.prototype
      : typeof dynamicTyping === 'function'
        ? Object.prototype
        : null;
  return members === null
    ? []
    : fields.filter((name): name is string => typeof name === 'string' && name in members);
}

/** A copy for Papa, which writes into its config; its types omit comments: true. */
export const papaConfig = (config: ParseConfig) => ({ ...config }) as Papa.ParseConfig<unknown>;

/** The config with its delimiter, transformHeader, transform and dynamicTyping functions, if any, recording their calls in order. */
export function recorded(config: ParseConfig) {
  const calls: unknown[][] = [];
  const copy = { ...config };
  const { delimiter, transformHeader, transform, dynamicTyping } = config;
  if (typeof delimiter === 'function') {
    copy.delimiter = (text) => {
      calls.push(['delimiter', text]);
      return delimiter(text);
    };
  }
  if (transformHeader) {
    copy.transformHeader = (header, index) => {
      calls.push(['transformHeader', header, index]);
      return transformHeader(header, index);
    };
  }
  if (transform) {
    copy.transform = (value, field) => {
      calls.push(['transform', value, field]);
      return transform(value, field);
    };
  }
  if (typeof dynamicTyping === 'function') {
    copy.dynamicTyping = (field) => {
      calls.push(['dynamicTyping', field]);
      return dynamicTyping(field);
    };
  }
  return { config: copy, calls };
}

/** The result, or the message of what the call threw. */
function attempt<T>(run: () => T): { value: T } | { thrown: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}
const thrown = (result: { value: unknown } | { thrown: string }) =>
  'thrown' in result ? result.thrown : null;

/**
 * Compares one input with an entry (default: the main entry); returns null, a
 * header exception, or the difference. Both sides throwing the same message
 * counts as equal. A delimiter function, transformHeader, transform and a
 * dynamicTyping function must be called with the same arguments, in the same
 * order, as many times, except the dynamicTyping calls Papa does not make for
 * D2-d names.
 */
export function compare(c: Case, run: EngineParse = mainParse): string | null {
  const { input, config } = c;
  const papa = recorded(config);
  const engine = recorded(config);
  const reference = attempt(() => Papa.parse<unknown>(input, papaConfig(papa.config)));
  const result = attempt(() => run(input, engine.config));
  const untyped = untypedByPapa(config, 'value' in result ? (result.value.meta.fields ?? []) : []);
  const calls =
    untyped.length === 0
      ? engine.calls
      : engine.calls.filter(
          ([kind, field]) =>
            kind !== 'dynamicTyping' || typeof field !== 'string' || !untyped.includes(field),
        );
  if (!isDeepStrictEqual(calls, papa.calls)) return 'callback calls';
  if ('thrown' in reference || 'thrown' in result) {
    return thrown(reference) === thrown(result)
      ? null
      : `throws ${String(thrown(result))} (reference: ${String(thrown(reference))})`;
  }
  const candidate = result.value;
  const exception =
    config.header && candidate.meta.fields?.includes('__proto__')
      ? 'D2-c'
      : untyped.length > 0
        ? 'D2-d'
        : null;
  if (exception) {
    const rows = { ...config, header: false };
    const diff = difference(run(input, rows), Papa.parse(input, papaConfig(rows)));
    return diff ? `${diff} (records of a ${exception} header input)` : exception;
  }
  return difference(candidate, reference.value);
}

export const isFailure = (result: string | null): result is string =>
  result !== null && !EXCEPTIONS.has(result);

const ALPHABET = [
  'a',
  'A',
  'b',
  '_1',
  'é',
  '😀',
  ',',
  ';',
  '\t',
  '"',
  '"',
  '"',
  "'",
  '\\',
  ':',
  '|',
  '#',
  '\n',
  '\r',
  '\r\n',
  ' ',
  '\ufeff',
  '1',
  '0',
  '.',
  'e',
  '-',
  'TRUE',
  'false',
  '2020-01-02T03:04Z',
];

/** Converts some fields and declines others; for the rest it returns undefined, which is not cached. */
const typingFunction = (field: string | number): boolean | undefined => {
  const n = typeof field === 'number' ? field : field.length;
  return n % 3 === 0 ? true : n % 3 === 1 ? undefined : false;
};

/**
 * Options laid over the fuzz cases, up to three at a time, applied in draw
 * order: an object is merged into the config (a key set earlier is replaced),
 * a function returns the new config.
 */
export const OVERLAYS: ReadonlyArray<
  | Partial<ParseConfig>
  | ((config: ParseConfig, dialect: Dialect, random: () => number) => ParseConfig)
> = [
  { quoteChar: "'" },
  { escapeChar: '\\' },
  { delimiter: '::' },
  { delimiter: '|' },
  { comments: '#' },
  { comments: true },
  { comments: '//' },
  // A detection candidate: equal to the delimiter used or tried, it throws in both.
  { comments: ';' },
  { skipEmptyLines: true },
  { skipEmptyLines: 'greedy' },
  { preview: 1 },
  { preview: 2 },
  { preview: 3 },
  { preview: 4 },
  { preview: 5 },
  { skipFirstNLines: 1 },
  { skipFirstNLines: 2 },
  { skipFirstNLines: 3 },
  { fastMode: true },
  { fastMode: false },
  (config) => {
    const copy = { ...config };
    delete copy.delimiter;
    return copy;
  },
  (config) => {
    const copy = { ...config };
    delete copy.newline;
    return copy;
  },
  // Returns the dialect's delimiter, in which the records are written.
  (config, dialect) => ({ ...config, delimiter: () => dialect.delimiter }),
  // '' is automatic too; the default candidates in another order, with a
  // multi-character one.
  { delimiter: '', delimitersToGuess: ['::', ';', '\t', ','] },
  // Detection with options that change what it reads.
  { delimiter: '', comments: '#' },
  { newline: '', skipFirstNLines: 1 },
  // Recorded by compare, with or without header.
  { transformHeader: (h) => h },
  { transformHeader: (h) => h.toLowerCase() },
  { transformHeader: (h) => h.trim() },
  { skipEmptyLines: true, transformHeader: (h) => h.trim() },
  { dynamicTyping: true },
  // A map of the first five column indices, each typed or not at random.
  (config, _dialect, random) => ({
    ...config,
    dynamicTyping: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [i, random() < 0.5])),
  }),
  // Recorded by compare.
  // @ts-expect-error -- returns undefined for some fields, as a JavaScript caller may
  { dynamicTyping: typingFunction },
  // Recorded by compare.
  { transform: (v) => v },
  { transform: (v) => `${v}!` },
  { transform: (v) => v.length },
];

const pick = <T>(random: () => number, items: readonly T[]) =>
  items[Math.floor(random() * items.length)] as T;

/** Arbitrary text, mostly malformed CSV. */
export function soup(random: () => number, maxLength = 30): string {
  let text = '';
  const length = Math.floor(random() * maxLength);
  for (let i = 0; i < length; i++) text += pick(random, ALPHABET);
  return text;
}

/** Records of fields, each quoted (with doubled quotes) or raw at random. */
export function records(
  random: () => number,
  delimiter: string,
  newline: string,
  quote = '"',
): string {
  const lines: string[] = [];
  const count = 1 + Math.floor(random() * 6);
  for (let r = 0; r < count; r++) {
    const fields: string[] = [];
    const width = 1 + Math.floor(random() * 5);
    for (let f = 0; f < width; f++) {
      const field = soup(random).slice(0, 8);
      fields.push(
        random() < 0.5 ? `${quote}${field.replaceAll(quote, quote + quote)}${quote}` : field,
      );
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join(newline) + (random() < 0.5 ? newline : '');
}

/** Removes characters while the input still differs, to report a small example. */
export function minimize(c: Case, run: EngineParse = mainParse): Case {
  let input = c.input;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < input.length; i++) {
      const shorter = input.slice(0, i) + input.slice(i + 1);
      if (isFailure(compare({ input: shorter, config: c.config }, run))) {
        input = shorter;
        changed = true;
        i--;
      }
    }
  }
  return { input, config: c.config };
}

export interface FuzzSummary {
  seed: number;
  cases: number;
  /** At most five minimized failures. */
  failures: Array<Case & { difference: string }>;
}

/**
 * Each dialect gets `perDialect` soup inputs and as many record-shaped inputs.
 * Each pair gets 0, 1, 2 or 3 overlays (each count with probability 1/4),
 * drawn from OVERLAYS with repetition. onConfig, if given, receives the OVERLAYS
 * indices of each pair in draw order and the config they make. run is the
 * entry compared (default: the main entry).
 */
export function fuzz(
  seed: number,
  perDialect: number,
  onConfig?: (overlays: readonly number[], config: ParseConfig) => void,
  run: EngineParse = mainParse,
): FuzzSummary {
  const random = mulberry32(seed);
  const summary: FuzzSummary = { seed, cases: 0, failures: [] };
  for (const dialect of DIALECTS) {
    for (let k = 0; k < perDialect; k++) {
      const drawn: number[] = [];
      let config: ParseConfig = { ...dialect };
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const index = Math.floor(random() * OVERLAYS.length);
        const overlay = OVERLAYS[index] ?? {};
        drawn.push(index);
        config =
          typeof overlay === 'function'
            ? overlay(config, dialect, random)
            : { ...config, ...overlay };
      }
      onConfig?.(drawn, config);
      // Records are written in the dialect when the config leaves it to detection.
      const given = config.delimiter;
      const delimiter = typeof given === 'string' && given !== '' ? given : dialect.delimiter;
      const newline = config.newline || dialect.newline;
      for (const input of [soup(random), records(random, delimiter, newline, config.quoteChar)]) {
        summary.cases++;
        const result = compare({ input, config }, run);
        if (isFailure(result) && summary.failures.length < 5) {
          summary.failures.push({ ...minimize({ input, config }, run), difference: result });
        }
      }
    }
  }
  return summary;
}

// The unparse differential: an entry's unparse against Papa.unparse
// on the same records and options, outputs compared exactly.

const FORMULA_PREFIXES = [
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  '\n',
  '\uff1d',
  '\uff0b',
  '\uff0d',
  '\uff20',
];
/** Signed numbers in the forms the main rule leaves alone and the ones it prefixes (D4-a). */
export const SIGNED_NUMBERS: readonly string[] = [
  '-5',
  '+5',
  '-1.5',
  '5.',
  '.5',
  '-2e3',
  '+1E-2',
  '-',
  '+',
  '-5a',
  '-5 ',
  '-5\n=1',
  '+90 555 123 45 67',
  '-1,5',
  '-1,234.56',
  '-3%',
  '+5.2%',
  '--5',
  '-.',
  '-e5',
];
const NUMBERS = [0, -0, 1, -1.5, 42, 1e21, Number.NaN, Infinity];
const KEYS = ['a', 'b', 'c', '=d', 'e f', '1'];
const EMPTY_ROWS: readonly unknown[][] = [[], [''], [' '], ['', ''], [' ', '\t'], [null]];
const EMPTY_OBJECTS: ReadonlyArray<Record<string, unknown>> = [{}, { a: '' }, { b: ' ' }];
const QUOTE_CHARS = ['"', "'", '$', '~~', ''];
const ESCAPE_CHARS = ['\\', '$', '"', "'", ''];
const UNPARSE_DELIMITERS = [',', ';', '\t', '|', '::', ', ', '\x1e', ''];
const UNPARSE_NEWLINES = ['\n', '\r', '\r\n', '', '$', '\n\n'];
const FORMULA_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['^=', ''],
  ['^[=+]', 'g'],
  ['=', 'y'],
  ['^\\s', ''],
  ['a', 'g'],
];
/** The main entry's error for delimiter '', which Papa accepts. */
const EMPTY_DELIMITER =
  'TypeError: Unparse option "delimiter" must be a non-empty string without "\\r", "\\n", \'"\' and "\\ufeff"';
/** What escapeFormulae: true means in csvloom/papa (D2-i). */
const D2I_FORMULA = /^[=+\-@\t\r]/;
/**
 * D4-a: what escapeFormulae: true means in the main entry, as one RegExp: the
 * look-ahead is the number exemption, the class the eleven first
 * characters.
 */
export const D4A_FORMULA =
  /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$)[=+\-@\t\r\n\uff1d\uff0b\uff0d\uff20]/;
const quoter = (value: unknown, column: number) =>
  typeof value === 'string' ? value.length % 2 === 0 : column % 2 === 1;

export function unparseValue(random: () => number): unknown {
  const r = random();
  if (r < 0.05) return pick(random, SIGNED_NUMBERS);
  if (r < 0.45) {
    const text = soup(random, 6);
    return random() < 0.25 ? pick(random, FORMULA_PREFIXES) + text : text;
  }
  if (r < 0.6) return pick(random, NUMBERS);
  if (r < 0.7) return null;
  if (r < 0.8) return undefined;
  if (r < 0.9) return new Date(random() < 0.5 ? Math.floor(random() * 4e12) : Number.NaN);
  return random() < 0.5;
}

export function unparseArrays(random: () => number): unknown[][] {
  return Array.from({ length: Math.floor(random() * 6) }, () =>
    random() < 0.15
      ? [...pick(random, EMPTY_ROWS)]
      : Array.from({ length: Math.floor(random() * 5) }, () => unparseValue(random)),
  );
}

/** The first object has a key, so a header always exists (see fuzzUnparse). */
export function unparseObjects(random: () => number): Array<Record<string, unknown>> {
  return Array.from({ length: 1 + Math.floor(random() * 5) }, (_, row) => {
    if (row > 0 && random() < 0.15) return { ...pick(random, EMPTY_OBJECTS) };
    const entries = KEYS.filter(() => random() < 0.5).map((key): [string, unknown] => [
      key,
      unparseValue(random),
    ]);
    if (row === 0 && entries.length === 0) entries.push([pick(random, KEYS), unparseValue(random)]);
    return Object.fromEntries(entries);
  });
}

/** A config of random options, with the quotes function and the RegExp left to each library. */
function unparseOptions(random: () => number) {
  const config: UnparseConfig = {};
  let quotesFunction = false;
  let pattern: readonly [string, string] | null = null;
  const maybe = () => random() < 0.5;
  if (maybe()) {
    const kind = Math.floor(random() * 4);
    if (kind < 2) config.quotes = kind === 1;
    else if (kind === 2) config.quotes = Array.from({ length: Math.floor(random() * 5) }, maybe);
    else quotesFunction = true;
  }
  if (maybe()) config.quoteChar = pick(random, QUOTE_CHARS);
  if (maybe()) config.escapeChar = pick(random, ESCAPE_CHARS);
  if (maybe()) config.delimiter = pick(random, UNPARSE_DELIMITERS);
  if (maybe()) config.header = maybe();
  if (maybe()) config.newline = pick(random, UNPARSE_NEWLINES);
  if (maybe()) config.skipEmptyLines = pick(random, [true, false, 'greedy'] as const);
  if (maybe()) {
    config.columns = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
      pick(random, [...KEYS, 'z']),
    );
  }
  if (maybe()) {
    const kind = Math.floor(random() * 3);
    if (kind < 2) config.escapeFormulae = kind === 1;
    else pattern = pick(random, FORMULA_PATTERNS);
  }
  return { config, quotesFunction, pattern };
}

/** The output, or the thrown constructor name and message, and the quotes function's calls. */
function unparseOutcome(
  run: (config: UnparseConfig) => string,
  options: ReturnType<typeof unparseOptions>,
) {
  const calls: unknown[][] = [];
  const config: UnparseConfig = { ...options.config };
  if (options.quotesFunction) {
    config.quotes = (value, column) => {
      calls.push([value, column]);
      return quoter(value, column);
    };
  }
  // Each library gets its own RegExp: a g or y RegExp keeps lastIndex between calls.
  if (options.pattern) config.escapeFormulae = new RegExp(...options.pattern);
  try {
    return { csv: run(config), calls };
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return { thrown: `${name}: ${error instanceof Error ? error.message : String(error)}`, calls };
  }
}

export interface UnparseFuzzSummary {
  seed: number;
  cases: number;
  /** Cases per input shape. */
  shapes: { arrays: number; objects: number };
  /** Cases in which both libraries threw the same error. */
  throws: number;
  /** Main entry: cases with delimiter '' that threw its TypeError (Papa writes them). */
  rejected: number;
  /** The first difference, or null. */
  failure: { input: unknown; config: UnparseConfig; engine: unknown; reference: unknown } | null;
}

/**
 * Generates `cases` inputs, each an array of arrays or an array of objects (with probability 1/2)
 * of ALPHABET strings (a quarter with a formula prefix), SIGNED_NUMBERS, numbers, null, undefined,
 * valid and invalid Dates and booleans, with random options. The reference is Papa.unparse on a
 * copy of the input with escapeFormulae: true, and for the main entry an omitted escapeFormulae,
 * replaced by the entry's rule as one RegExp (D4-a for the main entry, D2-i for csvloom/papa) and
 * nothing else changed. No value is an object other than a Date (which is written before
 * escapeFormulae is read), so string forms are never tested. The output, or the thrown constructor
 * and message, and the quotes function's calls must be equal. The first object always has a key:
 * for an array of objects without one, columns and a header, 'greedy' makes both libraries throw a
 * TypeError whose message quotes their source code (`data[row].join is not a function` in Papa).
 * The main entry must throw its delimiter TypeError for delimiter '' instead (counted as rejected).
 */
export function fuzzUnparse(
  seed: number,
  cases: number,
  entry: 'main' | 'papa' = 'main',
): UnparseFuzzSummary {
  const random = mulberry32(seed);
  const summary: UnparseFuzzSummary = {
    seed,
    cases,
    shapes: { arrays: 0, objects: 0 },
    throws: 0,
    rejected: 0,
    failure: null,
  };
  const run = entry === 'main' ? unparse : papaEntryUnparse;
  const formula = entry === 'main' ? D4A_FORMULA : D2I_FORMULA;
  // The main entry's default is its rule (D4-a); csvloom/papa's default is off.
  const ruled = (config: UnparseConfig) =>
    config.escapeFormulae === true || (entry === 'main' && config.escapeFormulae === undefined);
  for (let k = 0; k < cases; k++) {
    const shape = random() < 0.5 ? 'arrays' : 'objects';
    const input = shape === 'arrays' ? unparseArrays(random) : unparseObjects(random);
    const options = unparseOptions(random);
    summary.shapes[shape]++;
    const copy: unknown[] = structuredClone(input);
    const engine = unparseOutcome((config) => run(input, config), options);
    if (entry === 'main' && options.config.delimiter === '') {
      if (isDeepStrictEqual(engine, { thrown: EMPTY_DELIMITER, calls: [] })) summary.rejected++;
      else
        summary.failure ??= { input, config: options.config, engine, reference: EMPTY_DELIMITER };
      continue;
    }
    const reference = unparseOutcome(
      (config) =>
        Papa.unparse(
          copy as unknown[][],
          {
            ...config,
            ...(ruled(config) ? { escapeFormulae: formula } : {}),
          } as Papa.UnparseConfig,
        ),
      options,
    );
    if (!isDeepStrictEqual(engine, reference)) {
      summary.failure ??= { input, config: options.config, engine, reference };
    } else if ('thrown' in engine) summary.throws++;
  }
  return summary;
}
