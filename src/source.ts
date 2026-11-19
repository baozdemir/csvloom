import type { ReadableStreamLike, StreamSource } from './types.ts';

/** A source's chunks behind one read and one close. Nothing is touched before the first call. */
export interface OpenSource {
  /**
   * The next chunk, unchecked; { done: true } at the end. Rejects with the source's own error and
   * never throws synchronously. One call at a time.
   */
  read(): Promise<{ done: false; value: unknown } | { done: true }>;
  /**
   * Closes the source unless it ended or failed. Idempotent: every call returns the first call's
   * promise. `reason` is given only on abort. With a read in flight, the read's promise gets a
   * no-op rejection handler.
   */
  close(reason?: unknown): Promise<void>;
}

type Reader = ReturnType<ReadableStreamLike<unknown>['getReader']>;

interface SourceIterator {
  next(): unknown;
  return?: () => unknown;
}

/** The members detection and close() look at; every one may be missing or of another type. */
interface Members {
  getReader?: () => Reader;
  destroy?: (error?: unknown) => unknown;
  [Symbol.asyncIterator]?: () => SourceIterator;
  [Symbol.iterator]?: () => SourceIterator;
}

const noop = () => undefined;

/** The kind, by behaviour only (no instanceof or toStringTag): a source of another realm passes. */
function kindOf(value: unknown): 'string' | 'web' | 'async' | 'sync' | undefined {
  if (typeof value === 'string') return 'string';
  // An ArrayBuffer view iterates numbers: a bare Uint8Array is meant as [bytes].
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return undefined;
  const members = value as Members;
  if (typeof members.getReader === 'function') return 'web';
  if (typeof members[Symbol.asyncIterator] === 'function') return 'async';
  if (typeof members[Symbol.iterator] === 'function') return 'sync';
  return undefined;
}

/**
 * Whether parseStream accepts `value` as a source: a string, or an object other than an
 * ArrayBuffer view with a getReader, [Symbol.asyncIterator] or [Symbol.iterator] function.
 */
export function isStreamSource(value: unknown): boolean {
  return kindOf(value) !== undefined;
}

/**
 * Opens a source. Closing cancels and releases a Web reader, destroys a Node Readable (an async
 * iterable with a destroy function; its iterator's return() would wait for a pending read), and
 * calls return() on any other iterator. A source that ended or failed is not closed.
 */
export function openSource(source: StreamSource): OpenSource {
  const kind = kindOf(source);
  const members = source as Members;
  if (kind === 'string') {
    let given = false;
    return track(() => {
      if (given) return { done: true };
      given = true;
      return { done: false, value: source };
    }, noop);
  }
  if (kind === 'web') {
    let reader: Reader | undefined;
    const open = () => (reader ??= (members.getReader as () => Reader).call(source));
    return track(
      () => open().read(),
      (reason) => {
        const opened = open();
        const cancelled = opened.cancel(reason);
        // At once, not after cancel settles: a cancel that hangs must not keep the lock.
        opened.releaseLock();
        return cancelled;
      },
      () => reader?.releaseLock(),
    );
  }
  let iterator: SourceIterator | undefined;
  const open = () =>
    (iterator ??= (
      (kind === 'async'
        ? members[Symbol.asyncIterator]
        : members[Symbol.iterator]) as () => SourceIterator
    ).call(source));
  return track(
    () => open().next(),
    (reason, readMade) => {
      if (kind === 'async' && typeof members.destroy === 'function') {
        // Before any read nothing listens for 'error': destroy(reason) would emit an unhandled one.
        if (readMade && reason !== undefined) members.destroy(reason);
        else members.destroy();
        return undefined;
      }
      return open().return?.();
    },
  );
}

/**
 * The state every kind shares. `next` is the source's step (a result or a promise of one), `shut`
 * closes, and `release` runs once when the source ends or fails before any close.
 */
function track(
  next: () => unknown,
  shut: (reason: unknown, readMade: boolean) => unknown,
  release: () => void = noop,
): OpenSource {
  let finished = false;
  let closing: Promise<void> | undefined;
  let last: Promise<{ done: false; value: unknown } | { done: true }> | undefined;
  const finish = () => {
    if (closing !== undefined) return;
    finished = true;
    release();
  };
  return {
    read() {
      last = (async () => {
        let step: { done?: unknown; value?: unknown };
        try {
          step = (await next()) as { done?: unknown; value?: unknown };
          if (!step.done) return { done: false, value: step.value } as const;
        } catch (error) {
          finish();
          throw error;
        }
        finish();
        return { done: true } as const;
      })();
      return last;
    },
    close(reason) {
      if (closing === undefined) {
        const readMade = last !== undefined;
        closing = finished
          ? Promise.resolve()
          : (async () => {
              await shut(reason, readMade);
            })();
        // Whoever awaits these still sees their rejection; with nobody awaiting, none goes unhandled.
        closing.catch(noop);
        last?.catch(noop);
      }
      return closing;
    },
  };
}
