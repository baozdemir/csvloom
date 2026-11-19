// Run by test/stream.test.ts in a fresh node, on Node 24 and 26 (Node 22 has Symbol.asyncDispose
// but no `await using` syntax). The block is left after one batch of three: the source must be
// closed at the block's exit, by [Symbol.asyncDispose].
import process from 'node:process';
import { parseStream } from '../../src/stream.ts';

let closed = 0;
let closedInside;
async function* chunks() {
  try {
    yield 'a,b\n';
    yield '1,2\n';
    yield '3,4\n';
  } finally {
    closed++;
  }
}

const rows = [];
{
  await using batches = parseStream(chunks(), {
    delimiter: ',',
    newline: '\n',
    batchSize: 1,
  });
  const first = await batches.next();
  rows.push(...first.value.data);
  closedInside = closed;
}

const seen = JSON.stringify({ rows, closedInside, closed });
if (seen !== '{"rows":[["a","b"]],"closedInside":0,"closed":1}') {
  process.stderr.write(`unexpected: ${seen}\n`);
  process.exit(1);
}
process.stdout.write('closed once at block exit\n');
