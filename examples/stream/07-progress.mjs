import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseStream } from 'csvloom/stream';

async function* counted(source, onBytes) {
  for await (const chunk of source) {
    onBytes(chunk.byteLength);
    yield chunk;
  }
}

const file = new URL('./data.csv', import.meta.url);
const { size } = await stat(file);
let read = 0;
let rows = 0;
const source = counted(createReadStream(file), (bytes) => (read += bytes));
for await (const batch of parseStream(source, {
  header: true,
  skipEmptyLines: true,
  batchSize: 2,
})) {
  rows += batch.data.length;
  // A progress bar would show read / size here; how often that changes depends on the chunks.
}
console.log(`${rows} rows, ${read} of ${size} bytes (${(100 * read) / size}%)`);
