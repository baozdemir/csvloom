// The browser probes. probe.html runs every probe in order and writes { userAgent, fileFrom, pass,
// results: [{ name, pass, observed | error }] } as JSON into #out, then sets #out's data-done;
// browser.pw.ts (Playwright) and safari.mjs (safaridriver) read it from there. A probe throws when
// a check fails and returns the values it observed.
import { parse } from 'csvloom';
import { parseStream } from 'csvloom/stream';
import { makeCsv } from './data.js';

const MiB = 2 ** 20;
const SIZE = MiB; // browser.pw.ts gives the File input the server's /data.csv?size=1048576
const BOM = String.fromCharCode(0xfeff);
const encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function collect(source, config) {
  const data = [];
  const errors = [];
  let meta;
  for await (const batch of parseStream(source, config)) {
    for (const row of batch.data) data.push(row);
    for (const error of batch.errors) errors.push(error);
    meta = batch.meta;
  }
  return { data, errors, meta };
}

// Rules (a) and (c) of test/stream-split.ts: the stream's rows and errors equal bulk parse of the text.
async function equalsBulk(source, text) {
  const got = await collect(source);
  const bulk = parse(text);
  check(got.data.length > 0, 'no rows');
  check(same(got.data, bulk.data), 'rows differ from bulk parse');
  check(same(got.errors, bulk.errors), 'errors differ from bulk parse');
  return { rows: got.data.length, errors: got.errors.length, cursor: got.meta.cursor };
}

// A ReadableStream whose read stays pending; `pulled` resolves once a read is waiting.
function pendingStream() {
  const cancels = [];
  let pulledResolve;
  const pulled = new Promise((resolve) => (pulledResolve = resolve));
  const stream = new ReadableStream(
    {
      pull() {
        pulledResolve();
        return new Promise(() => {});
      },
      cancel(reason) {
        cancels.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled, cancels };
}

async function chunkSizes(stream) {
  const reader = stream.getReader();
  const counts = {};
  let chunks = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    total += value.byteLength;
    counts[value.byteLength] = (counts[value.byteLength] ?? 0) + 1;
  }
  return { chunks, total, counts };
}

const probes = {
  // First, so that every later probe is known to run under the page's CSP.
  'CSP: code generation is blocked'() {
    let error;
    try {
      Function('return 1');
    } catch (thrown) {
      error = thrown;
    }
    check(error !== undefined, 'Function() ran: no CSP without unsafe-eval in effect');
    return { functionConstructorThrew: `${error.name}: ${error.message}` };
  },

  async 'reader path: Blob.stream()'({ text, bytes }) {
    const stream = new Blob([bytes]).stream();
    const observed = await equalsBulk(stream, text);
    check(!stream.locked, 'stream still locked after the end');
    return { ...observed, lockedAfterEnd: stream.locked };
  },

  async 'reader path: File.stream()'({ text, bytes, file }) {
    check(file.size === bytes.length, `File has ${file.size} bytes, expected ${bytes.length}`);
    const stream = file.stream();
    const observed = await equalsBulk(stream, text);
    check(!stream.locked, 'stream still locked after the end');
    return { fileSize: file.size, ...observed, lockedAfterEnd: stream.locked };
  },

  async 'reader path: fetch body'({ text }) {
    const response = await fetch(`/data.csv?size=${SIZE}`);
    const observed = await equalsBulk(response.body, text);
    check(!response.body.locked, 'body still locked after the end');
    return { ...observed, lockedAfterEnd: response.body.locked };
  },

  async 'reader path: no Symbol.asyncIterator'({ text, bytes }) {
    const proto = ReadableStream.prototype;
    const engineHasAsyncIterator = typeof proto[Symbol.asyncIterator] === 'function';
    const saved = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator);
    check(Reflect.deleteProperty(proto, Symbol.asyncIterator), 'Symbol.asyncIterator not deleted');
    try {
      const stream = new Blob([bytes]).stream();
      check(!(Symbol.asyncIterator in stream), 'Symbol.asyncIterator still reachable');
      const observed = await equalsBulk(stream, text);
      check(!stream.locked, 'stream still locked after the end');
      return { engineHasAsyncIterator, ...observed, lockedAfterEnd: stream.locked };
    } finally {
      if (saved) Object.defineProperty(proto, Symbol.asyncIterator, saved);
    }
  },

  async 'cancel order: break after the first batch'() {
    const calls = [];
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue('a\nb\n');
      },
      cancel(reason) {
        calls.push(`source.cancel(${String(reason)})`);
      },
    });
    const getReader = stream.getReader.bind(stream);
    stream.getReader = () => {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      const releaseLock = reader.releaseLock.bind(reader);
      reader.cancel = (reason) => {
        calls.push('reader.cancel');
        return cancel(reason);
      };
      reader.releaseLock = () => {
        calls.push('reader.releaseLock');
        releaseLock();
      };
      return reader;
    };
    const config = { batchSize: 1, delimiter: ',', newline: '\n' };
    let batches = 0;
    for await (const batch of parseStream(stream, config)) {
      check(same(batch.data, [['a']]), 'unexpected first batch');
      batches++;
      break;
    }
    const expected = ['reader.cancel', 'source.cancel(undefined)', 'reader.releaseLock'];
    check(same(calls, expected), `calls ${JSON.stringify(calls)}`);
    check(!stream.locked, 'stream still locked');
    return { batches, calls, lockedAfter: stream.locked };
  },

  async 'cancel order: abort with a read pending'() {
    const { stream, pulled, cancels } = pendingStream();
    const controller = new AbortController();
    const it = parseStream(stream, { signal: controller.signal });
    const pending = it.next();
    await pulled;
    controller.abort();
    const error = await rejection(pending);
    const reason = controller.signal.reason;
    check(error === reason, 'next() did not reject with signal.reason');
    check(cancels.length === 1 && cancels[0] === reason, 'cancel(reason) not called once');
    const after = await it.next();
    check(after.done === true && after.value === undefined, 'next() after the abort is not done');
    check(!stream.locked, 'stream still locked');
    return {
      rejectedWithSignalReason: error === reason,
      reason: `${reason.name}: ${reason.message}`,
      cancelCalls: cancels.length,
      lockedAfter: stream.locked,
    };
  },

  async 'other realm: iframe Uint8Array and AbortSignal'() {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const realm = frame.contentWindow;
      const chunk = new realm.Uint8Array(encoder.encode('a,b\n1,2'));
      const controller = new realm.AbortController();
      check(!(chunk instanceof Uint8Array), 'the chunk is not from another realm');
      check(!(controller.signal instanceof AbortSignal), 'the signal is not from another realm');
      const got = await collect([chunk], { signal: controller.signal });
      check(
        same(got.data, [
          ['a', 'b'],
          ['1', '2'],
        ]),
        'unexpected rows',
      );

      const { stream, pulled, cancels } = pendingStream();
      const aborting = new realm.AbortController();
      const it = parseStream(stream, { signal: aborting.signal });
      const pending = it.next();
      await pulled;
      aborting.abort();
      const error = await rejection(pending);
      check(error === aborting.signal.reason, "next() did not reject with the iframe's reason");
      check(cancels.length === 1 && cancels[0] === error, 'cancel(reason) not called once');
      return {
        rows: got.data,
        rejectedWithIframeReason: error === aborting.signal.reason,
        reasonIsFromIframeRealm: error instanceof realm.DOMException,
        reason: `${error.name}: ${error.message}`,
      };
    } finally {
      frame.remove();
    }
  },

  async 'decoding: invalid UTF-8 rejects with a TypeError'() {
    const error = await rejection(collect([Uint8Array.of(0x61, 0x2c, 0xff, 0x0a)]));
    check(error instanceof TypeError, `${error.name} is not a TypeError of this realm`);
    return { instanceofTypeError: true, error: `${error.name}: ${error.message}` };
  },

  async 'decoding: a BOM split over two chunks is removed once'() {
    // EF BB | BF 61 2C C3 | A9 0A 31 2C 32.
    const e2 = await collect([
      Uint8Array.of(0xef, 0xbb),
      Uint8Array.of(0xbf, 0x61, 0x2c, 0xc3),
      Uint8Array.of(0xa9, 0x0a, 0x31, 0x2c, 0x32),
    ]);
    check(
      same(e2.data, [
        ['a', 'é'],
        ['1', '2'],
      ]),
      'split BOM rows',
    );
    check(e2.meta.cursor === 7, 'split BOM cursor');
    // Two BOMs, the first split: only the first is removed, as bulk parse does.
    const twice = await collect([
      Uint8Array.of(0xef, 0xbb),
      Uint8Array.of(0xbf, 0xef, 0xbb, 0xbf, 0x61),
    ]);
    check(same(twice.data, [[`${BOM}a`]]), 'second BOM not kept');
    check(same(twice.data, parse(`${BOM}${BOM}a`).data), 'differs from bulk parse');
    const units = (field) => [...field].map((c) => c.codePointAt(0).toString(16));
    return { e2: e2.data, e2Cursor: e2.meta.cursor, twoBomsFirstField: units(twice.data[0][0]) };
  },

  async 'chunk sizes (recorded only)'() {
    return {
      'Blob.stream() 4 MiB': await chunkSizes(new Blob([new Uint8Array(4 * MiB)]).stream()),
      'Blob.stream() 64 MiB': await chunkSizes(new Blob([new Uint8Array(64 * MiB)]).stream()),
      'fetch body 4 MiB': await chunkSizes((await fetch(`/data.csv?size=${4 * MiB}`)).body),
    };
  },

  async 'dispose and abort reason'() {
    const asyncDisposeSymbol = typeof Symbol.asyncDispose === 'symbol';
    const it = parseStream(['a\n']);
    const symbols = Object.getOwnPropertySymbols(it).map(String);
    const disposeIsFunction = asyncDisposeSymbol && typeof it[Symbol.asyncDispose] === 'function';
    check(disposeIsFunction === asyncDisposeSymbol, 'Symbol.asyncDispose method mismatch');
    if (disposeIsFunction) await it[Symbol.asyncDispose]();
    else await it.return();
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason;
    return {
      asyncDisposeSymbol,
      iteratorAsyncDisposeIsFunction: disposeIsFunction,
      iteratorOwnSymbols: symbols,
      signalReasonSetAfterAbort: reason !== undefined,
      reason: reason === undefined ? 'undefined' : `${reason.name}: ${reason.message}`,
    };
  },

  // For the documentation's other-encodings recipe; parseStream itself decodes UTF-8 only.
  async 'other encodings (recorded only)'() {
    const samples = {
      'windows-1252': [0x80, 0xe9],
      'utf-16le': [0xac, 0x20],
      shift_jis: [0x82, 0xa0],
    };
    const observed = { typeofTextDecoderStream: typeof TextDecoderStream };
    for (const [label, bytes] of Object.entries(samples)) {
      const entry = { bytes: bytes.map((byte) => byte.toString(16)) };
      try {
        entry.textDecoder = `constructs: encoding ${new TextDecoder(label).encoding}`;
      } catch (error) {
        entry.textDecoder = `throws: ${error.name}: ${error.message}`;
      }
      if (typeof TextDecoderStream === 'function') {
        try {
          const decoder = new TextDecoderStream(label);
          const reader = new Blob([Uint8Array.from(bytes)])
            .stream()
            .pipeThrough(decoder)
            .getReader();
          let text = '';
          for (let read = await reader.read(); !read.done; read = await reader.read()) {
            text += read.value;
          }
          entry.streamCodePoints = [...text].map((c) => `U+${c.codePointAt(0).toString(16)}`);
        } catch (error) {
          entry.stream = `throws: ${error.name}: ${error.message}`;
        }
      }
      observed[label] = entry;
    }
    return observed;
  },
};

const input = document.querySelector('#file');
const fromInput = new URLSearchParams(location.search).has('input');
const picked = new Promise((resolve) => {
  input.addEventListener('change', () => resolve(input.files[0]), { once: true });
});
const { text } = makeCsv(SIZE);
const bytes = encoder.encode(text);
const file = fromInput ? await picked : new File([bytes], 'probe.csv', { type: 'text/csv' });

const results = [];
for (const [name, probe] of Object.entries(probes)) {
  try {
    results.push({ name, pass: true, observed: await probe({ text, bytes, file }) });
  } catch (error) {
    results.push({ name, pass: false, error: `${error?.name}: ${error?.message}` });
  }
}
const out = document.querySelector('#out');
out.textContent = JSON.stringify({
  userAgent: navigator.userAgent,
  fileFrom: fromInput ? 'input' : 'constructed',
  pass: results.every((result) => result.pass),
  results,
});
out.dataset.done = '';
