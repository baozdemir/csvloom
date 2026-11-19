import { Readable } from 'node:stream';
import { parseStream } from 'csvloom/stream';

function* endless() {
  for (let i = 0; ; i++) yield `${i},${i * 2}\n`;
}
const config = { delimiter: ',', newline: '\n', batchSize: 100 };

const controller = new AbortController();
const reason = new Error('enough');
const aborted = Readable.from(endless());
let rows = 0;
try {
  for await (const batch of parseStream(aborted, { ...config, signal: controller.signal })) {
    rows += batch.data.length;
    if (rows === 300) controller.abort(reason);
  }
} catch (error) {
  console.log('abort: rejected with signal.reason:', error === reason);
}
console.log('abort: rows:', rows, 'source destroyed:', aborted.destroyed);

const broken = Readable.from(endless());
rows = 0;
for await (const batch of parseStream(broken, config)) {
  rows += batch.data.length;
  if (rows === 300) break;
}
console.log('break: rows:', rows, 'source destroyed:', broken.destroyed);
