// Probe Worker for local workerd, served by `wrangler dev --local` and driven
// by test/edge/run.mjs. Every route answers JSON; nothing is asserted here.
/* global AbortController, Blob, ReadableStream, Response, TextDecoder, TextDecoderStream,
   TransformStream, URL, performance, setTimeout */
import { parseStream } from 'csvloom/stream';

const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const attempt = async (body) => {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    return { ok: false, error: `${error?.name}: ${error?.message}` };
  }
};

// FNV-1a over every field's UTF-16 units, 0x1f after a field and 0x1e after a row; run.mjs has
// the same function over bulk parse's rows.
const checksum = (hash, rows) => {
  for (const row of rows) {
    for (const field of row) {
      for (let i = 0; i < field.length; i++) hash = Math.imul(hash ^ field.charCodeAt(i), 16777619);
      hash = Math.imul(hash ^ 0x1f, 16777619);
    }
    hash = Math.imul(hash ^ 0x1e, 16777619);
  }
  return hash;
};

async function parseBody(body, countChunks) {
  const seen = { chunks: 0, bytes: 0, largestChunk: 0 };
  const source = countChunks
    ? body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            seen.chunks += 1;
            seen.bytes += chunk.byteLength;
            seen.largestChunk = Math.max(seen.largestChunk, chunk.byteLength);
            controller.enqueue(chunk);
          },
        }),
      )
    : body;
  let rows = 0;
  let errors = 0;
  let batches = 0;
  let hash = 0x811c9dc5;
  for await (const batch of parseStream(source)) {
    batches += 1;
    rows += batch.data.length;
    errors += batch.errors.length;
    hash = checksum(hash, batch.data);
  }
  return { rows, errors, checksum: hash >>> 0, batches, ...(countChunks ? seen : {}) };
}

// One byte sequence per label: windows-1252 0x80 0xE9 is U+20AC U+00E9, UTF-16LE AC 20 is U+20AC,
// Shift_JIS 82 A0 is U+3042.
const LABELS = { 'windows-1252': [0x80, 0xe9], 'utf-16le': [0xac, 0x20], shift_jis: [0x82, 0xa0] };
const codePoints = (text) =>
  [...text].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`);

async function runtime() {
  const decoders = {};
  for (const [label, bytes] of Object.entries(LABELS)) {
    decoders[label] = {
      TextDecoder: await attempt(() => {
        const decoder = new TextDecoder(label);
        return {
          encoding: decoder.encoding,
          decoded: codePoints(decoder.decode(new Uint8Array(bytes))),
        };
      }),
      TextDecoderStream: await attempt(async () => {
        const stream = new Blob([new Uint8Array(bytes)]).stream();
        const reader = stream.pipeThrough(new TextDecoderStream(label)).getReader();
        let text = '';
        for (let read = await reader.read(); !read.done; read = await reader.read())
          text += read.value;
        return { decoded: codePoints(text) };
      }),
    };
  }
  // A CPU loop of a fixed iteration count (a time-bounded loop would never end on a clock that
  // stands still), then one timer turn.
  const clock = () => ({ date: Date.now(), performance: performance.now() });
  const beforeLoop = clock();
  let x = 1;
  for (let i = 0; i < 2 ** 27; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  const afterLoop = clock();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterTimer = clock();
  const controller = new AbortController();
  controller.abort();
  const reason = controller.signal.reason;
  return {
    decoders,
    TextDecoderStream: typeof TextDecoderStream === 'function',
    // Constant strings: the probe records whether this runtime allows code generation at all.
    eval: await attempt(() => eval('1')),
    newFunction: await attempt(() => new Function('return 1')()),
    clock: {
      loopIterations: 2 ** 27,
      loopResult: x,
      beforeLoop,
      afterLoop,
      afterTimer,
      dateAdvancedDuringLoop: afterLoop.date > beforeLoop.date,
      performanceAdvancedDuringLoop: afterLoop.performance > beforeLoop.performance,
      dateAdvancedAfterTimer: afterTimer.date > beforeLoop.date,
      performanceAdvancedAfterTimer: afterTimer.performance > beforeLoop.performance,
    },
    symbolAsyncDispose: typeof Symbol.asyncDispose === 'symbol',
    iteratorAsyncDispose: typeof parseStream([])[Symbol.asyncDispose] === 'function',
    signalReason: reason === undefined ? null : `${reason?.name}: ${reason?.message}`,
    readableStreamAsyncIterator:
      typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function',
  };
}

const MiB = 1_048_576;
// 300 MiB of ArrayBuffer memory with every page written.
const allocateBuffer = () => {
  const bytes = new Uint8Array(300 * MiB).fill(1);
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4096) sum += bytes[i];
  return { bytes: bytes.length, pagesSummed: sum };
};
// 300 MiB of JS heap: 300 distinct flat one-byte strings of 1 MiB each ('x'.repeat would build
// rope strings that share their parts and take almost no memory).
const allocateHeap = () => {
  const ascii = new Uint8Array(MiB).fill(0x78);
  const strings = Array.from({ length: 300 }, () => new TextDecoder().decode(ascii));
  return { strings: strings.length, units: strings.reduce((sum, s) => sum + s.length, 0) };
};

export default {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/runtime') return json(await runtime());
    if (pathname === '/parse' && request.method === 'POST')
      return json(await attempt(() => parseBody(request.body, searchParams.has('count'))));
    if (pathname === '/alloc/buffer') return json(await attempt(allocateBuffer));
    if (pathname === '/alloc/heap') return json(await attempt(allocateHeap));
    return json({ ready: true });
  },
};
