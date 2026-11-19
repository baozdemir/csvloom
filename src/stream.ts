import { BatchBuilder } from './batches.ts';
import { ByteDecoder, DECODE_WINDOW } from './decode.ts';
import { isPlainObject, resolveDetailedConfig } from './options.ts';
import { rowResult, validateRow } from './schema.ts';
import { isStreamSource, openSource, type OpenSource } from './source.ts';
import type {
  AbortSignalLike,
  BatchIterator,
  DynamicTyping,
  HeaderRow,
  ParseBatch,
  ParseError,
  SchemaError,
  StandardSchemaV1,
  StreamConfig,
  StreamSource,
  Transform,
  TypedValue,
} from './types.ts';

export type { StreamSource, StreamConfig, StreamMeta, ParseBatch, BatchIterator } from './types.ts';
export type {
  ParseConfig,
  ParseError,
  HeaderRow,
  TypedValue,
  DynamicTyping,
  Transform,
  Newline,
  DetailedConfig,
  Position,
  Located,
  Detection,
  DetectionCandidate,
  Repair,
  RepairRule,
  SchemaError,
  StandardSchemaV1,
  SchemaResult,
  SchemaIssue,
  InferOutput,
} from './types.ts';

// The build's lib (es2022) has no DOMException; this is the part used here.
declare const DOMException: new (message: string, name: string) => Error;

type Step = IteratorResult<ParseBatch<unknown, ParseError | SchemaError>, undefined>;
type Plain = StreamConfig & { schema?: undefined };
type WithSchema<Output> = Omit<StreamConfig, 'schema'> & {
  schema: StandardSchemaV1<unknown, Output>;
};
type MaybeSchema<Output> = Omit<StreamConfig, 'schema'> & {
  schema?: StandardSchemaV1<unknown, Output> | undefined;
};
type Read = Awaited<ReturnType<OpenSource['read']>>;

const noop = () => undefined;
const finished = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
const tagOf = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1);
/** What an error message says it got: null, a typeof, or an object's tag. */
const nameOf = (value: unknown) =>
  value === null ? 'null' : typeof value === 'object' ? tagOf(value) : typeof value;
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const mustBe = (key: string, expected: string) =>
  new TypeError(`Parse option "${key}" must be ${expected}`);

/** By tag and members, not instanceof: a signal of another realm passes. */
function isSignal(value: unknown): value is AbortSignalLike {
  const signal = value as Partial<AbortSignalLike>;
  return (
    tagOf(value) === 'AbortSignal' &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  );
}

/**
 * The iterator of one parse. An object with explicit state, not an async generator, so that
 * return() and an abort are never queued behind a pending next(). It reads from the source only
 * inside next(), and only when the batch being filled needs more text.
 */
class Batches {
  readonly #source: OpenSource;
  readonly #builder: BatchBuilder;
  readonly #signal: AbortSignalLike | undefined;
  readonly #schema: StandardSchemaV1 | null;
  /** The Schema errors get the place of their row. */
  readonly #positions: boolean;
  #decoder: ByteDecoder | undefined;
  /** True while #decoder holds a chunk that may have windows left. */
  #loaded = false;
  /** The kind of chunk 0, which every later chunk must have. */
  #kind: 'string' | 'Uint8Array' | undefined;
  #chunks = 0;
  #started = false;
  /** The iteration has ended: last batch, error, abort or return(). */
  #ended = false;
  /** Settles when the last next() made has; never rejects. */
  #tail: Promise<unknown> = Promise.resolve();
  /** The next() calls made whose step has not ended. */
  #calls = 0;
  /** Ends the wait of the next() that is waiting for the source. */
  #wake: (() => void) | undefined;
  /** The abort reason, until one next() has rejected with it. */
  #owed: { reason: unknown } | undefined;
  /** The close that preview or return() started; while #report, its failure is still owed. */
  #closing: Promise<void> | undefined;
  #report = false;

  constructor(
    source: OpenSource,
    builder: BatchBuilder,
    signal: AbortSignalLike | undefined,
    schema: StandardSchemaV1 | null,
    positions: boolean,
  ) {
    this.#source = source;
    this.#builder = builder;
    this.#signal = signal;
    this.#schema = schema;
    this.#positions = positions;
    // Assigned here, not declared: the key exists only where the engine has it, and nothing
    // runs when the module is imported.
    const dispose = (Symbol as { asyncDispose?: unknown }).asyncDispose;
    if (typeof dispose === 'symbol') {
      (this as unknown as Record<symbol, unknown>)[dispose] = async () => {
        await this.return();
      };
    }
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /**
   * Calls are served in order: one made while another is running waits for it. An async method,
   * so that a detached call rejects, as return() does, and never throws.
   */
  async next(): Promise<Step> {
    this.#calls++;
    const step = this.#tail.then(() => this.#step());
    this.#tail = step.catch(noop);
    return step;
  }

  async return(): Promise<IteratorReturnResult<undefined>> {
    if (!this.#ended) {
      this.#end();
      this.#closing = this.#source.close();
      this.#report = true;
      this.#wake?.();
    }
    // An abort reason that no next() is there to reject with is dropped: the consumer has ended
    // the iteration itself. A pending next() still rejects with it.
    if (this.#calls === 0) this.#owed = undefined;
    const closing = this.#closing;
    if (closing !== undefined) {
      const report = this.#report;
      this.#report = false;
      // Each call waits for the close; only the first that follows it reports its failure.
      await (report ? closing : closing.catch(noop));
    }
    return finished();
  }

  /**
   * Whether the iteration has ended. A call, because a callback or the wait for the source may
   * have ended it since the caller last looked.
   */
  #over(): boolean {
    return this.#ended;
  }

  /** Whether an abort reason is still to be reported. A call, for the same reason. */
  #aborted(): boolean {
    return this.#owed !== undefined;
  }

  #end(): void {
    this.#ended = true;
    this.#signal?.removeEventListener('abort', this.#onAbort);
  }

  /**
   * Neither the in-flight read nor the close is awaited; both have a rejection handler. The reason
   * goes to the next() that is running, else to the following one.
   */
  readonly #onAbort = (): void => {
    const reason = this.#signal?.reason;
    this.#end();
    this.#owed = {
      reason:
        reason === undefined
          ? new DOMException('The operation was aborted.', 'AbortError')
          : reason,
    };
    void this.#source.close(reason);
    this.#wake?.();
  };

  /** The source's next chunk, or undefined when an abort or return() ended the wait first. */
  #read(): Promise<Read | undefined> {
    return new Promise((resolve, reject) => {
      this.#wake = () => {
        resolve(undefined);
      };
      this.#source.read().then(resolve, reject);
    });
  }

  /**
   * Validates the rows of a batch in order, one at a time: data becomes the outputs of the valid
   * rows, and each issue of an invalid row is a Schema error after the batch's other errors.
   * Returns a Promise only when a validator returned one; it is awaited before the next row, and
   * nothing more is validated once the iteration has ended.
   */
  #validate(
    schema: StandardSchemaV1,
    batch: ParseBatch<unknown, ParseError | SchemaError>,
  ): Promise<void> | undefined {
    const rows = batch.data;
    const offset = batch.meta.rowOffset;
    const valid: unknown[] = [];
    const invalid: number[] = [];
    const found: SchemaError[][] = [];
    const take = (checked: { value: unknown } | SchemaError[], i: number) => {
      if (Array.isArray(checked)) {
        invalid.push(i);
        found.push(checked);
      } else valid.push(checked.value);
    };
    const finish = () => {
      const places = this.#positions ? this.#builder.positionsOfRows(invalid) : [];
      found.forEach((errors, j) => {
        for (const error of errors) batch.errors.push(Object.assign(error, places[j]));
      });
      batch.data = valid;
    };
    /** Whether the validator just called ended the iteration; its promise is then left handled. */
    const ended = (checked: ReturnType<typeof validateRow>): boolean => {
      if (!this.#over()) return false;
      if (!Array.isArray(checked) && 'then' in checked) void checked.then(noop, noop);
      return true;
    };
    const rest = async (from: number, pending: PromiseLike<unknown>): Promise<void> => {
      let waited = pending;
      for (let i = from; ;) {
        const result = await waited;
        if (this.#over()) return;
        take(rowResult(result as Parameters<typeof rowResult>[0], rows[i], offset + i), i);
        for (i++; i < rows.length; i++) {
          const checked = validateRow(schema, rows[i], offset + i);
          if (ended(checked)) return;
          if (!Array.isArray(checked) && 'then' in checked) {
            waited = checked;
            break;
          }
          take(checked, i);
        }
        if (i === rows.length) break;
      }
      finish();
    };
    for (let i = 0; i < rows.length; i++) {
      const checked = validateRow(schema, rows[i], offset + i);
      if (ended(checked)) return undefined;
      if (!Array.isArray(checked) && 'then' in checked) return rest(i, checked);
      take(checked, i);
    }
    finish();
    return undefined;
  }

  /** Waits for a validation; false when an abort or return() ended the wait first. */
  #settled(validation: Promise<void>): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.#wake = () => {
        resolve(false);
      };
      // A validator that rejects after the wait has ended is handled here and not reported.
      validation.then(() => {
        resolve(true);
      }, reject);
    });
  }

  /** Checks a chunk's kind by behaviour, so that bytes of another realm pass, and takes it. */
  #accept(chunk: unknown): void {
    const index = this.#chunks++;
    const first = this.#kind;
    const kind =
      typeof chunk === 'string'
        ? 'string'
        : ArrayBuffer.isView(chunk) && tagOf(chunk) === 'Uint8Array'
          ? 'Uint8Array'
          : undefined;
    if (kind === undefined || (first !== undefined && kind !== first)) {
      const expected =
        first === undefined ? 'a string or a Uint8Array' : `a ${first}, as chunk 0 is`;
      throw new TypeError(
        `Stream chunk ${String(index)} must be ${expected}, got ${nameOf(chunk)}`,
      );
    }
    this.#kind = kind;
    if (kind === 'string') this.#builder.push(chunk as string);
    else {
      (this.#decoder ??= new ByteDecoder(DECODE_WINDOW)).load(chunk as Uint8Array);
      this.#loaded = true;
    }
  }

  /**
   * One next(). Its call is counted out in the same job that ends the step, not when its promise
   * settles, so an abort and a return() in between find no call pending and drop the reason.
   */
  async #step(): Promise<Step> {
    try {
      if (!this.#started) {
        this.#started = true;
        const signal = this.#signal;
        if (signal !== undefined && !this.#ended) {
          signal.addEventListener('abort', this.#onAbort);
          if (signal.aborted) this.#onAbort();
        }
      }
      if (this.#owed === undefined) {
        if (this.#report) {
          this.#report = false;
          await this.#closing;
        }
        if (this.#ended) return finished();
        const builder = this.#builder;
        try {
          for (;;) {
            const batch = builder.take();
            // A callback aborted the signal or called return(): its batch is dropped.
            if (this.#over()) break;
            if (batch !== undefined) {
              if (this.#schema !== null) {
                // Before the batch ends the iteration: an abort still rejects this call.
                const validation = this.#validate(this.#schema, batch);
                if (validation !== undefined && !(await this.#settled(validation))) break;
                if (this.#over()) break;
              }
              if (batch.meta.done) {
                // Not awaited: a close that hangs must not hold back rows already parsed. It does
                // nothing when the source has ended; otherwise preview ended the parse.
                this.#end();
                this.#closing = this.#source.close();
                this.#report = true;
              }
              return { done: false, value: batch };
            }
            if (this.#loaded) {
              // The next window of the chunk is decoded only now that a batch needs its text.
              const text = (this.#decoder as ByteDecoder).next();
              if (text !== undefined) {
                builder.push(text);
                continue;
              }
              this.#loaded = false;
            }
            const read = await this.#read();
            if (read === undefined || this.#over()) break;
            if (read.done) {
              if (this.#decoder !== undefined) builder.push(this.#decoder.finish());
              builder.end();
            } else this.#accept(read.value);
          }
        } catch (error) {
          // An abort outranks what it interrupted: its reason is reported below. Any other error
          // is reported, also when the callback that threw had called return() first.
          if (!this.#aborted()) {
            if (!this.#over()) {
              this.#end();
              // A no-op when the source has ended or failed; this error is the one reported.
              void this.#source.close();
            }
            throw error;
          }
        }
      }
      const owed = this.#owed;
      if (owed === undefined) return finished();
      this.#owed = undefined;
      // The rejection is signal.reason itself, whatever it is.
      throw owed.reason;
    } finally {
      this.#calls--;
    }
  }
}

/**
 * Parses CSV that arrives in chunks, as batches of rows. The source is a string, a Web
 * ReadableStream (Response.body, Blob.stream()), a Node Readable, or any sync or async iterable of
 * string chunks or of Uint8Array chunks (UTF-8). The rows, errors and meta are those of parse on
 * the whole text, wherever the chunks split it, except for the differences listed in
 * docs/compatibility.md. Every batch but the last has batchSize rows, or fewer (at least one) when
 * the text read for it reaches 1,048,576 UTF-16 units first; the last has meta.done.
 *
 * The feature keys of parseDetailed (detect, positions, repair, schema, sepLine) work here too,
 * with parseDetailed's results grouped per batch (see ParseBatch). A schema may validate
 * asynchronously: a batch's rows are validated in order before the batch is delivered, and
 * nothing is read from the source meanwhile.
 *
 * The source is read only inside next(), and closed once on break, return(), an error, an abort
 * or a reached preview. An invalid config or source throws here; every other error rejects
 * next().
 *
 * @example
 * ```ts
 * import { parseStream } from 'csvloom/stream';
 *
 * // file.stream(), a fetch response body, a Node Readable or an iterable of chunks.
 * for await (const batch of parseStream(file.stream(), { header: true, skipEmptyLines: true })) {
 *   for (const row of batch.data) save(row); // up to batchSize (1024) rows per batch
 *   for (const error of batch.errors) console.warn(error.code, error.message);
 * }
 * ```
 * @see https://github.com/baozdemir/csvloom/blob/main/docs/streaming.md
 */
export function parseStream(
  source: StreamSource,
  config: Plain & { header: true; dynamicTyping?: false; transform?: undefined },
): BatchIterator<HeaderRow<string>>;
export function parseStream(
  source: StreamSource,
  config?: Plain & { header?: false; dynamicTyping?: false; transform?: undefined },
): BatchIterator<string[]>;
export function parseStream(
  source: StreamSource,
  config: Plain & { header: true; dynamicTyping: DynamicTyping; transform?: undefined },
): BatchIterator<HeaderRow<TypedValue>>;
export function parseStream(
  source: StreamSource,
  config: Plain & { header?: false; dynamicTyping: DynamicTyping; transform?: undefined },
): BatchIterator<TypedValue[]>;
export function parseStream(
  source: StreamSource,
  config: Plain & { header: true; transform: Transform },
): BatchIterator<HeaderRow<unknown>>;
export function parseStream(
  source: StreamSource,
  config: Plain & { header?: false; transform: Transform },
): BatchIterator<unknown[]>;
/** For a header, dynamicTyping or transform whose kind is known only at run time. */
export function parseStream(
  source: StreamSource,
  config?: Plain,
): BatchIterator<unknown[] | HeaderRow<unknown>>;
/** With a schema, sync or async: the rows are its output and the errors may be Schema errors. */
export function parseStream<Output>(
  source: StreamSource,
  config: WithSchema<Output>,
): BatchIterator<Output, ParseError | SchemaError>;
/** For a schema that may be undefined; a variable typed StreamConfig gives unknown rows. */
export function parseStream<Output>(
  source: StreamSource,
  config?: MaybeSchema<Output>,
): BatchIterator<Output | unknown[] | HeaderRow<unknown>, ParseError | SchemaError>;
export function parseStream(
  source: unknown,
  config?: unknown,
): BatchIterator<unknown, ParseError | SchemaError> {
  let parseConfig = config;
  let batchSize: unknown;
  let maxRecordLength: unknown;
  let signal: unknown;
  // Any other config goes on as it is, for the main entry's TypeError. A plain one is copied by
  // its own enumerable keys to a null-prototype object, so nothing inherited is read.
  if (isPlainObject(config)) {
    const own = Object.assign(Object.create(null) as Record<string, unknown>, config);
    ({ batchSize, maxRecordLength, signal, ...parseConfig } = own);
  }
  const options = resolveDetailedConfig(parseConfig);
  if (batchSize !== undefined && !isCount(batchSize)) {
    throw mustBe('batchSize', 'a positive safe integer');
  }
  if (maxRecordLength !== undefined && !isCount(maxRecordLength)) {
    throw mustBe('maxRecordLength', 'a positive safe integer');
  }
  if (signal !== undefined && !isSignal(signal)) throw mustBe('signal', 'an AbortSignal');
  if (!isStreamSource(source)) {
    throw new TypeError(
      `Expected a stream source (a string, a ReadableStream, or an iterable or async iterable of string or Uint8Array chunks), got ${nameOf(source)}`,
    );
  }
  const builder = new BatchBuilder(options, {
    batchSize: batchSize ?? 1024,
    maxRecordLength: maxRecordLength ?? 0,
  });
  return new Batches(
    openSource(source as StreamSource),
    builder,
    signal,
    options.features?.schema ?? null,
    options.features?.positions === true,
  ) as unknown as BatchIterator<unknown, ParseError | SchemaError>;
}
