import { setImmediate } from 'node:timers/promises';
import { parseStream } from 'csvloom/stream';

/**
 * Gives the event loop a turn once `budget` ms have passed since the last turn, or after `every`
 * batches, for a runtime whose clock does not advance while code runs.
 */
async function* responsive(batches, { budget = 10, every = Infinity } = {}) {
  let since = performance.now();
  let count = 0;
  for await (const batch of batches) {
    yield batch;
    if (++count % every === 0 || performance.now() - since >= budget) {
      await setImmediate();
      since = performance.now();
    }
  }
}

const text = `id,value\n${Array.from({ length: 200_000 }, (_, i) => `${i},${i % 7}\n`).join('')}`;
for (const options of [{ budget: 10 }, { every: 16 }]) {
  let rows = 0;
  for await (const batch of responsive(
    parseStream(text, { header: true, skipEmptyLines: true }),
    options,
  )) {
    rows += batch.data.length;
  }
  console.log(JSON.stringify(options), 'rows:', rows);
}
