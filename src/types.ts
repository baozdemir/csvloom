export type Newline = '\n' | '\r\n' | '\r';

/** A field value after dynamicTyping. */
export type TypedValue = string | number | boolean | Date | null;

/**
 * The fields dynamicTyping converts. A field is named by its header name with
 * header, by its column index without, and extra fields by '__parsed_extra'.
 * true converts every field; a map converts a field whose name is an own key
 * set to true; a function is called with the name the first time a field
 * appears (again for a field it returned undefined for) and converts the field
 * when it returns true. Names like Object.prototype members (constructor,
 * toString, ...) are treated like any other.
 */
export type DynamicTyping =
  true | Readonly<Record<string, boolean>> | ((field: string | number) => boolean);

/** The transform option (see ParseConfig.transform). */
export type Transform = (value: string, field: string | number) => unknown;

/** Parse options: every listed option is implemented; nothing else is accepted. */
export interface ParseConfig {
  /**
   * Any non-empty string except '"' and U+FEFF; it must not contain "\r" or
   * "\n". Several characters are matched as one delimiter. Omitted or '':
   * detected from the first 10 records with each of delimitersToGuess. A
   * function is called once with the text (after a leading BOM and
   * skipFirstNLines are removed) and must return such a string.
   */
  delimiter?: string | ((input: string) => string);
  /**
   * Omitted or '': detected from the first 1,048,576 UTF-16 units with quoted
   * text removed: "\n" unless a "\r" comes first, then "\r\n" when at least
   * half of the text's "\r" parts start with "\n", otherwise "\r".
   */
  newline?: '' | Newline;
  /**
   * The candidates for delimiter detection, each a valid delimiter; default
   * [',', '\t', '|', ';', '\x1e', '\x1f']. Of the candidates that average more
   * than 1.99 fields per record, the one with the smallest change in field
   * count between records wins, then the one with more fields, then the
   * earlier one; when none qualifies, ',' is used and an UndetectableDelimiter
   * error is reported. A comments value equal to any candidate throws.
   */
  delimitersToGuess?: readonly string[];
  /** One UTF-16 code unit; default '"'. */
  quoteChar?: string;
  /**
   * Defaults to quoteChar: a doubled quote inside a quoted field is one quote.
   * Otherwise a quote right after a one-unit escapeChar does not close the
   * field, and each escapeChar + quoteChar pair in a closed field becomes one
   * quote (as in Papa Parse 5.7.1).
   */
  escapeChar?: string;
  /**
   * Use the first record as field names and return one object per later record.
   * Each of its cells loses one leading U+FEFF, then goes through
   * transformHeader; a repeated name then becomes name_N with the smallest N,
   * from its repeat count up, that is neither a cell as written nor a name
   * already given.
   */
  header?: boolean;
  /**
   * A line that starts with this marker at the start of a record, outside
   * quotes, is skipped; true means '#', and false or '' means no comments. It
   * must not equal the delimiter, be '"' or U+FEFF, or contain "\r" or "\n".
   */
  comments?: boolean | string;
  /**
   * true removes records that are one empty field; 'greedy' also removes
   * records whose fields are all whitespace. With header, record 0 is renamed
   * first, and when it is removed the next remaining record is used as the
   * field names as is.
   */
  skipEmptyLines?: boolean | 'greedy';
  /**
   * Records to return, the header record not counted; 0 (the default) means
   * all. Counted as Papa Parse 5.7.1 does: when the text has no quoteChar, or
   * with fastMode: true, every line counts, comment lines included, and the
   * parse ends after the first record on line `preview` or later; otherwise
   * only records count, and only one that ends in a line break ends the parse.
   * Empty records count before skipEmptyLines removes them. A non-negative
   * safe integer.
   */
  preview?: number;
  /**
   * Lines to drop before parsing, split at the newline without regard to
   * quotes; meta.cursor counts from the text after them. A non-negative safe
   * integer.
   */
  skipFirstNLines?: number;
  /**
   * true: quotes are ordinary characters. false or omitted: quotes work; when
   * omitted and the text has no quoteChar, preview counts lines as with true.
   */
  fastMode?: boolean;
  /**
   * With header, called once per cell of the first record, after its leading
   * U+FEFF is removed and before duplicates are renamed, with the cell and its
   * index; it must return a string. Not called without header.
   */
  transformHeader?: (header: string, index: number) => string;
  /**
   * Converts the fields it names (see DynamicTyping) as Papa Parse 5.7.1 does,
   * in this order: 'true' and 'TRUE' become true, 'false' and 'FALSE' false; a
   * decimal number with an optional exponent and surrounding whitespace that
   * parseFloat reads strictly between -2^53 and 2^53 becomes that number; an
   * ISO date-time with minutes and a zone becomes a Date (possibly invalid);
   * '' becomes null; anything else stays the string. The header record is not
   * converted. With skipEmptyLines, records are removed before conversion.
   */
  dynamicTyping?: DynamicTyping | false;
  /**
   * Called for every field of every record, in order, before dynamicTyping,
   * with the value and the field: the column index without header, the header
   * name with header (__parsed_extra for extra fields). Not called for the
   * header record or for records skipEmptyLines removes. Its result is used as
   * returned; dynamicTyping then reads a non-string as Papa Parse 5.7.1 does
   * (for example -0 becomes 0, and a Symbol throws a TypeError). What it throws
   * propagates out of parse.
   */
  transform?: Transform;
}

export interface QuoteError {
  type: 'Quotes';
  code: 'MissingQuotes' | 'InvalidQuotes';
  message: string;
  /** Number of records completed before the field with the error. */
  row: number;
  /** UTF-16 offset just after the field's opening quote. */
  index: number;
}

export interface FieldCountError {
  type: 'FieldMismatch';
  code: 'TooFewFields' | 'TooManyFields';
  message: string;
  /** Index into `data`; the header record is not counted. */
  row: number;
}

/** Delimiter detection failed and ',' was used; listed after quote errors. */
export interface DelimiterError {
  type: 'Delimiter';
  code: 'UndetectableDelimiter';
  message: string;
}

export type ParseError = QuoteError | DelimiterError | FieldCountError;

/** Where an error or a repair is, in the input as given (a BOM, skipped lines and a sep= line count). */
export interface Position {
  /** 1-based physical line; "\r\n", "\n" and "\r" each end a line, inside quotes too. */
  line: number;
  /** 1-based, in UTF-16 units from the start of that line. */
  column: number;
  /** 0-based UTF-16 offset: bulk in the input string, stream in the source's text. */
  offset: number;
  /** The line's text; when longer than 120 units, the 120 units around column, cut with "…" (never inside a surrogate pair). */
  snippet: string;
}

/** An error of parseDetailed: the four keys are all present with positions: true, else all absent. */
export type Located<E> = E & Partial<Position>;

export type RepairRule =
  | 'pad-missing'
  | 'drop-trailing-empty'
  | 'trailing-empty-record'
  | 'mixed-newline'
  | 'unclosed-quote';

/** One change of the repair option, at the position where its span starts. */
export interface Repair extends Position {
  rule: RepairRule;
  /**
   * Index in the rows parsed of the first row the record became; -1 when it became none: it
   * was removed, or is the header record. A piece of a split record that is the header record,
   * or that skipEmptyLines removes, is not a row: row then names the first piece after it that
   * is one, which starts later than offset.
   */
  row: number;
  /** Units of the span the repair replaced: the record's raw text without its line break; for trailing-empty-record, the final line break itself, with the spaces before it when they only closed a quoted field. input.slice(offset, offset + length) is that span. */
  length: number;
  /** The first 256 units of that span (255 when the 256th would split a surrogate pair). */
  before: string;
  /**
   * The record's fields after the repair, before transform and dynamicTyping; several arrays
   * when it was split, none when removed. A split record keeps all its rows in this one entry,
   * and the limit of 10,000 repairs counts entries, not rows.
   */
  after: string[][];
}

/**
 * Fields beyond the header's length are collected under `__parsed_extra`;
 * fields missing from a short record are absent.
 */
export type HeaderRow<V> = Record<string, V | V[]>;

/**
 * Field is the type of a header name: a string, except in csvloom/papa,
 * where a transformHeader result is used as the name as returned.
 */
export interface ParseMeta<Field = string> {
  /** The delimiter used: given, returned by the function, or detected. */
  delimiter: string;
  /** The newline used: given or detected. */
  linebreak: Newline;
  aborted: false;
  /** True when preview ended the parse. */
  truncated: boolean;
  /**
   * UTF-16 offset, after a leading BOM and skipFirstNLines are removed, where
   * the last record read and its line break end: the text length unless the
   * text ends with comment lines or preview ended the parse. When lines count
   * for preview, the record that ended it is read but not returned if preview
   * records were already returned.
   */
  cursor: number;
  /** Renamed duplicate header to original name; null when nothing was renamed. */
  renamedHeaders: Record<string, Field> | null;
  /** Header fields after transformHeader and renaming; present only with `header: true`. */
  fields?: Field[];
}

export interface ParseResult<Row, Field = string> {
  data: Row[];
  errors: ParseError[];
  meta: ParseMeta<Field>;
}

/**
 * What unparse serializes, as Papa Parse 5.7.1 reads it: a string is parsed as
 * JSON first. An array of arrays gives one record per array. An array of
 * objects gives a header from the first object's keys (or columns) and one
 * record per object, read by those keys; keys only later objects have are not
 * written. An empty array gives the header of columns, if they are given. An
 * object gives fields (or meta.fields, then columns, then the first object's
 * keys) as the header and data as the records; data may be a JSON string, and
 * data whose first item is neither an array nor an object is one record. The
 * input is never modified. Where Papa Parse 5.7.1 fails reading a property,
 * the main entry throws a TypeError naming the input part: null or undefined
 * as the input or as a record and, without a header, a record that has no join
 * method with skipEmptyLines 'greedy'.
 */
export type UnparseInput =
  | string
  | readonly unknown[]
  | {
      readonly fields?: readonly string[];
      readonly data: string | readonly unknown[];
      readonly meta?: { readonly fields?: readonly string[] };
    };

/** Unparse options: every listed option is implemented; nothing else is accepted. */
export interface UnparseConfig {
  /**
   * true quotes every value; an array quotes the columns whose entry is true; a
   * function is called with each value and its column index, header cells
   * included, and quotes it when it returns true. It is not called for null,
   * undefined, a Date or a value escapeFormulae prefixed. Default false: a
   * value is quoted only when it contains "\r", "\n", '"', U+FEFF, the
   * delimiter or quoteChar, or starts or ends with a space.
   */
  quotes?: boolean | readonly boolean[] | ((value: unknown, column: number) => boolean);
  /** Any string; default '"'. */
  quoteChar?: string;
  /**
   * Written before each quoteChar inside a value; default quoteChar. The
   * replacement follows String.prototype.replaceAll, as in Papa Parse 5.7.1, so
   * "$&", "$'", "$`" and "$$" in escapeChar + quoteChar are patterns.
   */
  escapeChar?: string;
  /**
   * A non-empty string without "\r", "\n", '"' or U+FEFF; default ','. (Papa
   * Parse 5.7.1 also writes with '', which joins quoted values without a
   * separator; csvloom/papa keeps that.)
   */
  delimiter?: string;
  /** Write the header record (arrays of objects and fields); default true. */
  header?: boolean;
  /** Written between records; any string; default "\r\n". */
  newline?: string;
  /**
   * true leaves out empty records: without a header an empty array or one
   * whose only value is '', null or undefined, with a header a record without
   * own keys; 'greedy' also leaves out records whose values join to
   * whitespace. When the last records are left out, the line break before them
   * stays, as in Papa Parse 5.7.1.
   */
  skipEmptyLines?: boolean | 'greedy';
  /** The keys and header for arrays of objects, in order; not empty. */
  columns?: readonly string[];
  /**
   * true writes "'" before a value that starts with "=", "+", "-", "@", a tab,
   * "\r", "\n" or a full-width "＝", "＋", "－" or "＠" (U+FF1D, U+FF0B,
   * U+FF0D, U+FF20), and quotes it, unless the whole value is a plain number
   * such as "-5", "+1.5" or "-2e3"
   * (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/). Strings are tested, and
   * so are arrays, wrapper objects (such as new String('=x')), other objects,
   * functions and symbols, by their string form; numbers, bigints, booleans,
   * null, undefined and Dates are not. Default true; false writes every value
   * as it is. A RegExp is used as given, with no number exemption: its test
   * method is called once per tested value, header cells included, so a g or y
   * RegExp advances its own lastIndex. This is a mitigation, not a guarantee:
   * OWASP notes that a leading "'" is not reliable in Microsoft Excel after the
   * file is saved and re-opened.
   */
  escapeFormulae?: boolean | RegExp;
  /** true writes U+FEFF before everything else; default false. */
  bom?: boolean;
  /**
   * true writes "sep=", the delimiter and newline before the records (after the BOM), also when
   * there are none; parseDetailed reads that line with sepLine: true. The delimiter must then be
   * one UTF-16 code unit. Default false.
   */
  sepLine?: boolean;
}

/**
 * The csvloom/papa parse config: Papa Parse 5.7.1's option names with the value types
 * @types/papaparse 5.5.2 declares for the supported options, and the excluded options only as
 * their inactive values. At run time each value is read as Papa reads it and unknown keys are
 * ignored. The type parameters of @types/papaparse's ParseConfig are accepted and type nothing.
 * `transform` is a method, as it is there, so that a function whose `field` is a `string`, for a
 * parse with a header, is accepted.
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/compatibility.md
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- as above
export interface PapaParseConfig<_T = any, _TInput = undefined> {
  delimiter?: string | ((input: string) => string) | undefined;
  newline?: '\r' | '\n' | '\r\n' | undefined;
  quoteChar?: string | undefined;
  escapeChar?: string | undefined;
  header?: boolean | undefined;
  transformHeader?: ((header: string, index: number) => string) | undefined;
  dynamicTyping?:
    | boolean
    | { [headerName: string]: boolean; [columnNumber: number]: boolean }
    | ((field: string | number) => boolean)
    | undefined;
  preview?: number | undefined;
  comments?: false | string | undefined;
  skipEmptyLines?: boolean | 'greedy' | undefined;
  fastMode?: boolean | undefined;
  transform?(value: string, field: string | number): unknown;
  delimitersToGuess?: readonly string[] | undefined;
  skipFirstNLines?: number | undefined;
  worker?: false | undefined;
  download?: false | undefined;
  encoding?: '' | undefined;
  withCredentials?: false | undefined;
  step?: undefined;
  chunk?: undefined;
  complete?: undefined;
  error?: undefined;
  beforeFirstChunk?: undefined;
  chunkSize?: undefined;
  downloadRequestHeaders?: undefined;
  downloadRequestBody?: undefined;
  downloadTimeout?: undefined;
}

/**
 * The csvloom/papa unparse config: @types/papaparse 5.5.2's UnparseConfig.
 * Each value is read as Papa Parse 5.7.1 reads it (a value of another type
 * means the default) and unknown keys are ignored.
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/compatibility.md
 */
export interface PapaUnparseConfig {
  quotes?:
    boolean | readonly boolean[] | ((value: unknown, columnIndex: number) => boolean) | undefined;
  quoteChar?: string | undefined;
  escapeChar?: string | undefined;
  delimiter?: string | undefined;
  header?: boolean | undefined;
  newline?: string | undefined;
  skipEmptyLines?: boolean | 'greedy' | undefined;
  columns?: readonly string[] | undefined;
  escapeFormulae?: boolean | RegExp | undefined;
}

/**
 * @types/papaparse 5.5.2's ParseError, which every csvloom error fits: a
 * Delimiter error has no `row`, and only a Quotes error has an `index`.
 */
export interface PapaParseError {
  type: 'Quotes' | 'Delimiter' | 'FieldMismatch';
  code:
    'MissingQuotes' | 'UndetectableDelimiter' | 'TooFewFields' | 'TooManyFields' | 'InvalidQuotes';
  message: string;
  row?: number | undefined;
  index?: number | undefined;
}

/**
 * @types/papaparse 5.5.2's ParseMeta, and null for `renamedHeaders`: what Papa
 * Parse 5.7.1 and csvloom/papa return when no header was renamed.
 */
export interface PapaParseMeta {
  delimiter: string;
  linebreak: string;
  aborted: boolean;
  fields?: string[] | undefined;
  truncated: boolean;
  cursor: number;
  renamedHeaders?: Record<string, string> | null;
}

/** @types/papaparse 5.5.2's ParseResult. */
export interface PapaParseResult<T> {
  data: T[];
  errors: PapaParseError[];
  meta: PapaParseMeta;
}

/**
 * What csvloom/stream uses of a Web ReadableStream, as a structural type, so the
 * declarations need neither the DOM lib nor @types/node. `value?: T | undefined` keeps the global
 * ReadableStream assignable under exactOptionalPropertyTypes.
 */
export interface ReadableStreamLike<T> {
  getReader(): {
    read(): Promise<{ done: boolean; value?: T | undefined }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/** What csvloom/stream uses of an AbortSignal, as a structural type. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * What csvloom/stream reads: a string (one chunk), a Web ReadableStream, or a sync or async
 * iterable of chunks (an array, a generator, a Node Readable). The first chunk fixes the kind:
 * all strings, or all Uint8Arrays (UTF-8).
 */
export type StreamSource =
  | Iterable<string>
  | AsyncIterable<string>
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>
  | ReadableStreamLike<string | Uint8Array>;

/**
 * The csvloom/stream config: every ParseConfig key with its meaning in parse, the feature keys
 * of DetailedConfig, and three more. A schema may validate asynchronously here.
 */
export interface StreamConfig extends DetailedConfig {
  /**
   * The most rows per batch, fewer when their text reaches 1,048,576 UTF-16 units first; a
   * positive safe integer; default 1024.
   */
  batchSize?: number;
  /**
   * The most UTF-16 units of one record, its line break excluded; a positive safe integer.
   * Omitted: no limit, which is unsafe for untrusted input.
   */
  maxRecordLength?: number;
  /** Aborting closes the source and rejects next() with signal.reason. */
  signal?: AbortSignalLike;
}

/** The type of Symbol.asyncDispose where the consumer's lib declares it, else never. No global is augmented. */
export type AsyncDisposeKey = SymbolConstructor extends {
  readonly asyncDispose: infer S extends symbol;
}
  ? S
  : never;

/**
 * next() and return() as parseStream's iterator has them. An interface, so that these two
 * replace AsyncIterableIterator's wider members instead of overloading them.
 */
interface BatchSteps<Row, E> extends AsyncIterableIterator<
  ParseBatch<Row, E>,
  undefined,
  undefined
> {
  next(): Promise<IteratorResult<ParseBatch<Row, E>, undefined>>;
  /** Closes the source. */
  return(): Promise<IteratorReturnResult<undefined>>;
}

/**
 * What parseStream returns: batches for `for await`. return() closes the source; where
 * Symbol.asyncDispose exists, so does `await using`.
 */
export type BatchIterator<Row, E = ParseError> = BatchSteps<Row, E> & {
  [P in AsyncDisposeKey]: () => Promise<void>;
};

/*!
 * StandardSchemaV1, SchemaResult, SchemaIssue and InferOutput are a structural copy of the part of
 * Standard Schema v1 that csvloom uses, written from packages/spec/src/index.ts of
 * https://github.com/standard-schema/standard-schema at tag v1.1.0, commit
 * 2c4e37f6d92e7ddc1d0d0b6bab4173f1d8d41df1. No package is imported. That file's licence:
 *
 * MIT License
 *
 * Copyright (c) 2024 Colin McDonnell
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * A Standard Schema v1 object, as a library that implements the specification provides it.
 * csvloom calls schema['~standard'].validate(row) as a method, with one argument, and reads
 * issues, value, message and path only.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> | undefined },
    ) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
export type SchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<SchemaIssue> };
export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}
export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S['~standard']['types']
>['output'];

/** A row the schema rejected: one error per issue, or one when the result has no issue. */
export interface SchemaError extends Partial<Position> {
  type: 'Schema';
  code: 'InvalidRow';
  /** issue.message, as the validator gave it. */
  message: string;
  /** The row's index among the rows parsed, valid or not. */
  row: number;
  /** issue.path with each { key } segment replaced by its key; absent when the issue has none. */
  path?: readonly PropertyKey[];
  /** The row as the validator received it. */
  value: unknown;
}

/** One scored reading of the sample. */
export interface DetectionCandidate {
  delimiter: string;
  quoteChar: string;
  /** Equal to quoteChar when a doubled quote is the escape. */
  escapeChar: string;
  /** 0 to 1: the row pattern times the share of cells that look like values. */
  score: number;
}

/** What detect found in the first 65,536 UTF-16 units of the text. */
export interface Detection {
  delimiter: string;
  newline: Newline;
  quoteChar: string;
  escapeChar: string;
  /** A guess; never applied by detect: true (the result type depends on header). */
  header: boolean;
  /**
   * Offset in the input as given (a BOM counted) where the table starts: after a sep= line and
   * the preamble. UTF-16 units for a string, bytes for a Uint8Array.
   */
  start: number;
  /** The skipped preamble: complete physical lines, with their line breaks; '' when none. */
  preamble: string;
  /** How many physical lines preamble holds. */
  preambleLines: number;
  sepLine: boolean;
  /** Fields per record of the winning candidate (its most frequent count). */
  columns: number;
  /** The winner's score, 0 to 1. */
  score: number;
  /** The five best, highest score first; the winner is candidates[0]. */
  candidates: readonly DetectionCandidate[];
  /** Only for Uint8Array input. */
  encoding?: {
    name: 'utf-8' | 'utf-16le' | 'utf-16be' | 'unknown';
    evidence: 'bom' | 'valid' | 'invalid';
    /** With 'invalid': the offset of the first byte that is not UTF-8. */
    invalidAt?: number;
  };
  /** For plain parse: delimiter, newline, quoteChar, escapeChar and header, no skip. parse(input.slice(detection.start), detection.config) parses the table. */
  config: ParseConfig;
}

/**
 * The options of parseDetailed: every option of parse, and the features. A feature is off when
 * its key is omitted, undefined or false.
 */
export interface DetailedConfig extends ParseConfig {
  /**
   * true: the dialect comes from detect (see Detection) instead of the guess of parse: delimiter,
   * newline, quoteChar and escapeChar, each unless given (delimiter and newline '' are not
   * given); a "sep=" line is read as with sepLine; the leading lines detect reports as preamble
   * are skipped, unless skipFirstNLines is given: it is then applied as in parse, and detection
   * reads the rest as the table, with no "sep=" line and no preamble. The header guess is never
   * applied. meta.detected holds what was found and where the table starts; UndetectableDelimiter
   * is never reported. A delimiter function is called once, with the text detection reads.
   */
  detect?: boolean | undefined;
  /**
   * true: every error that belongs to a place gains line, column, offset and snippet (see
   * Position), after its other keys, which keep their values. For a Quotes error the place is
   * the field's opening quote; for a FieldMismatch or Schema error, where the record starts. An
   * UndetectableDelimiter error has no place.
   */
  positions?: boolean | undefined;
  /**
   * true applies every repair rule, an array the rules it names. Every change is logged in the
   * result's repairs and counted in repairCounts, and an issue that was repaired is not in
   * errors. mixed-newline is applied only when newline is omitted. With preview, data holds the
   * rows parse returns for the repaired text, so a record that was split is cut at the limit,
   * while repairs holds every change to a record that was read; unclosed-quote is then not
   * applied, and trailing-empty-record only when the last record of the input was read. Cost:
   * unclosed-quote rescans the rest of the input after each line it reads again, up to 100
   * times.
   */
  repair?: boolean | readonly RepairRule[] | undefined;
  /**
   * true: a first line (after a BOM) that is "sep=" and one delimiter unit is skipped and names
   * the delimiter, unless delimiter is given; meta.sepLine is then true. The line ends at
   * newline, or at "\r\n", "\n" or "\r" when newline is omitted. It is read before
   * skipFirstNLines counts its lines.
   */
  sepLine?: boolean | undefined;
  /**
   * A Standard Schema v1 object. Each row, built as header, transform and dynamicTyping build
   * it, is passed to schema['~standard'].validate: data then holds the outputs of the valid
   * rows, and each issue of an invalid row is a Schema error that holds the row. row in every
   * error counts the rows before validation. A validator that returns a Promise throws a
   * TypeError.
   */
  schema?: StandardSchemaV1 | undefined;
}

/** What parseDetailed returns: parse's result, with errors that may carry a position. */
export interface FeatureResult<Row, E = ParseError> {
  data: Row[];
  errors: Array<Located<E>>;
  /**
   * detected: present with detect; it holds what detection found, while delimiter and linebreak
   * hold what was used (mixed-newline can change the newline). sepLine: present, and true, when
   * the sepLine or detect option read a "sep=" line.
   */
  meta: ParseMeta & { detected?: Detection; sepLine?: true };
  /** Only with repair: the first 10,000 changes, in input order. */
  repairs?: Repair[];
  /** Only with repair: every change, counted per rule. */
  repairCounts?: Record<RepairRule, number>;
}

/**
 * The meta of one csvloom/stream batch. delimiter, linebreak, fields (with
 * header only) and renamedHeaders are bulk parse's and the same in every
 * batch. cursor counts as bulk's, to the end of the line break of the record
 * that filled the batch, and is bulk's in the last batch.
 */
export interface StreamMeta {
  delimiter: string;
  linebreak: Newline;
  fields?: string[];
  renamedHeaders: Record<string, string> | null;
  /** The rows in the batches before this one. */
  rowOffset: number;
  /** UTF-16 units. */
  cursor: number;
  /** True only in a last batch that preview ended. */
  truncated: boolean;
  /** True only in the last batch, which always comes. */
  done: boolean;
  /** With detect: what detection found, the same object in every batch (see FeatureResult). */
  detected?: Detection;
  /** Present, and true, when the sepLine or detect option read a "sep=" line. */
  sepLine?: true;
}

/**
 * One batch of csvloom/stream: its rows and the errors found for them, with a position each
 * under positions. With repair: repairs holds the changes to this batch's records (of the first
 * 10,000 of the stream) and repairCounts counts every change to them. With a schema, data holds
 * the outputs of the batch's valid rows, and meta.rowOffset and every row count the rows before
 * validation.
 */
export type ParseBatch<Row, E = ParseError> = {
  data: Row[];
  errors: Array<Located<E>>;
  meta: StreamMeta;
  repairs?: Repair[];
  repairCounts?: Record<RepairRule, number>;
};
