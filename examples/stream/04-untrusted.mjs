import { parseStream } from 'csvloom/stream';

async function* hostile() {
  try {
    yield 'id,note\n1,"';
    for (;;) yield 'x'.repeat(65_536);
  } finally {
    console.log('source closed');
  }
}

const config = { maxRecordLength: 1_048_576, delimiter: ',', newline: '\n' };
let rows = 0;
try {
  for await (const batch of parseStream(hostile(), config)) rows += batch.data.length;
} catch (error) {
  console.log(`${error.name}: ${error.message}`);
}
console.log('rows delivered:', rows);
