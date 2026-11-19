import { createReadStream } from 'node:fs';
import { parseStream } from 'csvloom/stream';

const source = createReadStream(new URL('./data.csv', import.meta.url));
const batches = await Array.fromAsync(parseStream(source, { header: true, skipEmptyLines: true }));
const rows = batches.flatMap((batch) => batch.data);
console.log(JSON.stringify(rows, null, 1));
