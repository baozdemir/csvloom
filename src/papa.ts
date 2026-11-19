import {
  BAD_DELIMITERS,
  checkInput,
  resolveParseConfig,
  resolveUnparseConfig,
  UnsupportedFeatureError,
} from './options.ts';
import { parseWith } from './parse.ts';
import type {
  PapaParseConfig,
  PapaParseError,
  PapaParseMeta,
  PapaParseResult,
  PapaUnparseConfig,
} from './types.ts';
import { unparseWith } from './unparse.ts';

/** Papa.RECORD_SEP: the ASCII record separator, U+001E. */
export const RECORD_SEP = '\x1e';
/** Papa.UNIT_SEP: the ASCII unit separator, U+001F. */
export const UNIT_SEP = '\x1f';
/** Papa.BYTE_ORDER_MARK: U+FEFF. */
export const BYTE_ORDER_MARK = '\ufeff';
export { BAD_DELIMITERS, UnsupportedFeatureError };
/** The type names of @types/papaparse 5.5.2 that have a meaning in csvloom/papa. */
export type {
  PapaParseConfig as ParseConfig,
  PapaParseError as ParseError,
  PapaParseMeta as ParseMeta,
  PapaParseResult as ParseResult,
  PapaUnparseConfig as UnparseConfig,
};

/**
 * Papa Parse 5.7.1's parse of a string: the config is read with Papa's coercions and unknown keys
 * are ignored. A feature csvloom leaves out, such as a worker, a download, a callback or a File,
 * Blob or stream input, throws UnsupportedFeatureError; the other differences are listed in the
 * compatibility guide.
 * Typed as @types/papaparse 5.5.2 types the string call: T is the row type the caller states, and
 * nothing checks it.
 *
 * @example
 * ```ts
 * import Papa from 'csvloom/papa'; // was: import Papa from 'papaparse';
 *
 * type Item = { sku: string; qty: number };
 * const { data } = Papa.parse<Item>('sku,qty\nA-1,2\n', { header: true, dynamicTyping: true, skipEmptyLines: true });
 * // data: [{ sku: 'A-1', qty: 2 }]
 * ```
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/migrating-from-papaparse.md
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/compatibility.md
 */
export function parse<T>(input: string, config?: PapaParseConfig<T>): PapaParseResult<T> {
  // Papa reads its config before it looks at the input.
  const options = resolveParseConfig(config, 'papa');
  return parseWith(checkInput(input, 'papa'), options) as PapaParseResult<T>;
}

/**
 * Papa Parse 5.7.1's unparse, its config read as Papa reads it. The differences are listed in the
 * compatibility guide.
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/compatibility.md
 */
export function unparse(input: unknown, config?: PapaUnparseConfig): string {
  return unparseWith(input, resolveUnparseConfig(config, 'papa'));
}

/** The Papa object's supported members, frozen. */
const Papa = Object.freeze({
  parse,
  unparse,
  RECORD_SEP,
  UNIT_SEP,
  BYTE_ORDER_MARK,
  BAD_DELIMITERS,
  UnsupportedFeatureError,
});
/** The same type names on the default import, as in `Papa.ParseResult<Row>`. */
// eslint-disable-next-line @typescript-eslint/no-namespace -- types only: nothing is emitted
declare namespace Papa {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/papaparse's default
  export type ParseConfig<T = any, TInput = undefined> = PapaParseConfig<T, TInput>;
  export type ParseError = PapaParseError;
  export type ParseMeta = PapaParseMeta;
  export type ParseResult<T> = PapaParseResult<T>;
  export type UnparseConfig = PapaUnparseConfig;
}
export { Papa as default };
