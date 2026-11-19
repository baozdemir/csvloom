# Streaming: `csvloom/stream`

The differences from bulk `parse` (S1-S7) and the support matrix are in `docs/compatibility.md`, "`/stream`". The five feature keys (`detect`, `positions`, `repair`, `schema`, `sepLine`) are in "Features" below; their differences from bulk `parseDetailed` are S8-S11 in the same section of `docs/compatibility.md`.

Every recipe with a file in `examples/stream/` is run by `npm run test:package` (check 15) on Node 22, 24 and 26 from the packed package (`03-await-using.mjs` on 24 and 26 only: Node 22 has no `await using` syntax), and its output is compared with the `.txt` file beside it. Measurements below name the Node versions they were seen on. The published speed and memory numbers of `parseStream` are in "Speed" at the end.

## What `parseStream` is and is not

```js
import { parseStream } from 'csvloom/stream';

for await (const batch of parseStream(source, { header: true })) {
  console.log(batch.data.length, batch.errors, batch.meta.cursor);
}
```

`parseStream(source, config)` parses one input that arrives in pieces and returns an async iterator of batches of rows. For a source that ends normally the batches, concatenated, give what `parse` gives for the whole text (rows, errors and the last `meta`), wherever the chunks split, except for the documented differences S1-S7. It reads from the source only inside `next()`, and only what the batch being filled needs (the first call also reads the detection window when the delimiter or the newline is detected); bytes are decoded as UTF-8 by one `TextDecoder` per stream, at most 1,048,576 bytes at a time and only when a batch needs the text; the work is linear in the record length, however many chunks a record spans.

- **Sources:** a string; an iterable or async iterable of string chunks or of `Uint8Array` chunks (a Node `Buffer` is one); a Node `Readable`; a Web `ReadableStream` (`Response.body`, `Blob.stream()`, `File.stream()`), read with `getReader()`, so a stream without `[Symbol.asyncIterator]` works too. The first chunk fixes the kind; a chunk of the other kind rejects `next()`.
- **Config:** every option of the main entry's `parse`, with the same meaning, plus `batchSize` (the most rows per batch, default 1024; batches of long rows hold fewer, "The batch" below), `maxRecordLength` (UTF-16 units, no default) and `signal` (an `AbortSignal`), and the five feature keys of `parseDetailed` ("Features" below). A wrong config or source kind throws at the call; every other error rejects a `next()`.
- **Not Papa's streaming API.** There is no `step`, `chunk` or `complete`, and no adapter for them; those options and the other excluded ones (`worker`, `download`, `chunkSize`, `encoding`, …) throw `UnsupportedFeatureError` when active, as in `parse`.
- **No worker mode.** Recipe 9 runs `parseStream` in a module worker that the page owns.
- **No network or file client.** It takes no URL and no file name: the caller calls `fetch` or opens the file (recipe 1).
- **UTF-8 only** for bytes (recipe 5), and no `/papa` form.
- **No timer and no yield.** It never gives the event loop a turn by itself (recipe 8).

## The batch

```ts
type ParseBatch<Row, E = ParseError> = {
  data: Row[];
  errors: Located<E>[]; // E with line, column, offset and snippet under positions: true
  meta: StreamMeta;
  repairs?: Repair[]; // with repair only
  repairCounts?: Record<RepairRule, number>; // with repair only
};

interface StreamMeta {
  delimiter: string;
  linebreak: Newline;
  fields?: string[]; // with header: true only
  renamedHeaders: Record<string, string> | null;
  rowOffset: number; // rows in the batches before this one
  cursor: number; // UTF-16 units
  truncated: boolean;
  done: boolean;
  detected?: Detection; // with detect: true only
  sepLine?: true; // only when sepLine or detect read a "sep=" line
}
```

- Every batch but the last holds `batchSize` rows, or fewer, at least one, when its text reaches 1,048,576 UTF-16 units first. A batch's text is what is read for it from the end of the batch before, less the line break that ends each record: its rows' records, and also the header record, records `skipEmptyLines` removes and comment lines, a comment line with its line break. The batch ends with the row of the record that brings its text to the bound, or with the next row when that record gives none. The bound is an internal constant, not an option, and keeps a batch's memory bounded whatever a row's size: 1,024 rows of up to 1,024 units each still fill a batch when nothing else is read with them, a batch of rows of 300,000 units holds four, and a record longer than the bound is a batch of its own or ends the batch it comes in (`test/batches.test.ts`, "BatchBuilder, the bound on a batch’s text"). The last batch has `meta.done: true` and 0 to `batchSize` rows, and it always comes: a header-only input still yields its `fields`. With `schema` a batch is built from `batchSize` rows, or fewer at the bound, and holds the valid ones, so it can hold fewer, or none (S10, below).
- `data` and `errors` are this batch's. `delimiter`, `linebreak`, `fields` and `renamedHeaders` are bulk's and the same in every batch. `FieldMismatch.row` is a global row index, in `[rowOffset, rowOffset + data.length)` (with `schema`, where `data` holds only the valid rows: in `[rowOffset, rowOffset + batchSize)`); `Quotes.row` counts records as bulk does; `Quotes.index` and `cursor` are UTF-16 offsets in the whole text after the BOM and the `skipFirstNLines` lines.
- `cursor` is the end of the line break of the record that filled the batch, and bulk's value in the last batch. `truncated` is true only in a last batch that `preview` ended. There is no `aborted`: an abort rejects (recipe 3).
- As with `parse`, a final line break gives one more record, `['']` (with `header`, a row such as `{ id: '' }` and a `TooFewFields` error). `skipEmptyLines: true` removes it; the examples use it.

Example: `parseStream(['a,1\nb,2\nc,3'], { batchSize: 2 })` gives `{ data: [['a', '1'], ['b', '2']], meta: { rowOffset: 0, cursor: 8, done: false, … } }`, then `{ data: [['c', '3']], meta: { rowOffset: 2, cursor: 11, done: true, … } }`.

The iterator has `next()`, `return()` and, where the engine defines `Symbol.asyncDispose`, `[Symbol.asyncDispose]()`. It has no `throw()` (recipe 3).

## Features

`parseStream` takes the five feature keys of `parseDetailed`: `detect`, `positions`, `repair`, `schema` and `sepLine`. `docs/features.md` says what each one does, with its limits; this section says only what is particular to a stream. A wrong value throws at the call with the message `parseDetailed` gives. A key that is `false`, `undefined` or an empty rule list sets nothing. The `unparse` options of that guide (`bom`, `sepLine`, `escapeFormulae` and the presets) have no place here: there is no streaming `unparse`.

- **Equal to bulk.** For a source that ends normally the batches, concatenated, give what `parseDetailed` gives for the whole text with the same config: the rows, the errors with their positions, `meta.detected`, `meta.sepLine`, the `repairs` and the summed `repairCounts`. It holds wherever the chunks split, for string and for byte chunks, except for S1-S7 and for S8-S11 below.
- **Off means off.** Without one of the five keys a stream calls none of the feature modules.
- **One running example.** `examples/features/schema-stream.mjs` (an async validator with `positions`), shown with its output in `docs/features.md`, "Row validation in a stream". The other keys have no stream example of their own; their behavior is pinned by the tests named here.
- **Not measured: what a feature costs in a stream.** No timing run was made with a feature key; the published S1 lane ("Speed" below) runs with none. With `repair` the stream scans one record per call (`src/batches.ts`), so it is expected to be the slowest of the five; that is an expectation, not a measurement.

Each claim of this section names what it rests on: a test of `test/stream-features.test.ts` (or of `test/stream-features-off.test.ts` where that file is named), quoted by its title so that it can be found, or, where there is no such test, a probe or the source. The claims above: "parseStream with features equals parseDetailed at every split" (each key alone and all five together, the seeded fuzz inputs and 1,200 inputs shaped for the features, at every split) and, in `test/stream-features-off.test.ts`, "off means off: a stream without a feature key never reaches the feature modules"; the config: "%s: %j throws the main entry’s message at the call" and "a key that is false, undefined or an empty rule list sets nothing: the batches are those without the key".

### `sepLine`

A first line that is `sep=` and one delimiter unit is read before the first batch, skipped, and names the delimiter, as in `parseDetailed`. `meta.sepLine` is then `true` in every batch; without such a line the key is absent. `meta.cursor` and `Quotes.index` count from the text after the line, as they count from the end of skipped lines. Tests: "meta.detected and meta.sepLine are in every batch, the same in each", `meta.cursor and Quotes.index stay relative to the text scanned, after the "sep=" line`.

### `detect`

Detection runs once, before the first batch, on the same sample `detect(text)` reads: the first 65,536 UTF-16 units after a BOM and a `sep=` line, cut after their last line break. The sample is a function of the text, so where the chunks split cannot change what is detected.

- The first `next()` reads until the stream holds that sample, or the whole text when it is shorter; no batch comes before ("the first batch comes only when the sample is held: no batch from 65,536 units of a longer source").
- `meta.detected` is the `Detection` found, the same object in every batch, and equals `parseDetailed`'s: it is `detect(text)` unless `skipFirstNLines` is given, and then the detection of the text after the skip, with no preamble. For a text longer than the sample this was checked at more than 300 split points ("detect: bulk and stream agree on meta.detected for inputs longer than the sample").
- A given `delimiter`, `newline`, `quoteChar`, `escapeChar` or `skipFirstNLines` wins, as in `parseDetailed` ("explicit options win over detect, as in parseDetailed"). `UndetectableDelimiter` is never reported under `detect` ("UndetectableDelimiter is never reported under detect, and is without it"). `detect: true` with `delimitersToGuess: []` throws at the call ("detect with no delimiter candidate throws as parseDetailed does").
- `header` is never applied by detection, as in `parseDetailed` (the equality test above covers it); give it yourself.

### `positions`

Every error that has a place gains `line`, `column`, `offset` and `snippet`. They are absolute in the source's text as given, whatever the chunks: a BOM, skipped lines, a `sep=` line and a detected preamble count, and a `\r\n` that two chunks split is one line. For byte chunks the units are still UTF-16 units of the decoded text, not bytes. `index` and `meta.cursor` keep their old meaning.

- "an error in the third 64 KiB chunk has the offset and the line it has in bulk"; `a "\\r\\n" split between two chunks is one line`; "the offset counts %s: at every split" (a BOM, skipped lines, a `sep=` line, a detected preamble).
- The snippet shows the whole line although earlier batches were delivered, because a batch starts at a record start ("with batchSize 1 the line of an error is whole in the snippet, though earlier batches were delivered: a batch starts at a record start").
- Without `repair`, a batch with `positions` closes where it closes without it: the same `cursor`, `rowOffset` and error grouping ("without repair a batch with a feature closes where it closes without one: the same cursor, rowOffset and error grouping").

### `repair`

The same five rules, in the same order. Each batch has `repairs` (the changes to its own records, always an array) and `repairCounts` (every change to them, per rule), beside `data`, `errors` and `meta`.

- **S8, the log.** `repairs` are grouped per batch, as errors are (S4). The 10,000-entry cap is per stream, as it is per parse in bulk: the concatenated `repairs` equal `parseDetailed`'s `repairs` and the summed `repairCounts` equal its counts. After the cap a batch has `repairs: []` and its counts still count ("S8, the cap: 10,050 short rows in 1,024-row batches give the first 10,000 repairs, then repairs: [] with counts"; "5: every batch counts the changes to its own rows").
- **S8, reading ahead.** The rules of the end of the input need the last records, so the stream holds the last records it has read back until more text or the end of the source comes. A batch can therefore need one read more than without `repair`: with chunks `a,b\n`, `1,2\n`, `3,4\n`, … and `batchSize: 1`, the first batch came after the second chunk was read, where without `repair` it came after the first (seen in a probe on Linux x64). A comment line is enough to release them ("2: a comment line that completes the records held back gives the batch at once: no further read").
- **Batch size.** A record that `mixed-newline` splits counts as the rows it became, so with `repair` alone every batch but the last still holds `batchSize` rows, or fewer at the bound on its text ("repair alone: a record that mixed-newline splits counts as the rows it became; every batch but the last has batchSize rows"). The rows of a split record share its text: each counts the units from the end of the row before to its own end, so the record's text counts once and the bound can close a batch inside it ("mixed-newline: the rows of a split record share its text, so the bound can close a batch inside it"). Each batch has the keys `data`, `errors`, `meta`, `repairs`, `repairCounts` ("repair: %j is accepted: the keys of every batch are data, errors, meta, repairs, repairCounts"). Under `repair` a batch's `cursor` is the end of the record that filled it, or of the piece of a split record that did ("3: under repair a batch’s cursor is the end of the record that filled it, comment lines after it not counted").
- **S11, `unclosed-quote` and `maxRecordLength`.** That rule needs the end of the source. With `maxRecordLength` set, a quoted field that never closes passes the limit first, and `next()` rejects with `RangeError: Record at offset <o> is longer than maxRecordLength (<M>)`: nothing is repaired, where bulk repairs. Without `maxRecordLength` the stream repairs at the end as bulk does ("S11: unclosed-quote and maxRecordLength").
- **`maxRecordLength` before a header.** With `repair`, `header: true` and `skipEmptyLines`, the text held while no header record has come counts against `maxRecordLength`: empty lines longer than the limit reject with the same `RangeError`. Without the limit they are held, as any record is ("repair with header and skipEmptyLines while no header record has come").
- **`mixed-newline`** reads the same first 1,048,576 units as bulk to decide, also with a small `maxRecordLength` ("mixed-newline with a bounded window").
- **`Quotes.row`** is what `parseDetailed` gives ("Quotes.row: an InvalidQuotes error has the same row under repair and schema as without them"). After a record that `mixed-newline` split it counts the repaired records, as `parseDetailed` does, pinned by the test that follows the one just named.
- **With `preview`** the rows are cut as `parseDetailed` cuts them, and the source is not read past the records `preview` counts ("repair with preview: the rows are cut as parseDetailed cuts them"; "repair with preview: the source is not read past the records preview counts, and is closed").

### `schema`

A Standard Schema v1 object, as in `parseDetailed`, and here its `validate` may return a promise.

- **S9, async validators.** `parseDetailed` throws its `TypeError` when a validator returns a promise; the stream awaits it ("S9: the same async schema throws in parseDetailed and works in parseStream"). The rows of a batch are validated one at a time, in input order, before the batch is delivered ("rows come out in input order whatever the validator waits for; one row is validated at a time"), and nothing is read from the source while a validation is pending ("no read happens while a validation is pending"). A batch whose validators all answer synchronously adds no `await` ("a batch whose validators are all synchronous adds no await: it resolves in as many jobs as without a schema").
- **S10, batch size and row numbers.** A batch is closed at `batchSize` rows as built, or at the bound on its text ("The batch"), and then validated ("schema (S10): a batch closes at the bound on its rows as built and is then validated"). Its `data` holds the valid ones: at most `batchSize`, possibly none, and it is delivered even when empty, since it carries the errors. `meta.rowOffset` counts the rows as built in earlier batches, valid or not, and `row` in `FieldMismatch` and `Schema` errors counts the same way, so `row - meta.rowOffset` is in `[0, batchSize)`. The header record, a comment line and a record `skipEmptyLines` removes are not rows ("with a schema a batch is built from batchSize rows and holds the valid ones; the header, a comment line and a removed empty record count for nothing"; "a batch whose rows are all invalid is delivered with data: []").
- **A validator that throws or rejects** ends the stream as any callback error does (S6): the `next()` that would deliver its batch rejects with the same object and the source is closed once ("%s: a rejection on row 3 rejects the next() that would deliver its batch, with the same object, and the source is closed once"; "a validator that throws, and one that returns neither value nor issues, reject next() the same way").
- **Abort and `return()` during a validation** end the iteration at once: `next()` rejects with `signal.reason`, or resolves done after `return()`; no later row is validated, the validator's late result is ignored, and its late rejection is not unhandled ("controller.abort(reason) during a pending validation rejects next() at once with the reason; the late result is ignored"; "4: an abort or return() made inside a validator ends the iteration at once"; "in a child process with default flags, a validator that rejects after the abort: exit code 0 and an empty stderr").
- **With `positions`** a `Schema` error has the place of its record ("with positions a Schema error has the place of its record, as in bulk, at every split").

## Recipes

### 1. Files and URLs (`examples/stream/01-sources.mjs`)

```js
parseStream(createReadStream(path)); // a file in Node
parseStream(file.stream()); // a File or Blob in a browser
parseStream((await fetch(url)).body); // a URL
```

These three lines are the migration for `Papa.parse(file, …)` and `Papa.parse(url, { download: true, … })`.

- `response.body` is `null` for a response that has no body (a 204 or 304 status, a `HEAD` request, `new Response(null)`), and `parseStream(null)` throws at the call: `TypeError: Expected a stream source (a string, a ReadableStream, or an iterable or async iterable of string or Uint8Array chunks), got null`. Check `response.ok` and `response.body` first; in TypeScript, passing `response.body` unchecked is a type error (check 9 of `npm run test:package`).
- An empty body (`new Response('')`) is a stream and parses to one last batch with `data: []`. With the delimiter left to detection that batch carries bulk's `UndetectableDelimiter` error, as `parse('')` does; with `delimiter` and `newline` given its `errors` is empty (seen on Node 22.23.4, 24.22.1 and 26.12.1).
- A bare `Uint8Array` or `Buffer` is not a source: it is iterable, but its items are numbers, so it throws at the call (`… got Uint8Array`). Pass `[bytes]`.

In a browser, `file` comes from an `<input type="file">`. The browser probes (`test/browser/page/probes.js`) parse `file.stream()` of such a `File`, `new Blob([bytes]).stream()` and a `fetch` body to bulk's rows in Playwright's Chromium, Firefox and WebKit builds (listed in `docs/compatibility.md`, "Support matrix").

### 2. Everything at once (`examples/stream/02-all-at-once.mjs`)

```js
const rows = (await Array.fromAsync(parseStream(source))).flatMap((batch) => batch.data);
```

This keeps every row, so use it only when the result fits in memory. With byte input it still never holds the whole text as one string, as `parse` must: Node 22-26 cannot make a string longer than 536,870,888 UTF-16 units, and a 600 MiB `Uint8Array` given as one chunk was parsed to the end (16,300,801 rows) on Node 22, 24 and 26, where `new TextDecoder().decode` of the same bytes threw `ERR_STRING_TOO_LONG`. `Array.fromAsync` exists on Node 22.23.4, 24.22.1 and 26.12.1.

### 3. Cancelling (`examples/stream/03-cancel.mjs`, `examples/stream/03-await-using.mjs`)

Each of these closes the source once:

- **`break`** (or `return`, or a throw) inside `for await`: the loop calls the iterator's `return()`, which closes the source and resolves when the close has settled.
- **`signal`:** `parseStream(source, { signal })`. An abort while a `next()` is waiting rejects that call at once; an abort between two calls rejects the next call, before it reads anything. The rejection value is `signal.reason` itself (`error === signal.reason`), not an `AbortError` that wraps it as Node's own stream APIs do: a Node `Readable` under `addAbortSignal` rejects its iteration with an `AbortError` whose `cause` is the reason. After that one rejection, `next()` resolves `{ done: true, value: undefined }`. Where `signal.reason` is `undefined` (Safari before 15.4) the rejection is a `DOMException` named `AbortError`.
- **`await using batches = parseStream(…)`** on Node 24 and 26. Node 22 has `Symbol.asyncDispose` but not the syntax; there, use `try` and `finally { await batches.return(); }`.

How the source is closed: a Node `Readable` is destroyed (with `signal.reason` on an abort); a Web stream's reader is cancelled, then released; an iterable's iterator gets `return()`. A Node `Readable` and a Web stream are closed at once, also while a read is pending. A generic async iterable, an async generator for example, cannot be: its `return()` waits for the step that is pending, so its clean-up (its `finally` block) runs when that step settles. The rejection of `next()` does not wait for it.

There is no `throw()`: `for await` never calls it. A generator that delegates with `yield* parseStream(…)` gets, from its own `throw()`, `TypeError: The iterator does not provide a 'throw' method.` (V8's text, seen on Node 22.23.4, 24.22.1 and 26.12.1), and the source is closed once.

### 4. Untrusted input (`examples/stream/04-untrusted.mjs`)

```js
parseStream(source, { maxRecordLength: 1_048_576, delimiter: ',', newline: '\n' });
```

- **`maxRecordLength`** bounds one record (header and comment lines included, line break excluded), in UTF-16 units. A record that passes it rejects `next()` as soon as it does, without another read, with `RangeError: Record at offset <o> is longer than maxRecordLength (<M>)`, where `<o>` is a `cursor` offset, and the source is closed. 1,048,576 is a suggested value: about 2 MiB of text.
- **No limit is unsafe** for untrusted input. The default is no limit, as in bulk `parse`; then an input that opens a quote and never closes it keeps the stream reading and holding one record until the engine refuses the string (536,870,888 units on Node 22-26), and that `next()` rejects with the engine's `RangeError: Invalid string length`.
- **Give `delimiter` and `newline`.** Then nothing is read ahead for detection, and the limit applies from the first chunk. With either one detected, the first `next()` first reads the detection window, and while it does the limit is not checked, since record ends are unknown before the dialect is. The window is always bounded: at most 1,048,576 + 10 × (M + 2) units with `maxRecordLength` = M, and 11,534,356 units without it (S7).

### 5. Other encodings

Bytes are decoded as UTF-8 only, and `encoding` throws `UnsupportedFeatureError`, as in `parse`. For another encoding, decode first and pass the strings:

```js
parseStream(response.body.pipeThrough(new TextDecoderStream('windows-1252')));
```

Where `TextDecoderStream` and the labels `windows-1252`, `utf-16le` and `shift_jis` were seen to work (bytes `80 E9` decoded to U+20AC U+00E9, `AC 20` to U+20AC, `82 A0` to U+3042):

- Node 22.23.4, 24.22.1 and 26.12.1, through `parseStream`.
- Playwright's Chromium, Firefox and WebKit builds, through `pipeThrough(new TextDecoderStream(label))`, recorded only.
- Local workerd through `wrangler dev --local`, recorded only.

Real Safari 18.6 on macOS 15.6.1 passed every probe and the worker example on 2026-11-18 (`safaridriver`, `test/browser/safari.mjs`). Not seen: Deno, Bun, Vercel Edge, Cloudflare production.

### 6. Strict decoding

`parseStream` decodes with `fatal: true`: an invalid UTF-8 sequence rejects `next()` with a `TypeError` and closes the source, and a sequence that the end of the input cuts rejects at the end. `response.text()` and `Blob.text()` replace bad bytes with U+FFFD instead, so a file that parses after `text()` can be rejected here. The bytes `61 2C FF 0A` give the text `a,` U+FFFD and a line break through `Response.text()`, and a `TypeError` through `parseStream`; on Node 22-26 its `code` is `ERR_ENCODING_INVALID_ENCODED_DATA` and its message `The encoded data was not valid for encoding utf-8`. The type is fixed and the text is the engine's: Chromium, Firefox and WebKit word it differently. To accept such a file as `text()` does, put `new TextDecoderStream()` (not fatal) in front and pass the strings; on Node 22-26 that gives the rows of `parse(await response.text())` for those bytes.

### 7. Progress in bytes (`examples/stream/07-progress.mjs`)

`meta` has no byte count (`cursor` counts UTF-16 units of the decoded text). Count the bytes in a wrapper around the source:

```js
async function* counted(source, onBytes) {
  for await (const chunk of source) {
    onBytes(chunk.byteLength);
    yield chunk;
  }
}
parseStream(counted(createReadStream(path), (bytes) => (read += bytes)));
```

- The count grows one source chunk at a time, so its steps are the source's chunks. `new Response(bytes).body` delivered a 32 MiB input as one chunk on Node 22-26, and `Blob.stream()` delivered 4 MiB and 64 MiB blobs as one chunk in Playwright's Firefox and WebKit builds: then the count reaches 100% at the first read.
- The wrapper is a generic async iterable, so closing it waits for its pending step (recipe 3), and `for await` over a Web stream needs `ReadableStream.prototype[Symbol.asyncIterator]`, which Safari 26 and earlier lack (per browser-compat-data). For a Web stream, count in a `TransformStream` instead: `parseStream(body.pipeThrough(new TransformStream({ transform(chunk, controller) { onBytes(chunk.byteLength); controller.enqueue(chunk); } })))`. The workerd probe (`test/edge/`) parses a 100 MiB request body passed through a `TransformStream`.

### 8. Staying responsive (`examples/stream/08-responsive.mjs`)

- Over a source that is already in memory (a string, an array, a buffered stream), `for await` over `parseStream` never gives the event loop a turn: it blocks as long as `parse` would.
- One `next()` is uninterruptible: it does the CPU work of one batch, and the first may also cover the detection window, any one a very long record. Since a batch also closes when its text reaches 1,048,576 UTF-16 units ("The batch"), long rows make that work smaller than `batchSize` alone would; with `repair` a call may also read one record ahead (S8).
- So give the loop a turn between batches yourself, by time: in Node `await setImmediate()` from `node:timers/promises` (the example's `budget` option); in a browser `await scheduler.yield()` where it exists, otherwise `await new Promise((resolve) => setTimeout(resolve, 0))` (no test runs this browser line).
- On a runtime whose clock stands still while code runs, a time budget never runs out; count batches there instead (the example's `every` option). Cloudflare's documentation says so of Workers: "Date.now() returns the time of the last I/O; it does not advance during code execution." and "Workers intentionally reduces the precision of performance.now() such that it returns the time of the last I/O and does not advance during code execution." (https://developers.cloudflare.com/workers/runtime-apis/web-standards/, retrieved 2026-11-11). In local workerd through `wrangler dev --local` the clock advanced during execution; production was not tested.
- For a page that must stay smooth, parse in a worker (recipe 9).

### 9. A module worker (`examples/worker/`)

The page creates `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` and posts it the `File`; the worker runs `parseStream(file.stream(), { header: true, transform })` and posts each batch, or its row count, back. `transform` and any other function live in the worker, since a function cannot be posted. This is not Papa's `worker: true`: csvloom has no worker mode, and the page owns the worker and its messages.

The browser tests run the example in Playwright's Chromium, Firefox and WebKit builds on a generated file of 5,547,688 bytes: 101,590 rows in both modes, and the first progress message reached the page before the worker had finished parsing. Real Safari 18.6 ran it through `safaridriver` on 2026-11-18 in both modes: 101,590 rows, 0 errors (`docs/compatibility.md`, "Support matrix").

### 10. Memory

What the stream holds:

- one text being scanned: for byte input one decoded window (the text of at most 1,048,576 bytes), whatever the source's chunk size; for string input one chunk, whatever its size;
- the carried unfinished record: at most `maxRecordLength` units when it is set, otherwise up to the longest record, and then up to the engine's string limit (recipe 4);
- the batch being filled: at most `batchSize` rows, and fewer when their records are long, since the rows before its last hold less than 1,048,576 UTF-16 units of text ("The batch"); with `repair` also the records read ahead (S8);
- the header, and the `dynamicTyping` function's answers;
- until detection ends, the detection window: at most 1,048,576 + 10 × (M + 2) units with `maxRecordLength` = M, and at most 11,534,356 units without it.

Outside its control and added to it: the source's own buffer (about its highWaterMark), engine body buffers, and the source's current chunk, which for bytes stays alive while its windows are decoded. None of the stream's own terms grows with the row count; the batches a consumer keeps are the consumer's.

**Fields keep their text alive.** A field of 13 UTF-16 units or more can be a V8 slice of the text it came from, so keeping one field keeps that whole string chunk or decoded window alive, as with bulk `parse`. Measured with `node --expose-gc` on Linux x64, Node 22.23.4, 24.22.1 and 26.12.1: 400 string chunks of 65,536 units, the consumer keeping one 16-unit field from each chunk's first row, retained 25.17 to 25.30 MiB for one-byte text and 50.17 to 50.30 MiB for two-byte text; with the copy idiom `(' ' + field).slice(1)` it retained 0.19 to 0.56 MiB. There is no copy option.

**A carried record keeps the text it started in alive.** The first part of a record that spans chunks is a slice of the text it started in, and that whole text stays alive until the record ends. Measured the same way (heap after `gc()` over the heap at the end): a string chunk of 64 Mi units whose last 100 units start a record that 1,000 chunks of 1,024 units continue held 64.54 to 64.55 MiB while the record was carried (one-byte text) and 129.02 to 129.03 MiB (two-byte text), against 0.53 to 0.55 MiB and 1.02 to 1.03 MiB when the same record starts a 1,024-unit chunk, and 0.02 to 0.04 MiB once the record was delivered (no leak). For byte input the slice is of one decoded window: 1.52 to 2.54 MiB (one-byte) and 2.06 to 2.07 MiB (two-byte) while carried. So with string input, large chunks and records that span them can hold far more than the record itself.

**One chunk that is the whole input.** When a 32 MiB input arrives as one chunk (`new Response(bytes).body`, and `Blob.stream()` over one part and over 32 parts), the stream's peak RSS was 79,296 to 146,540 KiB above an empty process plus the 32 MiB input on Node 22, 24 and 26 (VmHWM, medians of 3), and the rows equalled bulk's. Two causes were found:

- The sources themselves. Reading the same sources through a reader without parsing peaked 47,052 to 87,216 KiB above the same base.
- The decoded windows are Node external strings. Node makes a string of 1,031,913 units or more external (`EXTERN_APEX = 0xFBEE9` in Node's `src/string_bytes.cc`; one streaming decode of 1,031,912 units added 0 external bytes, and of 1,031,913 units 1,031,913 bytes on Node 24 and 26 and 2,063,826 on Node 22), and such strings wait for a garbage collection.

For comparison, one `TextDecoder.decode` plus bulk `parse` of the same bytes peaked 237,864 to 335,448 KiB above the same base. Decoding stays on demand (`test/stream.test.ts`, "decoding on demand"). The published S1 lane gives the stream's peak memory against the other stream parsers (`docs/benchmarks.md`, "Lane S1: `parseStream`").

### 11. Node `pipeline` (`examples/stream/11-pipeline.mjs`)

```js
await pipeline(
  createReadStream(path),
  (source, { signal }) => parseStream(source, { signal }),
  async (batches) => {
    for await (const batch of batches) save(batch.data);
  },
);
```

`parseStream` returns an async iterable, which `pipeline` takes as a stage, so no other export is needed. Passing `pipeline`'s `signal` lets a failure elsewhere in the pipeline abort the parse; a sink that throws destroys the file stream (the example, and `test/stream.test.ts`, "Node's pipeline").

## Speed

The published numbers for `parseStream` are the S1 lane of `docs/benchmarks.md`, "Lane S1: `parseStream`": each S1 file as 65,536-byte chunks from an in-memory async iterable, each header-keyed record handed to a consumer that keeps nothing, `batchSize` 1024, Node 26.13.1 at default settings. S1 is read on its own and has no overall mean. Its losing cases, its memory table and its noise check are there, and "How the harness measures" describes the method.
