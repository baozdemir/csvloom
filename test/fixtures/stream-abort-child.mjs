// Run by test/stream.test.ts in a fresh node with default flags (--unhandled-rejections=throw).
// Each scenario ends a parse while the source still has something to reject with; a rejection
// nobody handles, or an 'error' event nobody listens to, ends this process with a non-zero code.
import process from 'node:process';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseStream } from '../../src/stream.ts';

const { AbortController } = globalThis;
const reason = new Error('abort');
const later = async (error) => {
  await sleep(10);
  throw error;
};
const macrotask = () => sleep(0);
/**
 * A source failure that comes 10 ms after the parse closed the source, however slow the machine
 * is: `after` rejects 10 ms after `closed` was called.
 */
function lateFailure() {
  let closed;
  const closing = new Promise((resolve) => {
    closed = resolve;
  });
  const after = async (error) => {
    await closing;
    return later(error);
  };
  return { closed, after };
}

/** The next() must reject with the abort reason itself. */
async function rejectsWithReason(pending) {
  try {
    await pending;
  } catch (error) {
    if (error === reason) return;
    throw new Error('next() rejected with another error', { cause: error });
  }
  throw new Error('next() did not reject');
}

const scenarios = [
  // An async iterator: abort with a read pending; the read and return() both reject later.
  async () => {
    const { closed, after } = lateFailure();
    const iterator = {
      next: () => after(new Error('next')),
      return() {
        closed();
        return later(new Error('return'));
      },
    };
    const controller = new AbortController();
    const batches = parseStream(
      { [Symbol.asyncIterator]: () => iterator },
      { signal: controller.signal },
    );
    const pending = batches.next();
    await macrotask();
    controller.abort(reason);
    await rejectsWithReason(pending);
  },
  // A Web reader: the same, with a cancel() that rejects at once.
  async () => {
    const { closed, after } = lateFailure();
    const reader = {
      read: () => after(new Error('read')),
      cancel() {
        closed();
        return Promise.reject(new Error('cancel'));
      },
      releaseLock() {},
    };
    const controller = new AbortController();
    const batches = parseStream({ getReader: () => reader }, { signal: controller.signal });
    const pending = batches.next();
    await macrotask();
    controller.abort(reason);
    await rejectsWithReason(pending);
  },
  // A Node Readable with no listeners, aborted before the first next().
  async () => {
    const controller = new AbortController();
    const batches = parseStream(new Readable({ read() {} }), { signal: controller.signal });
    controller.abort(reason);
    await rejectsWithReason(batches.next());
  },
  // A Node Readable with a read pending.
  async () => {
    const controller = new AbortController();
    const batches = parseStream(new Readable({ read() {} }), { signal: controller.signal });
    const pending = batches.next();
    await macrotask();
    controller.abort(reason);
    await rejectsWithReason(pending);
  },
  // preview ends the parse, the close fails, and the consumer never makes the following call: the close's failure is still reported.
  async () => {
    const iterator = {
      next: () => Promise.resolve({ done: false, value: 'a\nb\n' }),
      return: () => later(new Error('return')),
    };
    const batches = parseStream({ [Symbol.asyncIterator]: () => iterator }, { preview: 1 });
    const { value } = await batches.next();
    if (!value.meta.truncated) throw new Error('preview did not end the parse');
  },
  // return() during a pending read whose source rejects later; the close fails too, and
  // return() reports it.
  async () => {
    const failure = new Error('return');
    const { closed, after } = lateFailure();
    const iterator = {
      next: () => after(new Error('next')),
      return() {
        closed();
        return later(failure);
      },
    };
    const batches = parseStream({ [Symbol.asyncIterator]: () => iterator });
    const pending = batches.next();
    await macrotask();
    const returned = batches.return().catch((error) => error);
    if (!(await pending).done) throw new Error('the pending next() did not resolve done');
    if ((await returned) !== failure) throw new Error('return() did not report the close');
  },
];

for (const scenario of scenarios) await scenario();
await sleep(50);
process.stdout.write(`${scenarios.length} scenarios settled\n`);
