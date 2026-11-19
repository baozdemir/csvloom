import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseStream } from 'csvloom/stream';

const file = new URL('./data.csv', import.meta.url);
const bytes = await readFile(file);
const rows = async (source) => {
  const all = [];
  for await (const batch of parseStream(source, { header: true, skipEmptyLines: true }))
    all.push(...batch.data);
  return all;
};

console.log('Node file:', (await rows(createReadStream(file))).length);
console.log('browser file:', (await rows(new File([bytes], 'data.csv').stream())).length);
// A data: URL keeps the example offline; any other URL is read the same way.
const response = await fetch(`data:text/csv;base64,${bytes.toString('base64')}`);
console.log('URL:', (await rows(response.body)).length);
console.log('bytes in an array:', (await rows([bytes])).length);

for (const source of [new Response(null, { status: 204 }).body, bytes]) {
  try {
    parseStream(source);
  } catch (error) {
    console.log(`${error.name}: ${error.message}`);
  }
}

const [last, ...more] = await Array.fromAsync(parseStream(new Response('').body));
const codes = last.errors.map((error) => error.code);
console.log('empty body:', JSON.stringify({ batches: 1 + more.length, data: last.data, codes }));
