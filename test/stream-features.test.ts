import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { parseDetailed } from '../src/detailed.ts';
import { detect } from '../src/detect.ts';
import { parseStream } from '../src/stream.ts';
import type {
  DetailedConfig,
  ParseBatch,
  ParseError,
  Repair,
  RepairRule,
  SchemaError,
  StandardSchemaV1,
  StreamConfig,
  StreamSource,
} from '../src/types.ts';
import {
  byteSplits,
  checkFeatures,
  drawn,
  featureDifference,
  featureReference,
  splits,
} from './stream-split.ts';

// The features of parseDetailed in parseStream (differences S8-S11 in docs/compatibility.md). The
// reference is parseDetailed on the whole text.

type Batch = ParseBatch<unknown, ParseError | SchemaError>;

const SEED = 20261115;
const PER_DIALECT = 56;
const BATCH_SIZES = [1, 2, 3, 1024];
const RULES: readonly RepairRule[] = [
  'pad-missing',
  'drop-trailing-empty',
  'trailing-empty-record',
  'mixed-newline',
  'unclosed-quote',
];

const encoder = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

async function collect(source: StreamSource, config: StreamConfig): Promise<Batch[]> {
  const batches: Batch[] = [];
  for await (const batch of parseStream(source, config)) batches.push(batch);
  return batches;
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const sumCounts = (batches: readonly Batch[]) =>
  Object.fromEntries(
    RULES.map((rule) => [
      rule,
      batches.reduce((sum, batch) => sum + (batch.repairCounts?.[rule] ?? 0), 0),
    ]),
  );

/**
 * A synchronous schema that depends on the row only: by the length of the row's text, it gives
 * one issue with a path, two issues (one without a path), a changed output, or the row.
 */
const fuzzSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const kind = inspect(value, { depth: 3 }).length % 7;
      if (kind === 0) return { issues: [{ message: 'seven', path: [0, { key: 'k' }] }] };
      if (kind === 1) return { issues: [{ message: 'first' }, { message: 'second', path: [] }] };
      if (kind === 2) return { value: { row: value } };
      return { value };
    },
  },
};

const FEATURE_SETS: ReadonlyArray<readonly [string, DetailedConfig]> = [
  ['positions', { positions: true }],
  ['repair', { repair: true }],
  ['schema', { schema: fuzzSchema }],
  ['detect', { detect: true }],
  ['sepLine', { sepLine: true }],
  ['all five', { positions: true, repair: true, schema: fuzzSchema, detect: true, sepLine: true }],
];

/** Inputs with what the features read: a BOM, a "sep=" line, a preamble, mixed line breaks, short and long rows, an open quote. */
function shaped(random: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const delimiter = pick([',', ';', '\t', '|']);
  const newline = pick(['\n', '\r\n', '\r']);
  const other = pick(['\n', '\r\n', '\r']);
  let text = random() < 0.3 ? '﻿' : '';
  if (random() < 0.4) text += `sep=${delimiter}${pick([newline, '\n', ''])}`;
  if (random() < 0.3) text += `Report${newline}${random() < 0.5 ? newline : ''}`;
  const width = 1 + Math.floor(random() * 4);
  const count = Math.floor(random() * 7);
  for (let r = 0; r < count; r++) {
    const n = Math.max(0, width + pick([0, 0, 0, -1, 1, 2]));
    const cells = Array.from({ length: n }, (_, c) =>
      pick(['', 'x', '1', '2.5', `"q${delimiter}"`, '"a""b"', ' ', `c${String(c)}`, '\r', '#']),
    );
    if (r >= width && random() < 0.3) cells.push('', '');
    text += cells.join(delimiter) + (random() < 0.25 ? other : newline);
  }
  const tail = random();
  if (tail < 0.2) text += `"open${delimiter}x${newline}y`;
  else if (tail < 0.45) text += `z${delimiter}9`;
  else if (tail < 0.6) text += '"w"  ' + newline;
  return text;
}

const SHAPED_CONFIGS: readonly DetailedConfig[] = [
  {},
  { header: true },
  { header: true, skipEmptyLines: true },
  { skipEmptyLines: 'greedy', dynamicTyping: true },
  { header: true, newline: '\n', delimiter: ',' },
  { preview: 3 },
  { header: true, preview: 2, skipEmptyLines: true },
  { comments: '#', header: true },
  { skipFirstNLines: 1 },
  { fastMode: true, preview: 2, comments: '#' },
  { header: true, transformHeader: (name: string) => name.trim(), skipEmptyLines: 'greedy' },
  { delimiter: ';', newline: '\r\n', header: true },
];

interface Coverage {
  inputs: number;
  runs: number;
  throwing: number;
  early: number;
  s2: number;
}

/** Every string split and every byte split of one input, with `random` cuts; a lone surrogate's byte runs are judged on their own text. */
async function everySplit(
  input: string,
  config: DetailedConfig,
  batchSize: number,
  random: () => number,
  coverage: Coverage,
  failures: unknown[],
  label: string,
) {
  const bytes = encoder.encode(input);
  const decoded = decode(bytes);
  const stringRuns = [[input], ...splits(input, random, 3)];
  const byteRuns = [[bytes], ...byteSplits(bytes, random, 3)];
  const groups: Array<[string, ReadonlyArray<ReadonlyArray<string | Uint8Array>>]> =
    decoded === input
      ? [[input, [...stringRuns, ...byteRuns]]]
      : [
          [input, stringRuns],
          [decoded, byteRuns],
        ];
  coverage.inputs++;
  for (const [text, runs] of groups) {
    const check = await checkFeatures(text, config, batchSize, runs);
    coverage.runs += check.splits;
    coverage.early += check.early;
    if (check.throwing) coverage.throwing++;
    if (check.s2) coverage.s2++;
    if (check.failure !== null && failures.length < 5) {
      failures.push({ label, ...check.failure, text, config, batchSize });
    }
  }
}

describe(`parseStream with features equals parseDetailed at every split (seed ${String(SEED)})`, () => {
  const CASES = drawn(SEED, PER_DIALECT);

  it('draws at least 2,000 inputs', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(2000);
  });

  it.each(FEATURE_SETS)(
    '%s: the seeded fuzz inputs under every overlay, string chunks at every split and UTF-8 bytes at every byte split: rules (a)-(d) with S4, S8 and S10, callback calls and thrown messages',
    async (label, features) => {
      const random = mulberry32(SEED + 1);
      const failures: unknown[] = [];
      const coverage: Coverage = { inputs: 0, runs: 0, throwing: 0, early: 0, s2: 0 };
      for (const { input, config } of CASES) {
        const batchSize = BATCH_SIZES[Math.floor(random() * BATCH_SIZES.length)] ?? 1;
        await everySplit(
          input,
          { ...config, ...features },
          batchSize,
          random,
          coverage,
          failures,
          label,
        );
      }
      expect(failures).toStrictEqual([]);
      expect(coverage.inputs).toBe(CASES.length);
      expect(coverage.runs).toBeGreaterThan(200_000);
      // S2 never applies to these inputs, so no reference is a windowed one.
      expect(coverage.s2).toBe(0);
    },
    1_800_000,
  );

  it.each(FEATURE_SETS)(
    '%s: 1,200 inputs shaped for the features (BOM, "sep=" line, preamble, mixed line breaks, short and long rows, an open quote) under twelve configs, every batch size, every split',
    async (label, features) => {
      const random = mulberry32(SEED + 2);
      const failures: unknown[] = [];
      const coverage: Coverage = { inputs: 0, runs: 0, throwing: 0, early: 0, s2: 0 };
      for (let k = 0; k < 1200; k++) {
        const input = shaped(random);
        const config = SHAPED_CONFIGS[k % SHAPED_CONFIGS.length] ?? {};
        const batchSize = BATCH_SIZES[Math.floor(k / SHAPED_CONFIGS.length) % 4] ?? 1;
        await everySplit(
          input,
          { ...config, ...features },
          batchSize,
          random,
          coverage,
          failures,
          label,
        );
      }
      expect(failures).toStrictEqual([]);
      expect(coverage.inputs).toBe(1200);
      expect(coverage.s2).toBe(0);
    },
    1_800_000,
  );

  it('the shaped inputs reach every repair rule, a "sep=" line, a preamble and a Schema error', () => {
    const random = mulberry32(SEED + 2);
    const seen = { sepLine: 0, preamble: 0, schema: 0, quotes: 0, mismatch: 0 };
    const counts = Object.fromEntries(RULES.map((rule) => [rule, 0])) as Record<RepairRule, number>;
    for (let k = 0; k < 1200; k++) {
      const input = shaped(random);
      const config = SHAPED_CONFIGS[k % SHAPED_CONFIGS.length] ?? {};
      const all = parseDetailed(input, { ...config, ...FEATURE_SETS[5]?.[1] });
      for (const rule of RULES) counts[rule] += all.repairCounts?.[rule] ?? 0;
      if (all.meta.sepLine === true) seen.sepLine++;
      if ((all.meta.detected?.preambleLines ?? 0) > 0) seen.preamble++;
      if (all.errors.some((error) => error.type === 'Schema')) seen.schema++;
      const plain = parseDetailed(input, { ...config, positions: true });
      if (plain.errors.some((error) => error.type === 'Quotes')) seen.quotes++;
      if (plain.errors.some((error) => error.type === 'FieldMismatch')) seen.mismatch++;
    }
    for (const rule of RULES) expect([rule, counts[rule] > 20]).toStrictEqual([rule, true]);
    for (const [what, n] of Object.entries(seen))
      expect([what, n > 20]).toStrictEqual([what, true]);
  });
});

describe('detect: bulk and stream agree on meta.detected for inputs longer than the sample', () => {
  // 70,000 units and more: a preamble, then a ";" table whose cells hold commas.
  const table = (rows: number) =>
    'Export of 2026\n\n' +
    'id;name;amount\n' +
    Array.from({ length: rows }, (_, i) => `${String(i)};n,${String(i % 7)};1,5\n`).join('');
  const long = table(6000);

  it('the input is longer than the sample, and detection reads the sample only', () => {
    expect(long.length).toBeGreaterThan(65_536 + 4096);
    const found = detect(long);
    expect([found.delimiter, found.preamble, found.start]).toStrictEqual([
      ';',
      'Export of 2026\n\n',
      16,
    ]);
  });

  it('every split point of the first 80 units, of the 80 around the end of the sample and of the last 40, and every 499th between: the batches equal bulk and each other', async () => {
    const config: DetailedConfig = { detect: true, header: true, positions: true };
    const expected = featureReference(long, config);
    expect(expected.meta.detected).toStrictEqual(detect(long));
    const cuts = new Set<number>();
    for (let k = 1; k <= 80; k++) cuts.add(k);
    for (let k = 65_536 - 40; k <= 65_536 + 40; k++) cuts.add(k);
    for (let k = long.length - 40; k < long.length; k++) cuts.add(k);
    for (let k = 499; k < long.length; k += 499) cuts.add(k);
    let first: Batch[] | undefined;
    const failures: unknown[] = [];
    for (const cut of [0, ...cuts]) {
      const chunks = cut === 0 ? [long] : [long.slice(0, cut), long.slice(cut)];
      const batches = await collect(chunks, config);
      first ??= batches;
      const diff = featureDifference(batches, expected, config, 1024);
      if (diff !== null || !isDeepStrictEqual(batches, first)) failures.push({ cut, diff });
      for (const batch of batches) {
        if (!isDeepStrictEqual(batch.meta.detected, expected.meta.detected)) failures.push({ cut });
      }
    }
    expect(failures).toStrictEqual([]);
    expect(cuts.size).toBeGreaterThan(300);
  }, 600_000);

  it('one unit per chunk, and the UTF-8 bytes in chunks of 1,000: the same batches', async () => {
    const config: DetailedConfig = { detect: true, header: true, repair: true };
    const expected = featureReference(long, config);
    const units = await collect(Array.from(long), config);
    expect(featureDifference(units, expected, config, 1024)).toBeNull();
    const bytes = encoder.encode(long);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 1000) chunks.push(bytes.subarray(at, at + 1000));
    expect(isDeepStrictEqual(await collect(chunks, config), units)).toBe(true);
  }, 600_000);

  it('the first batch comes only when the sample is held: no batch from 65,536 units of a longer source', async () => {
    const config: StreamConfig = { detect: true, batchSize: 1 };
    let reads = 0;
    function* source() {
      for (let at = 0; at < long.length; at += 8192) {
        reads++;
        yield long.slice(at, at + 8192);
      }
    }
    const batches = parseStream(source(), config);
    const first = await batches.next();
    // 9 chunks hold 73,728 units: the "sep=" line's 7, the sample's 65,536 and one more.
    expect(reads).toBe(9);
    expect(first.done).toBe(false);
    await batches.return();
  });
});

describe('absolute positions', () => {
  it('an error in the third 64 KiB chunk has the offset and the line it has in bulk', async () => {
    const line = 'aaaa,bbbb,cccc\r\n';
    const lines = Array.from({ length: 3 * 4096 }, () => line);
    // Inside the third chunk: a short record and a quoted field with a stray quote.
    lines[2 * 4096 + 100] = 'aaaa,bbbbbbbbb\r\n';
    lines[2 * 4096 + 200] = 'aa,"b"x",ccccc\r\n';
    const text = 'h1,h2,h3\r\n' + lines.join('');
    const size = 65_536;
    const chunks = [text.slice(0, size), text.slice(size, 2 * size), text.slice(2 * size)];
    const config: DetailedConfig = { header: true, positions: true };
    const bulk = parseDetailed(text, config);
    const errors = (await collect(chunks, config)).flatMap((batch) => batch.errors);
    const short = errors.find((error) => error.type === 'FieldMismatch');
    const offset = 10 + (2 * 4096 + 100) * 16;
    expect(short).toStrictEqual({
      type: 'FieldMismatch',
      code: 'TooFewFields',
      message: 'Too few fields: expected 3 fields but parsed 2',
      row: 2 * 4096 + 100,
      line: 2 * 4096 + 102,
      column: 1,
      offset,
      snippet: 'aaaa,bbbbbbbbb',
    });
    expect(offset).toBeGreaterThan(2 * size);
    const quote = errors.find((error) => error.type === 'Quotes');
    expect([quote?.line, quote?.column, quote?.offset]).toStrictEqual([
      2 * 4096 + 202,
      4,
      10 + (2 * 4096 + 200) * 16 + 3,
    ]);
    const grouped = ['Quotes', 'FieldMismatch'].flatMap((type) =>
      errors.filter((error) => error.type === type),
    );
    expect(grouped).toStrictEqual(bulk.errors);
    // The stray quote, the short record, and the empty record after the final line break.
    expect(grouped.map((error) => error.code)).toStrictEqual([
      'InvalidQuotes',
      'TooFewFields',
      'TooFewFields',
    ]);
  });

  it('a "\\r\\n" split between two chunks is one line', async () => {
    const config: DetailedConfig = { header: true, positions: true, newline: '\r\n' };
    const batches = await collect(['a,b\r', '\n1\r', '\n2,3,4'], config);
    expect(batches.flatMap((batch) => batch.errors)).toStrictEqual([
      {
        type: 'FieldMismatch',
        code: 'TooFewFields',
        message: 'Too few fields: expected 2 fields but parsed 1',
        row: 0,
        line: 2,
        column: 1,
        offset: 5,
        snippet: '1',
      },
      {
        type: 'FieldMismatch',
        code: 'TooManyFields',
        message: 'Too many fields: expected 2 fields but parsed 3',
        row: 1,
        line: 3,
        column: 1,
        offset: 8,
        snippet: '2,3,4',
      },
    ]);
  });

  // The positions test/positions.test.ts pins for parseDetailed, here at every split of the input.
  it.each([
    ['a BOM', '﻿a,b\n"x', { header: true }, 'MissingQuotes', 5, 2, 1, '"x'],
    [
      'skipped lines',
      'junk\na,b\n1\n',
      { header: true, skipFirstNLines: 1 },
      'TooFewFields',
      9,
      3,
      1,
      '1',
    ],
    [
      'a "sep=" line',
      'sep=;\na;b\n1\n',
      { header: true, sepLine: true },
      'TooFewFields',
      10,
      3,
      1,
      '1',
    ],
    [
      'a "sep=" line and an open quote',
      'sep=;\na;b\n"x',
      { sepLine: true },
      'MissingQuotes',
      10,
      3,
      1,
      '"x',
    ],
    [
      'a detected preamble',
      'Title\r\nSub\nMore\r\na,b\r\n1\r\n',
      { header: true, detect: true },
      'TooFewFields',
      22,
      5,
      1,
      '1',
    ],
    ['a BOM on the line of the error', '﻿"x', {}, 'MissingQuotes', 1, 1, 2, '﻿"x'],
  ] as const)(
    'the offset counts %s: at every split',
    async (_name, input, config, code, offset, line, column, snippet) => {
      const all: DetailedConfig = { ...config, positions: true };
      const bulk = parseDetailed(input, all);
      for (const pieces of [[input], ...splits(input, mulberry32(1), 0)]) {
        const batches = await collect(pieces, all);
        const errors = batches.flatMap((batch) => batch.errors);
        const first = errors.find((error) => error.code === code);
        expect([pieces, first?.offset, first?.line, first?.column, first?.snippet]).toStrictEqual([
          pieces,
          offset,
          line,
          column,
          snippet,
        ]);
        expect(errors).toStrictEqual(bulk.errors);
      }
    },
  );

  // skipFirstNLines guesses "\r" for its lines, the scan guesses "\n", and the first record is the
  // empty one at the "\n" of that "\r\n". positionsAt puts that "\n" on the line after it, whose
  // text is the next record's.
  describe('a first record that is only the "\\n" after a skipped line\'s "\\r"', () => {
    const text = 'skip\r\nb,c\rd\r1,2';
    const rejectAll: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'no' }] }),
      },
    };
    const base = {
      skipFirstNLines: 1,
      delimiter: ',',
      positions: true,
      schema: rejectAll,
    } as const;

    it('bulk: the record is at offset 5, line 2, column 1, and its snippet is the line after the "\\n"', () => {
      const bulk = parseDetailed(text, base);
      expect(bulk.meta.linebreak).toBe('\n');
      expect(bulk.errors).toStrictEqual([
        {
          type: 'Schema',
          code: 'InvalidRow',
          message: 'no',
          row: 0,
          value: [''],
          line: 2,
          column: 1,
          offset: 5,
          snippet: 'b,c',
        },
        {
          type: 'Schema',
          code: 'InvalidRow',
          message: 'no',
          row: 1,
          value: ['b', 'c\rd\r1', '2'],
          line: 2,
          column: 1,
          offset: 6,
          snippet: 'b,c',
        },
      ]);
    });

    it.each([
      ['positions and schema', {}],
      ['with repair', { repair: true }],
      [
        'with repair, header and skipEmptyLines',
        { repair: true, header: true, skipEmptyLines: true },
      ],
      ['with header', { header: true }],
    ] as const)(
      '%s: the stream equals bulk at every split, batchSize 1, 2 and 1024',
      async (_name, extra) => {
        const config: DetailedConfig = { ...base, ...extra };
        const bulk = featureReference(text, config);
        for (const batchSize of [1, 2, 1024]) {
          let first: Batch[] | undefined;
          for (const pieces of [[text], ...splits(text, mulberry32(6), 3)]) {
            const batches = await collect(pieces, { ...config, batchSize });
            expect([pieces, featureDifference(batches, bulk, config, batchSize)]).toStrictEqual([
              pieces,
              null,
            ]);
            first ??= batches;
            expect(batches).toStrictEqual(first);
          }
        }
      },
    );

    it('without repair the batches still close where they close without a feature', async () => {
      for (const batchSize of [1, 2, 3]) {
        const plain = await collect([text], { skipFirstNLines: 1, delimiter: ',', batchSize });
        const located = await collect(Array.from(text), {
          skipFirstNLines: 1,
          delimiter: ',',
          batchSize,
          positions: true,
        });
        expect(located.map((batch) => batch.meta)).toStrictEqual(plain.map((batch) => batch.meta));
        expect(located.map((batch) => batch.data)).toStrictEqual(plain.map((batch) => batch.data));
      }
    });

    it.each([
      ['the line ends at a "\\r"', text, 'b,c'],
      ['the line ends at a "\\n"', 'skip\r\nb,c\nd\re\r', 'b,c'],
      ['the line is empty', 'skip\r\n\rb\r', ''],
      [
        'the line is longer than a snippet',
        `skip\r\n${'x'.repeat(300)}\ry\r`,
        `${'x'.repeat(120)}…`,
      ],
      [
        'a surrogate pair lies at the cut of the snippet',
        `skip\r\n${'x'.repeat(119)}😀${'y'.repeat(50)}\rz\r`,
        `${'x'.repeat(119)}…`,
      ],
    ])(
      'when preview ends the scan at that record, the line after it is read for the snippet (%s): equal to bulk at every split',
      async (_name, input, snippet) => {
        const config = { ...base, preview: 1 } as const;
        const bulk = featureReference(input, config);
        expect(
          bulk.errors.map((error) => [error.offset, error.line, error.column, error.snippet]),
        ).toStrictEqual([[5, 2, 1, snippet]]);
        for (const extra of [{}, { repair: true }] as const) {
          const all: DetailedConfig = { ...config, ...extra };
          const expected = featureReference(input, all);
          let first: Batch[] | undefined;
          for (const pieces of [[input], ...splits(input, mulberry32(7), 3)]) {
            const batches = await collect(pieces, all);
            expect([pieces, featureDifference(batches, expected, all, 1024)]).toStrictEqual([
              pieces,
              null,
            ]);
            first ??= batches;
            expect(batches).toStrictEqual(first);
          }
        }
      },
    );

    it('a source longer than the detection window is read no further than that window, and is closed', async () => {
      // The corner needs the newline to be guessed, which reads 1,048,576 units after the
      // skipped line; the line the snippet shows lies inside them.
      const input = text + '\r' + 'z'.repeat(3 * 1_048_576);
      const config = { ...base, preview: 1 } as const;
      let reads = 0;
      let closed = 0;
      const iterator = {
        next: () =>
          reads * 65_536 < input.length
            ? { done: false as const, value: input.slice(reads * 65_536, ++reads * 65_536) }
            : { done: true as const, value: undefined },
        return: () => {
          closed++;
          return { done: true as const, value: undefined };
        },
      };
      const batches = await collect({ [Symbol.iterator]: () => iterator }, config);
      expect(featureDifference(batches, featureReference(input, config), config, 1024)).toBeNull();
      expect(batches[0]?.errors.map((error) => error.snippet)).toStrictEqual(['b,c']);
      // 17 chunks hold the 5 skipped units and the 1,048,576 of the window.
      expect([reads, closed]).toStrictEqual([17, 1]);
    }, 120_000);
  });

  it('meta.cursor and Quotes.index stay relative to the text scanned, after the "sep=" line', async () => {
    const [batch] = await collect(['sep=;\na;', 'b\n"x'], { sepLine: true, positions: true });
    expect(batch?.meta.cursor).toBe(6);
    expect(batch?.meta.sepLine).toBe(true);
    expect(batch?.meta.delimiter).toBe(';');
    expect(batch?.errors[0]).toMatchObject({ code: 'MissingQuotes', index: 5, offset: 10 });
  });

  it('with batchSize 1 the line of an error is whole in the snippet, though earlier batches were delivered: a batch starts at a record start', async () => {
    const config: StreamConfig = { header: true, positions: true, batchSize: 1 };
    const text = 'a,b\n1,2\n3,4\nfive is a short record\n6,7\n';
    for (const pieces of [[text], Array.from(text), ...splits(text, mulberry32(2), 0)]) {
      const batches = await collect(pieces, config);
      expect(batches.map((batch) => batch.data.length)).toStrictEqual([1, 1, 1, 1, 1]);
      expect(batches[2]?.errors).toStrictEqual([
        {
          type: 'FieldMismatch',
          code: 'TooFewFields',
          message: 'Too few fields: expected 2 fields but parsed 1',
          row: 2,
          line: 4,
          column: 1,
          offset: 12,
          snippet: 'five is a short record',
        },
      ]);
    }
  });

  it('without repair a batch with a feature closes where it closes without one: the same cursor, rowOffset and error grouping', async () => {
    const text = 'a,b\n\n1,2\n"x"y,3\n4\n\n5,6\n7,8,9\n"z';
    for (const base of [{ header: true }, { header: true, skipEmptyLines: true }, {}] as const) {
      for (const batchSize of [1, 2, 3]) {
        const plain = await collect([text], { ...base, batchSize });
        const located = await collect([text], { ...base, batchSize, positions: true });
        expect(located.map((batch) => batch.meta)).toStrictEqual(plain.map((batch) => batch.meta));
        expect(located.map((batch) => batch.data)).toStrictEqual(plain.map((batch) => batch.data));
        const bare = located.map((batch) =>
          batch.errors.map(({ line, column, offset, snippet, ...error }) => {
            expect([typeof line, typeof column, typeof offset, typeof snippet]).toStrictEqual(
              error.type === 'Delimiter'
                ? ['undefined', 'undefined', 'undefined', 'undefined']
                : ['number', 'number', 'number', 'string'],
            );
            return error;
          }),
        );
        expect(bare).toStrictEqual(plain.map((batch) => batch.errors));
      }
    }
  });
});

/** A schema for { age } rows: a number passes, anything else is one issue at path ['age']. */
const ageSchema = (wait?: (row: unknown, index: number) => Promise<void>): StandardSchemaV1 => {
  let index = 0;
  const judge = (value: unknown) => {
    const age = (value as { age?: unknown }).age;
    return typeof age === 'number'
      ? { value: { age } }
      : { issues: [{ message: 'age must be a number', path: ['age'] }] };
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        const i = index++;
        return wait === undefined ? judge(value) : wait(value, i).then(() => judge(value));
      },
    },
  };
};

/** The five source kinds of the close matrix over the same chunks, each counting its close calls. */
const CLOSABLE: Record<
  string,
  (chunks: readonly string[]) => { source: StreamSource; closes: () => number | undefined }
> = {
  'a Node Readable': (chunks) => {
    let closes = 0;
    let at = 0;
    const source = new Readable({
      objectMode: true,
      autoDestroy: false,
      read() {
        this.push(at < chunks.length ? chunks[at++] : null);
      },
      destroy(_error, callback) {
        closes++;
        callback(null);
      },
    });
    return { source, closes: () => closes };
  },
  'a Web ReadableStream': (chunks) => {
    let closes = 0;
    let at = 0;
    const source = new ReadableStream<string>(
      {
        pull(controller) {
          if (at < chunks.length) controller.enqueue(chunks[at++] ?? '');
          else controller.close();
        },
        cancel() {
          closes++;
        },
      },
      { highWaterMark: 0 },
    );
    return { source, closes: () => closes };
  },
  'an async iterable': (chunks) => {
    let closes = 0;
    let at = 0;
    const iterator = {
      next: () =>
        Promise.resolve(
          at < chunks.length
            ? { done: false as const, value: chunks[at++] ?? '' }
            : { done: true as const, value: undefined },
        ),
      return: () => {
        closes++;
        return Promise.resolve({ done: true as const, value: undefined });
      },
    };
    return { source: { [Symbol.asyncIterator]: () => iterator }, closes: () => closes };
  },
  'a sync iterable': (chunks) => {
    let closes = 0;
    let at = 0;
    const iterator = {
      next: () =>
        at < chunks.length
          ? { done: false as const, value: chunks[at++] ?? '' }
          : { done: true as const, value: undefined },
      return: () => {
        closes++;
        return { done: true as const, value: undefined };
      },
    };
    return { source: { [Symbol.iterator]: () => iterator }, closes: () => closes };
  },
  // A string has nothing to close.
  'a string': (chunks) => ({ source: chunks.join(''), closes: () => undefined }),
};

describe('an async validator', () => {
  const text = 'age\n1\nx\n3\n4\ny\n6';
  const config = { header: true, dynamicTyping: true, newline: '\n', delimiter: ',' } as const;

  it('S9: the same async schema throws in parseDetailed and works in parseStream', async () => {
    const schema = ageSchema(() => Promise.resolve());
    expect(() => parseDetailed(text, { ...config, schema })).toThrow(
      new TypeError(
        'Parse option "schema" returned a Promise; use parseStream for an async validator',
      ),
    );
    await tick();
    const batches = await collect([text], {
      ...config,
      schema: ageSchema(() => Promise.resolve()),
    });
    const sync = parseDetailed(text, { ...config, schema: ageSchema() });
    expect(batches.flatMap((batch) => batch.data)).toStrictEqual(sync.data);
    expect(batches.flatMap((batch) => batch.errors)).toStrictEqual(sync.errors);
    expect(sync.data).toStrictEqual([{ age: 1 }, { age: 3 }, { age: 4 }, { age: 6 }]);
    expect(sync.errors).toStrictEqual([
      {
        type: 'Schema',
        code: 'InvalidRow',
        message: 'age must be a number',
        row: 1,
        path: ['age'],
        value: { age: 'x' },
      },
      {
        type: 'Schema',
        code: 'InvalidRow',
        message: 'age must be a number',
        row: 4,
        path: ['age'],
        value: { age: 'y' },
      },
    ]);
  });

  it('rows come out in input order whatever the validator waits for; one row is validated at a time', async () => {
    let pending = 0;
    let most = 0;
    const order: number[] = [];
    // Later rows would settle first if they were validated together.
    const schema = ageSchema(async (_row, index) => {
      most = Math.max(most, ++pending);
      await new Promise((resolve) => setTimeout(resolve, 12 - 2 * index));
      order.push(index);
      pending--;
    });
    const batches = await collect([text], { ...config, schema, batchSize: 4 });
    expect(batches.map((batch) => batch.data)).toStrictEqual([
      [{ age: 1 }, { age: 3 }, { age: 4 }],
      [{ age: 6 }],
    ]);
    expect(
      batches.map((batch) => batch.errors.map((error) => (error as SchemaError).row)),
    ).toStrictEqual([[1], [4]]);
    expect(order).toStrictEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(1);
  });

  it('a validator that is async for some rows only keeps the order', async () => {
    const schema = ageSchema((_row, index) =>
      index % 2 === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 3)),
    );
    const mixed: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          (value as { age: unknown }).age === 3
            ? { value: { age: 3 } }
            : schema['~standard'].validate(value),
      },
    };
    const batches = await collect([text], { ...config, schema: mixed, batchSize: 2 });
    expect(batches.flatMap((batch) => batch.data)).toStrictEqual([
      { age: 1 },
      { age: 3 },
      { age: 4 },
      { age: 6 },
    ]);
    expect(batches.map((batch) => batch.meta.rowOffset)).toStrictEqual([0, 2, 4]);
  });

  it('a batch whose validators are all synchronous adds no await: it resolves in as many jobs as without a schema', async () => {
    const jobs = async (config2: StreamConfig) => {
      let count = 0;
      const state = { settled: false };
      void parseStream(['age\n1\n2'], config2)
        .next()
        .then(() => {
          state.settled = true;
        });
      while (!state.settled) {
        count++;
        await Promise.resolve();
      }
      return count;
    };
    const plain = await jobs({ header: true });
    expect(await jobs({ header: true, schema: ageSchema() })).toBe(plain);
    expect(
      await jobs({ header: true, schema: ageSchema(() => Promise.resolve()) }),
    ).toBeGreaterThan(plain);
  });

  it.each(Object.keys(CLOSABLE))(
    '%s: a rejection on row 3 rejects the next() that would deliver its batch, with the same object, and the source is closed once',
    async (kind) => {
      const failure = new Error('row 3');
      const schema = ageSchema((_row, index) =>
        index === 3 ? Promise.reject(failure) : Promise.resolve(),
      );
      const { source, closes } = (CLOSABLE[kind] as (typeof CLOSABLE)[string])([
        'age\n1\n2\n',
        '3\n4\n',
        '5\n6\n',
        '7\n8\n',
      ]);
      const batches = parseStream(source, { ...config, schema, batchSize: 2 });
      const first = await batches.next();
      expect(first.value?.data).toStrictEqual([{ age: 1 }, { age: 2 }]);
      // Row 3 is in the second batch.
      await expect(batches.next()).rejects.toBe(failure);
      await tick();
      expect(closes()).toBe(kind === 'a string' ? undefined : 1);
      await expect(batches.next()).resolves.toStrictEqual({ done: true, value: undefined });
      await expect(batches.return()).resolves.toStrictEqual({ done: true, value: undefined });
      expect(closes()).toBe(kind === 'a string' ? undefined : 1);
    },
  );

  it('a validator that throws, and one that returns neither value nor issues, reject next() the same way', async () => {
    const boom = new Error('boom');
    const throwing: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw boom;
        },
      },
    };
    const { source, closes } = (CLOSABLE['an async iterable'] as (typeof CLOSABLE)[string])([
      'a\n1\n',
      '2\n',
    ]);
    await expect(
      parseStream(source, { schema: throwing, batchSize: 1, delimiter: ',', newline: '\n' }).next(),
    ).rejects.toBe(boom);
    expect(closes()).toBe(1);
    const shapeless = {
      '~standard': { version: 1, vendor: 'test', validate: () => Promise.resolve({}) },
    } as unknown as StandardSchemaV1;
    await expect(parseStream(['a'], { schema: shapeless }).next()).rejects.toThrow(
      new TypeError('Parse option "schema" returned a result without "value" or "issues"'),
    );
  });

  it('controller.abort(reason) during a pending validation rejects next() at once with the reason; the late result is ignored', async () => {
    const reason = { why: 'stop' };
    const gate = deferred<undefined>();
    let validated = 0;
    const schema = ageSchema(() => {
      validated++;
      return gate.promise;
    });
    const controller = new AbortController();
    const { source, closes } = (CLOSABLE['an async iterable'] as (typeof CLOSABLE)[string])([
      'age\n1\n2\n',
      '3\n',
    ]);
    const batches = parseStream(source, {
      ...config,
      schema,
      signal: controller.signal,
      batchSize: 1,
    });
    const pending = batches.next();
    for (let i = 0; i < 5; i++) await tick();
    expect(validated).toBe(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(closes()).toBe(1);
    gate.resolve(undefined);
    await tick();
    // No further row was validated, and the iteration has ended.
    expect(validated).toBe(1);
    await expect(batches.next()).resolves.toStrictEqual({ done: true, value: undefined });
  });

  it('return() during a pending validation: the pending next() resolves done and the source is closed once', async () => {
    const gate = deferred<undefined>();
    const schema = ageSchema(() => gate.promise);
    const { source, closes } = (CLOSABLE['an async iterable'] as (typeof CLOSABLE)[string])([
      'age\n1\n',
      '2\n',
    ]);
    const batches = parseStream(source, { ...config, schema, batchSize: 1 });
    const pending = batches.next();
    for (let i = 0; i < 5; i++) await tick();
    await expect(batches.return()).resolves.toStrictEqual({ done: true, value: undefined });
    await expect(pending).resolves.toStrictEqual({ done: true, value: undefined });
    expect(closes()).toBe(1);
    gate.reject(new Error('late'));
    await tick();
  });

  it('an abort during the validation of the last batch still rejects with the reason', async () => {
    const reason = new Error('late abort');
    const gate = deferred<undefined>();
    const controller = new AbortController();
    const batches = parseStream(['age\n1'], {
      ...config,
      schema: ageSchema(() => gate.promise),
      signal: controller.signal,
    });
    const pending = batches.next();
    for (let i = 0; i < 5; i++) await tick();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    gate.resolve(undefined);
  });

  it('no read happens while a validation is pending', async () => {
    const gates = [deferred<undefined>(), deferred<undefined>(), deferred<undefined>()];
    const schema = ageSchema((_row, index) => gates[index]?.promise ?? Promise.resolve());
    let reads = 0;
    const chunks = ['age\n1\n', '2\n', '3\n', '4\n'];
    const iterator = {
      next: () => {
        const value = chunks[reads++];
        return Promise.resolve(
          value === undefined
            ? { done: true as const, value: undefined }
            : { done: false as const, value },
        );
      },
    };
    const batches = parseStream(
      { [Symbol.asyncIterator]: () => iterator },
      { ...config, schema, batchSize: 1 },
    );
    const first = batches.next();
    const second = batches.next();
    for (let i = 0; i < 5; i++) await tick();
    // Row 0 is being validated: only the chunk that holds it was read, though a second next() waits.
    expect(reads).toBe(1);
    gates[0]?.resolve(undefined);
    expect((await first).value?.data).toStrictEqual([{ age: 1 }]);
    for (let i = 0; i < 5; i++) await tick();
    expect(reads).toBe(2);
    gates[1]?.resolve(undefined);
    expect((await second).value?.data).toStrictEqual([{ age: 2 }]);
    for (let i = 0; i < 5; i++) await tick();
    // Nothing is read between two calls.
    expect(reads).toBe(2);
    await batches.return();
  });

  it('in a child process with default flags, a validator that rejects after the abort: exit code 0 and an empty stderr', () => {
    const fixture = fileURLToPath(new URL('fixtures/stream-validator-child.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', env });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('3 scenarios settled\n');
    expect(child.status).toBe(0);
  });

  it('with positions a Schema error has the place of its record, as in bulk, at every split', async () => {
    const input = '﻿age\n1\nx\n3\ny,z\n';
    const all = {
      header: true,
      dynamicTyping: true,
      positions: true,
      skipEmptyLines: true,
      delimiter: ',',
    } as const;
    const bulk = parseDetailed(input, { ...all, schema: ageSchema() });
    expect(
      bulk.errors.map((error) => [error.type, error.line, error.offset, error.snippet]),
    ).toStrictEqual([
      ['FieldMismatch', 5, 11, 'y,z'],
      ['Schema', 3, 7, 'x'],
      ['Schema', 5, 11, 'y,z'],
    ]);
    for (const batchSize of [1, 2, 1024]) {
      for (const pieces of [[input], ...splits(input, mulberry32(3), 0)]) {
        const batches = await collect(pieces, { ...all, schema: ageSchema(), batchSize });
        const errors = batches.flatMap((batch) => batch.errors);
        expect(
          ['FieldMismatch', 'Schema'].flatMap((type) => errors.filter((e) => e.type === type)),
        ).toStrictEqual(bulk.errors);
      }
    }
  });
});

describe('S10: batch size and row numbers', () => {
  it('with a schema a batch is built from batchSize rows and holds the valid ones; the header, a comment line and a removed empty record count for nothing', async () => {
    const text = 'age\n#note\n1\nx\n\n3\ny\n5\nz';
    const config = {
      header: true,
      skipEmptyLines: true,
      comments: '#',
      dynamicTyping: true,
      newline: '\n',
      delimiter: ',',
    } as const;
    const bulk = parseDetailed(text, { ...config, schema: ageSchema() });
    expect(bulk.data).toStrictEqual([{ age: 1 }, { age: 3 }, { age: 5 }]);
    for (const pieces of [[text], Array.from(text)]) {
      const batches = await collect(pieces, { ...config, schema: ageSchema(), batchSize: 2 });
      expect(batches.map((batch) => batch.data)).toStrictEqual([
        [{ age: 1 }],
        [{ age: 3 }],
        [{ age: 5 }],
      ]);
      expect(batches.map((batch) => batch.meta.rowOffset)).toStrictEqual([0, 2, 4]);
      expect(batches.map((batch) => batch.meta.done)).toStrictEqual([false, false, true]);
      for (const batch of batches) {
        expect(batch.errors.length).toBe(1);
        const row = (batch.errors[0] as SchemaError).row;
        expect(row).toBeGreaterThanOrEqual(batch.meta.rowOffset);
        expect(row).toBeLessThan(batch.meta.rowOffset + 2);
      }
      expect(batches.flatMap((batch) => batch.data)).toStrictEqual(bulk.data);
      expect(batches.flatMap((batch) => batch.errors)).toStrictEqual(bulk.errors);
      expect(bulk.errors.map((error) => (error as SchemaError).row)).toStrictEqual([1, 3, 5]);
    }
  });

  it('a batch whose rows are all invalid is delivered with data: []', async () => {
    const batches = await collect(['age\nx\ny\n3'], {
      header: true,
      dynamicTyping: true,
      delimiter: ',',
      schema: ageSchema(),
      batchSize: 2,
    });
    expect(
      batches.map((batch) => [batch.data, batch.errors.length, batch.meta.rowOffset]),
    ).toStrictEqual([
      [[], 2, 0],
      [[{ age: 3 }], 0, 2],
    ]);
  });

  it('repair alone: a record that mixed-newline splits counts as the rows it became; every batch but the last has batchSize rows', async () => {
    // "\n" ends the records; the lone "\r" in record 1 ends one more.
    const text = 'a,b\n1,2\r3,4\r5,6\n7,8\n9,10\n';
    const config = { repair: true, delimiter: ',' } as const;
    const bulk = parseDetailed(text, config);
    expect(bulk.meta.linebreak).toBe('\n');
    expect(bulk.data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
      ['7', '8'],
      ['9', '10'],
    ]);
    for (const pieces of [[text], Array.from(text), ...splits(text, mulberry32(4), 0)]) {
      const batches = await collect(pieces, { ...config, batchSize: 2 });
      expect(batches.map((batch) => batch.data.length)).toStrictEqual([2, 2, 2]);
      expect(batches.map((batch) => batch.meta.rowOffset)).toStrictEqual([0, 2, 4]);
      // The cursor of a batch is where its last row ends: a piece of the split record ends
      // after its "\r" (8), the last piece with the record (16).
      expect(batches.map((batch) => batch.meta.cursor)).toStrictEqual([8, 16, 25]);
      expect(batches.flatMap((batch) => batch.data)).toStrictEqual(bulk.data);
      expect(batches.flatMap((batch) => batch.repairs)).toStrictEqual(bulk.repairs);
      expect(
        batches.map((batch) => batch.repairs?.map((repair) => [repair.rule, repair.row])),
      ).toStrictEqual([[['mixed-newline', 1]], [], [['trailing-empty-record', -1]]]);
      expect(sumCounts(batches)).toStrictEqual(bulk.repairCounts);
    }
  });

  it('Quotes.row: an InvalidQuotes error has the same row under repair and schema as without them', async () => {
    const text = 'a,b\n1,2\n\n3,"x"y"\n4\n';
    const base = { header: true, skipEmptyLines: true, batchSize: 1 } as const;
    const rowOf = (batches: readonly Batch[]) =>
      batches.flatMap((batch) => batch.errors).find((error) => error.code === 'InvalidQuotes');
    const plain = rowOf(await collect([text], base));
    expect(plain).toMatchObject({ row: 3, index: 12 });
    for (const pieces of [[text], Array.from(text)]) {
      const featured = rowOf(await collect(pieces, { ...base, repair: true, schema: fuzzSchema }));
      expect(featured).toStrictEqual(plain);
    }
  });

  it('OPEN QUESTION (reported): after a record that mixed-newline split, Quotes.row counts the repaired records, as parseDetailed does', async () => {
    // Without repair "1\r2" is one record and the quote error is in record 2; repair splits it.
    const text = 'a\n1\r2\n"x"y"\n';
    const config = { repair: true, delimiter: ',' } as const;
    const bulk = parseDetailed(text, config).errors.find((error) => error.code === 'InvalidQuotes');
    const scanned = parseDetailed(text, {
      delimiter: ',',
      newline: '\n',
      positions: true,
    }).errors.find((error) => error.code === 'InvalidQuotes');
    expect([
      scanned?.type === 'Quotes' && scanned.row,
      bulk?.type === 'Quotes' && bulk.row,
    ]).toStrictEqual([2, 3]);
    for (const pieces of [[text], Array.from(text)]) {
      const stream = (await collect(pieces, config))
        .flatMap((batch) => batch.errors)
        .find((error) => error.code === 'InvalidQuotes');
      expect(stream).toStrictEqual(bulk);
    }
  });

  it('S8, the cap: 10,050 short rows in 1,024-row batches give the first 10,000 repairs, then repairs: [] with counts', async () => {
    const text = 'a,b\n' + Array.from({ length: 10_050 }, (_, i) => `${String(i)}\n`).join('');
    const config = { header: true, repair: true, newline: '\n', delimiter: ',' } as const;
    const bulk = parseDetailed(text, config);
    expect(bulk.repairs?.length).toBe(10_000);
    expect(bulk.repairCounts).toStrictEqual({
      'pad-missing': 10_050,
      'drop-trailing-empty': 0,
      'trailing-empty-record': 1,
      'mixed-newline': 0,
      'unclosed-quote': 0,
    });
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += 7001) chunks.push(text.slice(at, at + 7001));
    for (const pieces of [[text], chunks]) {
      const batches = await collect(pieces, { ...config, batchSize: 1024 });
      expect(batches.length).toBe(10);
      const repairs = batches.flatMap((batch) => batch.repairs as Repair[]);
      expect(repairs.length).toBe(10_000);
      expect(isDeepStrictEqual(repairs, bulk.repairs)).toBe(true);
      // 9 full batches hold 9,216 rows; the cap is reached inside the tenth.
      expect(batches.map((batch) => batch.repairs?.length)).toStrictEqual([
        ...Array.from({ length: 9 }, () => 1024),
        10_000 - 9 * 1024,
      ]);
      expect(batches.at(-1)?.repairCounts).toStrictEqual({
        'pad-missing': 10_050 - 9 * 1024,
        'drop-trailing-empty': 0,
        'trailing-empty-record': 1,
        'mixed-newline': 0,
        'unclosed-quote': 0,
      });
      expect(sumCounts(batches)).toStrictEqual(bulk.repairCounts);
      // With smaller batches, whole batches come after the cap.
      const small = await collect(pieces, { ...config, batchSize: 1000 });
      expect(small.map((batch) => batch.repairs?.length)).toStrictEqual([
        ...Array.from({ length: 10 }, () => 1000),
        0,
      ]);
      expect(small.at(-1)?.repairCounts?.['pad-missing']).toBe(50);
      expect(small.at(-1)?.repairCounts?.['trailing-empty-record']).toBe(1);
      expect(
        isDeepStrictEqual(
          small.flatMap((batch) => batch.repairs),
          bulk.repairs,
        ),
      ).toBe(true);
      expect(sumCounts(small)).toStrictEqual(bulk.repairCounts);
    }
  }, 120_000);

  it('repair end to end: the example of parseDetailed, per batch', async () => {
    const batches = await collect(['a,b,c\n1,', '2\n'], { header: true, repair: true });
    expect(batches).toStrictEqual([
      {
        data: [{ a: '1', b: '2', c: '' }],
        errors: [],
        meta: {
          delimiter: ',',
          linebreak: '\n',
          fields: ['a', 'b', 'c'],
          renamedHeaders: null,
          rowOffset: 0,
          cursor: 10,
          truncated: false,
          done: true,
        },
        repairs: parseDetailed('a,b,c\n1,2\n', { header: true, repair: true }).repairs,
        repairCounts: {
          'pad-missing': 1,
          'drop-trailing-empty': 0,
          'trailing-empty-record': 1,
          'mixed-newline': 0,
          'unclosed-quote': 0,
        },
      },
    ]);
    expect(
      batches[0]?.repairs?.map((repair) => [repair.rule, repair.row, repair.offset]),
    ).toStrictEqual([
      ['pad-missing', 0, 6],
      ['trailing-empty-record', -1, 9],
    ]);
  });

  it('repair with preview: the rows are cut as parseDetailed cuts them', async () => {
    const text = 'a\n1\r2\r3\n4\n5\n6\n7\n';
    const config = { repair: true, preview: 2, delimiter: ',' } as const;
    const bulk = featureReference(text, config);
    expect(bulk.data).toStrictEqual([['a'], ['1']]);
    expect(bulk.meta.truncated).toBe(true);
    expect(bulk.meta.cursor).toBe(8);
    for (const pieces of [[text], Array.from(text)]) {
      const batches = await collect(pieces, { ...config, batchSize: 1 });
      expect(featureDifference(batches, bulk, config, 1)).toBeNull();
      expect(batches.map((batch) => batch.data)).toStrictEqual([[['a']], [['1']]]);
      // The repair of the record that was cut is still reported, as in parseDetailed.
      expect(batches.flatMap((batch) => batch.repairs?.map((repair) => repair.rule))).toStrictEqual(
        ['mixed-newline'],
      );
    }
  });

  it('repair with preview: the source is not read past the records preview counts, and is closed', async () => {
    const text = 'a,b\n1\n2\n3\n4\n';
    const config = { repair: true, preview: 2, delimiter: ',', newline: '\n' } as const;
    let reads = 0;
    let closed = 0;
    const iterator = {
      next: () =>
        reads < text.length
          ? { done: false as const, value: text.charAt(reads++) }
          : { done: true as const, value: undefined },
      return: () => {
        closed++;
        return { done: true as const, value: undefined };
      },
    };
    const batches = await collect(
      { [Symbol.iterator]: () => iterator },
      { ...config, batchSize: 1 },
    );
    expect(featureDifference(batches, featureReference(text, config), config, 1)).toBeNull();
    expect(batches.map((batch) => batch.data)).toStrictEqual([[['a', 'b']], [['1', '']]]);
    // Two records end at unit 6; the unit after is not read.
    expect([reads, closed]).toStrictEqual([6, 1]);
  });
});

describe('S11: unclosed-quote and maxRecordLength', () => {
  const text = 'a,b\n1,"' + 'x'.repeat(1000) + '\n2,3\n';

  it.each(Object.keys(CLOSABLE).filter((kind) => kind !== 'a string'))(
    '%s: with maxRecordLength 64, next() rejects with the maxRecordLength RangeError and the source is closed once',
    async (kind) => {
      const chunks = [text.slice(0, 40), text.slice(40, 500), text.slice(500), 'more'];
      const { source, closes } = (CLOSABLE[kind] as (typeof CLOSABLE)[string])(chunks);
      const batches = parseStream(source, {
        repair: true,
        maxRecordLength: 64,
        delimiter: ',',
        newline: '\n',
      });
      let thrown: unknown;
      try {
        for (;;) if ((await batches.next()).done) break;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toStrictEqual(
        new RangeError('Record at offset 4 is longer than maxRecordLength (64)'),
      );
      await tick();
      expect(closes()).toBe(1);
    },
  );

  it('without maxRecordLength the result equals the repaired result of parseDetailed, at several splits', async () => {
    const config = { repair: true } as const;
    const bulk = featureReference(text, config);
    expect(bulk.repairCounts?.['unclosed-quote']).toBe(1);
    expect(bulk.data).toStrictEqual([
      ['a', 'b'],
      ['1', '"' + 'x'.repeat(1000)],
      ['2', '3'],
    ]);
    for (const pieces of [[text], ...splits(text, mulberry32(5), 20).slice(-120)]) {
      for (const batchSize of [1, 2, 1024]) {
        const batches = await collect(pieces, { ...config, batchSize });
        expect(featureDifference(batches, bulk, config, batchSize)).toBeNull();
      }
    }
  });
});

describe('repair with header and skipEmptyLines while no header record has come', () => {
  const config = {
    repair: true,
    header: true,
    skipEmptyLines: true,
    delimiter: ',',
    newline: '\n',
  } as const;
  const empty = '\n'.repeat(200);

  it.each(Object.keys(CLOSABLE).filter((kind) => kind !== 'a string'))(
    '%s: empty lines longer than maxRecordLength reject with the maxRecordLength RangeError, and the source is closed once',
    async (kind) => {
      const chunks = [empty.slice(0, 50), empty.slice(50, 100), empty.slice(100), 'a,b\n1,2\n'];
      const { source, closes } = (CLOSABLE[kind] as (typeof CLOSABLE)[string])(chunks);
      const batches = parseStream(source, { ...config, maxRecordLength: 64 });
      await expect(batches.next()).rejects.toStrictEqual(
        new RangeError('Record at offset 0 is longer than maxRecordLength (64)'),
      );
      await tick();
      expect(closes()).toBe(1);
      await expect(batches.next()).resolves.toStrictEqual({ done: true, value: undefined });
    },
  );

  it('the rejection does not depend on the chunks: it comes when 65 units before the records held back hold no header', async () => {
    for (const pieces of [
      [empty + 'a,b\n'],
      Array.from(empty + 'a,b\n'),
      [empty.slice(0, 64), empty.slice(64) + 'a,b\n'],
    ]) {
      let thrown: unknown;
      const delivered: Batch[] = [];
      try {
        for await (const batch of parseStream(pieces, { ...config, maxRecordLength: 64 }))
          delivered.push(batch);
      } catch (error) {
        thrown = error;
      }
      expect(delivered).toStrictEqual([]);
      expect(thrown).toStrictEqual(
        new RangeError('Record at offset 0 is longer than maxRecordLength (64)'),
      );
    }
    // 64 empty lines and the three records held back are within the limit.
    const within = '\n'.repeat(64) + 'a,b\n1\n';
    const bulk = featureReference(within, config);
    const batches = await collect(Array.from(within), { ...config, maxRecordLength: 64 });
    expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
  });

  it('without maxRecordLength the same input is held, as any record is without the limit, and equals bulk', async () => {
    for (const input of [empty, empty + 'a,b\n1\n\n2,3,4\n']) {
      const bulk = featureReference(input, config);
      for (const batchSize of [1, 2, 1024]) {
        for (const pieces of [[input], Array.from(input), [input.slice(0, 77), input.slice(77)]]) {
          const batches = await collect(pieces, { ...config, batchSize });
          expect(featureDifference(batches, bulk, config, batchSize)).toBeNull();
        }
      }
    }
    expect(featureReference(empty + 'a,b\n1\n\n2,3,4\n', config).data).toStrictEqual([
      { a: '1', b: '' },
      { a: '2', b: '3', __parsed_extra: ['4'] },
    ]);
  });

  it('a header that appears within the limit is unaffected: equal to bulk at every split, with and without maxRecordLength', async () => {
    const input = '\n\n \n' + 'name,amount\n' + 'x,1\n\ny\nz,3,\n'.repeat(40);
    for (const extra of [{}, { skipEmptyLines: 'greedy' }] as const) {
      const all: DetailedConfig = { ...config, ...extra };
      const bulk = featureReference(input, all);
      for (const batchSize of [1, 3, 1024]) {
        const plain = await collect([input], { ...all, batchSize });
        expect(featureDifference(plain, bulk, all, batchSize)).toBeNull();
        for (const pieces of [[input], ...splits(input, mulberry32(8), 3)]) {
          const limited = await collect(pieces, { ...all, batchSize, maxRecordLength: 64 });
          expect([pieces.length, limited]).toStrictEqual([pieces.length, plain]);
        }
      }
    }
  }, 120_000);
});

describe('mixed-newline with a bounded window', () => {
  it('maxRecordLength 16, a 2 MiB source that is CRLF except one lone "\\n" at unit 1,000,000: repairs equal bulk’s', async () => {
    const line = '12345,67\r\n';
    const lines = 2 * 104_858;
    let text = line.repeat(lines);
    // The lone "\n" replaces the "\r\n" that ends at unit 1,000,000 and the unit before it.
    text = text.slice(0, 999_998) + 'x\n' + text.slice(1_000_000);
    expect(text.length).toBeGreaterThanOrEqual(2 * 1_048_576);
    expect(text.slice(999_990, 1_000_002)).toBe('12345,67x\n12');
    const config = { repair: true, delimiter: ',' } as const;
    const bulk = parseDetailed(text, config);
    expect(bulk.meta.linebreak).toBe('\n');
    expect(bulk.repairs?.length).toBe(10_000);
    expect(bulk.repairCounts?.['mixed-newline']).toBe(lines - 1);
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += 65_536) chunks.push(text.slice(at, at + 65_536));
    const batches = await collect(chunks, { ...config, maxRecordLength: 16 });
    expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    expect(batches[0]?.meta.linebreak).toBe('\n');
  }, 600_000);

  it('the trigger reads 1,048,576 units and the one after them: a "\\r" at the end of that window is half of a "\\r\\n"', async () => {
    const config = { repair: ['mixed-newline'], delimiter: ',' } as const;
    // The window ends with the "\r" of a "\r\n", the only kind of line break in it: no second
    // kind, so the rule is off and the lone "\r" after the window stays in its field. Read
    // without the unit after the window, that "\r" would be a second kind.
    const text = 'h\r\n' + 'a'.repeat(1_048_576 - 4) + '\r\nb\rc\r\n';
    expect(text.charAt(1_048_575) + text.charAt(1_048_576)).toBe('\r\n');
    const bulk = parseDetailed(text, config);
    expect(bulk.repairCounts?.['mixed-newline']).toBe(0);
    // The newline is the guess of parse on that window, which ends in "\r".
    expect(bulk.meta.linebreak).toBe('\r');
    for (const pieces of [[text], [text.slice(0, 1_048_576), text.slice(1_048_576)]]) {
      const batches = await collect(pieces, config);
      expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    }
  }, 120_000);
});

describe('config', () => {
  it.each([
    ['detect', 1, 'Parse option "detect" must be a boolean'],
    ['positions', 'yes', 'Parse option "positions" must be a boolean'],
    ['sepLine', null, 'Parse option "sepLine" must be a boolean'],
    ['repair', 'all', 'Parse option "repair" must be a boolean or an array of rule names'],
    [
      'repair',
      ['pad-missing', 'nope'],
      'Parse option "repair" must be a boolean or an array of rule names',
    ],
    ['schema', {}, 'Parse option "schema" must be a Standard Schema v1 object'],
  ])('%s: %j throws the main entry’s message at the call', (key, value, message) => {
    expect(() => parseStream(['a'], { [key]: value } as StreamConfig)).toThrow(
      new TypeError(message),
    );
    expect(() => parseDetailed('a', { [key]: value } as DetailedConfig)).toThrow(
      new TypeError(message),
    );
  });

  it('detect with no delimiter candidate throws as parseDetailed does', () => {
    expect(() => parseStream(['a'], { detect: true, delimitersToGuess: [] })).toThrow(
      new TypeError('Parse option "delimitersToGuess" must be a non-empty array with detect'),
    );
  });

  it.each([
    ['detect', { detect: true }],
    ['positions', { positions: true }],
    ['sepLine', { sepLine: true }],
    ['schema', { schema: fuzzSchema }],
  ] as const)(
    '%s is accepted: the keys of a batch are data, errors, meta',
    async (_key, config) => {
      const batches = await collect(['a,b\n1,2'], config);
      expect(batches.map((batch) => Object.keys(batch))).toStrictEqual([
        ['data', 'errors', 'meta'],
      ]);
    },
  );

  it.each([true, ['pad-missing']] as const)(
    'repair: %j is accepted: the keys of every batch are data, errors, meta, repairs, repairCounts',
    async (repair) => {
      const batches = await collect(['a,b\n1,2\n3,4'], { repair, batchSize: 1 });
      expect(batches.length).toBe(3);
      for (const batch of batches) {
        expect(Object.keys(batch)).toStrictEqual([
          'data',
          'errors',
          'meta',
          'repairs',
          'repairCounts',
        ]);
        expect(batch.repairs).toStrictEqual([]);
        expect(Object.keys(batch.repairCounts ?? {}).sort()).toStrictEqual([...RULES].sort());
      }
    },
  );

  it('a key that is false, undefined or an empty rule list sets nothing: the batches are those without the key', async () => {
    const text = 'sep=;\na;b\n1\n';
    const plain = await collect([text], { header: true });
    const off = await collect([text], {
      header: true,
      detect: false,
      positions: false,
      repair: [],
      sepLine: false,
      schema: undefined,
    });
    expect(off).toStrictEqual(plain);
    expect(await collect([text], { header: true, repair: false })).toStrictEqual(plain);
  });

  it('meta.detected and meta.sepLine are in every batch, the same in each', async () => {
    const text = 'sep=;\nid;name\n1;x\n2;y\n3;z\n';
    const batches = await collect(Array.from(text), { detect: true, batchSize: 2 });
    expect(batches.length).toBe(3);
    for (const batch of batches) {
      expect(batch.meta.sepLine).toBe(true);
      expect(batch.meta.detected).toStrictEqual(detect(text));
      expect(batch.meta.detected).toBe(batches[0]?.meta.detected);
    }
    const none = await collect(['sep=x'], { sepLine: true });
    expect(none[0]?.meta).toStrictEqual({
      delimiter: 'x',
      linebreak: '\n',
      renamedHeaders: null,
      rowOffset: 0,
      cursor: 0,
      truncated: false,
      done: true,
      sepLine: true,
    });
    // Without a "sep=" line the key is absent, as in parseDetailed.
    expect(Object.keys((await collect(['a;b'], { sepLine: true }))[0]?.meta ?? {})).not.toContain(
      'sepLine',
    );
  });

  it('UndetectableDelimiter is never reported under detect, and is without it', async () => {
    for (const text of ['', 'abc\ndef\n']) {
      const detected = await collect([text], { detect: true });
      expect(detected.flatMap((batch) => batch.errors)).toStrictEqual([]);
      const guessed = await collect([text], {});
      expect(guessed.flatMap((batch) => batch.errors).map((error) => error.code)).toStrictEqual([
        'UndetectableDelimiter',
      ]);
    }
  });

  it('explicit options win over detect, as in parseDetailed', async () => {
    const text = 'Title\n\na;b,c\n1;2,3\n';
    for (const given of [
      { delimiter: ',' },
      { newline: '\r\n' },
      { quoteChar: "'" },
      { escapeChar: '\\' },
      { skipFirstNLines: 0 },
      { skipFirstNLines: 1 },
      { delimiter: () => ',' },
    ] as const) {
      const config = { ...given, detect: true } as const;
      const bulk = featureReference(text, config);
      for (const pieces of [[text], Array.from(text)]) {
        expect(featureDifference(await collect(pieces, config), bulk, config, 1024)).toBeNull();
      }
    }
  });
});

describe('edge cases of the features in a stream', () => {
  it('1a: a "sep=" line that names the comment character as delimiter, newline given: rejected as in parseDetailed, at every split', async () => {
    const text = 'sep=;\na;b\n';
    const config = { sepLine: true, newline: '\n', comments: ';' } as const;
    expect(() => parseDetailed(text, config)).toThrow(
      new Error('Comment character same as delimiter'),
    );
    for (const pieces of [[text], ...splits(text, mulberry32(9), 0)]) {
      let thrown: unknown;
      const delivered: Batch[] = [];
      try {
        for await (const batch of parseStream(pieces, config)) delivered.push(batch);
      } catch (error) {
        thrown = error;
      }
      expect([pieces, delivered, thrown]).toStrictEqual([
        pieces,
        [],
        new Error('Comment character same as delimiter'),
      ]);
    }
    // With the newline to guess, and under detect with skipFirstNLines given, the same.
    for (const other of [
      { sepLine: true, comments: ';' },
      { detect: true, skipFirstNLines: 0, newline: '\n', comments: ';' },
    ] as const) {
      expect(() => parseDetailed(text, other)).toThrow('Comment character same as delimiter');
      await expect(collect(Array.from(text), other)).rejects.toThrow(
        'Comment character same as delimiter',
      );
    }
  });

  it('2: a comment line that completes the records held back gives the batch at once: no further read', async () => {
    let reads = 0;
    const iterator = {
      next: () =>
        reads++ === 0
          ? Promise.resolve({ done: false as const, value: 'aaa\n1\n#c\n' })
          : new Promise<never>(() => undefined),
    };
    const batches = parseStream(
      { [Symbol.asyncIterator]: () => iterator },
      { repair: true, comments: '#', delimiter: ',', newline: '\n', batchSize: 1 },
    );
    const first = await Promise.race([
      batches.next(),
      new Promise<'pending'>((resolve) => setTimeout(resolve, 200, 'pending')),
    ]);
    expect(first).not.toBe('pending');
    expect((first as IteratorResult<Batch, undefined>).value?.data).toStrictEqual([['aaa']]);
    expect(reads).toBe(1);
  });

  describe('3: under repair a batch’s cursor is the end of the record that filled it, comment lines after it not counted', () => {
    it.each([
      // "x\ry\r" is split: the piece "x" ends after its "\r" (2), the record at 5; "#c\n" follows.
      // repair removes the empty record of the end, so the last row's batch is the last batch,
      // whose cursor is bulk's.
      ['a split record before a comment line', 'x\ry\r\n#c\nzz\nww\n', 1, [2, 5, 11, 14]],
      ['a split record before a comment line', 'x\ry\r\n#c\nzz\nww\n', 2, [5, 14]],
      ['a changed record before a comment line', 'xy\r\n#c\nzz\nww\n', 1, [4, 10, 13]],
      ['comment lines at the end of the input', 'x\ry\r\nzz\n#c\n#d\n', 1, [2, 5, 14]],
      ['comment lines at the end of the input', 'x\ry\r\nzz\n#c\n#d\n', 3, [14]],
      ['comment lines at the end of the input', 'x\ry\r\nzz\nww\n#c\n#d\n', 3, [8, 17]],
    ] as const)(
      '%s, %j, batchSize %i: cursors %j at every split',
      async (_name, text, batchSize, cursors) => {
        const config = { repair: true, comments: '#', delimiter: ',' } as const;
        const bulk = featureReference(text, config);
        for (const pieces of [[text], ...splits(text, mulberry32(10), 5)]) {
          const batches = await collect(pieces, { ...config, batchSize });
          expect([pieces, batches.map((batch) => batch.meta.cursor)]).toStrictEqual([
            pieces,
            cursors,
          ]);
          expect(featureDifference(batches, bulk, config, batchSize)).toBeNull();
        }
      },
    );

    it('where no record is split, the cursors are those of the stream without a feature', async () => {
      const text = 'xy\r\n#c\nzz\nww\n';
      const plain = await collect([text], {
        comments: '#',
        delimiter: ',',
        newline: '\n',
        batchSize: 1,
      });
      // The plain stream keeps the "\r" in "xy\r" and the empty record of the end.
      expect(plain.map((batch) => batch.meta.cursor)).toStrictEqual([4, 10, 13, 13]);
    });

    it('120 seeded inputs with comment lines, mixed line breaks and split records: the batches do not depend on the split', async () => {
      const random = mulberry32(SEED + 3);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      const failures: unknown[] = [];
      for (let k = 0; k < 120; k++) {
        let text = '';
        for (let r = 1 + Math.floor(random() * 7); r > 0; r--) {
          text +=
            pick(['a,b', 'x\ry', '1', '#c', '#d\r', 'p\rq\rr', '', '"u\nv",w']) +
            pick(['\n', '\n', '\r\n']);
        }
        const config = {
          repair: true,
          comments: '#',
          delimiter: ',',
          header: k % 2 === 0,
          skipEmptyLines: k % 3 === 0,
        } as const;
        const check = await checkFeatures(text, config, 1 + (k % 3), [
          [text],
          ...splits(text, random, 3),
        ]);
        if (check.failure !== null) failures.push({ text, config, ...check.failure });
      }
      expect(failures).toStrictEqual([]);
    });
  });

  describe('4: an abort or return() made inside a validator ends the iteration at once', () => {
    const rows = 'age\n1\n2\n3\n4\n';
    const config = { header: true, delimiter: ',', newline: '\n' } as const;
    const schemaThat = (act: (index: number) => void, result: (index: number) => unknown) => {
      const calls: number[] = [];
      const schema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => {
            const index = calls.length;
            calls.push(index);
            act(index);
            return result(index) ?? { value };
          },
        },
      } as unknown as StandardSchemaV1;
      return { schema, calls };
    };

    it('abort inside a validator that returns a promise which never settles: next() rejects with the reason; no later row is validated', async () => {
      const reason = new Error('inside');
      const controller = new AbortController();
      const { schema, calls } = schemaThat(
        (index) => {
          if (index === 1) controller.abort(reason);
        },
        (index) => (index === 1 ? new Promise(() => undefined) : undefined),
      );
      const batches = parseStream([rows], { ...config, schema, signal: controller.signal });
      const first = await Promise.race([
        batches.next().then(
          () => 'resolved',
          (error: unknown) => error,
        ),
        new Promise<'pending'>((resolve) => setTimeout(resolve, 200, 'pending')),
      ]);
      expect(first).toBe(reason);
      expect(calls).toStrictEqual([0, 1]);
      await expect(batches.next()).resolves.toStrictEqual({ done: true, value: undefined });
    });

    it('abort inside a synchronous validator: next() rejects with the reason; no later row is validated', async () => {
      const reason = new Error('inside');
      const controller = new AbortController();
      const { schema, calls } = schemaThat(
        (index) => {
          if (index === 1) controller.abort(reason);
        },
        () => undefined,
      );
      await expect(
        parseStream([rows], { ...config, schema, signal: controller.signal }).next(),
      ).rejects.toBe(reason);
      expect(calls).toStrictEqual([0, 1]);
    });

    it('abort inside a validator after an awaited row: the rest is not validated', async () => {
      const reason = new Error('inside');
      const controller = new AbortController();
      const { schema, calls } = schemaThat(
        (index) => {
          if (index === 2) controller.abort(reason);
        },
        (index) => (index === 0 ? Promise.resolve({ value: 0 }) : undefined),
      );
      await expect(
        parseStream([rows], { ...config, schema, signal: controller.signal }).next(),
      ).rejects.toBe(reason);
      expect(calls).toStrictEqual([0, 1, 2]);
    });

    it('return() inside a validator, sync or with a promise that later rejects: the pending next() resolves done; no later row is validated; nothing is unhandled', async () => {
      for (const result of [
        () => undefined,
        (index: number) => (index === 1 ? Promise.reject(new Error('late')) : undefined),
      ]) {
        const holder: { batches?: ReturnType<typeof parseStream> } = {};
        const { schema, calls } = schemaThat((index) => {
          if (index === 1) void holder.batches?.return();
        }, result);
        holder.batches = parseStream([rows], { ...config, schema });
        const first = await Promise.race([
          holder.batches.next(),
          new Promise<'pending'>((resolve) => setTimeout(resolve, 200, 'pending')),
        ]);
        expect(first).toStrictEqual({ done: true, value: undefined });
        expect(calls).toStrictEqual([0, 1]);
        await tick();
      }
    });
  });

  describe('5: every batch counts the changes to its own rows', () => {
    it('under preview with 12,000 padded rows in 1,000-row batches', async () => {
      const text = 'a,b\n' + '1\n'.repeat(12_000);
      const config = {
        repair: true,
        preview: 12_000,
        header: true,
        delimiter: ',',
        newline: '\n',
      } as const;
      const bulk = featureReference(text, config);
      // preview counts the rows after the header record.
      expect(bulk.repairCounts?.['pad-missing']).toBe(12_000);
      const batches = await collect([text], { ...config, batchSize: 1000 });
      expect(featureDifference(batches, bulk, config, 1000)).toBeNull();
      // Twelve batches of 1,000 rows; the twelfth is the last.
      expect(batches.map((batch) => batch.repairCounts?.['pad-missing'])).toStrictEqual(
        Array.from({ length: 12 }, () => 1000),
      );
      expect(batches.map((batch) => batch.repairs?.length)).toStrictEqual([
        ...Array.from({ length: 10 }, () => 1000),
        0,
        0,
      ]);
    }, 120_000);

    it('with batches of 12,000 rows: more changes per batch than the log holds', async () => {
      const text = 'a,b\n' + '1\n'.repeat(30_000);
      const config = { repair: true, header: true, delimiter: ',', newline: '\n' } as const;
      const bulk = featureReference(text, config);
      for (const pieces of [[text], [text.slice(0, 33_333), text.slice(33_333)]]) {
        const batches = await collect(pieces, { ...config, batchSize: 12_000 });
        expect(featureDifference(batches, bulk, config, 12_000)).toBeNull();
        expect(batches.map((batch) => batch.repairCounts?.['pad-missing'])).toStrictEqual([
          12_000, 12_000, 6000,
        ]);
        expect(batches.map((batch) => batch.repairCounts?.['trailing-empty-record'])).toStrictEqual(
          [0, 0, 1],
        );
        expect(batches.map((batch) => batch.repairs?.length)).toStrictEqual([10_000, 0, 0]);
      }
    }, 120_000);
  });
});

// The bound on a batch's text through parseStream: a batch closes at batchSize rows, or when the
// text read for it reaches 1,048,576 UTF-16 units; the concatenated results are those of bulk,
// whatever the source.
describe('the bound on a batch’s text, through parseStream and with the features', () => {
  const pieces = (text: string, size: number) =>
    Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
      text.slice(i * size, (i + 1) * size),
    );
  const byteChunks = (text: string, size: number) => {
    const all = encoder.encode(text);
    return Array.from({ length: Math.ceil(all.length / size) }, (_, i) =>
      all.subarray(i * size, (i + 1) * size),
    );
  };
  /** The text whole, in 65,536-unit chunks, and as UTF-8 in 65,536-byte chunks and in one chunk. */
  const sources = (text: string): StreamSource[] => [
    [text],
    pieces(text, 65_536),
    byteChunks(text, 65_536),
    [encoder.encode(text)],
  ];
  /** [rows, rowOffset, cursor] of each batch. */
  const shape = (batches: readonly Batch[]) =>
    batches.map(({ data, meta }) => [data.length, meta.rowOffset, meta.cursor]);

  it('without a feature key: the same batches from every source; the bound counts UTF-16 units, not bytes', async () => {
    const config = { delimiter: ',', newline: '\n' } as const;
    for (const unit of ['x', 'é', '😀']) {
      // Records of 300,000 units each (150,000 for the two-unit character).
      const text = `${unit.repeat(300_000 / unit.length)}\n`.repeat(10);
      for (const source of sources(text)) {
        expect(shape(await collect(source, config))).toStrictEqual([
          [4, 0, 1_200_004],
          [4, 4, 2_400_008],
          [3, 8, 3_000_010],
        ]);
      }
    }
  }, 120_000);

  it('schema (S10): a batch closes at the bound on its rows as built and is then validated', async () => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          Number((value as { a: string }).a) % 3 === 0
            ? { issues: [{ message: 'a multiple of 3' }] }
            : { value },
      },
    };
    const rows = Array.from({ length: 10 }, (_, i) => `${String(i)},${'v'.repeat(300_000 + i)}`);
    const text = `a,b\n${rows.join('\n')}`;
    const config = { header: true, delimiter: ',', newline: '\n', schema } as const;
    const bulk = parseDetailed(text, config);
    for (const source of sources(text)) {
      const batches = await collect(source, config);
      // Four rows as built reach the bound: rowOffset steps by them, data keeps the valid ones.
      expect(
        batches.map(({ data, errors, meta }) => [
          meta.rowOffset,
          data.map((row) => (row as { a: string }).a),
          errors.map((error) => (error as SchemaError).row),
        ]),
      ).toStrictEqual([
        [0, ['1', '2'], [0, 3]],
        [4, ['4', '5', '7'], [6]],
        [8, ['8'], [9]],
      ]);
      expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    }
  }, 120_000);

  it('repair: each batch has the repairs of its rows, and closes where it closes without repair', async () => {
    const text = `a,b,c\n${Array.from({ length: 10 }, (_, i) => `${String(i)},${'v'.repeat(400_000)}\n`).join('')}`;
    const plain = { header: true, delimiter: ',', newline: '\n' } as const;
    const config = { ...plain, repair: true } as const;
    const bulk = parseDetailed(text, config);
    const without = shape(await collect([text], plain));
    for (const source of sources(text)) {
      const batches = await collect(source, config);
      expect(shape(batches)).toStrictEqual([
        [3, 0, 1_200_015],
        [3, 3, 2_400_024],
        [3, 6, 3_600_033],
        [1, 9, 4_000_036],
      ]);
      // Without repair the [''] record at the end is a row of the last batch.
      expect(shape(batches).slice(0, 3)).toStrictEqual(without.slice(0, 3));
      expect(
        batches.map((batch) => batch.repairs?.map((repair) => [repair.rule, repair.row])),
      ).toStrictEqual([
        [
          ['pad-missing', 0],
          ['pad-missing', 1],
          ['pad-missing', 2],
        ],
        [
          ['pad-missing', 3],
          ['pad-missing', 4],
          ['pad-missing', 5],
        ],
        [
          ['pad-missing', 6],
          ['pad-missing', 7],
          ['pad-missing', 8],
        ],
        [
          ['pad-missing', 9],
          ['trailing-empty-record', -1],
        ],
      ]);
      expect(sumCounts(batches)).toStrictEqual(bulk.repairCounts);
      expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    }
  }, 120_000);

  it('mixed-newline: the rows of a split record share its text, so the bound can close a batch inside it', async () => {
    // Each record of 400,010 units becomes three rows at its lone "\r"s.
    const record = (i: number) =>
      `${String(i)},${'m'.repeat(200_000)}\r${String(i)},${'n'.repeat(200_000)}\r${String(i)},x\n`;
    const text = `a,b\n${[0, 1, 2, 3].map(record).join('')}`;
    const config = { repair: true, delimiter: ',' } as const;
    const bulk = parseDetailed(text, config);
    expect(bulk.meta.linebreak).toBe('\n');
    expect(bulk.repairCounts?.['mixed-newline']).toBe(4);
    for (const source of sources(text)) {
      const batches = await collect(source, config);
      // The first batch ends after the second row of the third record, at its "\r".
      expect(shape(batches)).toStrictEqual([
        [9, 0, 1_200_030],
        [4, 9, 1_600_044],
      ]);
      expect(text.charAt(1_200_029)).toBe('\r');
      expect(batches.flatMap((batch) => batch.data)).toStrictEqual(bulk.data);
      expect(batches.flatMap((batch) => batch.repairs)).toStrictEqual(bulk.repairs);
      expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    }
  }, 120_000);

  it('S8: the 10,000-entry cap of repairs is per stream when the bound closes the batches', async () => {
    const text = `a,b,c\n${Array.from({ length: 12_000 }, (_, i) => `${String(i)},${'v'.repeat(2000)}\n`).join('')}`;
    const config = { header: true, delimiter: ',', newline: '\n', repair: true } as const;
    const bulk = parseDetailed(text, config);
    expect(bulk.repairs?.length).toBe(10_000);
    for (const source of [[text], pieces(text, 65_536)]) {
      const batches = await collect(source, config);
      expect(batches).toHaveLength(23);
      expect(batches.slice(0, 2).map((batch) => batch.data.length)).toStrictEqual([524, 524]);
      expect(batches.flatMap((batch) => batch.repairs)).toStrictEqual(bulk.repairs);
      expect(sumCounts(batches)).toStrictEqual(bulk.repairCounts);
      expect(featureDifference(batches, bulk, config, 1024)).toBeNull();
    }
  }, 120_000);
});

describe('the copies of private helpers of src/detailed.ts in src/batches.ts', () => {
  const declaration = (file: string, name: string) => {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const start = text.indexOf(`\nfunction ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('\n}\n', start) + 3);
  };

  it.each(['previewRows', 'once'])('%s is the original’s text', (name) => {
    expect(declaration('batches.ts', name)).toBe(declaration('detailed.ts', name));
  });
});
