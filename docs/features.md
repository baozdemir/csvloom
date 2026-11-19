# Features

Six features. Five are options of one root function, `parseDetailed`, and of `parseStream`; the
sixth changes the main entry's `unparse` default.

- `parse` is not changed by these features: its signature, types and results are what they were
  and it rejects every key below with `TypeError: Unknown parse option "<key>"`.
- `csvloom/papa` is not changed: it ignores these keys as it ignores every unknown key, and its
  `unparse` does not escape formulae by default.
- `parseDetailed(input, config)` takes every option of `parse` and the five keys below. Without one
  of them it returns what `parse` returns, key for key.
- **In a stream:** `parseStream` (`csvloom/stream`) takes the same five keys. What is particular
  to a stream, and the differences from `parseDetailed` (S8-S11), are in `docs/streaming.md`,
  "Features"; "Row validation in a stream" below has its example.
- **Not measured:** what the features cost in time. `parseDetailed` with a feature collects the
  rows first and builds the records after the scan, so it is expected to be slower than `parse`;
  that is an expectation, and no timing run with a feature key was made, in bulk or in a stream.
- **Not published: what the formula-escaping default costs in `unparse`.** The published W1 lane
  (`docs/benchmarks.md`, "Lane W1: `unparse`") passes `escapeFormulae: false`, so that csvloom
  does the work the other writers do. With the default, every cell is also tested against the
  rule; that cost is not in the published numbers.

| Option (`parseDetailed`)               | Default | Adds to the result                                         |
| -------------------------------------- | ------- | ---------------------------------------------------------- |
| `detect: true`                         | `false` | `meta.detected`; `meta.sepLine` when a `sep=` line is read |
| `positions: true`                      | `false` | `line`, `column`, `offset`, `snippet` on errors            |
| `repair: true` or a list of rule names | `false` | `repairs`, `repairCounts`                                  |
| `schema`: a Standard Schema v1 object  | none    | `Schema` errors; `data` holds the valid rows only          |
| `sepLine: true`                        | `false` | `meta.sepLine` when a `sep=` line is read                  |

| Option (`unparse`, main entry) | Default | Effect                                              |
| ------------------------------ | ------- | --------------------------------------------------- |
| `bom: true`                    | `false` | U+FEFF before everything else                       |
| `sepLine: true`                | `false` | `sep=<delimiter>` and the newline before the header |
| `escapeFormulae`               | `true`  | formula-like strings written with `'` and quoted    |

Every example below is a file in `examples/features/`, shown here with the output it prints.
`test/examples.test.ts` runs each one in a fresh `node` on every `npm run check` and compares its
output with the `.txt` file beside it, and checks that this page shows both unchanged. That test
points the example's `csvloom` and `csvloom/stream` imports at `src/`; check 15 of
`npm run test:package` runs them against the packed package on Node 22, 24 and 26, together with
`examples/stream`.

## Dialect detection (`detect`)

```js
import { detect, parse, parseDetailed } from 'csvloom';

// Two title lines above a ';' table whose amounts use a decimal comma.
const text = 'Sales report 2026\nRegion: north\nid;name;amount\n1;Ada;1,5\n2;Grace;2,25\n';

const found = detect(text);
console.log(
  JSON.stringify({
    delimiter: found.delimiter,
    newline: found.newline,
    header: found.header,
    preamble: found.preamble,
    preambleLines: found.preambleLines,
    start: found.start,
    columns: found.columns,
  }),
);

// detect: true parses the table detect found. The header guess is only reported: header is
// given here, as it must be.
const detailed = parseDetailed(text, { detect: true, header: true, skipEmptyLines: true });
console.log(JSON.stringify(detailed.data));
console.log(JSON.stringify(detailed.meta.detected?.preamble));

// What parse makes of the same text: the first title line becomes the header.
const plain = parse(text, { header: true, skipEmptyLines: true });
console.log(JSON.stringify(plain.meta.fields), plain.errors.length, 'errors');

// Bytes: the encoding is reported; nothing but UTF-8 is decoded.
console.log(JSON.stringify(detect(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).encoding));
console.log(JSON.stringify(detect(new TextEncoder().encode('a;b\n1;2\n')).encoding));
```

```text
{"delimiter":";","newline":"\n","header":true,"preamble":"Sales report 2026\nRegion: north\n","preambleLines":2,"start":32,"columns":3}
[{"id":"1","name":"Ada","amount":"1,5"},{"id":"2","name":"Grace","amount":"2,25"}]
"Sales report 2026\nRegion: north\n"
["Sales report 2026"] 3 errors
{"name":"utf-16le","evidence":"bom"}
{"name":"utf-8","evidence":"valid"}
```

**What is detected.** `detect(input)` scores readings of the first 65,536 UTF-16 units of the text
(after a BOM and a `sep=` line, cut after the last line break in them): each delimiter of
`delimitersToGuess` (default `,`, tab, `|`, `;`, U+001E, U+001F), the quote `"` or `'` (`'` only
when the sample holds one), and a doubled quote or `\` as the escape (`\` only where the sample
holds it before that quote). A reading scores high when most records have the same number of
fields and most cells look like values (empty, numbers, dates, times, or text without a delimiter
or quote). The newline is guessed as `parse` guesses it. `columns` is the most frequent field count;
`candidates` holds the five best readings, the winner first.

**What is only reported.** `header` is a guess and is never applied: give `header` yourself, as the
example does (the type of the rows depends on it). For a `Uint8Array`, `encoding` says what the
bytes look like (`utf-8`, `utf-16le` or `utf-16be` by their BOM, `utf-8` when the first 262,144
bytes are valid UTF-8, else `unknown` with the offset of the first bad byte); nothing but UTF-8 is
decoded, and for any other encoding the dialect fields are the defaults with `score` 0.

**The preamble.** Title lines above the table are skipped only while each line holds no delimiter
outside quotes and does not end inside a quoted cell, at most 20 lines, and never when the table
found has one column. "Delimiter" means the given one when `delimiter` or a `sep=` line gives it,
else every candidate. The skipped text is returned whole in `meta.detected.preamble`, and
`meta.detected.start` is where the table starts in the input as given. A line holding the chosen
delimiter outside quotes is never skipped; a one-field line above a wider table is skipped and
reported, even if it was meant as data.

**Explicit options win.** A `delimiter`, `newline`, `quoteChar`, `escapeChar` or `skipFirstNLines`
that is given (any value but `undefined`; `skipFirstNLines: 0` too) is used, and the other keys are
still detected. `delimiter: ''` and `newline: ''` mean "detect", as in `parse`. With
`skipFirstNLines` given, the lines are skipped as `parse` skips them and detection reads the rest
as the table, with no preamble.

**Reading `meta.detected`.** It is the `Detection` that was found. `meta.delimiter` and
`meta.linebreak` hold what was used: they differ from it where an option was given, or where
`repair`'s `mixed-newline` rule changed the newline. `meta.cursor` and `Quotes.index` count from
the start of the table, as they count from the end of skipped lines in `parse`.
`UndetectableDelimiter` is never reported under `detect: true`: a one-column input gets `,` with
`columns: 1` and `score: 0`, which is how to see that nothing was found.

**Measured, and its limits.** On Pollock's `polluted_files` (commit `bd2a646f`): 2,290 variants of
**one** designed source file, so these numbers measure robustness to pollution, not variety of real
dialects. The `survey` files are not used (no license per file). Computed here with upstream's
evaluator; not submitted to or confirmed by the benchmark's authors.

| Measure (held-out half, 1,102 files, scored once)                  | `parse`'s guess | `detect` |
| ------------------------------------------------------------------ | --------------- | -------- |
| Delimiter, quote and escape all as `polluted_files/parameters` say | 1,098           | 1,099    |
| `pollock_simple` (at most 10)                                      | 9.937769        | 9.937977 |

On all 2,290 files, `pollock_simple` / `pollock_weighted`: `parse`'s guess 9.932604 / 9.439044,
`detect` 9.934627 / 9.449982, `detect` with `repair` 9.951767 / 9.468313, and the files' own
parameters 9.942610 / 9.839949. `detect` scores lower than the guess on one file
(`row_field_delimiter_0_0x20.csv`: its space-separated header line holds no candidate delimiter, so
it is skipped as a preamble), higher on 3, equal on 2,286. On the held-out half `detect` gets the
dialect wrong on 3 files and the guess on 4; both on `file_field_delimiter_0x20.csv`, whose space
delimiter is not a candidate, where `detect` also takes `'` as the quote. The 65,536-unit sample
is an assumption: no corpus file is longer than 43 KB.

## Positions on errors (`positions`, `formatError`)

```js
import { formatError, parseDetailed } from 'csvloom';

// A BOM, one line to skip, a short record on line 4 and a quote that never closes on line 5.
const text = '\ufeffexported 2026-11-12\nid,name,city\n1,Ada,London\n2,Grace\n3,Linus,"Helsinki\n';
const result = parseDetailed(text, { header: true, skipFirstNLines: 1, positions: true });

for (const error of result.errors) {
  console.log(formatError(error));
  console.log(JSON.stringify(error));
}

// offset and line count the input as given: the BOM and the skipped line too. index and
// meta.cursor keep their meaning: they count from the text after the BOM and the skipped lines.
const quote = result.errors.find((error) => error.type === 'Quotes');
console.log('offset', quote?.offset, 'index', quote?.index, 'cursor', result.meta.cursor);

// offset and column are UTF-16 units. The UTF-8 byte offset of the same place:
const bytes = new TextEncoder().encode(text.slice(0, quote?.offset)).length;
console.log('UTF-8 byte offset', bytes);
```

```text
Quoted field unterminated [MissingQuotes] at line 5, column 9 (row 3, offset 63)
  5 | 3,Linus,"Helsinki
    |         ^
{"type":"Quotes","code":"MissingQuotes","message":"Quoted field unterminated","row":3,"index":43,"line":5,"column":9,"offset":63,"snippet":"3,Linus,\"Helsinki"}
Too few fields: expected 3 fields but parsed 2 [TooFewFields] at line 4, column 1 (row 1, offset 47)
  4 | 2,Grace
    | ^
{"type":"FieldMismatch","code":"TooFewFields","message":"Too few fields: expected 3 fields but parsed 2","row":1,"line":4,"column":1,"offset":47,"snippet":"2,Grace"}
offset 63 index 43 cursor 52
UTF-8 byte offset 65
```

**Units.** `line` is 1-based and counts physical lines: `\r\n`, `\n` and `\r` each end one, inside
quotes too. `column` is 1-based and `offset` 0-based, both in UTF-16 units. They are measured on the
input as given: a BOM, skipped lines, a `sep=` line and a detected preamble all count. `snippet` is
the line; a line longer than 120 units is cut to the 120 around the column, with `…` at the cut,
never inside a surrogate pair.

**Where.** A `Quotes` error is at its field's opening quote; a `FieldMismatch` or `Schema` error
where its record starts. `UndetectableDelimiter` has no place and gains nothing. Without
`positions: true` no error has the four keys.

**Old keys keep their meaning.** `row`, `index` and `meta.cursor` are what `parse` gives: `index`
and `cursor` count from the text after the BOM, the skipped lines, a `sep=` line and a detected
preamble, which is why they differ from `offset` in the example.

**Bytes.** For a UTF-8 byte offset, encode the text before the place, as the example does:
`new TextEncoder().encode(input.slice(0, error.offset)).length`.

**`formatError(error)`** returns `<message> [<code>] at line <line>, column <column> (row <row>,
offset <offset>)`, then the line and a caret under the unit at `offset`; without a position,
`<message> [<code>] (row <row>)`, or `<message> [<code>]` when the error has no `row`.

**Cost.** With no error there is no second scan. With errors, the text up to the last error is
scanned a second time to find where their records start.

## Repair (`repair`)

```js
import { parseDetailed } from 'csvloom';

// CRLF and LF mixed, a short record, empty extra fields, and a quote that never closes.
const text = 'id,name,city\r\n1,Ada\r\n2,Grace,New York,,\r\n3,Linus,Helsinki\n4,"Alan,Wilmslow\n';
const result = parseDetailed(text, { header: true, repair: true });

console.log(JSON.stringify(result.data));
console.log(JSON.stringify(result.errors));
// The log is the feature: every change, where it was, what it was and what it became.
for (const entry of result.repairs ?? []) {
  const { rule, row, line, column, before, after } = entry;
  console.log(JSON.stringify({ rule, row, line, column, before, after }));
}
console.log(JSON.stringify(result.repairCounts));

// The width comes from the header record. A header with one delimiter too many pads every record.
const broken = parseDetailed('id,name,\n1,Ada\n2,Grace\n', { header: true, repair: true });
console.log(JSON.stringify(broken.meta.fields), JSON.stringify(broken.data));
console.log(JSON.stringify(broken.repairCounts));
```

```text
[{"id":"1","name":"Ada","city":""},{"id":"2","name":"Grace","city":"New York"},{"id":"3","name":"Linus","city":"Helsinki"},{"id":"4","name":"\"Alan","city":"Wilmslow"}]
[]
{"rule":"mixed-newline","row":-1,"line":1,"column":1,"before":"id,name,city\r","after":[["id","name","city"]]}
{"rule":"mixed-newline","row":0,"line":2,"column":1,"before":"1,Ada\r","after":[["1","Ada"]]}
{"rule":"pad-missing","row":0,"line":2,"column":1,"before":"1,Ada\r","after":[["1","Ada",""]]}
{"rule":"mixed-newline","row":1,"line":3,"column":1,"before":"2,Grace,New York,,\r","after":[["2","Grace","New York","",""]]}
{"rule":"drop-trailing-empty","row":1,"line":3,"column":1,"before":"2,Grace,New York,,\r","after":[["2","Grace","New York"]]}
{"rule":"unclosed-quote","row":3,"line":5,"column":1,"before":"4,\"Alan,Wilmslow","after":[["4","\"Alan","Wilmslow"]]}
{"rule":"trailing-empty-record","row":-1,"line":5,"column":17,"before":"\n","after":[]}
{"pad-missing":1,"drop-trailing-empty":1,"trailing-empty-record":1,"mixed-newline":3,"unclosed-quote":1}
["id","name",""] [{"id":"1","name":"Ada","":""},{"id":"2","name":"Grace","":""}]
{"pad-missing":2,"drop-trailing-empty":0,"trailing-empty-record":1,"mixed-newline":0,"unclosed-quote":0}
```

**Read `repairs`: the log is the feature.** Each entry says which rule changed which record,
where (`line`, `column`, `offset`, `snippet`, also without `positions`), what the span was
(`length`, and its first 256 units in `before`) and what it became (`after`). Replacing each logged
span of the input by its `after` (fields joined by the delimiter, rows by the newline, quoted where
needed) gives a text that parses to the same `data`. `repairs` holds the first 10,000 entries;
`repairCounts` counts every change per rule. An issue a rule repaired is not in `errors`; `errors`
describe the repaired rows. `repair: true` applies every rule; a list such as
`repair: ['pad-missing']` applies those named.

| Rule                    | When                                                                                       | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `unclosed-quote`        | A quoted field never closes and takes the rest of the input (`MissingQuotes`)              | The line of its opening quote is read again with quotes as ordinary characters; at most 100 per parse         |
| `mixed-newline`         | `newline` omitted, and two kinds of line break outside quotes in the first 1,048,576 units | Scans with `\n` if a lone `\n` exists, else `\r\n`; removes a `\r` before a line break; splits at a lone `\r` |
| `trailing-empty-record` | The input ends with a line break, which leaves a last record `['']`                        | Removes that record; the logged span is the line break                                                        |
| `drop-trailing-empty`   | A record has more than `W` fields and every extra field is empty                           | Cuts it to `W` fields                                                                                         |
| `pad-missing`           | A record has fewer than `W` fields                                                         | Appends empty fields up to `W`; `dynamicTyping` and `transform` see them as written empty fields              |

**Never repaired:** a record with an extra field that is not empty (it stays `TooManyFields` with
`header: true`); a quote followed by other text inside a closed quoted field (`InvalidQuotes`: the
intended data cannot be known); line breaks under a given `newline`. A CRLF file whose only `\n`
are inside quoted cells, as spreadsheet exports write them, does not trigger `mixed-newline`.

**The width `W` comes from the header record** with `header: true` (after `transformHeader` and
renaming), else from the first record `skipEmptyLines` keeps. When the header record is itself the
broken line, every record is reshaped to it: the last two lines of the example pad every record to
a header with one delimiter too many. On Pollock's files, `repair` scored lower than `detect` alone
on 22 of 2,290 files; 20 of them are this case (82 or 83 records padded or cut each), and the other
2 have a wrong dialect in both arms. It scored higher on 2,266, each with `trailing-empty-record`,
1,143 with one `pad-missing` and 761 with one `drop-trailing-empty`; the share of each rule in the
gain was not measured.

**Other limits.**

- Two rules on one record log two entries with the same span; the later `after` is the final row
  (the example's record `1,Ada`).
- `unclosed-quote` keeps the quote character in the field (`"Alan` in the example) and scans the
  rest of the input again after each line it reads again, so up to 100 repairs cost up to about
  100 scans. A `\r` at the end of such a line stays in its last field: `mixed-newline` does not
  touch a line `unclosed-quote` read again.
- `mixed-newline` keeps a re-read only if it raises no quote error and changes nothing but `\r`s;
  otherwise the record and its error stay.
- With `preview`, `data` is what `parse` gives for the repaired text, so a split record is cut at
  the limit; `unclosed-quote` is then not applied, and `trailing-empty-record` only when the last
  record of the input was read.

## Excel (`bom`, `sepLine`, `excel`, `excelSemicolon`)

```js
import { excel, excelSemicolon, parse, parseDetailed, unparse } from 'csvloom';

const rows = [
  ['name', 'city', 'amount'],
  ['Çağrı Işık', 'İstanbul', '1,5'],
  ['Zoë', 'Zürich', '=SUM(A1:A2)'],
];
// The BOM is shown as [BOM] here; the file holds the character U+FEFF.
const show = (csv) => JSON.stringify(csv.replace(/^\ufeff/, '[BOM]'));

// A reader whose list separator is ",": a BOM, CRLF, ",", formula escaping.
const comma = unparse(rows, excel);
console.log(show(comma));
// A reader whose list separator is ";" (where the decimal separator is a comma).
console.log(show(unparse(rows, excelSemicolon)));
// A "sep=" line names the delimiter in the file itself.
const withLine = unparse(rows, { sepLine: true, delimiter: ';' });
console.log(show(withLine));

// Reading them back: parse removes the BOM; parseDetailed with sepLine reads the line.
console.log(JSON.stringify(parse(comma).data));
const read = parseDetailed(withLine, { sepLine: true });
console.log(JSON.stringify(read.data), read.meta.delimiter, read.meta.sepLine);
```

```text
"[BOM]name,city,amount\r\nÇağrı Işık,İstanbul,\"1,5\"\r\nZoë,Zürich,\"'=SUM(A1:A2)\""
"[BOM]name;city;amount\r\nÇağrı Işık;İstanbul;1,5\r\nZoë;Zürich;\"'=SUM(A1:A2)\""
"sep=;\r\nname;city;amount\r\nÇağrı Işık;İstanbul;1,5\r\nZoë;Zürich;\"'=SUM(A1:A2)\""
[["name","city","amount"],["Çağrı Işık","İstanbul","1,5"],["Zoë","Zürich","'=SUM(A1:A2)"]]
[["name","city","amount"],["Çağrı Işık","İstanbul","1,5"],["Zoë","Zürich","'=SUM(A1:A2)"]] ; true
```

**Which preset.** `excel` and `excelSemicolon` are frozen `unparse` options to spread:
`{ bom: true, newline: '\r\n', delimiter: ',', escapeFormulae: true }`, and the same with `';'`.
Excel is reported to split a double-clicked CSV file at the system's list separator, which is `;`
where the decimal separator is a comma (Turkish and German settings, for example): `excelSemicolon`
is for those readers, `excel` for the others. csvloom does not look up a locale.

**`bom` or `sepLine`.** `bom: true` writes U+FEFF first; `sepLine: true` writes `sep=<delimiter>`
and the newline before the header (the delimiter must then be one UTF-16 unit); both together
write the BOM first. A file with a `sep=` line is read back with
`parseDetailed(text, { sepLine: true })`, where an explicit `delimiter` still wins over the line;
`parse` reads that line as a record, as Papa Parse does. `parse` already removes a BOM.

**What Excel did with these files, on one machine.** A manual check (2026-11-14) opened four files written by `unparse` the way a double-click opens them, in Excel
for Mac 16.115 on macOS 15.6.1, in a region whose decimal separator is `.`. With `bom: true`,
the Turkish letters, `Zoë` and `東京` showed correctly and each row split into three columns. With
`sepLine: true`, alone or after a BOM, the `sep=,` line was not shown and the rows split into
three columns, but the letters were garbled as if the file were Mac Roman (`Şehir` showed as
`≈ûehir`): the BOM was ignored. That is why the presets set `bom` and not `sepLine`. Not checked:
Excel on Windows, other Excel versions, a region whose list separator is `;` (so `excelSemicolon`
has not been opened in Excel), and importing a file (Data, From Text/CSV), which is reported to
let the user choose the delimiter and the encoding. The tests show something narrower:
csvloom reads back what it wrote, for the values in `test/excel.test.ts`.

## Row validation (`schema`)

```js
import { parseDetailed } from 'csvloom';

// A hand-written Standard Schema v1 object; a schema from any library that implements the
// specification is used the same way.
const person = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(row) {
      const issues = [];
      if (typeof row.name !== 'string')
        issues.push({ message: 'name is required', path: ['name'] });
      if (!Number.isInteger(row.age))
        issues.push({ message: 'age must be a whole number', path: ['age'] });
      return issues.length > 0 ? { issues } : { value: { name: row.name, age: row.age } };
    },
  },
};

const text = 'name,age\nAda,36\nGrace,x\n,41\nLinus,28\n';
// dynamicTyping runs first, so the validator sees 36 as a number and an empty field as null.
const result = parseDetailed(text, {
  header: true,
  dynamicTyping: true,
  skipEmptyLines: true,
  schema: person,
});

console.log(JSON.stringify(result.data));
// An invalid row leaves data and is kept whole in its error's value; row counts every row parsed.
for (const error of result.errors) console.log(JSON.stringify(error));
```

```text
[{"name":"Ada","age":36},{"name":"Linus","age":28}]
{"type":"Schema","code":"InvalidRow","message":"age must be a whole number","row":1,"path":["age"],"value":{"name":"Grace","age":"x"}}
{"type":"Schema","code":"InvalidRow","message":"name is required","row":2,"path":["name"],"value":{"name":null,"age":41}}
```

**The interface.** `schema` takes any Standard Schema v1 object: `schema['~standard'].validate(row)`
is called as a method, with one argument, and `value`, `issues`, `message` and `path` are read. No
validator library is a dependency; csvloom declares a structural copy of the specification's
types (`StandardSchemaV1`, MIT notice in `dist/types.d.ts`). The rows of `data` take the schema's
output type:

```ts
import { parseDetailed, type StandardSchemaV1 } from 'csvloom';

declare const person: StandardSchemaV1<unknown, { name: string; age: number }>;
const { data } = parseDetailed(text, { header: true, dynamicTyping: true, schema: person });
// data: { name: string; age: number }[]
```

A schema from a library that implements the specification is passed the same way. The Zod-style
snippet below is not run here, because csvloom has no validator dependency:

```ts
import { z } from 'zod';

const Person = z.object({ name: z.string().min(1), age: z.coerce.number().int() });
const { data, errors } = parseDetailed(text, { header: true, schema: Person });
```

**Typed values: `dynamicTyping` first, or coercion in the schema.** The validator receives the row
as `header`, `transform` and `dynamicTyping` built it. Without them every value is a string (and
an empty field is `''`); with `dynamicTyping: true`, `36` arrives as a number and an empty field as
`null`, as in the example. Either convert in the schema (as `z.coerce` does) or let
`dynamicTyping` convert first.

**Where invalid rows go.** A row with issues leaves `data` and is kept whole in the `value` of its
`Schema` errors, one per issue (one with the message
`Schema validation failed without an issue` when the result has none). `row` counts every row
parsed, valid or not, so it indexes the rows as parsed, not `data`. `Schema` errors come after the
others (`Quotes`, `Delimiter`, `FieldMismatch`); with `positions: true` they have the position of
their record.

**Limits.**

- `parseDetailed` is synchronous: a validator that returns a `Promise` makes it throw
  `TypeError('Parse option "schema" returned a Promise; use parseStream for an async validator')`
  and return nothing (the promise gets a handler first, so its rejection is not unhandled).
  `parseStream` awaits such a validator ("Row validation in a stream" below).
- The record `['']` that a final line break leaves is a row like any other and is validated; use
  `skipEmptyLines: true` (as the example does) or `repair: ['trailing-empty-record']`.
- The validator is not called for the header record, comment lines or records `skipEmptyLines`
  removes. What it throws propagates out of `parseDetailed`, as from `transform`.
- Types: a config held in a variable typed `DetailedConfig | undefined` gives `unknown[]` rows, as
  the schema's output cannot be known there.

### Row validation in a stream

`parseStream` takes the same `schema`, and there its validator may answer later:

```js
import { parseDetailed } from 'csvloom';
import { parseStream } from 'csvloom/stream';

// A validator that answers later: a Standard Schema v1 object whose validate returns a promise.
const person = {
  '~standard': {
    version: 1,
    vendor: 'example',
    async validate(row) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const issues = [];
      if (typeof row.name !== 'string')
        issues.push({ message: 'name is required', path: ['name'] });
      if (!Number.isInteger(row.age))
        issues.push({ message: 'age must be a whole number', path: ['age'] });
      return issues.length > 0 ? { issues } : { value: { name: row.name, age: row.age } };
    },
  },
};

// The source arrives in pieces, and a piece can end inside a record.
const chunks = ['name,age\nAda,36\nGra', 'ce,x\n,41\nLinus,2.5\nAl', 'an,41\n'];
const config = {
  header: true,
  dynamicTyping: true,
  skipEmptyLines: true,
  positions: true,
  schema: person,
};

// A batch is built from batchSize rows (fewer once its text reaches 1,048,576 units) and then
// validated, one row at a time and in input order:
// data holds the valid rows, so it can hold fewer than batchSize, or none.
for await (const batch of parseStream(chunks, { ...config, batchSize: 2 })) {
  const { rowOffset, done } = batch.meta;
  console.log(JSON.stringify(batch.data), 'rowOffset', rowOffset, 'done', done);
  for (const error of batch.errors) console.log(JSON.stringify(error));
}

// parseDetailed is synchronous: the same schema makes it throw.
try {
  parseDetailed(chunks.join(''), config);
} catch (error) {
  console.log(`${error.name}: ${error.message}`);
}
```

```text
[{"name":"Ada","age":36}] rowOffset 0 done false
{"type":"Schema","code":"InvalidRow","message":"age must be a whole number","row":1,"path":["age"],"value":{"name":"Grace","age":"x"},"line":3,"column":1,"offset":16,"snippet":"Grace,x"}
[] rowOffset 2 done false
{"type":"Schema","code":"InvalidRow","message":"name is required","row":2,"path":["name"],"value":{"name":null,"age":41},"line":4,"column":1,"offset":24,"snippet":",41"}
{"type":"Schema","code":"InvalidRow","message":"age must be a whole number","row":3,"path":["age"],"value":{"name":"Linus","age":2.5},"line":5,"column":1,"offset":28,"snippet":"Linus,2.5"}
[{"name":"Alan","age":41}] rowOffset 4 done true
TypeError: Parse option "schema" returned a Promise; use parseStream for an async validator
```

- **A batch is validated before it is delivered,** one row at a time and in input order; a promise
  is awaited, and nothing is read from the source meanwhile.
- **A batch can hold fewer rows than `batchSize`, or none.** It is built from `batchSize` rows, or
  fewer once its text reaches 1,048,576 units (`docs/streaming.md`), and holds the valid ones (the second batch above holds none), and it is delivered either way, with
  its errors. `meta.rowOffset`, and `row` in the errors, count the rows as built, valid or not.
- **With `positions`** each `Schema` error has the place of its record in the source's text,
  whatever the chunks.
- **A validator that throws or rejects** ends the stream: that `next()` rejects with the same
  object and the source is closed.

The tests that pin each of these, and the rest of what a stream does with the five keys, are named
in `docs/streaming.md`, "Features".

## Formula escaping in `unparse` (CSV injection)

```js
import { parse, unparse } from 'csvloom';

const rows = [
  ['note', 'phone', 'change'],
  ['=1+1', '+90 555 123 45 67', '-5'],
  ['@handle', '-abc', '+1.5'],
  ['-', 'plain text', '-2e3'],
];

// The default: a value that starts with = + - @, a tab, CR, LF or a full-width ＝ ＋ － ＠ is
// written with ' before it and quoted, unless the whole value is a plain number.
const safe = unparse(rows);
console.log(JSON.stringify(safe));
// Opt out: the values as they are.
console.log(JSON.stringify(unparse(rows, { escapeFormulae: false })));
// Reading the escaped text back gives each rewritten value with its ' in front.
console.log(JSON.stringify(parse(safe).data));
// A RegExp is used as given, with no number exemption.
console.log(JSON.stringify(unparse([['-5', 'x']], { escapeFormulae: /^-/ })));
```

```text
"note,phone,change\r\n\"'=1+1\",\"'+90 555 123 45 67\",-5\r\n\"'@handle\",\"'-abc\",+1.5\r\n\"'-\",plain text,-2e3"
"note,phone,change\r\n=1+1,+90 555 123 45 67,-5\r\n@handle,-abc,+1.5\r\n-,plain text,-2e3"
[["note","phone","change"],["'=1+1","'+90 555 123 45 67","-5"],["'@handle","'-abc","+1.5"],["'-","plain text","-2e3"]]
"\"'-5\",x"
```

**The rule.** The main entry's `unparse` writes `'` before a value and quotes it when the value
starts with `=`, `+`, `-`, `@`, a tab, a carriage return, a line feed, or a full-width `＝`, `＋`,
`－` or `＠` (the first characters OWASP's CSV Injection page lists, read 2026-11-11), unless the
whole value is a plain number: `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/`, such as `-5`,
`+1.5`, `-2e3`. Strings are tested, and arrays, wrapper objects, other objects, functions and
symbols by their string form (D2-i); numbers, bigints, booleans, `null`, `undefined` and `Date`
values are not. Header cells
are tested like values. A `quotes` function is not called for a value that was prefixed.

**Default on.** On real files the default rewrites few cells: 594 of 910,064 cells of the NGA text entries (489 starting with a carriage return or
line feed, 105 copies of one note starting `--`), 0 of 3,261,426 in GeoNames (the number exemption keeps 84,391
signed numbers such as `-61.7093`), 2 of 1,384,040 in the Tate artwork data, 0 of 1,728,990 in
Pollock's clean files, and no header cell. Those files
hold no phone numbers, handles, `@timestamp` headers or finance values, which the strings below
are.

**Opt out** with `escapeFormulae: false`: every value is written as it is. A
`RegExp` is used as given, with no number exemption. `csvloom/papa` is unchanged; Papa's default
is off.

**What it rewrites that is not a formula.** `unparse(parse(text).data)` keeps signed numbers as
written, but these strings come back with `'` in front: `-`, `-abc`, `+90 555 123 45 67`, `-3%`,
`+5.2%`, `-1,234.56`, `-1,5`, `@handle`, a header `@timestamp`, `=1`, a value that starts with a
tab or a line feed, and `＝1`. `-5`, `+1.5` and `-2e3` are left alone. Pass `escapeFormulae: false`
where such values must stay unchanged.

**A mitigation, not a guarantee.** OWASP's page (snapshot 2026-11-11) says that the `'` technique
is "not reliable in Microsoft Excel after saving and re-opening the CSV file", gives a tab inside
the quoted field as its Excel-resistant alternative (which then stays part of the data), and that
"There is no universal CSV sanitization strategy that is safe for all spreadsheet applications
and all downstream consumers." csvloom writes the `'` form only. In the manual Excel check
above, the cells `'=1+1`, `'@x`, `'-abc` and `'+90 555 123 45 67` showed as text with the `'`
visible and part of the value (`LEN` of `'=1+1` is 5), none ran as a formula, and `-5` stayed a
number. After a copy was saved as CSV in Excel and opened again, `'=1+1` was still text. That is
one Excel version and four values, not the general case OWASP warns about.
