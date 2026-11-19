import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStreamSource, openSource } from '../src/source.ts';
import type { OpenSource } from '../src/source.ts';
import type { StreamSource } from '../src/types.ts';

// The source kinds and the one close function. The Node destroy() rules follow what Node
// 22.23.4, 24.22.1 and 26.12.1 were observed to do.

type Kind = 'web' | 'node' | 'async' | 'sync';

/**
 * An instrumented source that records every call with its arguments. 'node' is an async iterable
 * with a function destroy. `step` replaces read() or next() (default: 'a', 'b', then the end);
 * `finish` replaces cancel() or the iterator's return().
 */
function fake(kind: Kind, step?: () => unknown, finish?: () => unknown) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: () => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push([name, ...args]);
      return result();
    };
  const wrap = (value: unknown) => (kind === 'sync' ? value : Promise.resolve(value));
  const chunks = ['a', 'b'];
  const next =
    step ??
    (() => {
      const value = chunks.shift();
      return wrap(value === undefined ? { done: true, value } : { done: false, value });
    });
  const end = finish ?? (() => wrap(kind === 'web' ? undefined : { done: true, value: undefined }));
  if (kind === 'web') {
    const reader = {
      read: record('read', next),
      cancel: record('cancel', end),
      releaseLock: record('releaseLock', () => undefined),
    };
    return { calls, source: { getReader: record('getReader', () => reader) } as StreamSource };
  }
  const iterator = { next: record('next', next), return: record('return', end) };
  const source: Record<PropertyKey, unknown> =
    kind === 'sync'
      ? { [Symbol.iterator]: record('iterator', () => iterator) }
      : { [Symbol.asyncIterator]: record('asyncIterator', () => iterator) };
  if (kind === 'node') source.destroy = record('destroy', () => source);
  return { calls, source: source as unknown as StreamSource };
}

/** An async generator that awaits before each chunk, as a real source does. */
async function* generate(chunks: readonly string[], onFinally?: () => void) {
  try {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  } finally {
    onFinally?.();
  }
}

async function readAll(source: OpenSource): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for (;;) {
    const step = await source.read();
    if (step.done) return chunks;
    chunks.push(step.value);
  }
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const reason = new Error('abort');
const names = (calls: unknown[][]) => calls.map((call) => call[0]);
const rejectLater = (error: Error) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(error);
    }, 10);
  });
// Real timers, only in the tests that check for an unhandled rejection after the source settles.
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
const closeEvent = (readable: Readable) =>
  new Promise((resolve) => {
    readable.once('close', resolve);
  });

let unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => {
  unhandled.push(error);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

describe('isStreamSource', () => {
  it.each<[string, unknown]>([
    ['a string', 'a,b'],
    ['an empty string', ''],
    ['a ReadableStream', new ReadableStream()],
    ['a Node Readable', new Readable({ read() {} })],
    ['an async generator', generate(['a'])],
    ['an array', []],
    ['a Set', new Set()],
    ['an array of another realm', runInNewContext('[]')],
    ['an object with a function getReader only', fake('web').source],
  ])('accepts %s', (_, value) => {
    expect(isStreamSource(value)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['a plain object', {}],
    ['a function', () => 'a'],
    ['a bare Uint8Array', new Uint8Array([97])],
    ['a Buffer', Buffer.from('a')],
    ['a DataView', new DataView(new ArrayBuffer(1))],
    ['an ArrayBuffer', new ArrayBuffer(1)],
    ['a Uint8Array of another realm', runInNewContext('new Uint8Array([97])')],
    ['an object whose getReader is not a function', { getReader: 1 }],
  ])('rejects %s', (_, value) => {
    expect(isStreamSource(value)).toBe(false);
  });
});

describe('detection and reading', () => {
  it('reads a string as one chunk, then the end', async () => {
    const source = openSource('a,b');
    expect(await source.read()).toStrictEqual({ done: false, value: 'a,b' });
    expect(await source.read()).toStrictEqual({ done: true });
    expect(await source.read()).toStrictEqual({ done: true });
  });

  it('reads a ReadableStream with its reader and releases the lock at the end', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a,b\n');
        controller.enqueue('1,2');
        controller.close();
      },
    });
    expect(await readAll(openSource(stream))).toStrictEqual(['a,b\n', '1,2']);
    expect(stream.locked).toBe(false);
  });

  it('reads a ReadableStream that has no [Symbol.asyncIterator] (Safari 26 and earlier)', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a,b\n');
        controller.enqueue('1,2');
        controller.close();
      },
    });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    expect(Reflect.get(stream, Symbol.asyncIterator)).toBeUndefined();
    expect(await readAll(openSource(stream))).toStrictEqual(['a,b\n', '1,2']);
    expect(stream.locked).toBe(false);
  });

  it('uses the reader of a source that also has [Symbol.asyncIterator]', async () => {
    const { source, calls } = fake('web');
    const iterate = vi.fn();
    const both = Object.assign(source, { [Symbol.asyncIterator]: iterate });
    expect(await readAll(openSource(both))).toStrictEqual(['a', 'b']);
    expect(names(calls)).toStrictEqual(['getReader', 'read', 'read', 'read', 'releaseLock']);
    expect(iterate).not.toHaveBeenCalled();
  });

  it('reads a Node Readable through its async iterator', async () => {
    const chunks = await readAll(openSource(Readable.from(['a,b\n', '1,2'])));
    expect(chunks.join('')).toBe('a,b\n1,2');
  });

  it.each<[string, () => StreamSource]>([
    ['an async generator', () => generate(['a,b\n', '1,2'])],
    ['an array', () => ['a,b\n', '1,2']],
    ['a Set', () => new Set(['a,b\n', '1,2'])],
    [
      'a generator of another realm',
      () => runInNewContext('(function* () { yield "a,b\\n"; yield "1,2"; })()') as StreamSource,
    ],
  ])('reads %s', async (_, make) => {
    expect(await readAll(openSource(make()))).toStrictEqual(['a,b\n', '1,2']);
  });

  it('passes chunks on unchecked', async () => {
    const bytes = Uint8Array.of(97);
    const chunks = [bytes, 5, null] as unknown as StreamSource;
    const read = await readAll(openSource(chunks));
    expect(read).toStrictEqual([bytes, 5, null]);
    expect(read[0]).toBe(bytes);
  });
});

describe('nothing is touched before the first read', () => {
  it.each<[Kind, PropertyKey[], string]>([
    ['web', ['getReader'], 'getReader'],
    ['node', ['getReader', Symbol.asyncIterator], 'asyncIterator'],
    ['async', ['getReader', Symbol.asyncIterator], 'asyncIterator'],
    ['sync', ['getReader', Symbol.asyncIterator, Symbol.iterator], 'iterator'],
  ])('%s: openSource makes only the detection reads', async (kind, detection, first) => {
    const { source, calls } = fake(kind);
    const accessed: PropertyKey[] = [];
    const proxy = new Proxy(source as object, {
      get(target, key, receiver) {
        accessed.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as StreamSource;
    const open = openSource(proxy);
    expect(accessed).toStrictEqual(detection);
    expect(calls).toStrictEqual([]);
    await open.read();
    expect(calls[0]).toStrictEqual([first]);
  });
});

describe('close with no read in flight', () => {
  it.each<[Kind, 'before' | 'after', 'no reason' | 'reason', unknown[][]]>([
    ['web', 'before', 'no reason', [['getReader'], ['cancel', undefined], ['releaseLock']]],
    ['web', 'before', 'reason', [['getReader'], ['cancel', reason], ['releaseLock']]],
    ['web', 'after', 'reason', [['cancel', reason], ['releaseLock']]],
    ['node', 'before', 'no reason', [['destroy']]],
    // Probe p1: destroy(reason) on a stream nobody listens to is an unhandled 'error' event.
    ['node', 'before', 'reason', [['destroy']]],
    ['node', 'after', 'no reason', [['destroy']]],
    ['node', 'after', 'reason', [['destroy', reason]]],
    ['async', 'before', 'reason', [['asyncIterator'], ['return']]],
    ['async', 'after', 'reason', [['return']]],
    ['sync', 'before', 'reason', [['iterator'], ['return']]],
    ['sync', 'after', 'reason', [['return']]],
  ])(
    '%s, %s a read, %s: one close, and the same promise again',
    async (kind, when, given, expected) => {
      const { source, calls } = fake(kind);
      const open = openSource(source);
      if (when === 'after') await open.read();
      const before = calls.length;
      const closing = given === 'reason' ? open.close(reason) : open.close();
      expect(calls.slice(before)).toStrictEqual(expected);
      await expect(closing).resolves.toBeUndefined();
      expect(open.close()).toBe(closing);
      expect(open.close(reason)).toBe(closing);
      expect(calls.slice(before)).toStrictEqual(expected);
    },
  );

  it.each<[string, StreamSource]>([
    ['a string', 'a,b'],
    ['an array', ['a,b']],
  ])('%s: nothing to call', async (_, value) => {
    expect([][Symbol.iterator]()).not.toHaveProperty('return');
    const open = openSource(value);
    const closing = open.close(reason);
    await expect(closing).resolves.toBeUndefined();
    expect(open.close()).toBe(closing);
  });

  it('a Node Readable before any read: destroyed once, without an error', async () => {
    const readable = new Readable({ read() {} });
    const destroy = vi.spyOn(readable, 'destroy');
    const closed = closeEvent(readable);
    const open = openSource(readable);
    await open.close(reason);
    await open.close(reason);
    await closed;
    expect(destroy.mock.calls).toStrictEqual([[]]);
    expect(readable.destroyed).toBe(true);
    expect(readable.errored).toBeNull();
  });

  it('a Node Readable after a read: destroyed once, with the reason', async () => {
    const readable = new Readable({ read() {} });
    readable.push('a');
    const open = openSource(readable);
    await open.read();
    const destroy = vi.spyOn(readable, 'destroy');
    const closed = closeEvent(readable);
    await open.close(reason);
    await open.close();
    await closed;
    expect(destroy.mock.calls).toStrictEqual([[reason]]);
    expect(readable.errored).toBe(reason);
  });

  it('a ReadableStream: cancelled with the reason, unlocked', async () => {
    const cancelled: unknown[] = [];
    const stream = new ReadableStream<string>({
      cancel(why) {
        cancelled.push(why);
      },
    });
    await openSource(stream).close(reason);
    expect(cancelled).toStrictEqual([reason]);
    expect(stream.locked).toBe(false);
  });
});

describe('close with a read in flight', () => {
  it('a ReadableStream: the pending read settles done; cancelled with the reason, unlocked', async () => {
    const cancelled: unknown[] = [];
    const stream = new ReadableStream<string>({
      cancel(why) {
        cancelled.push(why);
      },
    });
    const open = openSource(stream);
    const pending = open.read();
    const closing = open.close(reason);
    await expect(pending).resolves.toStrictEqual({ done: true });
    await expect(closing).resolves.toBeUndefined();
    expect(cancelled).toStrictEqual([reason]);
    expect(stream.locked).toBe(false);
  });

  it('a Web reader: cancel, then one releaseLock, also when the read ends after the close', async () => {
    const read = deferred();
    const { source, calls } = fake('web', () => read.promise);
    const open = openSource(source);
    const pending = open.read();
    await open.close(reason);
    expect(calls).toStrictEqual([['getReader'], ['read'], ['cancel', reason], ['releaseLock']]);
    read.resolve({ done: true, value: undefined });
    await expect(pending).resolves.toStrictEqual({ done: true });
    expect(calls).toHaveLength(4);
  });

  it('a Web reader whose cancel never settles: the lock is released at once', () => {
    const { source, calls } = fake('web', undefined, () => new Promise(() => undefined));
    void openSource(source).close(reason);
    expect(calls).toStrictEqual([['getReader'], ['cancel', reason], ['releaseLock']]);
  });

  it('a Node Readable: the pending read rejects with the reason; destroyed with it', async () => {
    const readable = new Readable({ read() {} });
    const destroy = vi.spyOn(readable, 'destroy');
    const open = openSource(readable);
    const pending = open.read();
    const closing = open.close(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(closing).resolves.toBeUndefined();
    expect(destroy.mock.calls).toStrictEqual([[reason]]);
    expect(readable.destroyed).toBe(true);
  });

  it('a slow async generator: the close settles when the pending step does', async () => {
    const step = deferred();
    let finallyRuns = 0;
    const source = (async function* () {
      try {
        await step.promise;
        yield 'a';
      } finally {
        finallyRuns++;
      }
    })();
    const open = openSource(source);
    const pending = open.read();
    let closed = false;
    const closing = open.close(reason).then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    expect(finallyRuns).toBe(0);
    const late = new Error('late');
    step.reject(late);
    await expect(pending).rejects.toBe(late);
    await closing;
    expect(closed).toBe(true);
    expect(finallyRuns).toBe(1);
    expect(unhandled).toStrictEqual([]);
  });

  // The test never handles these promises: only the module's own handlers stand between a late
  // rejection and an unhandledRejection.
  it('a Web reader whose read rejects after the close and whose cancel rejects', async () => {
    const { source } = fake(
      'web',
      () => rejectLater(new Error('read')),
      () => Promise.reject(new Error('cancel')),
    );
    const open = openSource(source);
    void open.read();
    void open.close(reason);
    await settle();
    expect(unhandled).toStrictEqual([]);
  });

  it('an async iterator whose next() and return() reject later', async () => {
    const { source } = fake(
      'async',
      () => rejectLater(new Error('next')),
      () => rejectLater(new Error('return')),
    );
    const open = openSource(source);
    void open.read();
    void open.close(reason);
    await settle();
    expect(unhandled).toStrictEqual([]);
  });

  it('a Node-like iterable whose next() rejects after destroy()', async () => {
    const { source, calls } = fake('node', () => rejectLater(new Error('next')));
    const open = openSource(source);
    void open.read();
    void open.close(reason);
    await settle();
    expect(names(calls)).toStrictEqual(['asyncIterator', 'next', 'destroy']);
    expect(unhandled).toStrictEqual([]);
  });

  it('a Node Readable', async () => {
    const readable = new Readable({ read() {} });
    const open = openSource(readable);
    void open.read();
    void open.close(reason);
    await settle();
    expect(readable.destroyed).toBe(true);
    expect(unhandled).toStrictEqual([]);
  });

  it('a slow async generator whose step rejects later', async () => {
    const source = (async function* () {
      await rejectLater(new Error('step'));
      yield 'a';
    })();
    const open = openSource(source);
    void open.read();
    void open.close(reason);
    await settle();
    expect(unhandled).toStrictEqual([]);
  });
});

describe('ended and failed sources are not closed', () => {
  it.each<[Kind, string[]]>([
    ['web', ['getReader', 'read', 'read', 'read', 'releaseLock']],
    ['node', ['asyncIterator', 'next', 'next', 'next']],
    ['async', ['asyncIterator', 'next', 'next', 'next']],
    ['sync', ['iterator', 'next', 'next', 'next']],
  ])('%s after its end', async (kind, expected) => {
    const { source, calls } = fake(kind);
    const open = openSource(source);
    expect(await readAll(open)).toStrictEqual(['a', 'b']);
    await expect(open.close(reason)).resolves.toBeUndefined();
    expect(names(calls)).toStrictEqual(expected);
  });

  it.each<[Kind, string[]]>([
    ['web', ['getReader', 'read', 'releaseLock']],
    ['node', ['asyncIterator', 'next']],
    ['async', ['asyncIterator', 'next']],
    ['sync', ['iterator', 'next']],
  ])('%s after its read failed', async (kind, expected) => {
    const error = new Error('source');
    const { source, calls } = fake(kind, () => {
      if (kind === 'sync') throw error;
      return Promise.reject(error);
    });
    const open = openSource(source);
    await expect(open.read()).rejects.toBe(error);
    await expect(open.close(reason)).resolves.toBeUndefined();
    expect(names(calls)).toStrictEqual(expected);
  });

  it('a Node Readable after its end', async () => {
    const readable = Readable.from(['a']);
    const open = openSource(readable);
    await readAll(open);
    const destroy = vi.spyOn(readable, 'destroy');
    await open.close(reason);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('a Node Readable after its error', async () => {
    const error = new Error('source');
    const readable = new Readable({
      read() {
        this.destroy(error);
      },
    });
    const open = openSource(readable);
    await expect(open.read()).rejects.toBe(error);
    const destroy = vi.spyOn(readable, 'destroy');
    await open.close(reason);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('a ReadableStream after its end and after its error: unlocked, never cancelled', async () => {
    const error = new Error('source');
    let cancels = 0;
    const ended = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a');
        controller.close();
      },
      cancel() {
        cancels++;
      },
    });
    const failed = new ReadableStream<string>({
      start(controller) {
        controller.error(error);
      },
      cancel() {
        cancels++;
      },
    });
    const openEnded = openSource(ended);
    await readAll(openEnded);
    expect(ended.locked).toBe(false);
    await openEnded.close(reason);
    const openFailed = openSource(failed);
    await expect(openFailed.read()).rejects.toBe(error);
    expect(failed.locked).toBe(false);
    await openFailed.close(reason);
    expect(cancels).toBe(0);
  });

  it('an async generator after its end: its finally ran once', async () => {
    let finallyRuns = 0;
    const open = openSource(
      generate(['a'], () => {
        finallyRuns++;
      }),
    );
    await readAll(open);
    await open.close(reason);
    expect(finallyRuns).toBe(1);
  });
});

describe('read() never throws synchronously', () => {
  it('a sync iterable whose next() throws', async () => {
    const error = new Error('next');
    const { source } = fake('sync', () => {
      throw error;
    });
    const pending = openSource(source).read();
    await expect(pending).rejects.toBe(error);
  });

  it('a sync iterable whose [Symbol.iterator]() throws: failed, so not closed', async () => {
    const error = new Error('iterator');
    const iterator = vi.fn(() => {
      throw error;
    });
    const open = openSource({ [Symbol.iterator]: iterator });
    const pending = open.read();
    await expect(pending).rejects.toBe(error);
    await open.close(reason);
    expect(iterator).toHaveBeenCalledTimes(1);
  });

  it('a getReader that throws: a locked ReadableStream, and a fake', async () => {
    const stream = new ReadableStream<string>();
    stream.getReader();
    await expect(openSource(stream).read()).rejects.toBeInstanceOf(TypeError);
    const error = new Error('locked');
    const getReader = vi.fn(() => {
      throw error;
    });
    const open = openSource({ getReader });
    await expect(open.read()).rejects.toBe(error);
    await open.close(reason);
    expect(getReader).toHaveBeenCalledTimes(1);
  });
});

describe('a failing close', () => {
  it.each<[string, Kind, (error: Error) => () => unknown]>([
    [
      'a sync return() that throws',
      'sync',
      (error) => () => {
        throw error;
      },
    ],
    [
      'an async return() that throws',
      'async',
      (error) => () => {
        throw error;
      },
    ],
    ['an async return() that rejects', 'async', (error) => () => Promise.reject(error)],
    ['a cancel() that rejects', 'web', (error) => () => Promise.reject(error)],
    [
      'a cancel() that throws',
      'web',
      (error) => () => {
        throw error;
      },
    ],
  ])('%s rejects close() with the same object', async (_, kind, finish) => {
    const error = new Error('close');
    const { source } = fake(kind, undefined, finish(error));
    const open = openSource(source);
    const closing = open.close(reason);
    await expect(closing).rejects.toBe(error);
    expect(open.close()).toBe(closing);
  });

  it('a cancel() that rejects: releaseLock was still called, after it', async () => {
    const error = new Error('cancel');
    const { source, calls } = fake('web', undefined, () => Promise.reject(error));
    await expect(openSource(source).close(reason)).rejects.toBe(error);
    expect(names(calls)).toStrictEqual(['getReader', 'cancel', 'releaseLock']);
  });

  it('a close nobody awaits raises no unhandled rejection', async () => {
    const { source } = fake('sync', undefined, () => {
      throw new Error('return');
    });
    void openSource(source).close(reason);
    await settle();
    expect(unhandled).toStrictEqual([]);
  });
});

describe('rejection paths in a fresh node with default flags', () => {
  it('test/fixtures/source-close-child.mjs exits 0 with an empty stderr', () => {
    const fixture = fileURLToPath(new URL('fixtures/source-close-child.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', env });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('9 scenarios settled\n');
    expect(child.status).toBe(0);
  });
});
