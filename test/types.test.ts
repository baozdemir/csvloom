import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  parse,
  unparse,
  type DynamicTyping,
  type HeaderRow,
  type Newline,
  type ParseConfig,
  type ParseError,
  type ParseMeta,
  type ParseResult,
  type Transform,
  type TypedValue,
  type UnparseConfig,
  type UnparseInput,
} from '../src/index.ts';
import Papa from '../src/papa.ts';
import {
  parseStream,
  type BatchIterator,
  type ParseBatch,
  type StreamConfig,
  type StreamMeta,
  type StreamSource,
} from '../src/stream.ts';
import type * as Reference from 'papaparse';
import type * as RealPapa from '../src/papa.ts';
import type * as Real from '../src/types.ts';
import type * as Frozen from './types/papa-frozen.ts';
import type FrozenPapa from './types/papa-frozen.ts';
import type { AbortSignalLike, ReadableStreamLike } from '../src/types.ts';
import type { InferOutput, SchemaResult, StandardSchemaV1 } from '../src/types.ts';
import {
  parseDetailed,
  type DetailedConfig,
  type Detection,
  type FeatureResult,
  type Located,
  type Repair,
  type RepairRule,
  type SchemaError,
} from '../src/index.ts';

/**
 * The public type contract, checked by `npm run typecheck`. Never called: the calls
 * marked @ts-expect-error would throw.
 */
export function typeContract(
  headerVariable: boolean,
  typingVariable: boolean,
  configVariable: ParseConfig | undefined,
): void {
  expectTypeOf(parse('a,b').data).toEqualTypeOf<string[][]>();
  expectTypeOf(parse('a,b', { header: true }).data).toEqualTypeOf<Array<HeaderRow<string>>>();
  expectTypeOf(parse('a,b', { dynamicTyping: true }).data).toEqualTypeOf<TypedValue[][]>();
  expectTypeOf(parse('a,b', { header: true, dynamicTyping: { b: true } }).data).toEqualTypeOf<
    Array<HeaderRow<TypedValue>>
  >();
  expectTypeOf(parse('a,b', { transform: (v) => v.length }).data).toEqualTypeOf<unknown[][]>();
  expectTypeOf(parse('a,b', { header: true, transform: (v) => v }).data).toEqualTypeOf<
    Array<HeaderRow<unknown>>
  >();
  expectTypeOf(parse('a,b', { header: headerVariable }).data).toEqualTypeOf<
    Array<unknown[] | HeaderRow<unknown>>
  >();
  expectTypeOf(parse('a,b', { dynamicTyping: typingVariable }).data).toEqualTypeOf<
    Array<unknown[] | HeaderRow<unknown>>
  >();
  expectTypeOf(parse('a,b', configVariable).data).toEqualTypeOf<
    Array<unknown[] | HeaderRow<unknown>>
  >();

  // A header record value may be the __parsed_extra array, and any key may be absent.
  const row = parse('a\n1,2', { header: true }).data[0];
  expectTypeOf(row?.['a']).toEqualTypeOf<string | string[] | undefined>();
  expectTypeOf(row?.['__parsed_extra']).toEqualTypeOf<string | string[] | undefined>();

  const result = parse('a,b');
  expectTypeOf(result).toEqualTypeOf<ParseResult<string[]>>();
  expectTypeOf(result.errors).toEqualTypeOf<ParseError[]>();
  expectTypeOf(result.meta).toEqualTypeOf<ParseMeta>();
  expectTypeOf(result.meta.aborted).toEqualTypeOf<false>();
  expectTypeOf(result.meta.linebreak).toEqualTypeOf<Newline>();
  expectTypeOf(result.meta.fields).toEqualTypeOf<string[] | undefined>();
  expectTypeOf<ParseConfig['dynamicTyping']>().toEqualTypeOf<DynamicTyping | false | undefined>();
  expectTypeOf<ParseConfig['transform']>().toEqualTypeOf<Transform | undefined>();

  expectTypeOf(unparse([['a', 'b']])).toEqualTypeOf<string>();
  expectTypeOf(unparse).parameter(0).toEqualTypeOf<UnparseInput>();
  expectTypeOf(unparse).parameter(1).toEqualTypeOf<UnparseConfig | undefined>();

  // csvloom/papa is typed as @types/papaparse types Papa: without a type argument or an
  // annotation the rows are unknown, and a header name is the string transformHeader's type says.
  expectTypeOf(Papa.parse('a,b', { header: true })).toEqualTypeOf<
    Frozen.PapaParseResult<unknown>
  >();
  expectTypeOf(Papa.unparse([['a', 'b']])).toEqualTypeOf<string>();

  // @ts-expect-error -- an unknown key
  parse('a,b', { delimiters: ',' });
  // @ts-expect-error -- header is a boolean
  parse('a,b', { header: 'yes' });
  // @ts-expect-error -- not a newline
  parse('a,b', { newline: 'x' });
  // @ts-expect-error -- an excluded option is not a main-entry key (D3)
  parse('a,b', { worker: true });
  // @ts-expect-error -- the input is a string
  parse(123);
  // @ts-expect-error -- not a dynamicTyping value
  parse('a,b', { dynamicTyping: 'yes' });
  // @ts-expect-error -- a main-entry header name is a string
  parse('a,b', { header: true, transformHeader: () => 1 });
  // @ts-expect-error -- csvloom/papa types an excluded option as its inactive value (D3)
  Papa.parse('a,b', { worker: true });
  // @ts-expect-error -- quotes is a boolean, a boolean array or a function
  unparse([['a', 'b']], { quotes: 'yes' });
}

/**
 * The type contract of parseDetailed, on the real function. Checked by `npm run typecheck`, and
 * once more with exactOptionalPropertyTypes off; never called.
 */
export function detailedContract(
  num: StandardSchemaV1<{ age: string }, { age: number }>,
  maybe: StandardSchemaV1<{ age: string }, { age: number }> | undefined,
  headerVariable: boolean,
  detailedVariable: DetailedConfig | undefined,
  configVariable: ParseConfig | undefined,
): void {
  // header, dynamicTyping and transform give the row types parse's overloads give.
  expectTypeOf(parseDetailed('x').data).toEqualTypeOf<string[][]>();
  expectTypeOf(parseDetailed('x', { header: true, positions: true }).data).toEqualTypeOf<
    Array<HeaderRow<string>>
  >();
  expectTypeOf(parseDetailed('x', { dynamicTyping: true, repair: true }).data).toEqualTypeOf<
    TypedValue[][]
  >();
  expectTypeOf(
    parseDetailed('x', { header: true, dynamicTyping: { b: true }, sepLine: true }).data,
  ).toEqualTypeOf<Array<HeaderRow<TypedValue>>>();
  expectTypeOf(
    parseDetailed('x', { transform: (v) => v.length, positions: false }).data,
  ).toEqualTypeOf<unknown[][]>();
  expectTypeOf(
    parseDetailed('x', { header: true, transform: (v) => v, repair: ['pad-missing'] }).data,
  ).toEqualTypeOf<Array<HeaderRow<unknown>>>();
  expectTypeOf(parseDetailed('x', { detect: true }).data).toEqualTypeOf<string[][]>();
  expectTypeOf(parseDetailed('x', { header: true, detect: true }).data).toEqualTypeOf<
    Array<HeaderRow<string>>
  >();
  expectTypeOf(parseDetailed('x', { header: headerVariable, positions: true }).data).toEqualTypeOf<
    Array<unknown[] | HeaderRow<unknown>>
  >();
  expectTypeOf(parseDetailed('x', configVariable).data).toEqualTypeOf<
    Array<unknown[] | HeaderRow<unknown>>
  >();

  // The result: parse's keys, errors that may carry a position, and the repair log.
  const plain = parseDetailed('x', { repair: true });
  expectTypeOf(plain).toEqualTypeOf<FeatureResult<string[]>>();
  expectTypeOf(plain.errors).toEqualTypeOf<Array<Located<ParseError>>>();
  expectTypeOf(plain.errors[0]?.line).toEqualTypeOf<number | undefined>();
  expectTypeOf(plain.errors[0]?.snippet).toEqualTypeOf<string | undefined>();
  expectTypeOf(plain.meta.sepLine).toEqualTypeOf<true | undefined>();
  expectTypeOf(plain.meta.detected).toEqualTypeOf<Detection | undefined>();
  expectTypeOf(plain.meta.fields).toEqualTypeOf<string[] | undefined>();
  expectTypeOf(plain.repairs).toEqualTypeOf<Repair[] | undefined>();
  expectTypeOf(plain.repairCounts).toEqualTypeOf<Record<RepairRule, number> | undefined>();
  // Without a schema it is assignable to parse's result type.
  expectTypeOf(parseDetailed('x', { header: true, positions: true })).toExtend<
    ParseResult<HeaderRow<string>>
  >();
  expectTypeOf(parseDetailed('x', configVariable)).toExtend<
    ParseResult<unknown[] | HeaderRow<unknown>>
  >();

  // schema: inferred row type, and errors that admit SchemaError.
  const checked = parseDetailed('x', { header: true, schema: num });
  expectTypeOf(checked.data).toEqualTypeOf<Array<{ age: number }>>();
  expectTypeOf(checked.errors).toEqualTypeOf<Array<Located<ParseError | SchemaError>>>();
  expectTypeOf<SchemaError>().toExtend<(typeof checked.errors)[number]>();
  expectTypeOf(checked).not.toExtend<ParseResult<{ age: number }>>();
  // A schema that may be undefined compiles, with and without exactOptionalPropertyTypes.
  expectTypeOf(parseDetailed('x', { header: true, schema: maybe }).data).toEqualTypeOf<
    Array<{ age: number } | unknown[] | HeaderRow<unknown>>
  >();
  // Known limit: the schema of a DetailedConfig variable is not known, so the rows are unknown.
  expectTypeOf(parseDetailed('x', detailedVariable).data).toEqualTypeOf<unknown[]>();

  // @ts-expect-error -- an unknown key
  parseDetailed('x', { header: true, nope: 1 });
  // @ts-expect-error -- an excluded option is not a key (D3)
  parseDetailed('x', { header: true, worker: true });
  // @ts-expect-error -- a misspelt key
  parseDetailed('x', { header: true, postions: true });
  // @ts-expect-error -- a misspelt key beside a schema
  parseDetailed('x', { schema: num, postions: true });
  // @ts-expect-error -- not a rule name
  parseDetailed('x', { repair: ['pad'] });
  // @ts-expect-error -- positions is a boolean
  parseDetailed('x', { positions: 'yes' });
  // @ts-expect-error -- not a Standard Schema v1 object
  parseDetailed('x', { schema: { validate: () => true } });
  // @ts-expect-error -- detect is a boolean
  parseDetailed('x', { detect: 'yes' });
  // @ts-expect-error -- parse takes no feature key
  parse('x', { positions: true });
  // @ts-expect-error -- the input is a string
  parseDetailed(123, { positions: true });
}

/** The csvloom/stream type contract, checked by `npm run typecheck`. Never called. */
export function streamContract(
  strings: AsyncIterable<string>,
  bytes: Iterable<Uint8Array>,
  web: ReadableStream<Uint8Array>,
  file: Readable,
  headerVariable: boolean,
  signal: AbortSignal,
  response: Response,
  blob: Blob,
  configVariable: StreamConfig | undefined,
): void {
  // Batch row types follow parse's overloads.
  expectTypeOf(parseStream(strings)).toEqualTypeOf<BatchIterator<string[]>>();
  expectTypeOf(parseStream(bytes, { header: true })).toEqualTypeOf<
    BatchIterator<HeaderRow<string>>
  >();
  expectTypeOf(parseStream(web, { dynamicTyping: true })).toEqualTypeOf<
    BatchIterator<TypedValue[]>
  >();
  expectTypeOf(parseStream(file, { header: true, dynamicTyping: { a: true } })).toEqualTypeOf<
    BatchIterator<HeaderRow<TypedValue>>
  >();
  expectTypeOf(parseStream(['a,b'], { transform: (v) => v.length })).toEqualTypeOf<
    BatchIterator<unknown[]>
  >();
  expectTypeOf(parseStream(['a,b'], { header: true, transform: (v) => v })).toEqualTypeOf<
    BatchIterator<HeaderRow<unknown>>
  >();
  expectTypeOf(parseStream(strings, { header: headerVariable })).toEqualTypeOf<
    BatchIterator<unknown[] | HeaderRow<unknown>>
  >();
  // A StreamConfig variable may hold a schema, whose output cannot be known, as a
  // DetailedConfig variable in parseDetailed; a config without the schema key keeps the row union.
  expectTypeOf(parseStream(strings, configVariable)).toEqualTypeOf<
    BatchIterator<unknown, ParseError | SchemaError>
  >();
  expectTypeOf(
    parseStream(strings, {} as (StreamConfig & { schema?: undefined }) | undefined),
  ).toEqualTypeOf<BatchIterator<unknown[] | HeaderRow<unknown>>>();
  expectTypeOf(parseStream(strings, {} as ParseConfig | undefined)).toEqualTypeOf<
    BatchIterator<unknown[] | HeaderRow<unknown>>
  >();
  // A string source is accepted (read as one chunk).
  expectTypeOf(parseStream('a,b\n1,2')).toEqualTypeOf<BatchIterator<string[]>>();

  // What next() and return() resolve to.
  expectTypeOf(parseStream(strings).next()).resolves.toEqualTypeOf<
    IteratorResult<ParseBatch<string[]>, undefined>
  >();
  expectTypeOf(parseStream(strings).return()).resolves.toEqualTypeOf<
    IteratorReturnResult<undefined>
  >();
  // The same through the method types, which read the last signature of an overloaded member.
  type Steps = BatchIterator<string[]>;
  expectTypeOf<ReturnType<Steps['return']>>().toEqualTypeOf<
    Promise<IteratorReturnResult<undefined>>
  >();
  expectTypeOf<Parameters<Steps['return']>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<Steps['next']>>().toEqualTypeOf<
    Promise<IteratorResult<ParseBatch<string[]>, undefined>>
  >();
  expectTypeOf<Parameters<Steps['next']>>().toEqualTypeOf<[]>();
  expectTypeOf(parseStream(strings, { header: true }).return()).resolves.toEqualTypeOf<
    IteratorReturnResult<undefined>
  >();
  expectTypeOf(parseStream(strings)[Symbol.asyncIterator]().next()).resolves.toEqualTypeOf<
    IteratorResult<ParseBatch<string[]>, undefined>
  >();
  expectTypeOf<ParseBatch<string[]>>().toEqualTypeOf<{
    data: string[][];
    errors: Array<Located<ParseError>>;
    meta: StreamMeta;
    repairs?: Repair[];
    repairCounts?: Record<RepairRule, number>;
  }>();
  // Without positions an error of a batch is still a ParseError.
  expectTypeOf<ParseBatch<string[]>['errors']>().toExtend<ParseError[]>();
  expectTypeOf<StreamMeta['linebreak']>().toEqualTypeOf<Newline>();
  expectTypeOf<StreamMeta['fields']>().toEqualTypeOf<string[] | undefined>();
  expectTypeOf<keyof StreamMeta>().toEqualTypeOf<
    | 'delimiter'
    | 'linebreak'
    | 'fields'
    | 'renamedHeaders'
    | 'rowOffset'
    | 'cursor'
    | 'truncated'
    | 'done'
    | 'detected'
    | 'sepLine'
  >();
  expectTypeOf<StreamMeta['detected']>().toEqualTypeOf<Detection | undefined>();
  expectTypeOf<StreamMeta['sepLine']>().toEqualTypeOf<true | undefined>();

  // The options the stream adds, and no others.
  expectTypeOf(
    parseStream(strings, { batchSize: 2, maxRecordLength: 1_048_576, signal }),
  ).toEqualTypeOf<BatchIterator<string[]>>();
  expectTypeOf<Exclude<keyof StreamConfig, keyof DetailedConfig>>().toEqualTypeOf<
    'batchSize' | 'maxRecordLength' | 'signal'
  >();
  // The stream takes the five feature keys of parseDetailed, and no others.
  expectTypeOf<Exclude<keyof StreamConfig, keyof ParseConfig>>().toEqualTypeOf<
    | 'batchSize'
    | 'maxRecordLength'
    | 'signal'
    | 'detect'
    | 'positions'
    | 'repair'
    | 'schema'
    | 'sepLine'
  >();

  // The features in parseStream: the seven row types are unchanged by a feature key, and
  // a schema, sync or async, gives its output as the rows and admits Schema errors.
  expectTypeOf(
    parseStream(strings, {
      header: true,
      positions: true,
      repair: true,
      detect: true,
      sepLine: true,
    }),
  ).toEqualTypeOf<BatchIterator<HeaderRow<string>>>();
  const ageSchema = {} as StandardSchemaV1<unknown, { age: number }>;
  const withSchema = parseStream(strings, { header: true, schema: ageSchema });
  expectTypeOf(withSchema).toEqualTypeOf<
    BatchIterator<{ age: number }, ParseError | SchemaError>
  >();
  expectTypeOf(withSchema.next()).resolves.toEqualTypeOf<
    IteratorResult<ParseBatch<{ age: number }, ParseError | SchemaError>, undefined>
  >();
  expectTypeOf<ParseBatch<{ age: number }, ParseError | SchemaError>['errors']>().toEqualTypeOf<
    Array<Located<ParseError | SchemaError>>
  >();
  const maybeSchema = {} as StandardSchemaV1<unknown, { age: number }> | undefined;
  expectTypeOf(parseStream(strings, { schema: maybeSchema })).toEqualTypeOf<
    BatchIterator<{ age: number } | unknown[] | HeaderRow<unknown>, ParseError | SchemaError>
  >();
  expectTypeOf<
    BatchIterator<{ age: number }, ParseError | SchemaError>
  >().toExtend<AsyncDisposable>();
  // @ts-expect-error -- a misspelt feature key, without a schema
  parseStream(strings, { position: true });
  // @ts-expect-error -- and with one
  parseStream(strings, { schema: ageSchema, position: true });
  // @ts-expect-error -- repair takes rule names
  parseStream(strings, { repair: ['nope'] });
  expectTypeOf<StreamConfig['signal']>().toEqualTypeOf<AbortSignalLike | undefined>();

  // The platform's own types are sources and signals, also under exactOptionalPropertyTypes.
  expectTypeOf<ReadableStream<Uint8Array>>().toExtend<StreamSource>();
  expectTypeOf<ReadableStream<string>>().toExtend<StreamSource>();
  expectTypeOf<NonNullable<Response['body']>>().toExtend<StreamSource>();
  expectTypeOf<ReturnType<Blob['stream']>>().toExtend<StreamSource>();
  expectTypeOf<NodeReadableStream<Uint8Array>>().toExtend<StreamSource>();
  expectTypeOf<Readable>().toExtend<StreamSource>();
  expectTypeOf<AbortSignal>().toExtend<NonNullable<StreamConfig['signal']>>();
  expectTypeOf<Response['body']>().not.toExtend<StreamSource>();
  expectTypeOf<Uint8Array[]>().toExtend<StreamSource>();
  expectTypeOf<AsyncGenerator<string, void, void>>().toExtend<StreamSource>();
  expectTypeOf<Array<string | Uint8Array>>().not.toExtend<StreamSource>();
  expectTypeOf<number[]>().not.toExtend<StreamSource>();
  if (response.body !== null) {
    expectTypeOf(parseStream(response.body)).toEqualTypeOf<BatchIterator<string[]>>();
  }
  expectTypeOf(parseStream(blob.stream())).toEqualTypeOf<BatchIterator<string[]>>();

  // With a lib that has Symbol.asyncDispose (this project's, through @types/node), the
  // iterator is an AsyncDisposable. No global is augmented for it.
  expectTypeOf<BatchIterator<string[]>>().toExtend<AsyncDisposable>();
  expectTypeOf(parseStream(strings)[Symbol.asyncDispose]()).toEqualTypeOf<Promise<void>>();
  expectTypeOf<BatchIterator<string[]>>().toExtend<
    AsyncIterableIterator<ParseBatch<string[]>, undefined, undefined>
  >();

  // @ts-expect-error -- a response without a body has none to parse: Response['body'] is nullable
  parseStream(response.body);
  // @ts-expect-error -- a source must not mix string and Uint8Array chunks
  parseStream(['a,b\n', Uint8Array.of(0x31)]);
  // @ts-expect-error -- an unknown key
  parseStream(strings, { batchsize: 2 });
  // @ts-expect-error -- batchSize is a number
  parseStream(strings, { batchSize: '2' });
  // @ts-expect-error -- an AbortController is not its signal
  parseStream(strings, { signal: new AbortController() });
  // @ts-expect-error -- an excluded option is not a stream key either (D3)
  parseStream(strings, { worker: true });
}

describe('public entry', () => {
  it('has a type contract, checked by npm run typecheck', () => {
    expectTypeOf(typeContract).toBeFunction();
  });

  it('has a type contract for parseDetailed, checked by npm run typecheck', () => {
    expectTypeOf(detailedContract).toBeFunction();
  });

  it('csvloom/stream has a type contract, checked by npm run typecheck', () => {
    expectTypeOf(streamContract).toBeFunction();
  });

  it('csvloom/stream exports exactly parseStream', async () => {
    const entry = await import('../src/stream.ts');
    expect(Object.keys(entry)).toStrictEqual(['parseStream']);
  });

  it('exports exactly parse, parseDetailed, unparse, UnsupportedFeatureError, formatError, detect, excel and excelSemicolon', async () => {
    const entry = await import('../src/index.ts');
    expect(Object.keys(entry).sort()).toStrictEqual([
      'UnsupportedFeatureError',
      'detect',
      'excel',
      'excelSemicolon',
      'formatError',
      'parse',
      'parseDetailed',
      'unparse',
    ]);
  });
});

describe('structural platform types, checked by npm run typecheck', () => {
  it('accept the Web streams and the AbortSignal of the DOM lib and of @types/node', () => {
    type Chunks = ReadableStreamLike<string | Uint8Array>;
    expectTypeOf<ReadableStream<Uint8Array>>().toExtend<Chunks>();
    expectTypeOf<ReadableStream<string>>().toExtend<Chunks>();
    expectTypeOf<NonNullable<Response['body']>>().toExtend<Chunks>();
    expectTypeOf<ReturnType<Blob['stream']>>().toExtend<Chunks>();
    expectTypeOf<NodeReadableStream<Uint8Array>>().toExtend<Chunks>();
    expectTypeOf<Response['body']>().not.toExtend<Chunks>();
    expectTypeOf<AbortSignal>().toExtend<AbortSignalLike>();
    expectTypeOf<AbortController>().not.toExtend<AbortSignalLike>();
  });
});

describe('the Standard Schema v1 copy, checked by npm run typecheck', () => {
  it('infers the output and accepts validate with one parameter, with options, or async', () => {
    expectTypeOf<InferOutput<StandardSchemaV1<unknown, { age: number }>>>().toEqualTypeOf<{
      age: number;
    }>();
    expectTypeOf<InferOutput<StandardSchemaV1<{ age: string }, { age: number }>>>().toEqualTypeOf<{
      age: number;
    }>();

    const one = {
      '~standard': {
        version: 1 as const,
        vendor: 'one',
        validate: (value: unknown) => ({ value }),
      },
    };
    const withOptions = {
      '~standard': {
        version: 1 as const,
        vendor: 'options',
        validate: (
          value: unknown,
          options?: { readonly libraryOptions?: Record<string, unknown> | undefined },
        ): SchemaResult<{ age: number }> =>
          options
            ? { issues: [{ message: 'no', path: [{ key: 'age' }, 0] }] }
            : { value: { age: Number(value) } },
        types: { input: { age: '' }, output: { age: 0 } },
      },
    };
    const async = {
      '~standard': {
        version: 1 as const,
        vendor: 'async',
        validate: (value: unknown) => Promise.resolve({ value }),
      },
    };
    expectTypeOf(one).toExtend<StandardSchemaV1>();
    expectTypeOf(withOptions).toExtend<StandardSchemaV1>();
    expectTypeOf(withOptions).toExtend<StandardSchemaV1<{ age: string }, { age: number }>>();
    expectTypeOf(async).toExtend<StandardSchemaV1>();
    expectTypeOf({
      '~standard': { ...one['~standard'], version: 2 },
    }).not.toExtend<StandardSchemaV1>();
  });
});

// Equal is true only when A and B are identical; same compiles only for true. Their T is read by
// the type checker alone.
type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Both<A, B> = [Equal<A, B>, Equal<B, A>] extends [true, true] ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
const same = <T extends true>(): T | undefined => undefined;

/**
 * Every type csvloom/papa reaches equals, in both directions, its frozen copy in
 * test/types/papa-frozen.ts. Checked by npm run typecheck; never called.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- R, F, V: any types
export function papaFrozenContract<R, F, V>(): void {
  same<Both<typeof Papa, typeof FrozenPapa>>();
  same<Both<typeof RealPapa.parse, typeof Frozen.parse>>();
  same<Both<typeof RealPapa.unparse, typeof Frozen.unparse>>();
  same<Both<typeof RealPapa.RECORD_SEP, typeof Frozen.RECORD_SEP>>();
  same<Both<typeof RealPapa.UNIT_SEP, typeof Frozen.UNIT_SEP>>();
  same<Both<typeof RealPapa.BYTE_ORDER_MARK, typeof Frozen.BYTE_ORDER_MARK>>();
  same<Both<typeof RealPapa.BAD_DELIMITERS, typeof Frozen.BAD_DELIMITERS>>();
  same<Both<typeof RealPapa.UnsupportedFeatureError, typeof Frozen.UnsupportedFeatureError>>();
  same<Both<RealPapa.UnsupportedFeatureError, Frozen.UnsupportedFeatureError>>();
  same<Both<Real.PapaParseConfig, Frozen.PapaParseConfig>>();
  same<Both<Real.PapaUnparseConfig, Frozen.PapaUnparseConfig>>();
  // The type parameters, the three result types under @types/papaparse's names, the
  // names as named exports and the names on the default import.
  same<Both<Real.PapaParseConfig<R, F>, Frozen.PapaParseConfig<R, F>>>();
  same<Both<Real.PapaParseError, Frozen.PapaParseError>>();
  same<Both<Real.PapaParseMeta, Frozen.PapaParseMeta>>();
  same<Both<Real.PapaParseResult<R>, Frozen.PapaParseResult<R>>>();
  same<Both<RealPapa.ParseConfig<R, F>, Frozen.PapaParseConfig<R, F>>>();
  same<Both<RealPapa.ParseConfig, Frozen.PapaParseConfig>>();
  same<Both<RealPapa.ParseError, Frozen.PapaParseError>>();
  same<Both<RealPapa.ParseMeta, Frozen.PapaParseMeta>>();
  same<Both<RealPapa.ParseResult<R>, Frozen.PapaParseResult<R>>>();
  same<Both<RealPapa.UnparseConfig, Frozen.PapaUnparseConfig>>();
  same<Both<Papa.ParseConfig<R, F>, FrozenPapa.ParseConfig<R, F>>>();
  same<Both<Papa.ParseConfig, FrozenPapa.ParseConfig>>();
  same<Both<Papa.ParseError, FrozenPapa.ParseError>>();
  same<Both<Papa.ParseMeta, FrozenPapa.ParseMeta>>();
  same<Both<Papa.ParseResult<R>, FrozenPapa.ParseResult<R>>>();
  same<Both<Papa.UnparseConfig, FrozenPapa.UnparseConfig>>();
  same<Both<Real.ParseResult<R, F>, Frozen.ParseResult<R, F>>>();
  same<Both<Real.ParseResult<string[]>, Frozen.ParseResult<string[]>>>();
  same<
    Both<
      Real.ParseResult<unknown[] | Real.HeaderRow<unknown>, unknown>,
      Frozen.ParseResult<unknown[] | Frozen.HeaderRow<unknown>, unknown>
    >
  >();
  same<Both<Real.ParseMeta<F>, Frozen.ParseMeta<F>>>();
  same<Both<Real.ParseMeta, Frozen.ParseMeta>>();
  same<Both<Real.ParseError, Frozen.ParseError>>();
  same<Both<Real.QuoteError, Frozen.QuoteError>>();
  same<Both<Real.DelimiterError, Frozen.DelimiterError>>();
  same<Both<Real.FieldCountError, Frozen.FieldCountError>>();
  same<Both<Real.HeaderRow<V>, Frozen.HeaderRow<V>>>();
  same<Both<Real.HeaderRow<string>, Frozen.HeaderRow<string>>>();
  same<Both<Real.Newline, Frozen.Newline>>();
  // The helper rejects a near miss.
  // @ts-expect-error -- a QuoteError without index is not a QuoteError
  same<Both<Real.QuoteError, Omit<Frozen.QuoteError, 'index'>>>();
  // @ts-expect-error -- an optional property is not the same as a required one
  same<Both<Real.ParseMeta, Partial<Frozen.ParseMeta>>>();
}

describe('csvloom/papa types, checked by npm run typecheck', () => {
  it('equal their frozen copies, in both directions', () => {
    expectTypeOf(papaFrozenContract).toBeFunction();
  });
});

/**
 * csvloom/papa under the type names of @types/papaparse 5.5.2 (Reference here). A type
 * it returns is declared as Reference declares it, and null is added for renamedHeaders; a config
 * holds the supported options with Reference's value types and the unsupported ones as their
 * inactive values (D3). Checked by npm run typecheck; never called.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- R: any type
export function papaNamesContract<R>(text: string, blob: Blob): void {
  interface Row {
    name: string;
  }
  // parse<T>, as Reference's call with a string: T from a type argument, from an annotation or
  // from a config variable's type; otherwise unknown.
  expectTypeOf(Papa.parse<Row>(text, { header: true })).toEqualTypeOf<RealPapa.ParseResult<Row>>();
  expectTypeOf(Papa.parse<Row>(text, { header: true }).data).toEqualTypeOf<Row[]>();
  expectTypeOf(Papa.parse<Row>(text).meta.fields).toEqualTypeOf<string[] | undefined>();
  const annotated: RealPapa.ParseResult<Row> = Papa.parse(text, { header: true });
  expectTypeOf(annotated.data).toEqualTypeOf<Row[]>();
  const config: RealPapa.ParseConfig<Row> = { header: true };
  expectTypeOf(Papa.parse(text, config).data).toEqualTypeOf<Row[]>();
  expectTypeOf(Papa.parse(text).data).toEqualTypeOf<unknown[]>();
  // The inactive value of an unsupported option is accepted, as at run time.
  Papa.parse<Row>(text, { worker: false, download: false, encoding: '', withCredentials: false });
  // transform is a method, as in Reference: a function whose field is a string is accepted.
  Papa.parse<Row>(text, { transform: (value: string, field: string) => value + field });

  // The names on the default import are the named exports.
  same<Both<Papa.ParseConfig<R>, RealPapa.ParseConfig<R>>>();
  same<Both<Papa.ParseConfig, RealPapa.ParseConfig>>();
  same<Both<Papa.ParseError, RealPapa.ParseError>>();
  same<Both<Papa.ParseMeta, RealPapa.ParseMeta>>();
  same<Both<Papa.ParseResult<R>, RealPapa.ParseResult<R>>>();
  same<Both<Papa.UnparseConfig, RealPapa.UnparseConfig>>();

  // Returned types are Reference's, but for renamedHeaders, which is also null.
  same<Both<RealPapa.ParseError, Reference.ParseError>>();
  type NotRenamed<Meta> = Omit<Meta, 'renamedHeaders'>;
  same<Both<NotRenamed<RealPapa.ParseMeta>, NotRenamed<Reference.ParseMeta>>>();
  expectTypeOf<RealPapa.ParseMeta['renamedHeaders']>().toEqualTypeOf<
    Record<string, string> | null | undefined
  >();
  type NoMeta<Result> = Omit<Result, 'meta'>;
  same<Both<NoMeta<RealPapa.ParseResult<R>>, NoMeta<Reference.ParseResult<R>>>>();
  same<Both<RealPapa.ParseResult<R>['meta'], RealPapa.ParseMeta>>();
  expectTypeOf<Reference.ParseResult<R>>().toExtend<RealPapa.ParseResult<R>>();
  // What the engine returns fits them: the main entry's result types.
  expectTypeOf<ParseResult<R>>().toExtend<RealPapa.ParseResult<R>>();
  expectTypeOf<ParseError>().toExtend<RealPapa.ParseError>();
  expectTypeOf<ParseMeta>().toExtend<RealPapa.ParseMeta>();

  // Configs: every key of Reference's ParseConfig is a key here; a Reference config without the
  // three callbacks is a config here; the three are typed as their inactive value.
  type Callbacks = 'step' | 'complete' | 'beforeFirstChunk';
  expectTypeOf<keyof Reference.ParseConfig>().toExtend<keyof RealPapa.ParseConfig>();
  expectTypeOf<Omit<Reference.ParseConfig<R>, Callbacks>>().toExtend<RealPapa.ParseConfig<R>>();
  expectTypeOf<RealPapa.ParseConfig<R>[Callbacks]>().toEqualTypeOf<undefined>();
  expectTypeOf<Reference.UnparseConfig>().toExtend<RealPapa.UnparseConfig>();

  // @ts-expect-error -- step is typed as its inactive value: csvloom/papa throws for it (D3)
  Papa.parse<Row>(text, { step: () => undefined });
  // @ts-expect-error -- complete: the result is returned, and the callback throws (D3)
  Papa.parse<Row>(text, { complete: () => undefined });
  // @ts-expect-error -- chunk (D3)
  Papa.parse<Row>(text, { chunk: () => undefined });
  // @ts-expect-error -- beforeFirstChunk (D3)
  Papa.parse<Row>(text, { beforeFirstChunk: (chunk: string) => chunk });
  // @ts-expect-error -- download (D3)
  Papa.parse<Row>(text, { download: true });
  // @ts-expect-error -- encoding (D3)
  Papa.parse<Row>(text, { encoding: 'latin1' });
  // @ts-expect-error -- the input is a string: a File or a Blob goes to parseStream
  Papa.parse<Row>(blob);
  // @ts-expect-error -- a row type is one type argument, not two
  Papa.parse<Row, File>(text);
  // @ts-expect-error -- unparse takes no type argument
  Papa.unparse<Row>([]);
  // @ts-expect-error -- a quotes function's value is unknown here and any in Reference
  Papa.unparse([], { quotes: (value: string) => value.length > 3 });
  // @ts-expect-error -- no ParseStepResult: there is no step callback
  expectTypeOf<RealPapa.ParseStepResult<Row>>();
  // @ts-expect-error -- nor on the default import
  expectTypeOf<Papa.ParseStepResult<Row>>();
}

describe('csvloom/papa under the type names of @types/papaparse', () => {
  it('has a type contract, checked by npm run typecheck', () => {
    expectTypeOf(papaNamesContract).toBeFunction();
  });

  it('compiles Papa Parse code with only its import changed, and returns the same', async () => {
    const source = (name: string) =>
      readFileSync(new URL(`./types/papa-snippets.${name}.ts`, import.meta.url), 'utf8');
    const changed = source('papaparse').replace(
      "} from 'papaparse';",
      "} from '../../src/papa.ts';",
    );
    expect(changed).not.toBe(source('papaparse'));
    expect(source('csvloom')).toBe(changed);

    const reference = await import('./types/papa-snippets.papaparse.ts');
    const engine = await import('./types/papa-snippets.csvloom.ts');
    expect(Object.keys(engine.snippets())).toHaveLength(10);
    expect(engine.snippets()).toStrictEqual(reference.snippets());
  });
});
