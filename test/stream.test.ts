import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, UnsupportedFeatureError } from '../src/index.ts';
import { parseStream } from '../src/stream.ts';
import type { BatchIterator, ParseBatch, StreamConfig, StreamSource } from '../src/stream.ts';

// parseStream and its iterator: the checks at the call, the source kinds, the iterator's
// protocol, and when the source is closed (docs/streaming.md).

type Chunk = string | Uint8Array;
type Batch = ParseBatch<unknown>;

/** parseStream as a caller without types reaches it. */
const open = parseStream as unknown as (
  source: unknown,
  config?: unknown,
) => BatchIterator<unknown>;

const DONE = { done: true, value: undefined };
const FIXED = { delimiter: ',', newline: '\n' } as const;
const SOURCE_MESSAGE =
  'Expected a stream source (a string, a ReadableStream, or an iterable or async iterable of string or Uint8Array chunks), got ';
const reason = new Error('abort');
const bytes = (text: string) => new TextEncoder().encode(text);
const never = () => new Promise<never>(() => undefined);
/** A macrotask: every promise job queued so far has run, and Node's nextTick queue too. */
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
// Real timers, only in the tests that wait for a source that settles late.
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
const rejectLater = (error: Error) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(error);
    }, 10);
  });

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collect(batches: AsyncIterable<Batch>): Promise<Batch[]> {
  const all: Batch[] = [];
  for await (const batch of batches) all.push(batch);
  return all;
}
const rowsOf = (batches: readonly Batch[]) => batches.flatMap((batch) => batch.data);
/** The batch of a next() that must not be the end. */
async function batchOf(step: Promise<IteratorResult<Batch, undefined>>): Promise<Batch> {
  const result = await step;
  if (result.done) throw new Error('the iteration ended');
  return result.value;
}
/** Whether a promise is still pending after a macrotask. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  await tick();
  return !settled;
}

// Instrumented sources: real ones (a Node Readable, a Web ReadableStream, generators, an array, a
// string) whose close calls are recorded with their arguments.

/** What a source gives: its chunks, then its own error, a read that waits for `hang`, or its end. */
interface Plan {
  chunks: readonly Chunk[];
  fail?: Error;
  hang?: Promise<unknown>;
}

interface Probe {
  source: StreamSource;
  /** The close calls made on the source, in order: destroy, cancel, releaseLock or return, with their arguments. */
  calls: unknown[][];
  /** The source's reads so far; undefined where they cannot be counted (a Node Readable reads ahead by itself; a string). */
  reads(): number | undefined;
  /** How often a generator's finally block ran. */
  finals(): number;
  /**
   * Asserts the exact close: `times` 1 is one close (with `reason` for Node and Web when an abort
   * gave one); 0 is none, with a Web lock released because the source ended or failed.
   */
  closed(times: 0 | 1, reason?: unknown): Promise<void>;
}

type ColumnName = 'node' | 'web' | 'async' | 'sync' | 'array' | 'string';

/**
 * A real Readable in object mode, so that chunks arrive as given. autoDestroy is off, so that the
 * only destroy() calls are parseStream's: with it on, Node destroys an ended stream itself and
 * "not closed" could not be told from "closed". Its own failure bypasses the recorded method.
 */
function nodeProbe({ chunks, fail, hang }: Plan): Probe {
  const queue = [...chunks];
  const calls: unknown[][] = [];
  let closeEvents = 0;
  const readable = new Readable({
    objectMode: true,
    // One chunk is buffered at most, so the source fails or ends only after its chunks were read.
    highWaterMark: 1,
    autoDestroy: false,
    read() {
      if (queue.length > 0) this.push(queue.shift());
      else if (fail !== undefined) Readable.prototype.destroy.call(this, fail);
      else if (hang === undefined) this.push(null);
    },
  });
  readable.on('close', () => {
    closeEvents++;
  });
  const destroy = readable.destroy.bind(readable);
  readable.destroy = (...args) => {
    calls.push(['destroy', ...args]);
    return destroy(...args);
  };
  return {
    source: readable as StreamSource,
    calls,
    reads: () => undefined,
    finals: () => 0,
    async closed(times, why) {
      // 'close' is emitted on a later tick.
      await tick();
      if (times === 1) {
        expect(calls).toStrictEqual([why === undefined ? ['destroy'] : ['destroy', why]]);
        expect(readable.destroyed).toBe(true);
        expect(closeEvents).toBe(1);
      } else {
        expect(calls).toStrictEqual([]);
        expect(readable.destroyed).toBe(fail !== undefined);
        expect(closeEvents).toBe(fail === undefined ? 0 : 1);
      }
    },
  };
}

/** A real ReadableStream that pulls only when read (highWaterMark 0); its reader's cancel and releaseLock are recorded. */
function webProbe({ chunks, fail, hang }: Plan): Probe {
  const queue = [...chunks];
  const calls: unknown[][] = [];
  const cancelled: unknown[] = [];
  let reads = 0;
  const stream = new ReadableStream<Chunk>(
    {
      pull(controller) {
        reads++;
        const chunk = queue.shift();
        if (chunk !== undefined) controller.enqueue(chunk);
        else if (fail !== undefined) controller.error(fail);
        else if (hang !== undefined) return hang.then(() => undefined);
        else controller.close();
        return undefined;
      },
      cancel(why) {
        cancelled.push(why);
      },
    },
    { highWaterMark: 0 },
  );
  const getReader = stream.getReader.bind(stream);
  stream.getReader = (() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader);
    const releaseLock = reader.releaseLock.bind(reader);
    reader.cancel = (...args) => {
      calls.push(['cancel', ...args]);
      return cancel(...args);
    };
    reader.releaseLock = () => {
      calls.push(['releaseLock']);
      releaseLock();
    };
    return reader;
  }) as typeof stream.getReader;
  return {
    source: stream,
    calls,
    reads: () => reads,
    finals: () => 0,
    async closed(times, why) {
      await tick();
      if (times === 1) {
        expect(calls).toStrictEqual([['cancel', why], ['releaseLock']]);
        expect(cancelled).toStrictEqual([why]);
      } else {
        expect(calls).toStrictEqual([['releaseLock']]);
        expect(cancelled).toStrictEqual([]);
      }
      expect(stream.locked).toBe(false);
    },
  };
}

/** A real generator object whose next() calls are counted and whose return() calls are recorded. */
function watch(generator: object, calls: unknown[][]): () => number {
  type Method = (...args: unknown[]) => unknown;
  const methods = generator as { next: Method; return: Method };
  let reads = 0;
  const next = methods.next.bind(generator);
  const finish = methods.return.bind(generator);
  Object.assign(generator, {
    next: (...args: unknown[]) => {
      reads++;
      return next(...args);
    },
    return: (...args: unknown[]) => {
      calls.push(['return', ...args]);
      return finish(...args);
    },
  });
  return () => reads;
}

function generatorClosed(calls: unknown[][], finals: () => number): Probe['closed'] {
  return async (times) => {
    await tick();
    // return() gets no argument, with or without an abort reason; an ended or failed generator
    // has run its finally block by itself.
    expect(calls).toStrictEqual(times === 1 ? [['return']] : []);
    expect(finals()).toBe(1);
  };
}

function asyncProbe({ chunks, fail, hang }: Plan): Probe {
  const calls: unknown[][] = [];
  let finals = 0;
  const generator = (async function* () {
    try {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
      if (fail !== undefined) throw fail;
      if (hang !== undefined) await hang;
    } finally {
      finals++;
    }
  })();
  const reads = watch(generator, calls);
  const count = () => finals;
  return {
    source: generator as StreamSource,
    calls,
    reads,
    finals: count,
    closed: generatorClosed(calls, count),
  };
}

function syncProbe({ chunks, fail }: Plan): Probe {
  const calls: unknown[][] = [];
  let finals = 0;
  const generator = (function* () {
    try {
      yield* chunks;
      if (fail !== undefined) throw fail;
    } finally {
      finals++;
    }
  })();
  const reads = watch(generator, calls);
  const count = () => finals;
  return {
    source: generator as StreamSource,
    calls,
    reads,
    finals: count,
    closed: generatorClosed(calls, count),
  };
}

/** A real array. Its iterator has no return(): every method called on the iterator is recorded, and only next() may be. */
function arrayProbe({ chunks }: Plan): Probe {
  const array = [...chunks];
  const invoked: PropertyKey[] = [];
  expect(array[Symbol.iterator]()).not.toHaveProperty('return');
  Object.defineProperty(array, Symbol.iterator, {
    value: () =>
      new Proxy(Array.prototype[Symbol.iterator].call(array), {
        get(target, key) {
          const member: unknown = Reflect.get(target, key, target);
          if (typeof member !== 'function') return member;
          return (...args: unknown[]): unknown => {
            invoked.push(key);
            return Reflect.apply(member, target, args);
          };
        },
      }),
  });
  return {
    source: array as StreamSource,
    calls: [],
    reads: () => invoked.length,
    finals: () => 0,
    closed() {
      expect(invoked.filter((key) => key !== 'next')).toStrictEqual([]);
      return Promise.resolve();
    },
  };
}

/** A string is one chunk and has nothing to call. */
function stringProbe({ chunks }: Plan): Probe {
  return {
    source: chunks.join(''),
    calls: [],
    reads: () => undefined,
    finals: () => 0,
    closed: () => Promise.resolve(),
  };
}

const COLUMNS: Record<ColumnName, (plan: Plan) => Probe> = {
  node: nodeProbe,
  web: webProbe,
  async: asyncProbe,
  sync: syncProbe,
  array: arrayProbe,
  string: stringProbe,
};
const ALL = Object.keys(COLUMNS) as ColumnName[];
const without = (...names: ColumnName[]) => ALL.filter((name) => !names.includes(name));

/**
 * An object source of fakes that records every call, for the cases a real source cannot show (a
 * close that fails or hangs). `step` replaces read() or next(); `finish` replaces cancel() or
 * return().
 */
function fake(kind: 'web' | 'async' | 'sync', step: () => unknown, finish?: () => unknown) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: () => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push([name, ...args]);
      return result();
    };
  const end = finish ?? (() => (kind === 'sync' ? DONE : Promise.resolve(DONE)));
  if (kind === 'web') {
    const reader = {
      read: record('read', step),
      cancel: record('cancel', end),
      releaseLock: record('releaseLock', () => undefined),
    };
    return { calls, source: { getReader: () => reader } as unknown as StreamSource };
  }
  const iterator = { next: record('next', step), return: record('return', end) };
  const key = kind === 'sync' ? Symbol.iterator : Symbol.asyncIterator;
  return { calls, source: { [key]: () => iterator } as unknown as StreamSource };
}
/** A step function that gives each chunk once, then the end. */
function steps(chunks: readonly Chunk[], wrap = true) {
  const queue = [...chunks];
  return () => {
    const value = queue.shift();
    const step = value === undefined ? { done: true, value } : { done: false, value };
    return wrap ? Promise.resolve(step) : step;
  };
}
const names = (calls: unknown[][]) => calls.map((call) => call[0]);

let unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => {
  unhandled.push(error);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Every test of this file: nothing it left in flight is an unhandled rejection.
  await tick();
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toStrictEqual([]);
});

function runChild(name: string) {
  const fixture = fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [fixture], { encoding: 'utf8', env });
}

describe('checks at the call are synchronous', () => {
  const invalid = [0, -1, 1.5, 2 ** 53, '2', null, NaN, Infinity, 1n];

  it.each(invalid)('batchSize %s throws', (value) => {
    expect(() => open('a', { batchSize: value })).toThrow(
      new TypeError('Parse option "batchSize" must be a positive safe integer'),
    );
  });

  it.each(invalid)('maxRecordLength %s throws', (value) => {
    expect(() => open('a', { maxRecordLength: value })).toThrow(
      new TypeError('Parse option "maxRecordLength" must be a positive safe integer'),
    );
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'abort'],
    ['an AbortController', new AbortController()],
    ['an object with the tag only', { [Symbol.toStringTag]: 'AbortSignal' }],
    [
      'a tagged object without a boolean aborted',
      {
        [Symbol.toStringTag]: 'AbortSignal',
        addEventListener() {},
        removeEventListener() {},
      },
    ],
    [
      'an untagged object with the members',
      { aborted: false, addEventListener() {}, removeEventListener() {} },
    ],
    [
      'a tagged object with a boolean aborted and no addEventListener',
      { [Symbol.toStringTag]: 'AbortSignal', aborted: false, removeEventListener() {} },
    ],
    [
      'a tagged object with a boolean aborted and no removeEventListener',
      { [Symbol.toStringTag]: 'AbortSignal', aborted: false, addEventListener() {} },
    ],
  ])('signal: %s throws', (_, signal) => {
    expect(() => open('a', { signal })).toThrow(
      new TypeError('Parse option "signal" must be an AbortSignal'),
    );
  });

  it('the largest safe integer is accepted for both counts', async () => {
    const batches = await collect(
      parseStream('a\nb', {
        batchSize: Number.MAX_SAFE_INTEGER,
        maxRecordLength: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(rowsOf(batches)).toStrictEqual([['a'], ['b']]);
  });

  it('the config is checked with the main entry rules and messages', () => {
    expect(() => open('a', { batchsize: 2 })).toThrow(
      new TypeError('Unknown parse option "batchsize"'),
    );
    expect(() => open('a', { worker: true })).toThrow(UnsupportedFeatureError);
    expect(() => open('a', { header: 'yes' })).toThrow(
      new TypeError('Parse option "header" must be a boolean'),
    );
    for (const config of [[], new Map(), 5, 'x', null, Object.create({})]) {
      expect(() => open('a', config)).toThrow(new TypeError('Parse config must be a plain object'));
    }
    // A config of another class is not read as a plain one, even with stream keys only.
    expect(() => open('a', Object.assign(Object.create({}), { batchSize: 1 }))).toThrow(
      new TypeError('Parse config must be a plain object'),
    );
  });

  it('the order is: the parse config, the three stream keys, the source', () => {
    expect(() => open(null, { batchsize: 1, batchSize: 0 })).toThrow(
      new TypeError('Unknown parse option "batchsize"'),
    );
    expect(() => open(null, { worker: true, batchSize: 0 })).toThrow(UnsupportedFeatureError);
    expect(() => open(null, { batchSize: 0, maxRecordLength: 0, signal: {} })).toThrow(
      new TypeError('Parse option "batchSize" must be a positive safe integer'),
    );
    expect(() => open(null, { maxRecordLength: 0, signal: {} })).toThrow(
      new TypeError('Parse option "maxRecordLength" must be a positive safe integer'),
    );
    expect(() => open(null, { signal: {} })).toThrow(
      new TypeError('Parse option "signal" must be an AbortSignal'),
    );
    expect(() => open(null, {})).toThrow(new TypeError(`${SOURCE_MESSAGE}null`));
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 5, 'number'],
    ['a function', () => 'a', 'function'],
    ['a plain object', {}, 'Object'],
    ['a bare Uint8Array', new Uint8Array([97]), 'Uint8Array'],
    ['a Buffer', Buffer.from('a'), 'Uint8Array'],
    ['an ArrayBuffer', new ArrayBuffer(1), 'ArrayBuffer'],
    ['a DataView', new DataView(new ArrayBuffer(1)), 'DataView'],
    ['a Promise of a string', Promise.resolve('a'), 'Promise'],
  ])('a source that is %s throws', (_, source, got) => {
    expect(() => open(source)).toThrow(new TypeError(SOURCE_MESSAGE + got));
    expect(() => open(source, { batchSize: 1 })).toThrow(new TypeError(SOURCE_MESSAGE + got));
  });

  it('a stream key set to undefined is a key left out', async () => {
    const config = { batchSize: undefined, maxRecordLength: undefined, signal: undefined };
    const given = await collect(open(['a,b\n1,2'], config));
    expect(given).toStrictEqual(await collect(parseStream(['a,b\n1,2'], {})));
    expect(given).toStrictEqual(await collect(parseStream(['a,b\n1,2'])));
  });

  it('a signal of another realm is accepted by its tag and members', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const signal = {
      [Symbol.toStringTag]: 'AbortSignal',
      aborted: false,
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    };
    const batches = open('a,b', { signal });
    expect(added).toStrictEqual([]);
    expect(rowsOf(await collect(batches))).toStrictEqual([['a', 'b']]);
    expect(added).toStrictEqual(['abort']);
    expect(removed).toStrictEqual(['abort']);
  });

  it('nothing else happens at the call: no read, no listener, no decoder', async () => {
    const decoder = vi.spyOn(globalThis, 'TextDecoder');
    const controller = new AbortController();
    for (const name of ['web', 'async', 'sync', 'array'] as const) {
      const probe = COLUMNS[name]({ chunks: [bytes('a\n')] });
      parseStream(probe.source, { signal: controller.signal });
      await tick();
      expect(probe.reads()).toBe(0);
      expect(probe.calls).toStrictEqual([]);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(decoder).not.toHaveBeenCalled();
  });

  it('a stream key on Object.prototype is not read, as no parse key is', async () => {
    const proto = Object.prototype as Record<string, unknown>;
    const polluted = (key: string, value: unknown) => {
      proto[key] = value;
      try {
        // Nothing is awaited while the prototype is changed.
        return open(['a\nb\n', 'c'], { ...FIXED });
      } finally {
        Reflect.deleteProperty(proto, key);
      }
    };
    // Read, each of these would throw at the call.
    for (const [key, value] of [
      ['batchSize', 0],
      ['maxRecordLength', 0],
      ['signal', {}],
      ['header', 'yes'],
    ] as const) {
      expect(rowsOf(await collect(polluted(key, value)))).toStrictEqual([['a'], ['b'], ['c']]);
    }
    // Read, these would change the result: three batches, a RangeError, a rejection.
    expect(await collect(polluted('batchSize', 1))).toHaveLength(1);
    expect(await collect(polluted('maxRecordLength', 1))).toHaveLength(1);
    expect(await collect(polluted('signal', AbortSignal.abort(reason)))).toHaveLength(1);
  });

  it('a stream key that is not enumerable is not read, as no parse key is', async () => {
    const hidden = (key: string, value: unknown) =>
      Object.defineProperty({ ...FIXED }, key, { value, enumerable: false });
    for (const [key, value] of [
      ['batchSize', 0],
      ['maxRecordLength', 0],
      ['signal', {}],
      ['header', 'yes'],
      ['batchSize', 1],
      ['maxRecordLength', 1],
      ['signal', AbortSignal.abort(reason)],
    ] as const) {
      const batches = await collect(open(['a\nb\n', 'c'], hidden(key, value)));
      expect(batches).toHaveLength(1);
      expect(rowsOf(batches)).toStrictEqual([['a'], ['b'], ['c']]);
    }
  });

  it('a string source never constructs a TextDecoder', async () => {
    const decoder = vi.spyOn(globalThis, 'TextDecoder');
    await collect(parseStream(['a,b\n', '1,2']));
    expect(decoder).not.toHaveBeenCalled();
  });
});

describe('chunk kinds', () => {
  class Bytes extends Uint8Array {}

  it.each<[string, Uint8Array]>([
    ['a Buffer', Buffer.from('a,b\n1,2')],
    [
      'a Uint8Array of another realm',
      runInNewContext('new Uint8Array([97, 44, 98])') as Uint8Array,
    ],
    ['a Uint8Array subclass', new Bytes([97, 44, 98])],
  ])('%s is bytes', async (_, chunk) => {
    const batches = await collect(parseStream([chunk]));
    expect(rowsOf(batches)[0]).toStrictEqual(['a', 'b']);
  });

  it.each<[string, unknown, string]>([
    ['a DataView', new DataView(new ArrayBuffer(1)), 'DataView'],
    ['a Uint16Array', new Uint16Array(1), 'Uint16Array'],
    ['an ArrayBuffer', new ArrayBuffer(1), 'ArrayBuffer'],
    ['a String object', new String('a'), 'String'],
    ['a number', 5, 'number'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an array', ['a'], 'Array'],
  ])('%s as chunk 0 rejects next()', async (_, chunk, got) => {
    const probe = asyncProbe({ chunks: [chunk as Chunk, 'b', 'c'] });
    const batches = parseStream(probe.source);
    await expect(batches.next()).rejects.toStrictEqual(
      new TypeError(`Stream chunk 0 must be a string or a Uint8Array, got ${got}`),
    );
    await probe.closed(1);
  });

  it.each<[string, unknown[], string]>([
    [
      'bytes after a string',
      ['a\n', bytes('b')],
      'Stream chunk 1 must be a string, as chunk 0 is, got Uint8Array',
    ],
    [
      'a string after bytes',
      [bytes('a\n'), 'b'],
      'Stream chunk 1 must be a Uint8Array, as chunk 0 is, got string',
    ],
    [
      'a number after a string',
      ['a\n', 5],
      'Stream chunk 1 must be a string, as chunk 0 is, got number',
    ],
    [
      'a DataView after bytes',
      [bytes('a\n'), bytes('b\n'), new DataView(new ArrayBuffer(1))],
      'Stream chunk 2 must be a Uint8Array, as chunk 0 is, got DataView',
    ],
    [
      'bytes after an empty string: an empty first chunk fixes the kind',
      ['', bytes('b')],
      'Stream chunk 1 must be a string, as chunk 0 is, got Uint8Array',
    ],
    [
      'a string after empty bytes',
      [new Uint8Array(0), 'b'],
      'Stream chunk 1 must be a Uint8Array, as chunk 0 is, got string',
    ],
  ])('%s rejects next() and drops the batch being filled', async (_, chunks, message) => {
    const batches = open(chunks);
    await expect(batches.next()).rejects.toStrictEqual(new TypeError(message));
    await expect(batches.next()).resolves.toStrictEqual(DONE);
  });

  it("a string chunk, then a byte chunk: ['a,b\\n', Uint8Array.of(0x31)] rejects the first next()", async () => {
    await expect(open(['a,b\n', Uint8Array.of(0x31)]).next()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('worked examples through parseStream', () => {
  it('one batch from two chunks', async () => {
    expect(await collect(parseStream(['a,b\n1', ',2']))).toStrictEqual([
      {
        data: [
          ['a', 'b'],
          ['1', '2'],
        ],
        errors: [],
        meta: {
          delimiter: ',',
          linebreak: '\n',
          renamedHeaders: null,
          rowOffset: 0,
          cursor: 7,
          truncated: false,
          done: true,
        },
      },
    ]);
  });

  it('bytes are decoded in place, a sequence cut by a chunk edge and the BOM included', async () => {
    const chunks = [
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xc3),
      Uint8Array.of(0xa9, 0x0a, 0x31, 0x2c, 0x32),
    ];
    const batches = await collect(parseStream(chunks));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.data).toStrictEqual([
      ['a', 'é'],
      ['1', '2'],
    ]);
    expect(batches[0]?.errors).toStrictEqual([]);
    expect(batches[0]?.meta).toMatchObject({ cursor: 7, done: true });
  });

  it('the same bytes with a TextDecoderStream in front give the same rows', async () => {
    const body = new Blob([
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xc3, 0xa9, 0x0a, 0x31, 0x2c, 0x32),
    ]).stream();
    const text = body.pipeThrough(new TextDecoderStream());
    const batches = await collect(parseStream(text));
    expect(rowsOf(batches)).toStrictEqual([
      ['a', 'é'],
      ['1', '2'],
    ]);
    expect(batches.at(-1)?.meta).toMatchObject({ cursor: 7, done: true });
  });

  it('batchSize, rowOffset, and the header meta', async () => {
    const batches = await collect(parseStream(['a,1\nb,2\nc,3'], { batchSize: 2 }));
    expect(batches.map((batch) => [batch.data, batch.meta.rowOffset, batch.meta.cursor])).toEqual([
      [
        [
          ['a', '1'],
          ['b', '2'],
        ],
        0,
        8,
      ],
      [[['c', '3']], 2, 11],
    ]);
    expect(await collect(parseStream(['id,id\n1,2'], { header: true }))).toStrictEqual([
      {
        data: [{ id: '1', id_1: '2' }],
        errors: [],
        meta: {
          delimiter: ',',
          linebreak: '\n',
          fields: ['id', 'id_1'],
          renamedHeaders: { id_1: 'id' },
          rowOffset: 0,
          cursor: 9,
          truncated: false,
          done: true,
        },
      },
    ]);
  });

  it('a record over three chunks, and its maxRecordLength error', async () => {
    const chunks = ['id,note\n1,"lo', 'ng', ' text"\n2,x'];
    const batches = await collect(parseStream(chunks));
    expect(rowsOf(batches)).toStrictEqual([
      ['id', 'note'],
      ['1', 'long text'],
      ['2', 'x'],
    ]);
    expect(batches[0]?.meta.cursor).toBe(25);
    await expect(parseStream(chunks, { maxRecordLength: 10 }).next()).rejects.toStrictEqual(
      new RangeError('Record at offset 8 is longer than maxRecordLength (10)'),
    );
  });

  it.each<[string, (text: string) => StreamSource]>([
    ['a string', (text) => text],
    ['string chunks', (text) => [text.slice(0, 7), text.slice(7, 19), text.slice(19)]],
    ['byte chunks', (text) => [bytes(text).subarray(0, 9), bytes(text).subarray(9)]],
    ['a ReadableStream of bytes', (text) => new Blob([text]).stream()],
    ['a Node Readable', (text) => Readable.from([Buffer.from(text)])],
  ])('%s gives what parse gives', async (_, make) => {
    const text = 'name,n\n"é, ş","1"\n😀,2\n\nx\n';
    const config = { header: true, dynamicTyping: true, skipEmptyLines: true } as const;
    const bulk = parse(text, config);
    const batches = await collect(parseStream(make(text), { ...config, batchSize: 2 }));
    expect(rowsOf(batches)).toStrictEqual(bulk.data);
    expect(batches.flatMap((batch) => batch.errors)).toStrictEqual(bulk.errors);
    const { rowOffset, done, ...meta } = batches.at(-1)?.meta ?? {};
    expect([rowOffset, done]).toStrictEqual([2, true]);
    const { aborted, ...bulkMeta } = bulk.meta;
    expect(aborted).toBe(false);
    expect(meta).toStrictEqual(bulkMeta);
  });
});

// The close matrix: 13 exits x the source kinds. Each cell asserts the exact close calls.

interface Row {
  name: string;
  columns: ColumnName[];
  run(make: (plan: Plan) => Probe, column: ColumnName): Promise<void>;
}

/**
 * Cells that cannot happen, by row:
 * - 2 (abort with a read pending): a string and a sync iterable (generator, array) answer a read
 *   at once.
 * - 5 (an invalid byte), 11 (a sequence cut by the end): a string source has no bytes.
 * - 6 (a wrong chunk kind as chunk 1): a string is one chunk.
 * - 9 (the source's own error): a string and an array cannot fail; the sync column is the
 *   generator.
 */
const three = ['a\n', 'b\n', 'c\n'];
const boom = new Error('boom');

async function expectError(
  make: (plan: Plan) => Probe,
  plan: Plan,
  config: StreamConfig,
  check: (rejection: unknown) => void,
  times: 0 | 1,
): Promise<void> {
  const probe = make(plan);
  const batches = parseStream(probe.source, config);
  const rejection: unknown = await batches.next().then(
    () => {
      throw new Error('next() did not reject');
    },
    (error: unknown) => error,
  );
  check(rejection);
  await probe.closed(times);
  await expect(batches.next()).resolves.toStrictEqual(DONE);
  await expect(batches.return()).resolves.toStrictEqual(DONE);
  await probe.closed(times);
}

const MATRIX: Row[] = [
  {
    name: '1a: break with no read pending: closed once',
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: three });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      const seen: unknown[] = [];
      for await (const batch of batches) {
        seen.push(...batch.data);
        break;
      }
      expect(seen).toStrictEqual([['a']]);
      await probe.closed(1);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await probe.closed(1);
    },
  },
  {
    name: '1b: return() with no read pending: closed once',
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: three });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      expect((await batchOf(batches.next())).data).toStrictEqual([['a']]);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      await probe.closed(1);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await probe.closed(1);
    },
  },
  {
    name: '2: abort with a read pending: closed once with signal.reason; next() rejects before the read settles',
    columns: ['node', 'web', 'async'],
    async run(make, column) {
      const gate = deferred();
      const probe = make({ chunks: ['a,b'], hang: gate.promise });
      const controller = new AbortController();
      const batches = parseStream(probe.source, { ...FIXED, signal: controller.signal });
      const pending = batches.next();
      // Chunk 0 has no line break, so the call is now waiting for the read that hangs.
      await tick();
      expect(await isPending(pending)).toBe(true);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      if (column === 'async') {
        // return() was requested once and waits for the generator's step.
        expect(probe.calls).toStrictEqual([['return']]);
        expect(probe.finals()).toBe(0);
        gate.resolve(undefined);
        await tick();
      }
      await probe.closed(1, reason);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await probe.closed(1, reason);
    },
  },
  {
    name: '3: abort between two calls: closed once at the abort, with the reason; the next next() rejects and reads nothing',
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: three });
      const controller = new AbortController();
      const batches = parseStream(probe.source, {
        ...FIXED,
        batchSize: 1,
        signal: controller.signal,
      });
      expect((await batchOf(batches.next())).data).toStrictEqual([['a']]);
      const reads = probe.reads();
      controller.abort(reason);
      await probe.closed(1, reason);
      await expect(batches.next()).rejects.toBe(reason);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      expect(probe.reads()).toBe(reads);
      await probe.closed(1, reason);
    },
  },
  {
    name: '4: preview reached in chunk 0 of 3: closed once; the last batch is delivered',
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: ['a\nb\n', 'c\n', 'd\n'] });
      const batches = parseStream(probe.source, { ...FIXED, preview: 1 });
      const batch = await batchOf(batches.next());
      expect(batch.data).toStrictEqual([['a']]);
      expect(batch.meta).toMatchObject({ cursor: 2, truncated: true, done: true });
      await probe.closed(1);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      await probe.closed(1);
      if (probe.reads() !== undefined) expect(probe.reads()).toBe(1);
    },
  },
  {
    name: '5: an invalid byte in chunk 0 of 3: closed once; TypeError',
    columns: without('string'),
    async run(make) {
      await expectError(
        make,
        { chunks: [Uint8Array.of(0x61, 0xff), bytes('b\n'), bytes('c\n')] },
        FIXED,
        (error) => {
          expect(error).toBeInstanceOf(TypeError);
        },
        1,
      );
    },
  },
  {
    name: '6: a wrong chunk kind as chunk 1 of 3: closed once; TypeError with the full message',
    columns: without('string'),
    async run(make) {
      const probe = make({ chunks: ['a\n', bytes('b\n'), 'c\n'] });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      expect((await batchOf(batches.next())).data).toStrictEqual([['a']]);
      await expect(batches.next()).rejects.toStrictEqual(
        new TypeError('Stream chunk 1 must be a string, as chunk 0 is, got Uint8Array'),
      );
      await probe.closed(1);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await probe.closed(1);
    },
  },
  {
    name: '7: maxRecordLength exceeded in chunk 0 of 3: closed once; RangeError',
    columns: ALL,
    async run(make) {
      await expectError(
        make,
        { chunks: ['abcdefgh\n', 'b\n', 'c\n'] },
        { ...FIXED, maxRecordLength: 3 },
        (error) => {
          expect(error).toStrictEqual(
            new RangeError('Record at offset 0 is longer than maxRecordLength (3)'),
          );
        },
        1,
      );
    },
  },
  {
    name: '7b: maxRecordLength exceeded by a last record without a line break (chunk 2 of 3): found when the chunk arrives, before the source reports its end: closed once',
    columns: ALL,
    async run(make) {
      await expectError(
        make,
        { chunks: ['a\n', 'b\n', 'cdefgh'] },
        { ...FIXED, maxRecordLength: 3 },
        (error) => {
          expect(error).toStrictEqual(
            new RangeError('Record at offset 4 is longer than maxRecordLength (3)'),
          );
        },
        1,
      );
    },
  },
  ...(
    [
      [
        'transform',
        {
          transform: () => {
            throw boom;
          },
        },
      ],
      [
        'transformHeader',
        {
          header: true,
          transformHeader: () => {
            throw boom;
          },
        },
      ],
      [
        'a dynamicTyping function',
        {
          dynamicTyping: () => {
            throw boom;
          },
        },
      ],
    ] satisfies Array<[string, StreamConfig]>
  ).map(([name, config]): Row => ({
    name: `8: a throw from ${name} on a record of chunk 0 of 3: closed once; the same error object`,
    columns: ALL,
    async run(make) {
      await expectError(
        make,
        { chunks: ['a,b\n1,2\n', 'c\n', 'd\n'] },
        { ...FIXED, ...config },
        (error) => {
          expect(error).toBe(boom);
        },
        1,
      );
    },
  })),
  {
    name: "9: the source's own error: not closed; next() rejects with the same error object",
    columns: ['node', 'web', 'async', 'sync'],
    async run(make) {
      const probe = make({ chunks: ['a\n'], fail: boom });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      expect((await batchOf(batches.next())).data).toStrictEqual([['a']]);
      await expect(batches.next()).rejects.toBe(boom);
      await probe.closed(0);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      await probe.closed(0);
    },
  },
  {
    name: "10: the source's normal end: not closed",
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: ['a\n', 'b\n', 'c'] });
      const batches = parseStream(probe.source, FIXED);
      const all = await collect(batches);
      expect(rowsOf(all)).toStrictEqual([['a'], ['b'], ['c']]);
      expect(all.at(-1)?.meta).toMatchObject({ cursor: 5, truncated: false, done: true });
      await probe.closed(0);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      await probe.closed(0);
    },
  },
  {
    name: '11: a sequence cut by the end of the input, seen at the final flush: not closed; TypeError',
    columns: without('string'),
    async run(make) {
      await expectError(
        make,
        { chunks: [bytes('a\n'), bytes('b\n'), Uint8Array.of(0x63, 0xc3)] },
        FIXED,
        (error) => {
          expect(error).toBeInstanceOf(TypeError);
        },
        0,
      );
    },
  },
  {
    name: '12a: maxRecordLength on the text left at the end (a last record ended by a lone "\\r"): not closed; RangeError',
    columns: ALL,
    async run(make) {
      // 'cde\r' may still be 'cde' and a "\r\n": only the end of the input makes it four units.
      await expectError(
        make,
        { chunks: ['a\r\n', 'b\r\n', 'cde\r'] },
        { delimiter: ',', newline: '\r\n', maxRecordLength: 3 },
        (error) => {
          expect(error).toStrictEqual(
            new RangeError('Record at offset 6 is longer than maxRecordLength (3)'),
          );
        },
        0,
      );
    },
  },
  {
    name: '12b: a transform throw on the last record, which the end of the input ends: not closed; the same error object',
    columns: ALL,
    async run(make) {
      await expectError(
        make,
        { chunks: ['a\n', 'b\n', 'c'] },
        {
          ...FIXED,
          transform(value) {
            if (value === 'c') throw boom;
            return value;
          },
        },
        (error) => {
          expect(error).toBe(boom);
        },
        0,
      );
    },
  },
  {
    name: '12c: preview reached by the record that the end of the input ends: not closed; the last batch',
    columns: ALL,
    async run(make) {
      const probe = make({ chunks: ['a\n', 'b\n', 'c'] });
      const batches = parseStream(probe.source, { ...FIXED, preview: 3 });
      const batch = await batchOf(batches.next());
      expect(batch.data).toStrictEqual([['a'], ['b'], ['c']]);
      expect(batch.meta).toMatchObject({ cursor: 5, truncated: false, done: true });
      await probe.closed(0);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await probe.closed(0);
    },
  },
  {
    name: '13a: a throw from a delimiter function on a window that a one-chunk source ends: not closed',
    columns: ALL,
    async run(make) {
      await expectError(
        make,
        { chunks: ['a,b\n1,2\n'] },
        {
          delimiter() {
            throw boom;
          },
        },
        (error) => {
          expect(error).toBe(boom);
        },
        0,
      );
    },
  },
  {
    name: '13b: a throw from a delimiter function on a window that chunks of more than 1,048,576 units fill: closed once',
    columns: ALL,
    async run(make) {
      const chunk = 'a,b\n'.repeat(262_145);
      expect(chunk.length).toBeGreaterThan(1_048_576);
      const seen: number[] = [];
      await expectError(
        make,
        { chunks: [chunk, chunk, chunk] },
        {
          delimiter(text) {
            seen.push(text.length);
            throw boom;
          },
        },
        (error) => {
          expect(error).toBe(boom);
        },
        1,
      );
      expect(seen).toStrictEqual([1_048_576]);
    },
  },
];

describe('the close matrix', () => {
  for (const row of MATRIX) {
    describe(row.name, () => {
      it.each(row.columns)('%s', async (column) => {
        await row.run(COLUMNS[column], column);
      });
    });
  }

  it('has every row of the matrix, and only the listed cells are left out', () => {
    const cells = MATRIX.reduce((sum, row) => sum + row.columns.length, 0);
    // 20 rows (1, 7 and 12 have variants, 8 has three callbacks, 13 has two windows) x 6 columns,
    // less row 2 (3 cells), rows 5, 6 and 11 (1 each) and row 9 (2).
    expect(MATRIX).toHaveLength(20);
    expect(cells).toBe(20 * 6 - 3 - 3 - 2);
  });

  it('a Node Readable with autoDestroy on (the default) is destroyed once by return()', async () => {
    const readable = Readable.from(['a\n', 'b\n', 'c\n']);
    const destroy = vi.spyOn(readable, 'destroy');
    let closeEvents = 0;
    readable.on('close', () => {
      closeEvents++;
    });
    const batches = parseStream(readable, { ...FIXED, batchSize: 1 });
    expect((await batchOf(batches.next())).data).toStrictEqual([['a']]);
    await batches.return();
    await batches.return();
    await tick();
    expect(destroy.mock.calls).toStrictEqual([[]]);
    expect(readable.destroyed).toBe(true);
    expect(closeEvents).toBe(1);
  });
});

describe('abort: the value and the order', () => {
  it.each<[string, (controller: AbortController) => void]>([
    [
      'abort()',
      (controller) => {
        controller.abort();
      },
    ],
    [
      'abort(new Error("x"))',
      (controller) => {
        controller.abort(new Error('x'));
      },
    ],
    [
      'a TimeoutError made by hand',
      (controller) => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      },
    ],
    [
      'abort(null)',
      (controller) => {
        controller.abort(null);
      },
    ],
    [
      'abort("why")',
      (controller) => {
        controller.abort('why');
      },
    ],
  ])('%s: next() rejects with signal.reason itself', async (_, abort) => {
    for (const when of ['pending', 'between'] as const) {
      const controller = new AbortController();
      const probe = asyncProbe({ chunks: ['a\n'], hang: never() });
      const batches = parseStream(probe.source, {
        ...FIXED,
        batchSize: 1,
        signal: controller.signal,
      });
      await batches.next();
      let rejection: unknown = 'none';
      if (when === 'pending') {
        const pending = batches.next().catch((error: unknown) => {
          rejection = error;
        });
        await tick();
        abort(controller);
        await pending;
      } else {
        abort(controller);
        await batches.next().catch((error: unknown) => {
          rejection = error;
        });
      }
      expect(rejection).toBe(controller.signal.reason);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
    }
  });

  it.each(['web', 'async', 'sync', 'array'] as const)(
    'a signal already aborted: the first next() rejects, %s is closed at that call and never read',
    async (column) => {
      const probe = COLUMNS[column]({ chunks: three });
      const signal = AbortSignal.abort(reason);
      const batches = parseStream(probe.source, { signal });
      await tick();
      expect(probe.calls).toStrictEqual([]);
      await expect(batches.next()).rejects.toBe(reason);
      expect(probe.reads()).toBe(0);
      // A generator that never started has no finally block to run; return() is still called once.
      const expected = { web: [['cancel', reason], ['releaseLock']], array: [] };
      expect(probe.calls).toStrictEqual(
        column === 'web' || column === 'array' ? expected[column] : [['return']],
      );
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    },
  );

  it('a signal already aborted: a Node Readable nobody has read is destroyed without an argument', async () => {
    const readable = new Readable({ read() {} });
    const destroy = vi.spyOn(readable, 'destroy');
    const batches = parseStream(readable, { signal: AbortSignal.abort(reason) });
    await expect(batches.next()).rejects.toBe(reason);
    await tick();
    expect(destroy.mock.calls).toStrictEqual([[]]);
    expect(readable.destroyed).toBe(true);
    expect(readable.errored).toBeNull();
  });

  it.each(['web', 'node', 'async'] as const)(
    'a signal whose reason is undefined: next() rejects with a DOMException named AbortError, and the %s source is closed without it',
    async (column) => {
      let listener: (() => void) | undefined;
      const removed: unknown[] = [];
      const signal = {
        [Symbol.toStringTag]: 'AbortSignal',
        aborted: false,
        reason: undefined,
        addEventListener(_: string, added: () => void) {
          listener = added;
        },
        removeEventListener(_: string, gone: () => void) {
          removed.push(gone);
        },
      };
      const probe = COLUMNS[column]({ chunks: ['a,b'], hang: never() });
      const batches = open(probe.source, { signal });
      const pending = batches.next();
      await tick();
      signal.aborted = true;
      listener?.();
      const rejection: unknown = await pending.catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(DOMException);
      expect(rejection).toMatchObject({
        name: 'AbortError',
        message: 'The operation was aborted.',
      });
      expect(removed).toStrictEqual([listener]);
      // The source gets signal.reason as it is, here undefined, never the stand-in:
      // cancel(undefined) for Web, destroy() without an argument for Node.
      if (column === 'async') expect(probe.calls).toStrictEqual([['return']]);
      else await probe.closed(1, undefined);
    },
  );

  it('two pending next() calls: the first rejects, the second resolves done', async () => {
    const controller = new AbortController();
    const probe = webProbe({ chunks: ['a,b'], hang: never() });
    const batches = parseStream(probe.source, { signal: controller.signal });
    const first = batches.next();
    const second = batches.next();
    const third = batches.next();
    await tick();
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(second).resolves.toStrictEqual(DONE);
    await expect(third).resolves.toStrictEqual(DONE);
    await probe.closed(1, reason);
  });

  it('an abort inside a for await body ends the loop with the reason; the rows before it are intact', async () => {
    const controller = new AbortController();
    const probe = asyncProbe({ chunks: ['a\nb\n', 'c\nd\n'] });
    const seen: unknown[] = [];
    const loop = async () => {
      for await (const batch of parseStream(probe.source, {
        ...FIXED,
        batchSize: 1,
        signal: controller.signal,
      })) {
        seen.push(...batch.data);
        if (seen.length === 2) controller.abort(reason);
      }
      return 'ended as if the input had ended';
    };
    await expect(loop()).rejects.toBe(reason);
    expect(seen).toStrictEqual([['a'], ['b']]);
    expect(probe.reads()).toBe(1);
    await probe.closed(1);
  });

  it('an abort after the iteration has ended changes nothing', async () => {
    const controller = new AbortController();
    const batches = parseStream('a', { signal: controller.signal });
    await collect(batches);
    controller.abort(reason);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
  });

  it('return() after an abort between two calls ends the iteration: it resolves, and so does next()', async () => {
    const controller = new AbortController();
    const probe = asyncProbe({ chunks: three });
    const batches = parseStream(probe.source, {
      ...FIXED,
      batchSize: 1,
      signal: controller.signal,
    });
    await batches.next();
    controller.abort(reason);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await probe.closed(1);
  });
});

describe('abort, then return() at once', () => {
  it('a pending next() still rejects with the reason; return() resolves', async () => {
    const controller = new AbortController();
    const probe = webProbe({ chunks: ['a,b'], hang: never() });
    const batches = parseStream(probe.source, { signal: controller.signal });
    const first = batches.next();
    const second = batches.next();
    await tick();
    controller.abort(reason);
    const returned = batches.return();
    await expect(first).rejects.toBe(reason);
    await expect(second).resolves.toStrictEqual(DONE);
    await expect(returned).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await probe.closed(1, reason);
  });
});

describe('abort from inside a callback', () => {
  it('a transform that aborts on the third field: that next() rejects with the reason, its batch is dropped, the source is closed once', async () => {
    const controller = new AbortController();
    const probe = asyncProbe({ chunks: ['a,b\n1,2\n', 'c,d\n'] });
    const fields: string[] = [];
    const batches = parseStream(probe.source, {
      ...FIXED,
      signal: controller.signal,
      transform(value) {
        fields.push(value);
        if (fields.length === 3) controller.abort(reason);
        return value;
      },
    });
    await expect(batches.next()).rejects.toBe(reason);
    // The scan of the text held is not interrupted.
    expect(fields).toStrictEqual(['a', 'b', '1', '2']);
    expect(probe.reads()).toBe(1);
    await probe.closed(1);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await probe.closed(1);
  });

  it('a callback that aborts and then throws: the reason is reported, not the throw', async () => {
    const controller = new AbortController();
    const probe = asyncProbe({ chunks: ['a,b\n1,2\n', 'c,d\n'] });
    const batches = parseStream(probe.source, {
      ...FIXED,
      signal: controller.signal,
      transform() {
        controller.abort(reason);
        throw boom;
      },
    });
    await expect(batches.next()).rejects.toBe(reason);
    await probe.closed(1);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
  });

  it('a callback that calls return(): that next() resolves done and the source is closed once', async () => {
    const probe = asyncProbe({ chunks: ['a,b\n1,2\n', 'c,d\n'] });
    let returned: Promise<unknown> | undefined;
    const batches: BatchIterator<unknown> = parseStream(probe.source, {
      ...FIXED,
      transform(value) {
        returned ??= batches.return();
        return value;
      },
    });
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await expect(returned).resolves.toStrictEqual(DONE);
    await probe.closed(1);
  });

  it('a callback that calls return() and then throws: that next() rejects with the thrown error; return() resolves, the source closed once', async () => {
    const probe = asyncProbe({ chunks: ['a,b\n1,2\n', 'c,d\n'] });
    let returned: Promise<unknown> | undefined;
    const batches: BatchIterator<unknown> = parseStream(probe.source, {
      ...FIXED,
      transform() {
        returned ??= batches.return();
        throw boom;
      },
    });
    await expect(batches.next()).rejects.toBe(boom);
    await expect(returned).resolves.toStrictEqual(DONE);
    await probe.closed(1);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    await probe.closed(1);
  });
});

describe('after return(), every later next() resolves done', () => {
  it('abort and return() in the tick after a next() whose step already has its batch: the batch arrives, then done, never the reason', async () => {
    const controller = new AbortController();
    const batches = parseStream(['a\nb\nc\n'], {
      ...FIXED,
      batchSize: 1,
      signal: controller.signal,
    });
    await batches.next();
    const pending = batches.next();
    let returned: Promise<unknown> | undefined;
    // This job runs after the one that ran the step of `pending`, before `pending` has settled.
    await Promise.resolve().then(() => {
      controller.abort(reason);
      returned = batches.return();
    });
    expect((await batchOf(pending)).data).toStrictEqual([['b']]);
    await expect(returned).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
  });

  it('an abort any number of jobs after the source answered: a next() that rejects has not scanned the chunk', async () => {
    const outcomes: string[] = [];
    for (let depth = 0; depth < 24; depth++) {
      const controller = new AbortController();
      let scanned = 0;
      const later = (left: number): void => {
        if (left === 0) controller.abort(reason);
        else
          void Promise.resolve().then(() => {
            later(left - 1);
          });
      };
      const { source } = fake('async', () => {
        later(depth);
        return Promise.resolve({ done: false, value: 'a\n' });
      });
      const batches = parseStream(source, {
        ...FIXED,
        batchSize: 1,
        signal: controller.signal,
        transform(value) {
          scanned++;
          return value;
        },
      });
      const outcome = await batches.next().then(
        () => 'batch',
        (error: unknown) => (error === reason ? 'reason' : 'other'),
      );
      await tick();
      outcomes.push(outcome);
      if (outcome === 'reason') expect([depth, scanned]).toStrictEqual([depth, 0]);
      else expect([depth, outcome, scanned]).toStrictEqual([depth, 'batch', 1]);
    }
    // Early aborts win, late ones come after the batch: the sweep crosses the boundary.
    expect(outcomes[0]).toBe('reason');
    expect(outcomes.at(-1)).toBe('batch');
  });
});

describe('no listener leak', () => {
  it('10,000 parses with one signal, run to the end, ended by break, and ended by a source error', async () => {
    const { signal } = new AbortController();
    const listeners = () => getEventListeners(signal, 'abort').length;
    let most = 0;
    for (let i = 0; i < 10_000; i++) {
      const batches = parseStream(['a\n', 'b'], { ...FIXED, batchSize: 1, signal });
      await batches.next();
      most = Math.max(most, listeners());
      expect(await collect(batches)).toHaveLength(1);
    }
    expect(most).toBe(1);
    expect(listeners()).toBe(0);
    for (let i = 0; i < 10_000; i++) {
      for await (const batch of parseStream(['a\n', 'b\n'], { ...FIXED, batchSize: 1, signal })) {
        expect(batch.meta.done).toBe(false);
        break;
      }
    }
    expect(listeners()).toBe(0);
    const failing = {
      [Symbol.iterator]: () => ({
        next(): never {
          throw boom;
        },
      }),
    } as unknown as StreamSource;
    for (let i = 0; i < 10_000; i++) {
      await expect(parseStream(failing, { signal }).next()).rejects.toBe(boom);
    }
    expect(listeners()).toBe(0);
    // 30,000 parses take about 2.3 s on an idle machine; the default 5 s is too close on a loaded one.
  }, 60_000);

  it('return() before the first next() adds no listener, and neither does the next() after it', async () => {
    const { signal } = new AbortController();
    const batches = parseStream('a,b', { signal });
    await batches.return();
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });
});

describe('no unhandled rejection', () => {
  it.each(['async', 'web'] as const)(
    'abort with a read pending on a %s source whose read rejects 10 ms later and whose close rejects too',
    async (kind) => {
      // The read rejects 10 ms after the close was called, however slow the machine is.
      const closed = deferred();
      const { source, calls } = fake(
        kind,
        () => closed.promise.then(() => rejectLater(new Error('read'))),
        () => {
          closed.resolve(undefined);
          return Promise.reject(new Error('close'));
        },
      );
      const controller = new AbortController();
      const batches = parseStream(source, { signal: controller.signal });
      const pending = batches.next();
      await tick();
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      await settle();
      expect(unhandled).toStrictEqual([]);
      expect(names(calls)).toStrictEqual(
        kind === 'web' ? ['read', 'cancel', 'releaseLock'] : ['next', 'return'],
      );
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
    },
  );

  it('in a child process with default flags: exit code 0 and an empty stderr', () => {
    const child = runChild('stream-abort-child.mjs');
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('6 scenarios settled\n');
    expect(child.status).toBe(0);
  });
});

describe('pull only, and in order', () => {
  it.each(['web', 'async', 'sync', 'array'] as const)(
    '%s: the event order, read by read',
    async (column) => {
      const probe = COLUMNS[column]({ chunks: ['a,1\nb,2\n', 'c,3'] });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      await tick();
      expect(probe.reads()).toBe(0);
      const first = await batchOf(batches.next());
      expect([first.data, first.meta.cursor, first.meta.done]).toStrictEqual([
        [['a', '1']],
        4,
        false,
      ]);
      expect(probe.reads()).toBe(1);
      await tick();
      expect(probe.reads()).toBe(1);
      // A full batch reads nothing more: the second row was already in the text held.
      const second = await batchOf(batches.next());
      expect([second.data, second.meta.cursor, second.meta.done]).toStrictEqual([
        [['b', '2']],
        8,
        false,
      ]);
      expect(probe.reads()).toBe(1);
      // Chunk 1 and the end.
      const third = await batchOf(batches.next());
      expect([third.data, third.meta.cursor, third.meta.done]).toStrictEqual([
        [['c', '3']],
        11,
        true,
      ]);
      expect(probe.reads()).toBe(3);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      expect(probe.reads()).toBe(3);
    },
  );

  it.each(['node', 'web', 'async'] as const)(
    '%s: with an idle source, the rows complete in the first chunk are all delivered before a call hangs',
    async (column) => {
      const probe = COLUMNS[column]({ chunks: ['a\nb\nc\n'], hang: never() });
      const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
      for (const row of ['a', 'b', 'c']) {
        expect((await batchOf(batches.next())).data).toStrictEqual([[row]]);
      }
      const fourth = batches.next();
      expect(await isPending(fourth)).toBe(true);
      // return() during the pending next(): it resolves done, and the source is closed at once.
      void batches.return();
      await expect(fourth).resolves.toStrictEqual(DONE);
      expect(names(probe.calls)[0]).toBe(
        { node: 'destroy', web: 'cancel', async: 'return' }[column],
      );
    },
  );

  it('four overlapping next() calls resolve in call order with consecutive rowOffsets', async () => {
    const probe = asyncProbe({ chunks: ['a\nb\n', 'c\nd\n'] });
    const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
    const order: number[] = [];
    const calls = [0, 1, 2, 3, 4, 5].map((index) =>
      batches.next().then((result) => {
        order.push(index);
        return result;
      }),
    );
    const results = await Promise.all(calls);
    expect(order).toStrictEqual([0, 1, 2, 3, 4, 5]);
    expect(results.map((result) => result.value?.meta.rowOffset)).toStrictEqual([
      0,
      1,
      2,
      3,
      4,
      undefined,
    ]);
    expect(results.map((result) => result.value?.data)).toStrictEqual([
      [['a']],
      [['b']],
      [['c']],
      [['d']],
      [['']],
      undefined,
    ]);
  });

  it('a rejected call does not stop the calls queued behind it', async () => {
    const batches = open([5]);
    const first = batches.next();
    const second = batches.next();
    await expect(first).rejects.toBeInstanceOf(TypeError);
    await expect(second).resolves.toStrictEqual(DONE);
  });

  it('no timers: a parse of 10 chunks from an async generator ends under fake timers that never advance', async () => {
    vi.useFakeTimers();
    const chunks = Array.from({ length: 10 }, (_, index) => `${String(index)},x\n`);
    const batches = await collect(parseStream(asyncProbe({ chunks }).source, { batchSize: 3 }));
    expect(rowsOf(batches)).toHaveLength(11);
    expect(batches).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('Zalgo: a sync iterable whose next() throws: parseStream returns, next() rejects', async () => {
    const { source, calls } = fake('sync', () => {
      throw boom;
    });
    const batches = parseStream(source);
    expect(calls).toStrictEqual([]);
    const pending = batches.next();
    await expect(pending).rejects.toBe(boom);
    expect(names(calls)).toStrictEqual(['next']);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
  });

  it('Zalgo: a getReader or an iterator factory that throws rejects next(), and nothing is closed', async () => {
    const locked = {
      getReader() {
        throw boom;
      },
    } as unknown as StreamSource;
    await expect(parseStream(locked).next()).rejects.toBe(boom);
    const broken = {
      [Symbol.asyncIterator]() {
        throw boom;
      },
    } as unknown as StreamSource;
    await expect(parseStream(broken).next()).rejects.toBe(boom);
  });
});

describe('return()', () => {
  it('is idempotent: two calls, one close', async () => {
    const { source, calls } = fake('async', steps(three));
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    const both = await Promise.all([batches.return(), batches.return()]);
    expect(both).toStrictEqual([DONE, DONE]);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    expect(names(calls)).toStrictEqual(['next', 'return']);
  });

  it('before the first next(): the source is closed once and never read', async () => {
    const { source, calls } = fake('web', steps(three));
    const batches = parseStream(source);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    expect(calls).toStrictEqual([['cancel', undefined], ['releaseLock']]);
  });

  it('during a pending next(): the pending call resolves done and the source is closed once', async () => {
    const { source, calls } = fake('web', never);
    const batches = parseStream(source);
    const pending = batches.next();
    await tick();
    const returned = batches.return();
    await expect(pending).resolves.toStrictEqual(DONE);
    await expect(returned).resolves.toStrictEqual(DONE);
    expect(calls).toStrictEqual([['read'], ['cancel', undefined], ['releaseLock']]);
  });

  it('waits for the close', async () => {
    const gate = deferred();
    const { source } = fake('async', steps(three), () => gate.promise);
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    const first = batches.return();
    const second = batches.return();
    expect(await isPending(first)).toBe(true);
    expect(await isPending(second)).toBe(true);
    gate.resolve(DONE);
    expect(await Promise.all([first, second])).toStrictEqual([DONE, DONE]);
  });

  it('a close that fails rejects return() once', async () => {
    const failure = new Error('close');
    const { source, calls } = fake('async', steps(three), () => Promise.reject(failure));
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    await expect(batches.return()).rejects.toBe(failure);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    expect(names(calls)).toStrictEqual(['next', 'return']);
  });

  it('a sync return() that throws rejects return() once', async () => {
    const failure = new Error('close');
    const { source } = fake('sync', steps(three, false), () => {
      throw failure;
    });
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    await expect(batches.return()).rejects.toBe(failure);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
  });

  it('a break whose close fails makes the for await loop throw the close error', async () => {
    const failure = new Error('close');
    const { source } = fake('async', steps(three), () => Promise.reject(failure));
    const loop = async () => {
      for await (const batch of parseStream(source, { ...FIXED, batchSize: 1 })) {
        expect(batch.data).toStrictEqual([['a']]);
        break;
      }
    };
    await expect(loop()).rejects.toBe(failure);
  });

  it('after a stream error, return() resolves and does not report the close', async () => {
    const { source, calls } = fake('async', steps(['a\n', 5 as unknown as Chunk]), () =>
      Promise.reject(new Error('close')),
    );
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    await expect(batches.next()).rejects.toBeInstanceOf(TypeError);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
    await expect(batches.next()).resolves.toStrictEqual(DONE);
    expect(names(calls)).toStrictEqual(['next', 'next', 'return']);
  });

  it('after an abort, return() resolves without waiting for a close that never settles', async () => {
    const controller = new AbortController();
    const { source } = fake('async', never, never);
    const batches = parseStream(source, { signal: controller.signal });
    const pending = batches.next();
    await tick();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(batches.return()).resolves.toStrictEqual(DONE);
  });

  it.each(['next', 'return'] as const)(
    'after preview with a close that fails, the last batch is delivered and the following %s() rejects once',
    async (following) => {
      const failure = new Error('close');
      const { source, calls } = fake('async', steps(['a\nb\n', 'c\n']), () =>
        Promise.reject(failure),
      );
      const batches = parseStream(source, { ...FIXED, preview: 1 });
      const batch = await batchOf(batches.next());
      expect(batch.data).toStrictEqual([['a']]);
      expect(batch.meta).toMatchObject({ truncated: true, done: true });
      await expect(batches[following]()).rejects.toBe(failure);
      await expect(batches.next()).resolves.toStrictEqual(DONE);
      await expect(batches.return()).resolves.toStrictEqual(DONE);
      expect(names(calls)).toStrictEqual(['next', 'return']);
    },
  );

  it('after preview with a close that fails, in a for await loop: the rows arrive, then the loop throws the close error', async () => {
    const failure = new Error('close');
    const { source } = fake('web', steps(['a\nb\n', 'c\n']), () => Promise.reject(failure));
    const seen: unknown[] = [];
    const loop = async () => {
      for await (const batch of parseStream(source, { ...FIXED, preview: 1 })) {
        seen.push(...batch.data);
      }
    };
    await expect(loop()).rejects.toBe(failure);
    expect(seen).toStrictEqual([['a']]);
  });

  it('after preview with a close that never settles, the last batch is still delivered', async () => {
    const { source, calls } = fake('async', steps(['a\nb\n', 'c\n']), never);
    const batches = parseStream(source, { ...FIXED, preview: 1 });
    const batch = await batchOf(batches.next());
    expect(batch.data).toStrictEqual([['a']]);
    expect(batch.meta).toMatchObject({ truncated: true, done: true });
    expect(names(calls)).toStrictEqual(['next', 'return']);
    // The following call waits for the close.
    expect(await isPending(batches.next())).toBe(true);
  });
});

describe('decoding on demand', () => {
  // 32 MiB of ASCII CSV: 32,768 rows of 1,024 bytes, as one chunk.
  const WINDOW = 1_048_576;
  const row = bytes(`${'x'.repeat(1021)},y\n`);
  const input = new Uint8Array(32 * WINDOW);
  for (let at = 0; at < input.length; at += row.length) input.set(row, at);

  it('the first next() decodes one window, a view of the chunk; later calls decode only when a batch needs text', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const slice = vi.spyOn(Uint8Array.prototype, 'slice');
    const batches = parseStream([input], { ...FIXED, batchSize: 1 });
    expect(decode).not.toHaveBeenCalled();
    await batches.next();
    expect(decode).toHaveBeenCalledTimes(1);
    const [view, options] = decode.mock.calls[0] ?? [];
    expect(view).toBeInstanceOf(Uint8Array);
    expect((view as Uint8Array).byteLength).toBe(WINDOW);
    expect((view as Uint8Array).buffer).toBe(input.buffer);
    expect(options).toStrictEqual({ stream: true });
    for (let i = 0; i < 100; i++) await batches.next();
    expect(decode).toHaveBeenCalledTimes(1);
    // The first window holds 1,024 rows: the 1,025th needs the second window.
    for (let i = 0; i < 923; i++) await batches.next();
    expect(decode).toHaveBeenCalledTimes(1);
    const next = await batchOf(batches.next());
    expect(next.meta.rowOffset).toBe(1024);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(slice).not.toHaveBeenCalled();
    await batches.return();
  });

  it('a full run makes 32 decode calls with { stream: true } and one final call without it', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    let rows = 0;
    for await (const batch of parseStream([input], FIXED)) rows += batch.data.length;
    // 32,768 records and the [''] record after the last line break.
    expect(rows).toBe(32_769);
    expect(decode).toHaveBeenCalledTimes(33);
    const calls = decode.mock.calls;
    for (const [index, call] of calls.slice(0, 32).entries()) {
      const view = call[0] as Uint8Array;
      expect([index, view.byteOffset, view.byteLength, view.buffer === input.buffer]).toStrictEqual(
        [index, index * WINDOW, WINDOW, true],
      );
      expect(call[1]).toStrictEqual({ stream: true });
    }
    expect(calls[32]).toStrictEqual([]);
  });
});

describe('[Symbol.asyncDispose]', () => {
  it('calls return() once and resolves undefined', async () => {
    const probe = asyncProbe({ chunks: three });
    const batches = parseStream(probe.source, { ...FIXED, batchSize: 1 });
    await batches.next();
    const returned = vi.spyOn(batches, 'return');
    await expect(batches[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(returned.mock.calls).toStrictEqual([[]]);
    await probe.closed(1);
  });

  it('rejects when the close fails, as return() does', async () => {
    const failure = new Error('close');
    const { source } = fake('async', steps(three), () => Promise.reject(failure));
    const batches = parseStream(source, { ...FIXED, batchSize: 1 });
    await batches.next();
    await expect(batches[Symbol.asyncDispose]()).rejects.toBe(failure);
  });

  it('a detached next() or return() rejects with a TypeError; neither throws', async () => {
    const batches = parseStream('a');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- detached on purpose
    const { next, return: finish } = batches;
    const settled = await Promise.allSettled([next(), finish()]);
    expect(settled.map((result) => result.status)).toStrictEqual(['rejected', 'rejected']);
    for (const result of settled) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TypeError);
    }
    await expect(batches.next()).resolves.toMatchObject({ done: false });
  });

  it('the iterator is its own async iterable and has no throw()', () => {
    const batches = parseStream('a');
    expect(batches[Symbol.asyncIterator]()).toBe(batches);
    expect('throw' in batches).toBe(false);
  });

  const major = Number(process.versions.node.split('.')[0]);
  it.skipIf(major < 24)(
    'an `await using` block closes the source at its exit (child process; skipped on Node 22: no `await using` syntax)',
    () => {
      const child = runChild('stream-await-using.mjs');
      expect(child.stderr).toBe('');
      expect(child.stdout).toBe('closed once at block exit\n');
      expect(child.status).toBe(0);
    },
  );
});

describe("Node's pipeline", () => {
  // The signal pipeline gives its function: the last one seen.
  let inner: AbortSignal | undefined;
  // Node calls a pipeline function with (source, { signal }); @types/node declares one parameter.
  const through = ((source: Readable, { signal }: { signal: AbortSignal }) => {
    inner = signal;
    return parseStream(source, { ...FIXED, batchSize: 1, signal });
  }) as unknown as (source: Readable) => AsyncIterable<Batch>;

  it('a sink that throws: return() has destroyed the source when the loop is left, before pipeline does', async () => {
    const source = Readable.from(['a\n', 'b\n', 'c\n']);
    const seen: unknown[] = [];
    let destroyedAtExit: boolean | undefined;
    const done = pipeline(source, through, async (batches: AsyncIterable<Batch>) => {
      try {
        for await (const batch of batches) {
          seen.push(...batch.data);
          throw boom;
        }
      } finally {
        // for await has awaited the iterator's return() by now; pipeline has not seen the throw.
        destroyedAtExit = source.destroyed;
      }
    });
    await expect(done).rejects.toBe(boom);
    expect(seen).toStrictEqual([['a']]);
    expect(destroyedAtExit).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it("aborting pipeline's signal rejects the iteration with the reason of the signal pipeline gave", async () => {
    const source = new Readable({ read() {} });
    source.push('a\n');
    const controller = new AbortController();
    const seen: unknown[] = [];
    let rejection: unknown;
    const done = pipeline(
      source,
      through,
      async (batches: AsyncIterable<Batch>) => {
        try {
          for await (const batch of batches) {
            seen.push(...batch.data);
            // The source is idle: the next call waits for it until the abort.
            setImmediate(() => {
              controller.abort();
            });
          }
        } catch (error) {
          rejection = error;
          throw error;
        }
      },
      { signal: controller.signal },
    );
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toStrictEqual([['a']]);
    expect(inner?.aborted).toBe(true);
    expect(rejection).toBeDefined();
    expect(rejection).toBe(inner?.reason);
    expect(source.destroyed).toBe(true);
  });
});
