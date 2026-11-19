import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parseStream } from 'csvloom/stream';

const file = new URL('./data.csv', import.meta.url);
const parse = (source, { signal }) =>
  parseStream(source, { header: true, skipEmptyLines: true, signal });

let rows = 0;
await pipeline(createReadStream(file), parse, async (batches) => {
  for await (const batch of batches) rows += batch.data.length;
});
console.log('rows:', rows);

const source = createReadStream(file);
try {
  await pipeline(source, parse, async (batches) => {
    for await (const batch of batches)
      throw new Error(`sink failed at row ${batch.meta.rowOffset}`);
  });
} catch (error) {
  console.log(`${error.message}; source destroyed: ${source.destroyed}`);
}
