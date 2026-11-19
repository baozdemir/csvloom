<h1 align="center">
  <img alt="csvloom" src="docs/assets/wordmark.svg" width="360">
</h1>

<p align="center"><b>Fast, safe CSV for JavaScript — a drop-in replacement for Papa Parse.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/csvloom"><img alt="npm" src="https://img.shields.io/npm/v/csvloom"></a>
  <a href="https://github.com/baozdemir/csvloom/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/baozdemir/csvloom/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://codecov.io/gh/baozdemir/csvloom"><img alt="coverage on Codecov" src="https://codecov.io/gh/baozdemir/csvloom/graph/badge.svg"></a>
  <a href="https://www.jsdocs.io/package/csvloom"><img alt="API docs on jsDocs.io" src="https://img.shields.io/badge/docs-jsdocs.io-blue"></a>
  <a href="https://context7.com/baozdemir/csvloom"><img alt="docs for AI assistants on Context7" src="https://img.shields.io/badge/docs-Context7-blue"></a>
  <a href="https://www.npmjs.com/package/csvloom?activeTab=dependencies"><img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="#why-csvloom">Why csvloom</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#streaming">Streaming</a> ·
  <a href="#features">Features</a> ·
  <a href="#migrating-from-papa-parse">Migrating from Papa Parse</a> ·
  <a href="#performance">Performance</a> ·
  <a href="#documentation">Docs</a>
</p>

csvloom parses and writes CSV in Node, Deno, Bun, browsers and edge runtimes. For a string, it returns what Papa Parse 5.7.1 returns: the same rows, errors and `meta`, with every intended difference [listed](docs/compatibility.md). Moving such code over takes one changed import.

On top of that, it streams with async iterators, reports errors with line and column, repairs broken rows, and escapes spreadsheet formulas when it writes. Zero dependencies, no `eval`, types included.

<!-- published-results:start -->

![Bar chart of parsing speed relative to Papa Parse, the geometric mean over 24 parse cases; Papa Parse is 1 and higher is faster: csvloom 2.60, csv-simple-parser 1.95, udsv 1.94, csv-pipe 1.66, d3-dsv 1.41, csv-rex 1.04, Papa Parse 1.00, amigo-labs-csv 0.68 (a native addon, Node only), csv-parse 0.49, fast-csv 0.28.](docs/assets/bench-parse.svg)

_`parse` of a string, Node 26.13.1 at default settings, Papa Parse 5.7.1: 24 cases (six kinds of CSV, 1 MiB and 32 MiB, arrays and objects), 20 processes per library and case. Libraries without valid results on all 24 cases are not shown. [How it was measured](docs/benchmarks.md#charts)_

- **2.6× faster than Papa Parse** at parsing strings: 2.596 [2.590, 2.605], the geometric mean over the 24 cases.
- **Faster than Papa Parse on every published `parse` and `parseStream` case:** all 24 and all 12.
- **1.14× on average against the fastest other parser of each case** (1.142 [1.139, 1.145], the geometric mean over the 24), and ahead on 15 of them.

<!-- published-results:end -->

<br>

## Why csvloom

Side by side with Papa Parse 5.7.1:

<!-- published-results:start -->

|                         | Papa Parse 5.7.1               | csvloom                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------ |
| Parsing speed           | 1×                             | **2.6× faster** on average, and faster in all 24 cases |
| Streaming               | `step` and `chunk` callbacks   | `for await`, with backpressure and cancelling          |
| Where an error is       | `row` (and `index` for quotes) | Line, column, offset and snippet (`positions`)         |
| Broken rows             | Reported                       | Reported, or repaired with a log (`repair`)            |
| Row validation          | —                              | Any Standard Schema v1 object (`schema`)               |
| Formula escaping        | Off by default                 | On by default in `csvloom`                             |
| TypeScript types        | `@types/papaparse`             | Included                                               |
| Worker mode, `download` | Built in                       | Not included                                           |

<!-- published-results:end -->

csvloom has zero dependencies and no `eval`, so it also runs under a strict Content Security Policy. It ships ESM and CommonJS, and runs in Node, Deno, Bun, browsers and edge runtimes ([where it runs](#where-it-runs)).

<br>

## Install

```sh
npm install csvloom
```

csvloom needs Node 22 or later. Browsers and edge runtimes are under [Where it runs](#where-it-runs).

<br>

## Usage

### Parse and write a string

`parse` turns a string into rows, and `unparse` turns rows back into CSV.

```js
import { parse, unparse } from 'csvloom';

const csv = 'name,city\nAda,"London, UK"\nGrace,New York';

// Rows as arrays, or as objects keyed by the header record.
console.log(JSON.stringify(parse(csv).data));
const { data, errors, meta } = parse(csv, { header: true });
console.log(JSON.stringify(data), errors.length, JSON.stringify(meta.fields));

// Back to CSV. A value that a spreadsheet would run as a formula is escaped by default.
// (The default newline is "\r\n"; "\n" keeps this output readable.)
console.log(unparse([{ name: 'Ada', note: '=1+1' }], { newline: '\n' }));
```

```text
[["name","city"],["Ada","London, UK"],["Grace","New York"]]
[{"name":"Ada","city":"London, UK"},{"name":"Grace","city":"New York"}] 0 ["name","city"]
name,note
Ada,"'=1+1"
```

`parse(text, config)` takes Papa Parse's options for a string, with the same meaning: `delimiter`, `newline`, `quoteChar`, `escapeChar`, `header`, `dynamicTyping`, `transform`, `transformHeader`, `comments`, `skipEmptyLines`, `preview`, `skipFirstNLines`, `fastMode` and `delimitersToGuess`.

`unparse(data, config)` writes arrays of arrays, arrays of objects, or `{ fields, data }`. It takes Papa's options, plus `bom` and `sepLine`.

Malformed CSV never throws: read `errors`. A wrong option does throw, with a `TypeError` that names it.

### Pick an entry

| Import           | Use it for                                                        |
| ---------------- | ----------------------------------------------------------------- |
| `csvloom`        | `parse`, `unparse` and `parseDetailed`; strict about options      |
| `csvloom/papa`   | Existing Papa Parse code: `Papa.parse(string)` and `Papa.unparse` |
| `csvloom/stream` | `parseStream`: files, HTTP bodies and other chunked input         |

### TypeScript

Types are included for ESM and CommonJS. The row type follows the config: `string[]` by default, an object per record with `header: true`, and typed values with `dynamicTyping`.

<br>

## Streaming

`parseStream` reads a file, an HTTP body or any chunked source as an async iterator of row batches.

```js
import { parseStream } from 'csvloom/stream';

// A source is text or UTF-8 bytes in pieces: a fetch body, file.stream(), a Node Readable,
// an array or an async generator of chunks.
const { body } = new Response('id,name\n1,Ada\n2,Grace\n3,Linus\n');

const options = { header: true, skipEmptyLines: true, batchSize: 2 };
for await (const batch of parseStream(body, options)) {
  console.log(JSON.stringify(batch.data), batch.meta.rowOffset, batch.meta.done);
}
```

```text
[{"id":"1","name":"Ada"},{"id":"2","name":"Grace"}] 0 false
[{"id":"3","name":"Linus"}] 2 true
```

It reads from the source only when your loop asks for the next batch, so a slow consumer slows the source down. The stream keeps no queue of its own.

Leaving the loop, an `AbortSignal` or `await using` closes the source.

Bytes are decoded as UTF-8, a window at a time, so an input larger than the longest string the engine allows can still be parsed.

For input you do not trust, set `maxRecordLength`. It has no default: without it, one unterminated quote makes the stream hold the rest of the input as one record.

[docs/streaming.md](docs/streaming.md) has eleven recipes: files and URLs, cancelling, untrusted input, other encodings, progress, staying responsive, a module worker, memory and Node `pipeline`. Those with a file in [examples/stream/](examples/stream/) are run by the package test.

<br>

## Features

`parseDetailed` takes every option of `parse` and five more, each off unless asked for: `detect`, `positions`, `repair`, `schema` and `sepLine`. `parseStream` takes the same five.

### Errors with line and column

`positions: true` adds a line, a column, an offset and a snippet to every error that has a place.

```js
import { formatError, parseDetailed } from 'csvloom';

const text = 'id,name,city\n1,Ada,London\n2,Grace\n3,Linus,"Helsinki\n';
const { errors } = parseDetailed(text, { header: true, positions: true });
for (const error of errors) console.log(formatError(error));
```

```text
Quoted field unterminated [MissingQuotes] at line 4, column 9 (row 3, offset 42)
  4 | 3,Linus,"Helsinki
    |         ^
Too few fields: expected 3 fields but parsed 2 [TooFewFields] at line 3, column 1 (row 1, offset 26)
  3 | 2,Grace
    | ^
```

[More on positions](docs/features.md#positions-on-errors-positions-formaterror)

### Repair

`repair: true` fixes ragged rows, mixed line breaks and a quote that never closes, with five named rules. Every change is logged in `repairs`.

```js
import { parseDetailed } from 'csvloom';

// A short record, and a quote that never closes.
const text = 'id,name,city\n1,Ada\n2,"Grace,New York\n';
const { data, errors, repairs } = parseDetailed(text, { header: true, repair: true });
console.log(JSON.stringify(data), errors.length, 'errors');
for (const { rule, line } of repairs) console.log(rule, 'on line', line);
```

```text
[{"id":"1","name":"Ada","city":""},{"id":"2","name":"\"Grace","city":"New York"}] 0 errors
pad-missing on line 2
unclosed-quote on line 3
trailing-empty-record on line 3
```

[More on repair](docs/features.md#repair-repair)

### Dialect detection

`detect: true` scores the delimiter, quote, escape and newline, and skips title lines and a `sep=` line above the table.

```js
import { parseDetailed } from 'csvloom';

// A title line above a table separated by ';'. Nothing about the dialect is given.
const text = 'Sales report 2026\nid;name;amount\n1;Ada;1,5\n2;Grace;2,25\n';
const { data, meta } = parseDetailed(text, { detect: true, header: true, skipEmptyLines: true });
console.log(JSON.stringify(meta.delimiter), JSON.stringify(meta.detected?.preamble));
console.log(JSON.stringify(data));
```

```text
";" "Sales report 2026\n"
[{"id":"1","name":"Ada","amount":"1,5"},{"id":"2","name":"Grace","amount":"2,25"}]
```

[More on detection](docs/features.md#dialect-detection-detect)

### Row validation

`schema` validates each row with any object that implements [Standard Schema](https://github.com/standard-schema/standard-schema) v1, the interface that validation libraries publish. Invalid rows leave `data` and are reported as errors.

```js
import { parseDetailed } from 'csvloom';

// Any Standard Schema v1 object works here. This one is written by hand.
const schema = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: (row) =>
      Number.isInteger(row.age)
        ? { value: row }
        : { issues: [{ message: 'age must be a whole number', path: ['age'] }] },
  },
};
const text = 'name,age\nAda,36\nGrace,x\n';
const config = { header: true, dynamicTyping: true, skipEmptyLines: true, schema };
const { data, errors } = parseDetailed(text, config);
console.log(JSON.stringify(data));
console.log(JSON.stringify(errors));
```

```text
[{"name":"Ada","age":36}]
[{"type":"Schema","code":"InvalidRow","message":"age must be a whole number","row":1,"path":["age"],"value":{"name":"Grace","age":"x"}}]
```

No validator is bundled, and the tests use hand-written schema objects, not a library.

[More on validation](docs/features.md#row-validation-schema)

### Excel and formula escaping

The `excel` and `excelSemicolon` presets write what spreadsheet programs expect: a BOM, `\r\n`, and `,` or `;`.

```js
import { excel, unparse } from 'csvloom';

const rows = [
  ['name', 'total'],
  ['Zoë', '=SUM(B2:B9)'],
];
// The excel preset writes a BOM, "\r\n" and ",". The formula is escaped, as by default.
const csv = unparse(rows, excel);
console.log(csv.startsWith('\uFEFF'), JSON.stringify(csv.slice(1)));
```

```text
true "name,total\r\nZoë,\"'=SUM(B2:B9)\""
```

`unparse` from `csvloom` writes `'` before a value that a spreadsheet would run as a formula. `escapeFormulae: false` turns it off. `sepLine` writes or reads Excel's `sep=;` first line.

[More on Excel output](docs/features.md#excel-bom-sepline-excel-excelsemicolon) · [More on formula escaping](docs/features.md#formula-escaping-in-unparse-csv-injection)

<br>

## Migrating from Papa Parse

For a synchronous `Papa.parse(string)` or `Papa.unparse`, change `import Papa from 'papaparse'` to `import Papa from 'csvloom/papa'`. Nothing else changes.

```js
import Papa from 'csvloom/papa'; // was: import Papa from 'papaparse';

const csv = 'sku;qty;price\r\nA-1;2;9.50\r\nB-7;;12\r\n';
const parsed = Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: true });
console.log(JSON.stringify(parsed.data));
console.log(JSON.stringify(parsed.meta));

// Errors keep Papa's type, code, message and row.
console.log(JSON.stringify(Papa.parse('a,b\n1,2,3\n"x', { header: true }).errors));
console.log(JSON.stringify(Papa.unparse(parsed.data, { quotes: true, newline: '\n' })));
```

```text
[{"sku":"A-1","qty":2,"price":9.5},{"sku":"B-7","qty":null,"price":12}]
{"delimiter":";","linebreak":"\r\n","aborted":false,"truncated":false,"cursor":36,"renamedHeaders":null,"fields":["sku","qty","price"]}
[{"type":"Quotes","code":"MissingQuotes","message":"Quoted field unterminated","row":2,"index":11},{"type":"FieldMismatch","code":"TooManyFields","message":"Too many fields: expected 2 fields but parsed 3","row":0},{"type":"FieldMismatch","code":"TooFewFields","message":"Too few fields: expected 2 fields but parsed 1","row":1}]
"\"sku\",\"qty\",\"price\"\n\"A-1\",\"2\",\"9.5\"\n\"B-7\",,\"12\""
```

`csvloom/papa` reads a config as Papa Parse 5.7.1 reads it, coercions and ignored keys included. The same file with its import changed back to `papaparse` prints the same output, and a test runs both.

Files, URLs, `step`, `complete` and workers need a rewrite with `parseStream`. Each of them throws `UnsupportedFeatureError`; none is silently ignored.

[The migration guide](docs/migrating-from-papaparse.md) sorts your calls into the two groups, with the limits first. The two libraries side by side are under [Why csvloom](#why-csvloom).

### How compatibility is tested

- Papa's own "Parse Tests" and "Unparse Tests" run against `csvloom/papa` with their own assertions: 100 and 64 tests, all passing. Four suites and one test are left out by name, because they test the callbacks, workers, downloads, `File` input and Papa's internal `Parser` class.
- A differential test compares both entries with Papa itself on Papa's test inputs, on CSV Spectrum and on generated inputs with up to three options combined.
- Every intended difference has an id, a reason and a test in [docs/compatibility.md](docs/compatibility.md). For example, a config object is never modified (D2-a), and a column named `__proto__` is kept as an ordinary property (D2-c).
- The main entry `csvloom` is stricter than Papa: an unknown option or a value of the wrong type throws a `TypeError`, and `unparse` escapes formulas by default. `csvloom/papa` does neither.

<br>

## Performance

<!-- published-results:start -->

csvloom's published numbers come from one benchmark campaign in three lanes: `parse`, `parseStream` and `unparse`. Each ratio is the other library's time divided by csvloom's, so above 1 means csvloom is faster.

The conditions: Node 26.13.1 at V8's default settings, Papa Parse 5.7.1, one Google Cloud c3-standard-8 machine per lane, 20 processes per library and case, 95% bootstrap intervals, release 0.1.0's code, 2026-11-18.

- **`parse` of a string:** 2.596 [2.590, 2.605] against Papa Parse over 24 cases, and faster on every one of them, from 1.101 to 7.530. Against the fastest other parser of each case: 1.142 [1.139, 1.145] on average, and ahead on 15 of the 24.
- **Small inputs:** faster than Papa Parse on all 16 cases of 1 KiB and 64 KiB, from 3.347 to 5.529.
- **`parseStream`:** faster than Papa Parse on all 12 streaming cases, from 1.158 to 2.714.
- **`unparse`:** faster than or on par with Papa Parse on all 24 writing cases, up to 3.4× (3.407). csvloom runs with `escapeFormulae: false` here, so it does the same work as the other writers.

![Grouped bar chart: how many times faster csvloom is than Papa Parse in each of the 24 parse cases; Papa Parse is 1 and every bar is above it. 1 MiB files, rows as arrays and as objects: simple 2.51 and 3.88, quote-heavy 4.55 and 4.55, multiline 3.62 and 4.44, wide 2.97 and 3.74, unicode 3.56 and 3.91, long-field 7.23 and 7.53. 32 MiB files: simple 1.23 and 1.79, quote-heavy 1.31 and 1.74, multiline 1.24 and 1.52, wide 1.10 and 2.36, unicode 1.23 and 1.67, long-field 2.64 and 2.44.](docs/assets/bench-parse-cases.svg)

_`parse` of a string, Node 26.13.1 at default settings, Papa Parse 5.7.1: each of the 24 cases, 20 processes per library and case. [How it was measured](docs/benchmarks.md#charts)_

<!-- published-results:end -->

Every case, every library, memory, the noise checks, the method and how to reproduce the numbers are in [docs/benchmarks.md](docs/benchmarks.md).

<br>

## What it does not do

- **Papa's callbacks, workers and downloads.** `step`, `chunk`, `complete`, `error`, `beforeFirstChunk`, `worker`, `download` and `encoding` throw `UnsupportedFeatureError`, and so does a `File`, `Blob`, URL or Node stream passed to `parse`. Use `parseStream` for files and URLs.
- **A worker mode.** [examples/worker/](examples/worker/) is a recipe for a module worker that your page owns.
- **Encodings other than UTF-8 for bytes.** Decode first with `TextDecoderStream` and pass the strings. `detect` reports what bytes look like, but converts nothing.
- **Type inference beyond Papa's `dynamicTyping`,** a schema language of its own, XLSX, SQL or a command-line tool.
- **A guarantee against CSV injection.** Formula escaping is a mitigation: OWASP notes that the leading `'` is not reliable in Microsoft Excel once the file is saved and opened again.
- **Repair of every fault.** A row with a non-empty extra field and a stray quote inside a field are reported, not repaired.

<br>

## Where it runs

The tests ran on release 0.1.0's code in:

- **Node 22.23.4, 24.22.1 and 26.13.1 on Linux x64, and Node 22, 24 and 26 on macOS:** the whole test suite, and the packed package as ESM, CommonJS and TypeScript.
- **Node 24.22.1 on Windows:** the test suite without the benchmark harness, and the examples against the packed package.
- **Deno 2.9.8 and Bun 1.4.4:** every example of `examples/` against the packed package.
- **Chromium, Firefox and WebKit** as shipped with Playwright 1.65.0, and **Safari 18.6**, on macOS 15.6.1: the streaming probes and the worker example, under `Content-Security-Policy: script-src 'self'`.
- **Cloudflare Workers and Vercel Edge Functions, deployed,** and Cloudflare's workerd locally: `parseStream` over request bodies up to each platform's request size limit.

Safari versions other than 18.6 are not in the test matrix yet. The versions, dates and results are in the [support matrix](docs/compatibility.md#support-matrix).

<br>

## Security

- **No code generation.** There is no `eval`, `new Function` or WebAssembly in the source or the built files. The packed package is tested under `node --disallow-code-generation-from-strings`.
- **No side effects.** Importing an entry prints nothing and adds nothing to `globalThis`. The library makes no network calls and sets no timers.
- **Untrusted input.** Use `parseStream` with `maxRecordLength`, `delimiter` and `newline`: a record that passes the limit is rejected as soon as it does ([recipe 4](docs/streaming.md#4-untrusted-input-examplesstream04-untrustedmjs)).
- **CSV injection.** `unparse` in the main entry writes `'` before a value that starts with `=`, `+`, `-`, `@` (or their full-width forms), a tab or a line break, and quotes it, unless the whole value is a plain number.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

<br>

## FAQ

### Is it a drop-in replacement for Papa Parse?

For `Papa.parse(string, config)` and `Papa.unparse`, yes: change the import to `csvloom/papa`. Files, URLs, `step`, `complete` and workers need a rewrite with `parseStream`. [The migration guide](docs/migrating-from-papaparse.md) sorts your calls into the two groups.

### How do I parse a file or a URL?

Pass a stream to `parseStream`: `file.stream()` in a browser, `(await fetch(url)).body`, or a Node `Readable` such as `fs.createReadStream(path)`. [docs/streaming.md](docs/streaming.md) has a recipe for each.

### Why is there an empty last row, or a `TooFewFields` error at the end?

A line break at the end of the input gives one more record, as in Papa Parse. Pass `skipEmptyLines: true` unless you want it.

### Why does the output have a `'` before some values?

`unparse` from `csvloom` escapes values that a spreadsheet would run as formulas. Pass `escapeFormulae: false` to turn it off. `Papa.unparse` from `csvloom/papa` keeps Papa's default, off.

### Can I validate rows with Zod or Valibot?

Yes, if the library implements [Standard Schema](https://github.com/standard-schema/standard-schema) v1: pass its schema as `schema` to `parseDetailed` or `parseStream`. The tests use hand-written schema objects, not those libraries. [docs/features.md](docs/features.md#row-validation-schema) has the details.

### Is it safe for input I do not trust?

Use `parseStream` with `maxRecordLength`, `delimiter` and `newline`. `maxRecordLength` has no default, so without it there is no limit. Cells come back as they are: escaping them for HTML, SQL or a shell is up to you.

<br>

## Documentation

- [Migrating from Papa Parse](docs/migrating-from-papaparse.md): what one import changes, and what needs a rewrite.
- [Streaming](docs/streaming.md): `parseStream`, recipe by recipe.
- [Features](docs/features.md): detection, positions, repair, Excel output, validation and formula escaping.
- [Compatibility](docs/compatibility.md): every difference from Papa Parse 5.7.1, and the support matrix.
- [Benchmarks](docs/benchmarks.md): the published numbers, every case, the method and how to reproduce them.
- [llms.txt](llms.txt): the essentials, in the form coding assistants read.
- [Changelog](CHANGELOG.md).

<br>

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says what a change must keep, and everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

<br>

## License

MIT. Copyright (c) 2026 Baris Ozdemir. See [LICENSE](LICENSE).
