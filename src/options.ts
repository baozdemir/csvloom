import { DEFAULT_DELIMITERS } from './dialect.ts';
import { isStandardSchema } from './schema.ts';
import type { Newline, RepairRule, StandardSchemaV1 } from './types.ts';

/**
 * Thrown when a config or input asks for a Papa Parse feature that csvloom leaves out, such as
 * workers, downloads, callbacks or a File, Blob or stream input.
 */
export class UnsupportedFeatureError extends Error {
  override readonly name = 'UnsupportedFeatureError';
  readonly feature: string;

  constructor(feature: string) {
    super(`"${feature}" is not supported by csvloom`);
    this.feature = feature;
  }
}

/** 'main' is strict; 'papa' reads a config as Papa Parse 5.7.0 does and ignores unknown keys. */
export type EntryPolicy = 'main' | 'papa';

/**
 * Returns a string input as is. Papa's other inputs (objects, functions and
 * NODE_STREAM_INPUT) are excluded features; any other value throws a
 * TypeError naming its kind (main) or with Papa's text (csvloom/papa).
 */
export function checkInput(input: unknown, policy: EntryPolicy = 'main'): string {
  if (typeof input === 'string') return input;
  if (input === 1) throw new UnsupportedFeatureError('NODE_STREAM_INPUT');
  // Papa reads any other object or function as a File, Blob or stream.
  if ((typeof input === 'object' && input !== null) || typeof input === 'function') {
    throw new UnsupportedFeatureError('non-string input');
  }
  if (policy === 'papa') {
    // What Papa throws when it reads input.readable or streamer.stream.
    throw new TypeError(
      input === null || input === undefined
        ? `Cannot read properties of ${String(input)} (reading 'readable')`
        : "Cannot read properties of null (reading 'stream')",
    );
  }
  throw new TypeError(`Expected a string input, got ${input === null ? 'null' : typeof input}`);
}

/**
 * csvloom/papa: what Papa Parse 5.7.0 throws when it builds a RegExp from a quoteChar or
 * escapeChar that is not a string.
 */
export interface QuoteFailure {
  /** Thrown by newline detection, which uses quoteChar || '"'; null when it does not throw. */
  onDetect: string | null;
  /** Thrown by the full path: fastMode false, or not true and the text contains quote. */
  onFullPath: string;
  /** String(quoteChar), which the full-path test searches for. */
  quote: string;
}

/** A validated parse config. */
export interface ParseOptions {
  /** '' means detect; a function returns a delimiter checked by the entry's rules. */
  delimiter: string | ((input: string) => string);
  /** '' means detect. */
  newline: '' | Newline;
  /** csvloom/papa: the newline as given, at which skipFirstNLines splits; undefined: newline. */
  skipNewline: string | undefined;
  /** null: a candidate scanned as ',' that Papa reports as undetectable when it wins. */
  delimitersToGuess: readonly (string | null)[];
  quoteChar: string;
  escapeChar: string;
  /** csvloom/papa only; null otherwise. */
  quoteFailure: QuoteFailure | null;
  header: boolean;
  /** The comment marker; '' means none. */
  comments: string;
  /** comments as given, which Papa compares with a delimiter before true becomes '#'. */
  rawComments: boolean | string;
  skipEmptyLines: boolean | 'greedy';
  /** Records to read, the header record included; 0 means no limit. */
  preview: number;
  skipFirstNLines: number;
  /** Kept as given: Papa treats undefined and false differently. */
  fastMode: boolean | undefined;
  /** In the main entry, a wrapper that throws for a result that is not a string. */
  transformHeader: ((header: string, index: number) => unknown) | undefined;
  /** A map is copied before any callback runs, as Papa copies its config. */
  dynamicTyping: boolean | Readonly<Record<string, boolean>> | ((field: unknown) => unknown);
  transform: ((value: string, field: unknown) => unknown) | undefined;
}

const isFunction = (value: unknown): value is (input: string) => unknown =>
  typeof value === 'function';
const isHeaderTransform = (value: unknown): value is (header: string, index: number) => unknown =>
  typeof value === 'function';
const isTypingFunction = (value: unknown): value is (field: unknown) => unknown =>
  typeof value === 'function';
const isTransform = (value: unknown): value is (value: string, field: unknown) => unknown =>
  typeof value === 'function';
const isTypingMap = (value: unknown): value is Readonly<Record<string, boolean>> =>
  isPlainObject(value) && Object.values(value).every((typed) => typeof typed === 'boolean');
const always = () => true;

// The excluded options: the test for a value that asks for the feature, and the one value other
// than undefined that does not.
const UNSUPPORTED = new Map<string, { active: (value: unknown) => boolean; inactive?: false | '' }>(
  [
    ['worker', { active: (value) => value === true, inactive: false }],
    ['download', { active: (value) => value === true, inactive: false }],
    ['step', { active: isFunction }],
    ['chunk', { active: isFunction }],
    ['complete', { active: isFunction }],
    ['error', { active: isFunction }],
    ['beforeFirstChunk', { active: isFunction }],
    ['chunkSize', { active: (value) => typeof value === 'number' }],
    ['encoding', { active: (value) => typeof value === 'string' && value !== '', inactive: '' }],
    ['downloadRequestHeaders', { active: always }],
    ['downloadRequestBody', { active: always }],
    ['withCredentials', { active: (value) => value !== false, inactive: false }],
    ['downloadTimeout', { active: always }],
  ],
);
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'delimiter',
  'newline',
  'quoteChar',
  'escapeChar',
  'header',
  'comments',
  'skipEmptyLines',
  'preview',
  'skipFirstNLines',
  'fastMode',
  'delimitersToGuess',
  'transformHeader',
  'dynamicTyping',
  'transform',
  ...UNSUPPORTED.keys(),
]);

const isNewline = (value: unknown): value is Newline =>
  value === '\n' || value === '\r\n' || value === '\r';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = (key: string, expected: string) =>
  new TypeError(`Parse option "${key}" must be ${expected}`);

/**
 * The main entry's delimiter rule, for the delimiter option, each delimitersToGuess entry and a
 * delimiter function's result. It rejects what Papa silently reads as ',' ('"', U+FEFF and
 * non-strings), '' (Papa never ends a field there) and "\r" or "\n" inside a delimiter (Papa's
 * two scanning paths disagree on it).
 */
function checkDelimiter(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '' || value === '"' || value === '\ufeff') {
    throw invalid(key, 'a non-empty string other than \'"\' and "\\ufeff"');
  }
  if (value.includes('\r') || value.includes('\n')) throw invalid(key, 'free of "\\r" and "\\n"');
  return value;
}

/**
 * Validates a caller config in this order:
 * 1. The main entry takes undefined or a plain object, and throws a TypeError for any other
 *    config and for an unknown key; csvloom/papa reads the config as Papa does and ignores
 *    unknown keys.
 * 2. In both entries, an excluded option that asks for its feature throws UnsupportedFeatureError,
 *    and any value of it other than the inactive one a TypeError.
 * 3. The main entry throws a TypeError naming an option whose value is outside its type;
 *    csvloom/papa applies Papa's coercions, except where Papa never returns or its two parsing
 *    paths disagree, which throws in both.
 *
 * A key set to undefined counts as omitted.
 */
export function resolveParseConfig(config: unknown, policy: EntryPolicy): ParseOptions {
  const values = policy === 'main' ? mainValues(config) : papaValues(config);
  for (const [key, value] of values) {
    if (UNSUPPORTED.get(key)?.active(value)) throw new UnsupportedFeatureError(key);
  }
  for (const [key, value] of values) {
    const rule = UNSUPPORTED.get(key);
    if (rule && value !== rule.inactive) {
      throw invalid(key, rule.inactive === undefined ? 'omitted' : JSON.stringify(rule.inactive));
    }
  }
  return policy === 'main' ? mainParseOptions(values) : papaParseOptions(values);
}

const definedEntries = (config: object) =>
  new Map(
    Object.entries(config as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );

function mainValues(config: unknown): Map<string, unknown> {
  if (config !== undefined && !isPlainObject(config)) {
    throw new TypeError('Parse config must be a plain object');
  }
  const values = definedEntries(config ?? {});
  for (const key of values.keys()) {
    if (!KNOWN_KEYS.has(key)) throw new TypeError(`Unknown parse option "${key}"`);
  }
  return values;
}

/**
 * Papa replaces a falsy config with {}, writes into any other (a primitive throws in strict mode)
 * and reads a deep copy of it, so inherited enumerable keys count; a function is read as is.
 */
function papaValues(config: unknown): Map<string, unknown> {
  if (typeof config === 'object' && config !== null)
    return definedEntries(papaCopy(config) as object);
  if (typeof config === 'function') return definedEntries(config);
  if (config) throw writeError(config);
  return new Map();
}

const writeError = (target: unknown) =>
  new TypeError(`Cannot create property 'dynamicTyping' on ${typeof target} '${String(target)}'`);

/** Papa Parse 5.7.0's deep copy of a config: every enumerable key, inherited ones included. */
function papaCopy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const copy = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
  for (const key in value) copy[key] = papaCopy((value as Record<string, unknown>)[key]);
  return copy;
}

function mainParseOptions(values: ReadonlyMap<string, unknown>): ParseOptions {
  // '' or omitted means detect; a function's result is checked when parse calls it.
  const delimiterOption = values.has('delimiter') ? values.get('delimiter') : '';
  const delimiter =
    delimiterOption === ''
      ? ''
      : isFunction(delimiterOption)
        ? (text: string) => checkDelimiter(delimiterOption(text), 'delimiter')
        : checkDelimiter(delimiterOption, 'delimiter');
  const newline = values.has('newline') ? values.get('newline') : '';
  const quoteChar = values.has('quoteChar') ? values.get('quoteChar') : '"';
  const header = values.has('header') ? values.get('header') : false;
  if (newline !== '' && !isNewline(newline)) {
    throw invalid('newline', '"\\n", "\\r\\n", "\\r" or \'\'');
  }
  // Papa never opens a quoted field with a quoteChar of any other length.
  if (typeof quoteChar !== 'string' || quoteChar.length !== 1) {
    throw invalid('quoteChar', 'one UTF-16 code unit');
  }
  const escapeChar = values.has('escapeChar') ? values.get('escapeChar') : quoteChar;
  if (typeof escapeChar !== 'string') throw invalid('escapeChar', 'a string');
  if (typeof header !== 'boolean') throw invalid('header', 'a boolean');
  const comments = values.has('comments') ? values.get('comments') : false;
  // Compared before true becomes '#', as Papa does; parse compares it with a detected or
  // returned delimiter.
  if (delimiter !== '' && comments === delimiter) {
    throw new Error('Comment character same as delimiter');
  }
  // Papa silently reads any other value, '"' or U+FEFF as no comments; the main entry rejects
  // them.
  if (
    (typeof comments !== 'boolean' && typeof comments !== 'string') ||
    comments === '"' ||
    comments === '\ufeff'
  ) {
    throw invalid('comments', 'a boolean or a string other than \'"\' and "\\ufeff"');
  }
  // Rejected in both entries, as for the delimiter.
  if (typeof comments === 'string' && (comments.includes('\r') || comments.includes('\n'))) {
    throw invalid('comments', 'free of "\\r" and "\\n"');
  }
  const skipEmptyLines = values.has('skipEmptyLines') ? values.get('skipEmptyLines') : false;
  if (typeof skipEmptyLines !== 'boolean' && skipEmptyLines !== 'greedy') {
    throw invalid('skipEmptyLines', 'a boolean or "greedy"');
  }
  const preview = values.has('preview') ? values.get('preview') : 0;
  // A negative preview throws in both entries: Papa's two paths disagree on it.
  if (!isCount(preview)) throw invalid('preview', 'a non-negative safe integer');
  const skipFirstNLines = values.has('skipFirstNLines') ? values.get('skipFirstNLines') : 0;
  if (!isCount(skipFirstNLines)) {
    throw invalid('skipFirstNLines', 'a non-negative safe integer');
  }
  const fastMode = values.get('fastMode');
  if (fastMode !== undefined && typeof fastMode !== 'boolean') {
    throw invalid('fastMode', 'a boolean');
  }
  const guesses = values.get('delimitersToGuess');
  let delimitersToGuess = DEFAULT_DELIMITERS;
  if (guesses !== undefined) {
    if (!Array.isArray(guesses)) throw invalid('delimitersToGuess', 'an array');
    // A copy, with holes read as undefined (and rejected).
    delimitersToGuess = Array.from(guesses, (candidate) =>
      checkDelimiter(candidate, 'delimitersToGuess'),
    );
  }
  const transformHeader = values.get('transformHeader');
  if (transformHeader !== undefined && !isHeaderTransform(transformHeader)) {
    throw invalid('transformHeader', 'a function');
  }
  const typing = values.has('dynamicTyping') ? values.get('dynamicTyping') : false;
  let dynamicTyping: ParseOptions['dynamicTyping'];
  if (typeof typing === 'boolean' || isTypingFunction(typing)) dynamicTyping = typing;
  else if (isTypingMap(typing)) dynamicTyping = { ...typing };
  else throw invalid('dynamicTyping', 'a boolean, a plain object of booleans or a function');
  const transform = values.get('transform');
  if (transform !== undefined && !isTransform(transform)) throw invalid('transform', 'a function');
  return {
    delimiter,
    newline,
    skipNewline: undefined,
    delimitersToGuess,
    quoteChar,
    escapeChar,
    quoteFailure: null,
    header,
    comments: comments === true ? '#' : comments === false ? '' : comments,
    rawComments: comments,
    skipEmptyLines,
    // The header record counts too.
    preview: header && preview > 0 ? preview + 1 : preview,
    skipFirstNLines,
    fastMode,
    // Papa would use a result that is not a string as the name.
    transformHeader:
      transformHeader &&
      ((cell, index) => {
        const name = transformHeader(cell, index);
        if (typeof name !== 'string') {
          throw new TypeError('Parse option "transformHeader" must return a string');
        }
        return name;
      }),
    dynamicTyping,
    transform,
  };
}

/**
 * Papa's reading of a delimiter, a delimitersToGuess entry or a delimiter function's result: a
 * non-string or one of BAD_DELIMITERS is ','; '' and "\r" or "\n" inside a longer string throw.
 */
function papaDelimiter(value: unknown, key: string): string {
  if (typeof value !== 'string' || BAD_DELIMITERS.includes(value)) return ',';
  return checkDelimiter(value, key);
}

/**
 * Papa Parse 5.7.0's coercions. Throws only where Papa never returns or its two parsing paths
 * disagree; values that make Papa throw are left to throw where it does.
 */
function papaParseOptions(values: ReadonlyMap<string, unknown>): ParseOptions {
  // Falsy detects; a function is called by parse.
  const delimiterOption = values.get('delimiter');
  const delimiter = isFunction(delimiterOption)
    ? (text: string) => papaDelimiter(delimiterOption(text), 'delimiter')
    : delimiterOption
      ? papaDelimiter(delimiterOption, 'delimiter')
      : '';
  // Any other value is "\n"; skipFirstNLines splits at the value as given.
  const newlineOption = values.get('newline');
  const newline = !newlineOption ? '' : isNewline(newlineOption) ? newlineOption : '\n';
  // null means '"'; any other value is kept, and one that is not a string makes Papa's RegExp
  // construction throw (QuoteFailure).
  const quote: unknown = values.get('quoteChar') ?? '"';
  const escape = values.has('escapeChar') ? values.get('escapeChar') : quote;
  const quoteFailure: QuoteFailure | null =
    typeof quote === 'string' && typeof escape === 'string'
      ? null
      : {
          onDetect: quote && typeof quote !== 'string' ? 'string.replace is not a function' : null,
          onFullPath:
            escape === null
              ? "Cannot read properties of null (reading 'replace')"
              : 'string.replace is not a function',
          quote: String(quote),
        };
  // A non-string or one of BAD_DELIMITERS means no comments; such a value never equals the
  // delimiter Papa compares it with.
  const commentsOption = values.get('comments');
  let rawComments: boolean | string = false;
  if (commentsOption === true) rawComments = true;
  else if (typeof commentsOption === 'string' && !BAD_DELIMITERS.includes(commentsOption)) {
    // Rejected in both entries.
    if (commentsOption.includes('\r') || commentsOption.includes('\n')) {
      throw invalid('comments', 'free of "\\r" and "\\n"');
    }
    rawComments = commentsOption;
  }
  const header = Boolean(values.get('header'));
  // Compared as a number, plus one with a header. Papa's two paths agree only on a whole number
  // of records, so anything else throws; NaN and Infinity mean no limit.
  const previewOption = values.get('preview');
  let preview = 0;
  if (previewOption) {
    const count = Number(previewOption);
    const records = header ? count + 1 : count;
    if (count < 0 || records === 0 || (Number.isFinite(records) && !Number.isInteger(records))) {
      throw invalid(
        'preview',
        'a whole number of records, positive without header (or not numeric)',
      );
    }
    if (Number.isFinite(records)) preview = records;
  }
  // Falsy means the default candidates; anything else is read by index up to its length, as an
  // array is.
  const guesses = values.get('delimitersToGuess');
  let delimitersToGuess: readonly (string | null)[] = DEFAULT_DELIMITERS;
  if (guesses) {
    const list = guesses as ArrayLike<unknown>;
    const candidates: (string | null)[] = [];
    // A falsy candidate other than '' is scanned as ',' but never reported.
    for (let i = 0; i < list.length; i++) {
      const candidate = list[i];
      candidates.push(
        candidate || candidate === '' ? papaDelimiter(candidate, 'delimitersToGuess') : null,
      );
    }
    delimitersToGuess = candidates;
  }
  const typing = values.get('dynamicTyping');
  const fastMode = values.get('fastMode');
  const skipEmptyLines = values.get('skipEmptyLines');
  const transformHeader = values.get('transformHeader');
  const transform = values.get('transform');
  return {
    delimiter,
    newline,
    skipNewline: newline === '' ? undefined : String(newlineOption),
    delimitersToGuess,
    quoteChar: typeof quote === 'string' ? quote : '',
    escapeChar: typeof escape === 'string' ? escape : '',
    quoteFailure,
    header,
    comments: rawComments === true ? '#' : rawComments === false ? '' : rawComments,
    rawComments,
    // Truthiness, and 'greedy' by equality.
    skipEmptyLines: skipEmptyLines === 'greedy' ? 'greedy' : Boolean(skipEmptyLines),
    preview,
    // A string, a fraction or a negative count, as parseInt reads them.
    skipFirstNLines: parseInt(values.get('skipFirstNLines') as string) || 0,
    // Only false forces the full path.
    fastMode: fastMode ? true : fastMode === false ? false : undefined,
    transformHeader: isHeaderTransform(transformHeader) ? transformHeader : undefined,
    // A map types the fields whose own value is true, never an inherited one; a primitive types
    // nothing.
    dynamicTyping:
      typing === true || isTypingFunction(typing)
        ? typing
        : typeof typing === 'object' && typing !== null
          ? Object.fromEntries(
              Object.entries(typing as Record<string, unknown>)
                .filter(([, typed]) => typed === true)
                .map(([field]) => [field, true] as const),
            )
          : false,
    transform: isTransform(transform) ? transform : undefined,
  };
}

/** The features a parseDetailed config sets. */
export interface Features {
  detect: boolean;
  positions: boolean;
  repair: ReadonlySet<RepairRule> | null;
  schema: StandardSchemaV1 | null;
  sepLine: boolean;
  /** Which of delimiter, newline, quoteChar, escapeChar, skipFirstNLines the caller gave. */
  given: ReadonlySet<string>;
}

const REPAIR_RULES: readonly RepairRule[] = [
  'pad-missing',
  'drop-trailing-empty',
  'trailing-empty-record',
  'mixed-newline',
  'unclosed-quote',
];
const isRule = (value: unknown): value is RepairRule =>
  (REPAIR_RULES as readonly unknown[]).includes(value);
const DIALECT_KEYS = ['delimiter', 'newline', 'quoteChar', 'escapeChar', 'skipFirstNLines'];

/**
 * The config of parseDetailed: the feature keys are taken out and checked, and the rest goes to
 * resolveParseConfig for the main entry, so every ParseConfig key keeps its rules and messages
 * and is checked first. features is null when no feature is set: a key that is omitted,
 * undefined or false, and an empty rule list, set nothing.
 */
export function resolveDetailedConfig(
  config: unknown,
): ParseOptions & { features: Features | null } {
  if (!isPlainObject(config)) return { ...resolveParseConfig(config, 'main'), features: null };
  const { detect, positions, repair, schema, sepLine, ...rest } = config;
  const options = resolveParseConfig(rest, 'main');
  if (detect !== undefined && typeof detect !== 'boolean') throw invalid('detect', 'a boolean');
  // Detection needs a candidate; parse reports an empty list as UndetectableDelimiter instead.
  if (detect === true && options.delimitersToGuess.length === 0) {
    throw invalid('delimitersToGuess', 'a non-empty array with detect');
  }
  if (positions !== undefined && typeof positions !== 'boolean') {
    throw invalid('positions', 'a boolean');
  }
  if (sepLine !== undefined && typeof sepLine !== 'boolean') throw invalid('sepLine', 'a boolean');
  let rules: ReadonlySet<RepairRule> | null = null;
  if (repair === true) rules = new Set(REPAIR_RULES);
  else if (Array.isArray(repair) && repair.every(isRule)) {
    if (repair.length > 0) rules = new Set(repair);
  } else if (repair !== undefined && repair !== false) {
    throw invalid('repair', 'a boolean or an array of rule names');
  }
  if (schema !== undefined && !isStandardSchema(schema)) {
    throw invalid('schema', 'a Standard Schema v1 object');
  }
  if (
    detect !== true &&
    positions !== true &&
    sepLine !== true &&
    rules === null &&
    schema === undefined
  ) {
    return { ...options, features: null };
  }
  return {
    ...options,
    features: {
      detect: detect === true,
      positions: positions === true,
      repair: rules,
      schema: schema ?? null,
      sepLine: sepLine === true,
      given: new Set(DIALECT_KEYS.filter((key) => rest[key] !== undefined)),
    },
  };
}

/** Papa.BAD_DELIMITERS: the values Papa Parse 5.7.1 replaces with ',' when given as a delimiter. */
export const BAD_DELIMITERS: readonly string[] = Object.freeze(['\r', '\n', '"', '\ufeff']);

/** A validated unparse config. */
export interface UnparseOptions {
  /** An array quotes the columns whose entry is truthy. */
  quotes: boolean | readonly unknown[] | ((value: unknown, column: number) => unknown);
  quoteChar: string;
  /** What each quoteChar in a value becomes: escapeChar + quoteChar. */
  escapedQuote: string;
  delimiter: string;
  header: boolean;
  newline: string;
  skipEmptyLines: boolean | 'greedy';
  /** null: the first object's keys. */
  columns: readonly unknown[] | null;
  /** null: no prefix. */
  escapeFormulae: RegExp | null;
  /** The main rule (main entry, default or true): MAIN_FORMULA, and a PLAIN_NUMBER is not prefixed. */
  exemptNumbers: boolean;
  /** Main entry only: U+FEFF first. */
  bom: boolean;
  /** Main entry only: "sep=" + delimiter + newline before the records, after the BOM. */
  sepLine: boolean;
  /**
   * 'main': an input of which Papa would read a property of null or undefined,
   * or call join on a record without one, throws a TypeError naming the input
   * part; 'papa': the read throws as in Papa.
   */
  policy: EntryPolicy;
}

const UNPARSE_KEYS: ReadonlySet<string> = new Set([
  'quotes',
  'quoteChar',
  'escapeChar',
  'delimiter',
  'header',
  'newline',
  'skipEmptyLines',
  'columns',
  'escapeFormulae',
  'bom',
  'sepLine',
]);
/** csvloom/papa's escapeFormulae: true; unlike Papa's, it also matches a value with a line break. */
const FORMULA = /^[=+\-@\t\r]/;
/** The main entry's escapeFormulae: true: the eleven first characters of OWASP's CSV Injection page. */
const MAIN_FORMULA = /^[=+\-@\t\r\n\uff1d\uff0b\uff0d\uff20]/;
/** A plain number, which the main rule leaves alone. No quantifier is nested: linear on any input. */
export const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const invalidUnparse = (key: string, expected: string) =>
  new TypeError(`Unparse option "${key}" must be ${expected}`);
const isQuotesFunction = (value: unknown): value is (value: unknown, column: number) => unknown =>
  typeof value === 'function';
// Holes read as undefined, so a sparse array fails.
const isArrayOf = <T>(
  value: unknown,
  item: (entry: unknown) => entry is T,
): value is readonly T[] => Array.isArray(value) && Array.from(value).every(item);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Validates an unparse config. The main entry checks it as resolveParseConfig does (plain object,
 * no unknown keys, undefined means omitted, null and values outside an option's type throw a
 * TypeError naming it), in the order Papa reads the options; csvloom/papa reads it as Papa does.
 * Both keep Papa's Error for an empty columns array.
 */
export function resolveUnparseConfig(config: unknown, policy: EntryPolicy): UnparseOptions {
  if (policy === 'papa') return papaUnparseOptions(config);
  if (config !== undefined && !isPlainObject(config)) {
    throw new TypeError('Unparse config must be a plain object');
  }
  const values = definedEntries(config ?? {});
  for (const key of values.keys()) {
    if (!UNPARSE_KEYS.has(key)) throw new TypeError(`Unknown unparse option "${key}"`);
  }
  const delimiter = values.has('delimiter') ? values.get('delimiter') : ',';
  // Papa reads a non-string, or one that contains a BAD_DELIMITERS character, as ','; '' joins the
  // values without a separator. The main entry rejects all three.
  if (
    typeof delimiter !== 'string' ||
    delimiter === '' ||
    BAD_DELIMITERS.some((bad) => delimiter.includes(bad))
  ) {
    throw invalidUnparse(
      'delimiter',
      'a non-empty string without "\\r", "\\n", \'"\' and "\\ufeff"',
    );
  }
  const quotes = values.has('quotes') ? values.get('quotes') : false;
  if (!isBoolean(quotes) && !isQuotesFunction(quotes) && !isArrayOf(quotes, isBoolean)) {
    throw invalidUnparse('quotes', 'a boolean, an array of booleans or a function');
  }
  const skipEmptyLines = values.has('skipEmptyLines') ? values.get('skipEmptyLines') : false;
  if (!isBoolean(skipEmptyLines) && skipEmptyLines !== 'greedy') {
    throw invalidUnparse('skipEmptyLines', 'a boolean or "greedy"');
  }
  const newline = values.has('newline') ? values.get('newline') : '\r\n';
  if (!isString(newline)) throw invalidUnparse('newline', 'a string');
  const quoteChar = values.has('quoteChar') ? values.get('quoteChar') : '"';
  if (!isString(quoteChar)) throw invalidUnparse('quoteChar', 'a string');
  const header = values.has('header') ? values.get('header') : true;
  if (!isBoolean(header)) throw invalidUnparse('header', 'a boolean');
  const columns = values.get('columns');
  if (columns !== undefined && !isArrayOf(columns, isString)) {
    throw invalidUnparse('columns', 'an array of strings');
  }
  if (columns?.length === 0) throw new Error('Option columns is empty');
  const escapeChar = values.has('escapeChar') ? values.get('escapeChar') : quoteChar;
  if (!isString(escapeChar)) throw invalidUnparse('escapeChar', 'a string');
  // On by default in the main entry.
  const escapeFormulae = values.has('escapeFormulae') ? values.get('escapeFormulae') : true;
  // instanceof, as Papa tests it: a RegExp from another realm is rejected.
  if (!isBoolean(escapeFormulae) && !(escapeFormulae instanceof RegExp)) {
    throw invalidUnparse('escapeFormulae', 'a boolean or a RegExp');
  }
  const bom = values.has('bom') ? values.get('bom') : false;
  if (!isBoolean(bom)) throw invalidUnparse('bom', 'a boolean');
  const sepLine = values.has('sepLine') ? values.get('sepLine') : false;
  if (!isBoolean(sepLine)) throw invalidUnparse('sepLine', 'a boolean');
  if (sepLine && delimiter.length !== 1) {
    throw new TypeError('Unparse option "sepLine" needs a delimiter of one UTF-16 code unit');
  }
  return {
    quotes,
    quoteChar,
    escapedQuote: escapeChar + quoteChar,
    delimiter,
    header,
    newline,
    skipEmptyLines,
    columns: columns ?? null,
    escapeFormulae:
      escapeFormulae === true ? MAIN_FORMULA : escapeFormulae === false ? null : escapeFormulae,
    exemptNumbers: escapeFormulae === true,
    bom,
    sepLine,
    policy: 'main',
  };
}

/**
 * Papa Parse 5.7.0's unpackConfig: a config that is not an object is ignored and null throws as
 * Papa's read does; each option of the type Papa tests is used and any other value means the
 * default. Reads go through the prototype chain, as Papa's do.
 */
function papaUnparseOptions(config: unknown): UnparseOptions {
  if (config === null) throw new TypeError("Cannot read properties of null (reading 'delimiter')");
  const {
    delimiter,
    quotes,
    skipEmptyLines,
    newline,
    quoteChar,
    header,
    columns,
    escapeChar,
    escapeFormulae,
  } = (typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const quote = isString(quoteChar) ? quoteChar : '"';
  if (Array.isArray(columns) && columns.length === 0) throw new Error('Option columns is empty');
  return {
    quotes: isBoolean(quotes) || isQuotesFunction(quotes) || isArray(quotes) ? quotes : false,
    quoteChar: quote,
    // JavaScript's +, so null gives 'null' + quote.
    escapedQuote: (escapeChar === undefined ? quote : (escapeChar as string)) + quote,
    delimiter:
      isString(delimiter) && !BAD_DELIMITERS.some((bad) => delimiter.includes(bad))
        ? delimiter
        : ',',
    header: isBoolean(header) ? header : true,
    newline: isString(newline) ? newline : '\r\n',
    // Papa reads truthiness, and 'greedy' by equality.
    skipEmptyLines:
      skipEmptyLines === 'greedy'
        ? 'greedy'
        : (isBoolean(skipEmptyLines) || isString(skipEmptyLines)) && Boolean(skipEmptyLines),
    columns: isArray(columns) ? columns : null,
    // A RegExp from another realm is ignored, as by Papa.
    escapeFormulae:
      escapeFormulae instanceof RegExp ? escapeFormulae : escapeFormulae === true ? FORMULA : null,
    exemptNumbers: false,
    bom: false,
    sepLine: false,
    policy: 'papa',
  };
}

const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** An object literal from any realm, or an object without a prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}
