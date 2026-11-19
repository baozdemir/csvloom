/*
 * Every type csvloom/papa reaches, copied by hand (doc comments left out) from dist/papa.d.ts,
 * dist/types.d.ts and dist/options.d.ts as `npm run build` writes them. Nothing here imports
 * src/, so a change to the real types cannot change these copies. test/types.test.ts asserts
 * that the real types equal them in both directions; papa-frozen-decls.txt beside this file holds
 * the declaration text. Edit only with an intended change to csvloom/papa's types.
 *
 * PapaParseConfig has type parameters and its transform is a method; PapaParseError,
 * PapaParseMeta and PapaParseResult are named as in @types/papaparse 5.5.2; parse has a type
 * parameter and returns PapaParseResult; the default export has a namespace of the type names.
 * The main entry's result types are copied too.
 */

export type Newline = '\n' | '\r\n' | '\r';

export interface QuoteError {
  type: 'Quotes';
  code: 'MissingQuotes' | 'InvalidQuotes';
  message: string;
  row: number;
  index: number;
}

export interface FieldCountError {
  type: 'FieldMismatch';
  code: 'TooFewFields' | 'TooManyFields';
  message: string;
  row: number;
}

export interface DelimiterError {
  type: 'Delimiter';
  code: 'UndetectableDelimiter';
  message: string;
}

export type ParseError = QuoteError | DelimiterError | FieldCountError;

export type HeaderRow<V> = Record<string, V | V[]>;

export interface ParseMeta<Field = string> {
  delimiter: string;
  linebreak: Newline;
  aborted: false;
  truncated: boolean;
  cursor: number;
  renamedHeaders: Record<string, Field> | null;
  fields?: Field[];
}

export interface ParseResult<Row, Field = string> {
  data: Row[];
  errors: ParseError[];
  meta: ParseMeta<Field>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- as src/types.ts
export interface PapaParseConfig<_T = any, _TInput = undefined> {
  delimiter?: string | ((input: string) => string) | undefined;
  newline?: '\r' | '\n' | '\r\n' | undefined;
  quoteChar?: string | undefined;
  escapeChar?: string | undefined;
  header?: boolean | undefined;
  transformHeader?: ((header: string, index: number) => string) | undefined;
  dynamicTyping?:
    | boolean
    | {
        [headerName: string]: boolean;
        [columnNumber: number]: boolean;
      }
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

export interface PapaParseError {
  type: 'Quotes' | 'Delimiter' | 'FieldMismatch';
  code:
    'MissingQuotes' | 'UndetectableDelimiter' | 'TooFewFields' | 'TooManyFields' | 'InvalidQuotes';
  message: string;
  row?: number | undefined;
  index?: number | undefined;
}

export interface PapaParseMeta {
  delimiter: string;
  linebreak: string;
  aborted: boolean;
  fields?: string[] | undefined;
  truncated: boolean;
  cursor: number;
  renamedHeaders?: Record<string, string> | null;
}

export interface PapaParseResult<T> {
  data: T[];
  errors: PapaParseError[];
  meta: PapaParseMeta;
}

export declare class UnsupportedFeatureError extends Error {
  override readonly name: 'UnsupportedFeatureError';
  readonly feature: string;
  constructor(feature: string);
}

export declare const BAD_DELIMITERS: readonly string[];
export declare const RECORD_SEP = '\u001E';
export declare const UNIT_SEP = '\u001F';
export declare const BYTE_ORDER_MARK = '\uFEFF';

export declare function parse<T>(input: string, config?: PapaParseConfig<T>): PapaParseResult<T>;

export declare function unparse(input: unknown, config?: PapaUnparseConfig): string;

declare const papa: Readonly<{
  parse: typeof parse;
  unparse: typeof unparse;
  RECORD_SEP: '\u001E';
  UNIT_SEP: '\u001F';
  BYTE_ORDER_MARK: '\uFEFF';
  BAD_DELIMITERS: readonly string[];
  UnsupportedFeatureError: typeof UnsupportedFeatureError;
}>;
// eslint-disable-next-line @typescript-eslint/no-namespace -- as src/papa.ts
declare namespace papa {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as src/papa.ts
  export type ParseConfig<T = any, TInput = undefined> = PapaParseConfig<T, TInput>;
  export type ParseError = PapaParseError;
  export type ParseMeta = PapaParseMeta;
  export type ParseResult<T> = PapaParseResult<T>;
  export type UnparseConfig = PapaUnparseConfig;
}
export default papa;
