// Run by test/schema.test.ts in a fresh node with default flags (--unhandled-rejections=throw).
// validateRowSync refuses a validator's Promise with a TypeError; the Promise then rejects, at
// once or later. Without a handler attached before the throw, that rejection ends this process
// with a non-zero code.
import process from 'node:process';
import { setImmediate as macrotask, setTimeout as sleep } from 'node:timers/promises';
import { validateRowSync } from '../../src/schema.ts';

const schemaOf = (validate) => ({ '~standard': { version: 1, vendor: 'child', validate } });
const scenarios = [
  schemaOf(() => Promise.reject(new Error('rejected at once'))),
  schemaOf(async () => {
    await sleep(10);
    throw new Error('rejected later');
  }),
];

for (const schema of scenarios) {
  try {
    validateRowSync(schema, { age: 'x' }, 0);
    throw new Error('validateRowSync returned');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}
await macrotask();
await macrotask();
await sleep(50);
process.stdout.write(`${scenarios.length} scenarios refused and settled\n`);
