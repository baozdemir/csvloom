// Run by test/source.test.ts in a fresh node with default flags (--unhandled-rejections=throw).
// Each scenario leaves the promises of src/source.ts unhandled, as an abort does; a rejection
// nobody handles or an 'error' event nobody listens to ends this process with a non-zero code.
import process from 'node:process';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { openSource } from '../../src/source.ts';

const reason = new Error('abort');
const later = async (error) => {
  await sleep(10);
  throw error;
};

const scenarios = [
  // Probe p1: destroy(reason) here would be an unhandled 'error' event.
  () => {
    void openSource(new Readable({ read() {} })).close(reason);
  },
  () => {
    const open = openSource(new Readable({ read() {} }));
    void open.read();
    void open.close(reason);
  },
  async () => {
    const readable = new Readable({ read() {} });
    readable.push('a');
    const open = openSource(readable);
    await open.read();
    void open.close(reason);
  },
  () => {
    const reader = {
      read: () => later(new Error('read')),
      cancel: () => Promise.reject(new Error('cancel')),
      releaseLock() {},
    };
    const open = openSource({ getReader: () => reader });
    void open.read();
    void open.close(reason);
  },
  () => {
    const stream = new ReadableStream({
      cancel() {
        throw new Error('cancel');
      },
    });
    const open = openSource(stream);
    void open.read();
    void open.close(reason);
  },
  () => {
    const iterator = {
      next: () => later(new Error('next')),
      return: () => later(new Error('return')),
    };
    const open = openSource({ [Symbol.asyncIterator]: () => iterator });
    void open.read();
    void open.close(reason);
  },
  () => {
    const open = openSource(
      (async function* () {
        await later(new Error('step'));
        yield 'a';
      })(),
    );
    void open.read();
    void open.close(reason);
  },
  () => {
    const iterator = {
      next: () => ({ done: false, value: 'a' }),
      return() {
        throw new Error('return');
      },
    };
    void openSource({ [Symbol.iterator]: () => iterator }).close(reason);
  },
  () => {
    const source = {
      getReader() {
        throw new Error('locked');
      },
    };
    void openSource(source).close(reason);
  },
];

for (const scenario of scenarios) await scenario();
await sleep(50);
process.stdout.write(`${scenarios.length} scenarios settled\n`);
