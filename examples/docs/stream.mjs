import { parseStream } from 'csvloom/stream';

// A source is text or UTF-8 bytes in pieces: a fetch body, file.stream(), a Node Readable,
// an array or an async generator of chunks.
const { body } = new Response('id,name\n1,Ada\n2,Grace\n3,Linus\n');

const options = { header: true, skipEmptyLines: true, batchSize: 2 };
for await (const batch of parseStream(body, options)) {
  console.log(JSON.stringify(batch.data), batch.meta.rowOffset, batch.meta.done);
}
