// Node 24 and 26: Node 22 has Symbol.asyncDispose but not the `await using` syntax.
import { Readable } from 'node:stream';
import { parseStream } from 'csvloom/stream';

const source = Readable.from(['id,name\n', '1,Ada\n', '2,Grace\n']);
{
  await using batches = parseStream(source, { delimiter: ',', newline: '\n', batchSize: 1 });
  const { value } = await batches.next();
  console.log('first batch:', JSON.stringify(value.data));
}
console.log('source destroyed at the end of the block:', source.destroyed);
