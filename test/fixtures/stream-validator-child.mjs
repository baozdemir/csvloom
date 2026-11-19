// Run by test/stream-features.test.ts in a fresh node with default flags
// (--unhandled-rejections=throw). Each scenario ends a parse while a validation is pending, and
// the validator rejects afterwards; a rejection nobody handles ends this process with a non-zero
// code.
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseStream } from '../../src/stream.ts';

const { AbortController } = globalThis;
const reason = new Error('abort');
const macrotask = () => sleep(0);

/** A schema whose validation rejects 10 ms after `ended` was called, however slow the machine is. */
function lateSchema() {
  let ended;
  const ending = new Promise((resolve) => {
    ended = resolve;
  });
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'child',
      validate: async () => {
        await ending;
        await sleep(10);
        throw new Error('validator');
      },
    },
  };
  return { schema, ended };
}

const scenarios = [
  // An abort during a pending validation: next() rejects with the reason, the validator later.
  async () => {
    const { schema, ended } = lateSchema();
    const controller = new AbortController();
    const batches = parseStream(['a\n1\n2'], { schema, signal: controller.signal });
    const pending = batches.next();
    await macrotask();
    controller.abort(reason);
    try {
      await pending;
      throw new Error('next() did not reject');
    } catch (error) {
      if (error !== reason) throw new Error('next() rejected with another error', { cause: error });
    }
    ended();
  },
  // return() during a pending validation: both resolve, the validator rejects later.
  async () => {
    const { schema, ended } = lateSchema();
    const batches = parseStream(['a\n1\n2'], { schema });
    const pending = batches.next();
    await macrotask();
    await batches.return();
    if (!(await pending).done) throw new Error('the pending next() did not end');
    ended();
  },
  // The validator's rejection reaches next() and nothing else.
  async () => {
    const { schema, ended } = lateSchema();
    ended();
    try {
      await parseStream(['a\n1\n2'], { schema, batchSize: 1 }).next();
      throw new Error('next() did not reject');
    } catch (error) {
      if (error.message !== 'validator') throw error;
    }
  },
];

for (const scenario of scenarios) await scenario();
// Longer than every late rejection above.
await sleep(100);
process.stdout.write(`${String(scenarios.length)} scenarios settled\n`);
