# Migrating from Papa Parse

## Read this first: what one line changes, and what it does not

The reference is Papa Parse 5.7.1. Everything below is about that version.

**Changing the import is the whole migration** when your code does only this:

- `Papa.parse(text, config)` with a **string**, using the **returned** `{ data, errors, meta }`;
- `Papa.unparse(data, config)`;
- the constants `Papa.RECORD_SEP`, `Papa.UNIT_SEP`, `Papa.BYTE_ORDER_MARK` and `Papa.BAD_DELIMITERS`.

**It is a rewrite** when your code does any of this. In `csvloom/papa` each of these throws, an `UnsupportedFeatureError` unless the row says otherwise; none is ignored.

| Your Papa code                                                            | With csvloom                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Papa.parse(file, …)` with a `File` or `Blob`                             | `parseStream(file.stream(), …)` from `csvloom/stream`                                                                     |
| `Papa.parse(url, { download: true, … })`                                  | `parseStream((await fetch(url)).body, …)`; headers, credentials and timeouts are `fetch`'s                                |
| `Papa.parse(readable, …)` in Node, or `Papa.NODE_STREAM_INPUT` and `pipe` | `parseStream(readable, …)`. `Papa.NODE_STREAM_INPUT` is not a member, so that call throws a `TypeError` about `undefined` |
| `step` or `chunk`                                                         | the body of a `for await` loop over batches                                                                               |
| `complete`, `error`                                                       | the code after the loop; `try` and `catch` around it                                                                      |
| `parser.pause()`, `parser.resume()`, `parser.abort()`                     | an `await` inside the loop pauses; `break` or an `AbortSignal` stops                                                      |
| `worker: true`                                                            | a module worker that your page owns ([docs/streaming.md](streaming.md), recipe 9)                                         |
| `encoding`                                                                | `TextDecoderStream` in front of `parseStream` ([docs/streaming.md](streaming.md), recipe 5)                               |
| `beforeFirstChunk`, `chunkSize`                                           | no equivalent; transform the source before you pass it                                                                    |

**There is no equivalent** for Papa's mutable settings (`Papa.DefaultDelimiter`, `Papa.LocalChunkSize`, `Papa.RemoteChunkSize`), for `Papa.WORKERS_SUPPORTED`, or for its internal classes (`Papa.Parser`, `Papa.ParserHandle` and the streamers). The object `csvloom/papa` exports is frozen and has seven members: `parse`, `unparse`, the four constants and `UnsupportedFeatureError`. Reading any other member gives `undefined`, and assigning one throws a `TypeError` in a module or in strict mode.

**In TypeScript the same synchronous code compiles after the import change**, with the exceptions at the end of this list. `csvloom/papa` has its own types, declared as `@types/papaparse` 5.5.2 declares Papa's:

- `Papa.parse<Row>(text, config)` returns a `ParseResult<Row>`, so `result.data` is `Row[]`. Without a type argument the row type comes from an annotation (`const result: Papa.ParseResult<Row> = Papa.parse(…)`) or from a config variable typed `ParseConfig<Row>`; otherwise the rows are `unknown`. As with Papa, the type is what you state: nothing checks the rows against it.
- `ParseResult`, `ParseConfig`, `ParseError`, `ParseMeta` and `UnparseConfig` are exported by name and are on the default import (`Papa.ParseResult<Row>`). `ParseError` is the declaration of `@types/papaparse`. `ParseMeta` differs from `@types/papaparse`'s in one place: `renamedHeaders` can be `null`, which is what Papa Parse 5.7.1 itself returns when no header was renamed. `ParseResult` has the shape of `@types/papaparse`'s and holds that `ParseMeta`.
- An unsupported option is a compile error: `step`, `complete`, `worker: true` and the others of the table above are typed as their inactive values, so the compiler lists what has to be rewritten.
- Not declared, because what they type is not there: `ParseStepResult`, `Parser`, `LocalFile`, `ParseWorkerConfig`, `ParseLocalConfig` and `ParseRemoteConfig`.
- `Papa.unparse` takes no type argument: write `Papa.unparse(rows)`, not `Papa.unparse<Row>(rows)`. It takes `{ fields, data }` as before, but the type name `UnparseObject` is not declared. A `quotes` function receives its value as `unknown`, not `any`.

A test compiles one file of such code against `@types/papaparse` and against `csvloom/papa` with only its import changed, and compares what the two return (`test/types.test.ts`, `test/types/papa-snippets.*.ts`). `npm run test:package` compiles the names against the packed package, as ESM and as CommonJS (checks 4, 5 and 8). The table of names is in [docs/compatibility.md](compatibility.md), "`csvloom/papa` and TypeScript".

## Step 1: change the import

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

This file prints the same output with its first line changed back to `import Papa from 'papaparse';`. A test runs both (`test/docs-examples.test.ts`).

In CommonJS, `const Papa = require('csvloom/papa')` returns the same frozen object, as `require('papaparse')` returns Papa (check 2 of `npm run test:package` runs that line against the packed package).

What the entry promises: for the same string and config it returns what Papa Parse 5.7.1 returns. The config is read as Papa reads it: a value of another type is coerced or replaced by the default as Papa does, and an unknown key is ignored. The error types, codes and messages in `errors` are Papa's. That includes the behavior you may not expect from either library: a final line break gives one more record, `['']` (D2-e), and `preview` counts lines or records depending on the input (D2-g).

### Where `csvloom/papa` differs from Papa Parse 5.7.1, on purpose

Each row is an id in [docs/compatibility.md](compatibility.md), with its reason and its test.

| Id   | In `csvloom/papa`                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D2-a | The config object and the `unparse` input are never modified.                                                                                                      |
| D2-b | Duplicate header names are renamed and reported in `meta.renamedHeaders`, without a `console.warn`.                                                                |
| D2-c | A column named `__proto__` is kept, as an ordinary property of each row.                                                                                           |
| D2-d | `dynamicTyping` also converts columns named like `Object.prototype` members (`constructor`, `toString`, …).                                                        |
| D2-i | `escapeFormulae: true` in `unparse` also prefixes a risky value that holds a line break (for example `"=1\n2"`), which Papa Parse 5.7.1 quotes without the prefix. |
| P3-a | An empty delimiter from a delimiter function or in `delimitersToGuess` throws a `TypeError`.                                                                       |
| P3-b | A negative `preview` throws a `TypeError`; so does a truthy `preview` whose number is 0 or fractional.                                                             |
| P3-c | A `\r` or `\n` inside a delimiter or a comment marker throws a `TypeError`.                                                                                        |
| D3   | The features in the table at the top throw `UnsupportedFeatureError`.                                                                                              |

```js
import Papa from 'csvloom/papa';

// Papa's callbacks, workers, downloads and non-string inputs are not here. Asking for one
// throws; it is never ignored.
const requests = {
  step: () => Papa.parse('a,b', { step() {} }),
  complete: () => Papa.parse('a,b', { complete() {} }),
  worker: () => Papa.parse('a,b', { worker: true }),
  download: () => Papa.parse('https://example.com/data.csv', { download: true }),
  encoding: () => Papa.parse('a,b', { encoding: 'latin1' }),
  'a File or Blob': () => Papa.parse(new Blob(['a,b'])),
};
for (const [request, run] of Object.entries(requests)) {
  try {
    run();
  } catch (error) {
    console.log(`${request}: ${error.name}: ${error.message}`);
  }
}
```

```text
step: UnsupportedFeatureError: "step" is not supported by csvloom
complete: UnsupportedFeatureError: "complete" is not supported by csvloom
worker: UnsupportedFeatureError: "worker" is not supported by csvloom
download: UnsupportedFeatureError: "download" is not supported by csvloom
encoding: UnsupportedFeatureError: "encoding" is not supported by csvloom
a File or Blob: UnsupportedFeatureError: "non-string input" is not supported by csvloom
```

## Step 2, optional: the main entry

`csvloom` (without `/papa`) parses the same way and returns the same result, and is stricter about what you pass. Move to it when you want mistakes named instead of ignored, row types inferred from the config, or the features Papa does not have.

```js
import { parse, unparse } from 'csvloom';
import Papa from 'csvloom/papa';

const attempt = (run) => {
  try {
    return JSON.stringify(run());
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

// A misspelled option: csvloom/papa ignores it, as Papa does. The main entry names it.
console.log(attempt(() => Papa.parse('a;b', { delimeter: ';' }).data));
console.log(attempt(() => parse('a;b', { delimeter: ';' }).data));

// A value outside an option's type: csvloom/papa reads it as Papa does. The main entry throws.
console.log(attempt(() => Papa.parse('a\n\nb', { skipEmptyLines: 'yes' }).data));
console.log(attempt(() => parse('a\n\nb', { skipEmptyLines: 'yes' }).data));

// Formula escaping in unparse: off by default in csvloom/papa, on in the main entry.
console.log(attempt(() => Papa.unparse([['=1+1', '-5', 'x']])));
console.log(attempt(() => unparse([['=1+1', '-5', 'x']])));
console.log(attempt(() => unparse([['=1+1', '-5', 'x']], { escapeFormulae: false })));
```

```text
[["a","b"]]
TypeError: Unknown parse option "delimeter"
[["a"],["b"]]
TypeError: Parse option "skipEmptyLines" must be a boolean or "greedy"
"=1+1,-5,x"
"\"'=1+1\",-5,x"
"=1+1,-5,x"
```

| What                                             | `csvloom/papa`                    | `csvloom`                                                                  |
| ------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| Import                                           | `import Papa from 'csvloom/papa'` | `import { parse, unparse } from 'csvloom'` (no default export)             |
| An unknown option                                | ignored, as in Papa               | `TypeError: Unknown parse option "<key>"`                                  |
| A value outside an option's type                 | read as Papa reads it             | `TypeError` that names the option                                          |
| An invalid `delimiter`, `newline` or `quoteChar` | Papa's fallback                   | `TypeError` (D2-k)                                                         |
| `unparse` and formula-like values                | written as they are               | written with `'` in front and quoted; `escapeFormulae: false` turns it off |
| Row types                                        | the stated `Row`, else `unknown`  | inferred from `header`, `dynamicTyping` and `transform`                    |
| More                                             | nothing                           | `parseDetailed`, `detect`, `formatError`, `excel`, `excelSemicolon`        |

The changed default is the one to check before you switch an export path: with the main entry, `unparse([['=1+1', '@x', 'a']])` writes `"'=1+1","'@x",a`, and a string such as `-abc` or `+90 555 123 45 67` gets a `'` in front too. Plain numbers such as `-5` do not. [docs/features.md](features.md), "Formula escaping in `unparse`", has the rule and what it rewrites that is not a formula.

## Files, URLs, `step` and `complete`

```js
import { parseStream } from 'csvloom/stream';

// Papa: Papa.parse(file, { header: true, step: (row) => save(row.data), complete: done });
const file = new File(['id,name\n1,Ada\n2,Grace\n'], 'people.csv');
const saved = [];

for await (const batch of parseStream(file.stream(), { header: true, skipEmptyLines: true })) {
  for (const row of batch.data) saved.push(row); // what step did, a batch at a time
  for (const error of batch.errors) console.log(error.code, error.row);
}
console.log(JSON.stringify(saved)); // what complete did: the loop has ended
```

```text
[{"id":"1","name":"Ada"},{"id":"2","name":"Grace"}]
```

`parseStream` is not Papa's streaming API with other names, and there is no adapter that takes Papa's callbacks:

- **Rows arrive in batches,** up to 1024 by default (`batchSize`; fewer when a batch's text reaches 1,048,576 UTF-16 units), not one call per row. `batch.errors` holds the errors of that batch's rows; `batch.meta.rowOffset` is the number of rows before it.
- **The loop is the control flow.** The source is read only when the loop asks for the next batch. An `await` in the loop body is Papa's `pause`; `break`, `return` or a throw closes the source, as `abort` did; `signal` takes an `AbortSignal`.
- **Errors reject.** A source that fails, bytes that are not UTF-8, or a callback of yours that throws rejects the loop's next step; there is no `error` callback and no `meta.aborted`.
- **Bytes are UTF-8, strictly.** An invalid sequence rejects, where `file.text()` and `response.text()` put U+FFFD. To accept such a file, or to read another encoding, put a `TextDecoderStream` in front and pass the strings (recipes 5 and 6).
- **Results equal `parse` of the whole text,** wherever the chunks split, except for the seven documented differences S1 to S7 in [docs/compatibility.md](compatibility.md): `preview` without quotes, detection on a window, errors per batch, no `meta.aborted`, and batches already delivered when something throws.
- **For input you do not trust,** set `maxRecordLength` and give `delimiter` and `newline` (recipe 4).

[docs/streaming.md](streaming.md) has the recipes: files and URLs, everything at once, cancelling, progress in bytes, keeping a page responsive, a module worker, Node `pipeline`.

## Papa Parse versions

- The tests compare with Papa Parse 5.7.1 (2026-11-11, npm's latest), the version this guide describes, and run Papa's own 5.7.1 test cases.
- `csvloom/papa` follows 5.7.1's `unparse`: an empty array with `columns` writes their header, a record that holds only `null` or `undefined` is left out under `skipEmptyLines: true`, and `escapeFormulae` follows 5.7.1 for arrays and objects.

## Checklist

1. Search your code for `Papa.parse(` and sort each call by the table at the top: a string with a used return value, or anything else.
2. Change the import to `csvloom/papa` and run your tests. An `UnsupportedFeatureError` names an option that needs the rewrite; a `TypeError` about a delimiter or `preview` is P3-a, P3-b or P3-c.
3. In TypeScript, fix what the compiler lists: an unsupported option, or one of the type names that `csvloom/papa` does not declare (the list is at the top).
4. Rewrite file, URL and callback code with `parseStream`.
5. Optionally move to the main entry, and check every `unparse` call for the formula default first.
