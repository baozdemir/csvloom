// Run by test/schema.test.ts in a fresh node with default flags (--unhandled-rejections=throw).
// parseDetailed refuses a validator's Promise with a TypeError; the Promise then rejects, at once
// or later. Without a handler attached before the throw, that rejection ends this process with a
// non-zero code.
import process from 'node:process';
import { setImmediate as macrotask, setTimeout as sleep } from 'node:timers/promises';
import { parseDetailed } from '../../src/detailed.ts';

const schemaOf = (validate) => ({ '~standard': { version: 1, vendor: 'child', validate } });
const schemas = [
  schemaOf(() => Promise.reject(new Error('rejected at once'))),
  schemaOf(async () => {
    await sleep(10);
    throw new Error('rejected later');
  }),
];

for (const schema of schemas) {
  try {
    parseDetailed('age\nx\ny', { header: true, delimiter: ',', schema });
    throw new Error('parseDetailed returned');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}
await macrotask();
await macrotask();
await sleep(50);
process.stdout.write(`${schemas.length} parses refused and settled\n`);
