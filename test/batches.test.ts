import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { BATCH_TEXT, BatchBuilder } from '../src/batches.ts';
import { resolveParseConfig } from '../src/options.ts';
import { RecordEnd } from '../src/record-end.ts';
import { parse } from '../src/parse.ts';
import { scanRows, SEARCH, type ScanDialect, type ScanWindow } from '../src/parser.ts';
import type { Newline, ParseBatch, ParseConfig, StreamMeta } from '../src/types.ts';
import {
  DIALECTS,
  difference,
  OVERLAYS,
  recorded,
  records,
  soup,
  type Dialect,
} from './differential.ts';
import {
  buildBatches,
  checkSplits,
  s2Delimiter,
  splits,
  streamDifference,
} from './stream-split.ts';

// BatchBuilder with a fixed dialect: the batches of a text given in pieces
// equal bulk parse under rules (a)-(c) of test/stream-split.ts, and do not
// depend on where the pieces split the text (rule d).

const SEED = 20261113;
const RANDOM_SETS = 30;
const BATCH_SIZES = [1, 2, 3, 1024];

/**
 * What the equality test covered per batchSize: inputs, runs (the unsplit one and every split),
 * inputs whose config both sides reject (comments equal to the delimiter), batches of the unsplit runs.
 */
const EXPECTED_COUNTS: Record<number, unknown> = {
  1: { inputs: 2052, splits: 140_358, throwing: 40, batches: 5299 },
  2: { inputs: 2052, splits: 140_358, throwing: 40, batches: 3316 },
  3: { inputs: 2052, splits: 140_358, throwing: 40, batches: 2716 },
  1024: { inputs: 2052, splits: 140_358, throwing: 40, batches: 2012 },
};

/** What the maxRecordLength fuzz covered per limit: inputs, runs, inputs that reject, runs that waited for the unit after a "\\r". */
const EXPECTED_LIMITED: Record<number, unknown> = {
  3: { inputs: 2012, splits: 137_698, rejecting: 1879, waited: 12 },
  8: { inputs: 2012, splits: 137_698, rejecting: 1722, waited: 17 },
  40: { inputs: 2012, splits: 137_698, rejecting: 586, waited: 2 },
};

/** The inputs and runs of each test with a misled RecordEnd. */
const EXPECTED_MISLED = [401, 27_053];

/** What the promptness test covered. */
const EXPECTED_PROMPT = { inputs: 720, splits: 49_355, pushes: 150_593, records: 1662 };

/** The explicit dialect every fixed-dialect case has. */
const D = { delimiter: ',', newline: '\n' } as const;

type StreamTestConfig = ParseConfig & { batchSize?: number; maxRecordLength?: number };

const meta = (over: Partial<StreamMeta>): StreamMeta => ({
  delimiter: ',',
  linebreak: '\n',
  renamedHeaders: null,
  rowOffset: 0,
  cursor: 0,
  truncated: false,
  done: true,
  ...over,
});

/** The fixed-dialect config: delimiter (a string) and newline given, no skipFirstNLines, fastMode not true. */
const inScope = (config: ParseConfig) =>
  typeof config.delimiter === 'string' &&
  config.delimiter !== '' &&
  config.newline !== undefined &&
  config.newline !== '' &&
  config.skipFirstNLines === undefined &&
  config.fastMode !== true;

const overlaid = (config: ParseConfig, dialect: Dialect, index: number, random: () => number) => {
  const overlay = OVERLAYS[index] ?? {};
  return typeof overlay === 'function'
    ? overlay(config, dialect, random)
    : { ...config, ...overlay };
};

/** The OVERLAYS indices that keep a dialect inside the fixed-dialect config. */
const IN_SCOPE = OVERLAYS.map((_, index) => index).filter((index) =>
  inScope(overlaid({ ...D }, { ...D }, index, () => 0)),
);

interface Case {
  input: string;
  config: ParseConfig;
  overlays: readonly number[];
}

/**
 * For every dialect of DIALECTS: no overlay, each in-scope overlay alone, and
 * RANDOM_SETS seeded sets of two or three of them, applied in draw order as
 * fuzz does; one soup and one record input per set.
 */
function cases(): Case[] {
  const random = mulberry32(SEED);
  const list: Case[] = [];
  for (const dialect of DIALECTS) {
    const sets: number[][] = [[], ...IN_SCOPE.map((index) => [index])];
    for (let n = 0; n < RANDOM_SETS; n++) {
      sets.push(
        Array.from(
          { length: 2 + Math.floor(random() * 2) },
          () => IN_SCOPE[Math.floor(random() * IN_SCOPE.length)] ?? 0,
        ),
      );
    }
    for (const overlays of sets) {
      let config: ParseConfig = { ...dialect };
      for (const index of overlays) config = overlaid(config, dialect, index, random);
      const delimiter = config.delimiter as string;
      const newline = config.newline as Newline;
      for (const input of [soup(random), records(random, delimiter, newline, config.quoteChar)]) {
        list.push({ input, config, overlays });
      }
    }
  }
  return list;
}

const CASES = cases();

/** The reference config: S1 makes preview count records when fastMode is omitted. */
const counted = (config: ParseConfig): ParseConfig =>
  (config.preview ?? 0) > 0 && config.fastMode === undefined
    ? { ...config, fastMode: false }
    : config;

const message = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

/** Batches, the callback calls made for them, and the message of what was thrown, if anything. */
function run(pieces: readonly string[], config: ParseConfig, batchSize: number) {
  const record = recorded(config);
  const { batches, thrown } = buildBatches(pieces, { ...record.config, batchSize });
  return { batches, calls: record.calls, thrown: thrown === undefined ? null : message(thrown) };
}

/** Bulk parse's callback calls, or the message of what it threw. */
function bulk(text: string, config: ParseConfig) {
  const record = recorded(counted(config));
  try {
    parse(text, record.config);
    return { calls: record.calls, thrown: null };
  } catch (thrown) {
    return { calls: record.calls, thrown: message(thrown) };
  }
}

const sameBatches = (a: readonly ParseBatch<unknown>[], b: readonly ParseBatch<unknown>[]) =>
  a.length === b.length && a.every((batch, i) => difference(batch, b[i]) === null);

interface Span {
  /** Where the record or comment line starts. */
  start: number;
  /** Its units, the line break not counted. */
  length: number;
  /** Where it ends, the line break included. */
  end: number;
  /** False for a comment line. */
  record: boolean;
  /** Whether a line break ends it; false only for the last one, which the input ends. */
  ended: boolean;
}

/**
 * The records and comment lines of a whole text in order, as scanRows reads
 * them one record per call; the comment lines a call skips are found as
 * scanRows skips them.
 */
function spans(text: string, config: ParseConfig): Span[] {
  const options = resolveParseConfig(config, 'main');
  const { comments, quoteChar } = options;
  const newline = options.newline as Newline;
  const dialect: ScanDialect = {
    delimiter: options.delimiter as string,
    newline,
    quoteChar,
    escapeChar: options.escapeChar,
    comments,
    preview: 0,
    fastMode: false,
  };
  const window: ScanWindow = {
    cursor: 0,
    limit: 1,
    final: true,
    nextDelimiter: SEARCH,
    nextNewline: SEARCH,
    nextQuote: SEARCH,
    end: -1,
    stop: 'end',
  };
  const list: Span[] = [];
  for (;;) {
    let start = window.cursor;
    while (comments !== '' && text[start] !== quoteChar && text.startsWith(comments, start)) {
      const at = text.indexOf(newline, start);
      const ended = at !== -1;
      const end = ended ? at + newline.length : text.length;
      list.push({ start, length: (ended ? at : end) - start, end, record: false, ended });
      if (!ended) return list;
      start = end;
    }
    scanRows(text, dialect, undefined, window);
    const { end } = window;
    if (end === -1) return list;
    const ended = window.stop === 'limit';
    const length = end - start - (ended ? newline.length : 0);
    list.push({ start, length, end, record: true, ended });
    if (!ended) return list;
  }
}

/**
 * Where the first record or comment line longer than max starts, among those
 * the stream reads (up to the record that reaches preview at a line break); null for none.
 */
function firstTooLong(text: string, config: ParseConfig, max: number): number | null {
  // Records to read, the header record included (0: no limit).
  const { preview } = resolveParseConfig(config, 'main');
  let records = 0;
  for (const span of spans(text, config)) {
    if (span.length > max) return span.start;
    if (span.record && ++records === preview && span.ended) return null;
  }
  return null;
}

/** The batches when end() is called before the first take(). */
function endedFirst(text: string, config: ParseConfig, batchSize: number) {
  const builder = new BatchBuilder(resolveParseConfig(config, 'main'), {
    batchSize,
    maxRecordLength: 0,
  });
  const batches: ParseBatch<unknown>[] = [];
  builder.push(text);
  builder.end();
  for (let b = builder.take(); b !== undefined; b = builder.take()) batches.push(b);
  return batches;
}

/** Pushes pieces until take() throws: the pushes made, the batches taken before, and the error. */
function untilThrow(pieces: readonly string[], config: StreamTestConfig) {
  const { batchSize = 1024, maxRecordLength = 0, ...parseConfig } = config;
  const builder = new BatchBuilder(resolveParseConfig(parseConfig, 'main'), {
    batchSize,
    maxRecordLength,
  });
  const batches: ParseBatch<unknown>[] = [];
  let pushes = 0;
  try {
    for (const piece of pieces) {
      builder.push(piece);
      pushes++;
      for (let b = builder.take(); b !== undefined; b = builder.take()) batches.push(b);
    }
    builder.end();
    for (let b = builder.take(); b !== undefined; b = builder.take()) batches.push(b);
  } catch (thrown) {
    return { pushes, batches, thrown, after: builder.take() };
  }
  return { pushes, batches, thrown: undefined, after: builder.take() };
}

describe('BatchBuilder, fixed dialect', () => {
  describe('worked examples', () => {
    it('a record split over two pieces is one row of one batch', () => {
      expect(buildBatches(['a,b\n1', ',2'], D)).toStrictEqual({
        batches: [
          {
            data: [
              ['a', 'b'],
              ['1', '2'],
            ],
            errors: [],
            meta: meta({ cursor: 7 }),
          },
        ],
      });
    });

    it('batchSize 2 gives cursors 8 and 11 and rowOffsets 0 and 2', () => {
      expect(buildBatches(['a,1\nb,2\nc,3'], { ...D, batchSize: 2 })).toStrictEqual({
        batches: [
          {
            data: [
              ['a', '1'],
              ['b', '2'],
            ],
            errors: [],
            meta: meta({ rowOffset: 0, cursor: 8, done: false }),
          },
          { data: [['c', '3']], errors: [], meta: meta({ rowOffset: 2, cursor: 11, done: true }) },
        ],
      });
    });

    it('a duplicate header, every meta field', () => {
      expect(buildBatches(['id,id\n1,2'], { ...D, header: true })).toStrictEqual({
        batches: [
          {
            data: [{ id: '1', id_1: '2' }],
            errors: [],
            meta: {
              delimiter: ',',
              linebreak: '\n',
              fields: ['id', 'id_1'],
              renamedHeaders: { id_1: 'id' },
              rowOffset: 0,
              cursor: 9,
              truncated: false,
              done: true,
            },
          },
        ],
      });
    });

    it('errors go to the batch of their record, Quotes before FieldMismatch', () => {
      const tooFew = (row: number) => ({
        type: 'FieldMismatch',
        code: 'TooFewFields',
        message: 'Too few fields: expected 2 fields but parsed 1',
        row,
      });
      const fields = ['a', 'b'];
      expect(
        buildBatches(['a,b\n1,2\n3\n4,5\n"6'], { ...D, header: true, batchSize: 2 }),
      ).toStrictEqual({
        batches: [
          {
            data: [{ a: '1', b: '2' }, { a: '3' }],
            errors: [tooFew(1)],
            meta: meta({ fields, rowOffset: 0, cursor: 10, done: false }),
          },
          {
            data: [{ a: '4', b: '5' }, { a: '6' }],
            errors: [
              {
                type: 'Quotes',
                code: 'MissingQuotes',
                message: 'Quoted field unterminated',
                row: 4,
                index: 15,
              },
              tooFew(3),
            ],
            meta: meta({ fields, rowOffset: 2, cursor: 16, done: true }),
          },
        ],
      });
    });

    it('a record over three pieces; with maxRecordLength 10 the RangeError', () => {
      const pieces = ['id,note\n1,"lo', 'ng', ' text"\n2,x'];
      expect(buildBatches(pieces, D)).toStrictEqual({
        batches: [
          {
            data: [
              ['id', 'note'],
              ['1', 'long text'],
              ['2', 'x'],
            ],
            errors: [],
            meta: meta({ cursor: 25 }),
          },
        ],
      });
      const { batches, thrown } = buildBatches(pieces, { ...D, maxRecordLength: 10 });
      expect(batches).toStrictEqual([]);
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as RangeError).message).toBe(
        'Record at offset 8 is longer than maxRecordLength (10)',
      );
    });

    it('preview 2 counts records and ends at the line break of the second', () => {
      expect(buildBatches(['a\nb\nc\nd'], { ...D, preview: 2 })).toStrictEqual({
        batches: [{ data: [['a'], ['b']], errors: [], meta: meta({ cursor: 4, truncated: true }) }],
      });
    });
  });

  describe('the last batch always comes', () => {
    it('no text, an empty text and a BOM alone give one empty batch at cursor 0', () => {
      const empty = { batches: [{ data: [], errors: [], meta: meta({}) }] };
      expect(buildBatches([], D)).toStrictEqual(empty);
      expect(buildBatches([''], D)).toStrictEqual(empty);
      expect(buildBatches(['\ufeff'], D)).toStrictEqual(empty);
      expect(buildBatches([], { ...D, header: true })).toStrictEqual({
        batches: [{ data: [], errors: [], meta: meta({ fields: [] }) }],
      });
    });

    it('a header-only input still gives its fields', () => {
      expect(buildBatches(['a,b'], { ...D, header: true })).toStrictEqual({
        batches: [{ data: [], errors: [], meta: meta({ fields: ['a', 'b'], cursor: 3 }) }],
      });
    });

    it.each<[string, string, StreamTestConfig, ParseBatch<unknown>[]]>([
      [
        'the input ends the record that fills the batch: that batch is the last',
        'a\nb',
        { ...D, batchSize: 2 },
        [{ data: [['a'], ['b']], errors: [], meta: meta({ cursor: 3 }) }],
      ],
      [
        'a line break ends it and no row follows: a full batch, then an empty last one',
        'a\nb\n',
        { ...D, batchSize: 2, skipEmptyLines: true },
        [
          { data: [['a'], ['b']], errors: [], meta: meta({ cursor: 4, done: false }) },
          { data: [], errors: [], meta: meta({ rowOffset: 2, cursor: 4 }) },
        ],
      ],
      [
        'a line break ends it and only a comment line follows: the same',
        'a\nb\n#c',
        { ...D, batchSize: 2, comments: '#' },
        [
          { data: [['a'], ['b']], errors: [], meta: meta({ cursor: 4, done: false }) },
          { data: [], errors: [], meta: meta({ rowOffset: 2, cursor: 4 }) },
        ],
      ],
      [
        'with a header, the input ending the last record',
        'h\na\nb',
        { ...D, batchSize: 2, header: true },
        [{ data: [{ h: 'a' }, { h: 'b' }], errors: [], meta: meta({ fields: ['h'], cursor: 5 }) }],
      ],
      [
        'preview reached at a line break by the record that fills the batch: the last, truncated',
        'a\nb\nc',
        { ...D, batchSize: 2, preview: 2 },
        [{ data: [['a'], ['b']], errors: [], meta: meta({ cursor: 4, truncated: true }) }],
      ],
      [
        'preview reached by a record the input ends: the last, not truncated',
        'a\nb',
        { ...D, batchSize: 2, preview: 2 },
        [{ data: [['a'], ['b']], errors: [], meta: meta({ cursor: 3 }) }],
      ],
    ])('exactly batchSize rows, %s (every split)', (_, text, config, expected) => {
      const random = mulberry32(SEED);
      for (const pieces of [[text], ...splits(text, random, 5)]) {
        expect([pieces, buildBatches(pieces, config)]).toStrictEqual([
          pieces,
          { batches: expected },
        ]);
      }
    });

    it.each<[string, StreamTestConfig, number, unknown[]]>([
      ['a\n#c\n#d', { ...D, comments: '#' }, 2, [['a']]],
      ['a\n#c\n', { ...D, comments: '#' }, 5, [['a'], ['']]],
      ['#c\n#d', { ...D, comments: '#' }, 0, []],
      ['a\n', D, 2, [['a'], ['']]],
      ['a,b\r\n', { ...D, newline: '\r\n' }, 5, [['a', 'b'], ['']]],
    ])('the last cursor of %j is bulk’s (every split)', (text, config, cursor, data) => {
      const random = mulberry32(SEED);
      const linebreak = (config.newline ?? '\n') as Newline;
      expect(parse(text, config).meta.cursor).toBe(cursor);
      for (const pieces of [[text], ...splits(text, random, 5)]) {
        expect([pieces, buildBatches(pieces, config)]).toStrictEqual([
          pieces,
          { batches: [{ data, errors: [], meta: meta({ cursor, linebreak }) }] },
        ]);
      }
    });
  });

  describe(`every split equals bulk (seed ${String(SEED)})`, () => {
    it('uses every overlay of test/differential.ts that stays inside the fixed dialect', () => {
      expect(IN_SCOPE).toStrictEqual([
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        19,
        ...[26, 27, 28, 29, 30, 31, 32, 33, 34, 35],
      ]);
      // Left out of the fixed dialect: skipFirstNLines, fastMode: true, and a delimiter or newline to detect.
      expect(OVERLAYS.slice(15, 19)).toStrictEqual([
        { skipFirstNLines: 1 },
        { skipFirstNLines: 2 },
        { skipFirstNLines: 3 },
        { fastMode: true },
      ]);
      expect(OVERLAYS.slice(20, 23).map((overlay) => typeof overlay)).toStrictEqual([
        'function',
        'function',
        'function',
      ]);
      expect(OVERLAYS.slice(23, 26)).toStrictEqual([
        { delimiter: '', delimitersToGuess: ['::', ';', '\t', ','] },
        { delimiter: '', comments: '#' },
        { newline: '', skipFirstNLines: 1 },
      ]);
      expect(OVERLAYS).toHaveLength(36);
      expect(CASES).toHaveLength(DIALECTS.length * (1 + IN_SCOPE.length + RANDOM_SETS) * 2);
      expect(CASES).toHaveLength(2052);
      expect(CASES.every((c) => inScope(c.config))).toBe(true);
      // Each in-scope overlay is in a case with each dialect, alone.
      for (const index of IN_SCOPE) {
        expect(
          CASES.filter((c) => c.overlays.length === 1 && c.overlays[0] === index),
        ).toHaveLength(DIALECTS.length * 2);
      }
    });

    it.each(BATCH_SIZES)(
      'batchSize %i: rules (a)-(d) and the callback calls, at every split point, unit by unit and at 5 random cuts',
      (batchSize) => {
        const random = mulberry32(SEED + batchSize);
        const failures: unknown[] = [];
        const counts = { inputs: 0, splits: 0, throwing: 0, batches: 0 };
        for (const c of CASES) {
          const { input, config } = c;
          const fail = (what: string, pieces: readonly string[]) => {
            if (failures.length < 5) failures.push({ what, input, config, pieces });
          };
          const reference = bulk(input, config);
          // The unsplit run, with which every split must agree (rule d).
          let whole: ReturnType<typeof run> | undefined;
          counts.inputs++;
          if (reference.thrown !== null) counts.throwing++;
          for (const pieces of [[input], ...splits(input, random, 5)]) {
            counts.splits++;
            const got = run(pieces, config, batchSize);
            if (whole === undefined) {
              whole = got;
              counts.batches += got.batches.length;
            }
            if (got.thrown !== reference.thrown) fail(`throws ${String(got.thrown)}`, pieces);
            if (!isDeepStrictEqual(got.calls, reference.calls)) fail('callback calls', pieces);
            if (!sameBatches(got.batches, whole.batches)) fail('rule (d)', pieces);
            if (reference.thrown !== null) {
              if (got.batches.length > 0) fail('batches before a throw at the start', pieces);
              continue;
            }
            const diff = streamDifference(got.batches, input, config, batchSize);
            if (diff !== null) fail(diff, pieces);
          }
          if (reference.thrown === null && whole !== undefined) {
            const early = endedFirst(input, config, batchSize);
            if (!sameBatches(early, whole.batches)) fail('end() before the first take()', [input]);
          }
        }
        expect(failures).toStrictEqual([]);
        expect(counts).toStrictEqual(EXPECTED_COUNTS[batchSize]);
      },
      600_000,
    );
  });

  describe('pull exactness at the builder', () => {
    it('three records in one text give three batches without a push between them', () => {
      const builder = new BatchBuilder(resolveParseConfig(D, 'main'), {
        batchSize: 1,
        maxRecordLength: 0,
      });
      builder.push('a\nb\nc\n');
      const taken = [builder.take(), builder.take(), builder.take(), builder.take()];
      expect(taken.map((batch) => batch?.data)).toStrictEqual([
        [['a']],
        [['b']],
        [['c']],
        undefined,
      ]);
      expect(taken.map((batch) => batch?.meta.cursor)).toStrictEqual([2, 4, 6, undefined]);
      builder.end();
      expect(builder.take()).toStrictEqual({
        data: [['']],
        errors: [],
        meta: meta({ rowOffset: 3, cursor: 6 }),
      });
      expect(builder.take()).toBeUndefined();
    });

    it('take() returns undefined exactly while the text holds no complete record', () => {
      const builder = new BatchBuilder(resolveParseConfig(D, 'main'), {
        batchSize: 1,
        maxRecordLength: 0,
      });
      expect(builder.take()).toBeUndefined();
      builder.push('a,"b');
      expect(builder.take()).toBeUndefined();
      builder.push('\n"');
      expect(builder.take()).toBeUndefined();
      builder.push('');
      expect(builder.take()).toBeUndefined();
      builder.push('\nc');
      expect(builder.take()?.data).toStrictEqual([['a', 'b\n']]);
      expect(builder.take()).toBeUndefined();
      builder.end();
      expect(builder.take()?.data).toStrictEqual([['c']]);
      expect(builder.take()).toBeUndefined();
    });
  });

  describe('maxRecordLength', () => {
    const M = 5;
    const error = (offset: number) =>
      `Record at offset ${String(offset)} is longer than maxRecordLength (${String(M)})`;
    const CRLF = { ...D, newline: '\r\n' } as const;

    // [what, text, config, the offset in the message or null when the text passes]. One text
    // can pass until the input ends (its last unit may start a line break): 'end'.
    const edges: Array<[string, string, ParseConfig, number | null, 'end'?]> = [
      ['a record of exactly M units', 'aaaaa\nb', D, null],
      ['a record of M + 1 units', 'aaaaaa\nb', D, 0],
      ['"\\r\\n" after M units is not counted', 'aaaaa\r\nbbbbb\r\n', CRLF, null],
      ['"\\r\\n" after M + 1 units', 'a\r\nbbbbbb\r\n', CRLF, 3],
      ['a last record of M units that the input ends', 'a\nbbbbb', D, null],
      ['a last record of M + 1 units that the input ends', 'a\nbbbbbb', D, 2],
      ['M units and a "\\r" that the input ends, newline "\\r\\n"', 'a\r\nbbbbb\r', CRLF, 3, 'end'],
      ['a quoted field counts with its quotes: M units', 'a\n"b,b"\nc', D, null],
      ['a quoted field counts with its quotes: M + 1 units', 'a\n"b,bb"\nc', D, 2],
      ['a quoted field with a line break in it', '"a\nbbb"\n', D, 0],
      ['"\\r\\n" inside a quoted field at M units', '"aaaa\r\nb"\r\n', CRLF, 0],
      ['an unclosed quote', 'a\n"bbbbbbbbbbbbbb', D, 2],
      ['a header record of M units', 'aa,bb\n1,2', { ...D, header: true }, null],
      ['a header record of M + 1 units', 'aaa,bb\n1,2', { ...D, header: true }, 0],
      ['a comment line of M units', 'a\n#cccc\nb', { ...D, comments: '#' }, null],
      ['a comment line of M + 1 units', 'a\n#ccccc\nb', { ...D, comments: '#' }, 2],
      ['a first comment line of M + 1 units', '#ccccc\nb', { ...D, comments: '#' }, 0],
      ['a last comment line of M units', 'a\n#cccc', { ...D, comments: '#' }, null],
      ['a last comment line of M + 1 units', 'a\n#ccccc', { ...D, comments: '#' }, 2],
      ['a comment line, "\\r\\n" after M units', '//ccc\r\nb', { ...CRLF, comments: '//' }, null],
      ['a comment line, "\\r\\n" after M + 1', '//cccc\r\nb', { ...CRLF, comments: '//' }, 0],
      ['a record removed by skipEmptyLines', 'a\n      \nb', { ...D, skipEmptyLines: 'greedy' }, 2],
      ['offsets count after the BOM', '\ufeffa\nbbbbbb\n', D, 2],
      ['the BOM is not counted', '\ufeffaaaaa\nb', D, null],
    ];

    it.each(edges)('%s (every split)', (_, text, config, offset, when) => {
      const random = mulberry32(SEED);
      const bom = text.startsWith('\ufeff') ? 1 : 0;
      for (const pieces of [[text], ...splits(text, random, 5)]) {
        const got = untilThrow(pieces, { ...config, maxRecordLength: M });
        if (offset === null) {
          expect([pieces, got.thrown]).toStrictEqual([pieces, undefined]);
          expect(streamDifference(got.batches, text, config, 1024)).toBeNull();
          continue;
        }
        expect(got.thrown).toBeInstanceOf(RangeError);
        expect([pieces, (got.thrown as RangeError).message]).toStrictEqual([pieces, error(offset)]);
        expect(got.after).toBeUndefined();
        // No push after the one that brings unit M + 1 of the record.
        let held = 0;
        const crossing = pieces.findIndex((piece) => (held += piece.length) > bom + offset + M);
        const pushes = when === 'end' ? pieces.length : crossing + 1;
        expect([pieces, got.pushes]).toStrictEqual([pieces, pushes]);
      }
    });

    it('an unclosed quote: the throw comes from the take() after the push that crosses M', () => {
      const pieces = Array.from({ length: 10 }, (_, i) => (i === 0 ? '"xxx' : 'xxxx'));
      const got = untilThrow(pieces, { ...D, maxRecordLength: 10 });
      expect(got.pushes).toBe(3);
      expect(got.batches).toStrictEqual([]);
      expect((got.thrown as RangeError).message).toBe(
        'Record at offset 0 is longer than maxRecordLength (10)',
      );
      expect(got.after).toBeUndefined();
    });

    it('M units and "\\r" under "\\r\\n": waits for the next unit outside a quoted field only', () => {
      // The pushes made, and whether the throw came before end() ('push'), from it ('end') or not at all.
      const outcome = (pieces: string[], config: ParseConfig = CRLF) => {
        const got = untilThrow(pieces, { ...config, maxRecordLength: M });
        const threw =
          got.thrown === undefined ? 'no' : got.pushes < pieces.length ? 'push' : 'last';
        return [got.pushes, threw];
      };
      expect(outcome(['aaaaa\r', '\n'])).toStrictEqual([2, 'no']);
      expect(outcome(['aaaaa\r', 'x', '\r\n'])).toStrictEqual([2, 'push']);
      expect(outcome(['aaaaa\r', '\r\n', 'b'])).toStrictEqual([2, 'push']);
      // The input ends: the record is M + 1 units.
      expect(outcome(['aaaaa\r'])).toStrictEqual([1, 'last']);
      // Inside a quoted field the "\r" cannot start the record's line break.
      expect(outcome(['"aaaa\r', '\n', 'b"\r\n'])).toStrictEqual([1, 'push']);
      // After a closing quote it can.
      expect(outcome(['"aaa"\r', '\n'])).toStrictEqual([2, 'no']);
      expect(outcome(['"aaa"\r', '"', '\r\n'])).toStrictEqual([2, 'push']);
      // A comment line.
      const comments = { ...CRLF, comments: '#' };
      expect(outcome(['#cccc\r', '\n'], comments)).toStrictEqual([2, 'no']);
      expect(outcome(['#cccc\r', 'x', '\r\n'], comments)).toStrictEqual([2, 'push']);
    });

    it('batches taken before the throw stay; the batch being filled is dropped', () => {
      const got = untilThrow(['a\nb\nc\ndddddd\n'], { ...D, batchSize: 2, maxRecordLength: M });
      expect(got.batches).toStrictEqual([
        { data: [['a'], ['b']], errors: [], meta: meta({ cursor: 4, done: false }) },
      ]);
      expect((got.thrown as RangeError).message).toBe(error(6));
      expect(got.after).toBeUndefined();
    });

    it('a text of many records longer than M in total passes and equals bulk', () => {
      const text = 'aa,bb\n'.repeat(200);
      for (const batchSize of [1, 7, 1024]) {
        const { batches, thrown } = buildBatches([text], { ...D, batchSize, maxRecordLength: M });
        expect(thrown).toBeUndefined();
        expect(streamDifference(batches, text, D, batchSize)).toBeNull();
      }
    });

    it('end() before the first take(): a last comment line the input ends is measured', () => {
      const run = (text: string) => {
        const builder = new BatchBuilder(resolveParseConfig({ ...D, comments: '#' }, 'main'), {
          batchSize: 1024,
          maxRecordLength: M,
        });
        builder.push(text);
        builder.end();
        return builder.take();
      };
      expect(run('a\nbbb\n#cccc')).toStrictEqual({
        data: [['a'], ['bbb']],
        errors: [],
        meta: meta({ cursor: 6 }),
      });
      expect(() => run('a\nbbb\n#ccccc')).toThrow(new RangeError(error(6)));
    });

    it.each([3, 8, 40])(
      `the fuzz inputs with maxRecordLength %i (seed ${String(SEED)}): the first longer record rejects, at every split, on the push that brings its unit M + 1`,
      (max) => {
        const random = mulberry32(SEED + max);
        const batchSize = 2;
        const failures: unknown[] = [];
        const counts = { inputs: 0, splits: 0, rejecting: 0, waited: 0 };
        for (const { input, config } of CASES) {
          if (bulk(input, config).thrown !== null) continue;
          counts.inputs++;
          const bom = input.startsWith('\ufeff') ? 1 : 0;
          const body = input.slice(bom);
          const offset = firstTooLong(body, config, max);
          if (offset !== null) counts.rejecting++;
          const expected =
            offset === null
              ? undefined
              : `Record at offset ${String(offset)} is longer than maxRecordLength (${String(max)})`;
          // Without the limit: all of its batches come, or the full ones before the record.
          const free = buildBatches([input], { ...config, batchSize }).batches;
          let whole: ParseBatch<unknown>[] | undefined;
          for (const pieces of [[input], ...splits(input, random, 5)]) {
            counts.splits++;
            const fail = (what: string) => {
              if (failures.length < 5) failures.push({ what, input, config, pieces });
            };
            const got = untilThrow(pieces, { ...config, batchSize, maxRecordLength: max });
            whole ??= got.batches;
            const thrown = got.thrown === undefined ? undefined : message(got.thrown);
            if (thrown !== expected) fail(`throws ${String(thrown)}, expected ${String(expected)}`);
            if (got.thrown !== undefined && !(got.thrown instanceof RangeError)) fail('error type');
            if (!sameBatches(got.batches, whole)) fail('batches differ between splits');
            const prefix = offset === null ? free : free.slice(0, got.batches.length);
            if (!sameBatches(got.batches, prefix))
              fail('batches differ from those without a limit');
            if (offset === null || got.thrown === undefined) continue;
            if (got.batches.some((batch) => batch.meta.done)) fail('a last batch before the throw');
            // The push that brings unit M + 1 of the record; one unit later (or the end of
            // the input) only when that unit is a "\r" that may start the record's "\r\n".
            const pushAt = (units: number) => {
              let held = 0;
              const index = pieces.findIndex((piece) => (held += piece.length) > units);
              return index === -1 ? pieces.length : index + 1;
            };
            const first = pushAt(bom + offset + max);
            if (got.pushes === first) continue;
            const mayEnd = config.newline === '\r\n' && body[offset + max] === '\r';
            if (mayEnd && got.pushes === pushAt(bom + offset + max + 1)) counts.waited++;
            else fail(`rejected after push ${String(got.pushes)}, expected ${String(first)}`);
          }
        }
        expect(failures).toStrictEqual([]);
        expect(counts).toStrictEqual(EXPECTED_LIMITED[max]);
      },
      600_000,
    );
  });

  describe(`a RecordEnd that answers early or late costs time, never data (seed ${String(SEED)})`, () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    // Every fifth fuzz input whose config is accepted: soup and record inputs in turn.
    const SAMPLE = CASES.filter((c, i) => i % 5 === 0 && bulk(c.input, c.config).thrown === null);

    it.each<[string, (text: string) => number]>([
      ['late: it never finds the end', () => -1],
      ['early: the record ends after one unit of every text', () => 1],
    ])(
      '%s',
      (_, feed) => {
        const random = mulberry32(SEED);
        const failures: unknown[] = [];
        let runs = 0;
        let unreset = 0;
        for (const { input, config } of SAMPLE) {
          const whole = buildBatches([input], { ...config, batchSize: 2 }).batches;
          // Without and with a limit that some records pass: no rejection that a true reader does not make.
          const limited = untilThrow([input], { ...config, batchSize: 2, maxRecordLength: 8 });
          // RecordEnd's rule: after an answer other than -1, reset() comes before the next feed().
          let answered = false;
          const reset = vi.spyOn(RecordEnd.prototype, 'reset').mockImplementation(() => {
            answered = false;
          });
          const spy = vi.spyOn(RecordEnd.prototype, 'feed').mockImplementation((text) => {
            if (answered) unreset++;
            const answer = feed(text);
            answered = answer !== -1;
            return answer;
          });
          for (const pieces of [[input], ...splits(input, random, 5)]) {
            runs++;
            const got = buildBatches(pieces, { ...config, batchSize: 2 });
            const same =
              got.thrown === undefined &&
              sameBatches(got.batches, whole) &&
              streamDifference(got.batches, input, config, 2) === null;
            if (!same && failures.length < 5) failures.push({ input, config, pieces });
            const bounded = untilThrow(pieces, { ...config, batchSize: 2, maxRecordLength: 8 });
            const sameLimited =
              sameBatches(bounded.batches, limited.batches) &&
              (bounded.thrown === undefined
                ? limited.thrown === undefined
                : message(bounded.thrown) === message(limited.thrown));
            if (!sameLimited && failures.length < 5) {
              failures.push({ what: 'maxRecordLength: 8', input, config, pieces });
            }
          }
          spy.mockRestore();
          reset.mockRestore();
        }
        expect(failures).toStrictEqual([]);
        expect(unreset).toBe(0);
        expect([SAMPLE.length, runs]).toStrictEqual(EXPECTED_MISLED);
      },
      600_000,
    );
  });

  describe('a carried record is scanned with its next text before a RecordEnd reads it', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const config = { delimiter: ',', newline: '\n' as const };
    const text = 'a,"b\nc""d",e\n1,"2\n3",4\n5,6,7\n';
    const whole = buildBatches([text], config).batches;
    const fed = () => vi.spyOn(RecordEnd.prototype, 'feed');

    it('a record that ends in the text after its first is read by no RecordEnd, wherever the cut is', () => {
      const feed = fed();
      for (let at = 1; at < text.length; at++) {
        const got = buildBatches([text.slice(0, at), text.slice(at)], config);
        expect(got.batches, String(at)).toStrictEqual(whole);
      }
      expect(feed).not.toHaveBeenCalled();
    });

    it('a record that does not is read by one, and so is each carried record after it until four in a row end in their second text', () => {
      const feed = fed();
      // Record 0 spans three pieces. The four carried records after it span two each and are
      // read; the fifth is scanned with its text.
      const long = `${text}8,9\n10,11\n12,13\n`;
      const pieces = [
        'a,"b',
        '\nc',
        '""d",e\n1,"2',
        '\n3",4\n5,',
        '6,7\n8',
        ',9\n10',
        ',11\n12,',
        '13\n',
      ];
      expect(pieces.join('')).toBe(long);
      expect(buildBatches(pieces, config).batches).toStrictEqual(
        buildBatches([long], config).batches,
      );
      expect(feed.mock.calls.map(([part]) => part)).toStrictEqual([
        'a,"b\nc',
        '""d",e\n1,"2',
        '1,"2',
        '\n3",4\n5,',
        '5,',
        '6,7\n8',
        '8',
        ',9\n10',
        '10',
        ',11\n12,',
      ]);
    });

    it('a next text that makes more than 2 x 1,048,576 units with the record, or more than maxRecordLength, is not joined', () => {
      const long = `a,"xx|xx"\n${'b,c\n'.repeat(524_300)}`;
      const [first = '', second = ''] = long.split('|');
      const expected = buildBatches([first + second], config).batches;
      const feed = fed();
      expect(buildBatches([first, second], config).batches).toStrictEqual(expected);
      expect(feed.mock.calls.map(([part]) => part.length)).toStrictEqual([5, 2_097_204]);
      feed.mockClear();
      const short = ['a,"xx', 'xx"\nb,c\nd,e\n'];
      const unlimited = buildBatches([short.join('')], config).batches;
      expect(buildBatches(short, { ...config, maxRecordLength: 16 }).batches).toStrictEqual(
        unlimited,
      );
      expect(feed.mock.calls.map(([part]) => part)).toStrictEqual(short);
      feed.mockClear();
      expect(buildBatches(short, { ...config, maxRecordLength: 17 }).batches).toStrictEqual(
        unlimited,
      );
      expect(feed).not.toHaveBeenCalled();
    });
  });

  describe(`promptness (seed ${String(SEED)})`, () => {
    it('with batchSize 1, each push gives a batch for every record whose line break it completes', () => {
      const random = mulberry32(SEED);
      const failures: unknown[] = [];
      const counts = { inputs: 0, splits: 0, pushes: 0, records: 0 };
      for (const dialect of DIALECTS.filter((d) => d.header !== true)) {
        const sets = [[], [0], [1], [2], [3], [0, 1], [1, 2], [0, 3]];
        for (const set of sets) {
          let config: ParseConfig = { ...dialect };
          for (const index of set) config = overlaid(config, dialect, index, random);
          const delimiter = config.delimiter as string;
          for (let k = 0; k < 5; k++) {
            for (const input of [
              soup(random),
              records(random, delimiter, dialect.newline, config.quoteChar),
            ]) {
              counts.inputs++;
              const bom = input.startsWith('\ufeff') ? 1 : 0;
              const ends = spans(input.slice(bom), config)
                .filter((span) => span.ended)
                .map((span) => span.end);
              counts.records += ends.length;
              for (const pieces of [[input], ...splits(input, random, 5)]) {
                counts.splits++;
                const builder = new BatchBuilder(resolveParseConfig(config, 'main'), {
                  batchSize: 1,
                  maxRecordLength: 0,
                });
                let pushed = 0;
                let taken = 0;
                for (const piece of pieces) {
                  builder.push(piece);
                  counts.pushes++;
                  pushed += piece.length;
                  while (builder.take() !== undefined) taken++;
                  const complete = ends.filter((end) => end <= pushed - bom).length;
                  if (taken !== complete && failures.length < 5) {
                    failures.push({ input, config, pieces, pushed, taken, complete });
                  }
                }
              }
            }
          }
        }
      }
      expect(failures).toStrictEqual([]);
      expect(counts).toStrictEqual(EXPECTED_PROMPT);
    }, 120_000);
  });

  describe('errors', () => {
    it('a comment marker equal to a given delimiter is rejected with the config, before any builder', () => {
      const config = { delimiter: ';', newline: '\n', comments: ';' } as const;
      expect(() => parse('a', config)).toThrow(new Error('Comment character same as delimiter'));
      expect(() => resolveParseConfig(config, 'main')).toThrow(
        new Error('Comment character same as delimiter'),
      );
    });

    it('what a callback throws is thrown by take(), which then returns undefined', () => {
      const failure = new Error('transform failed');
      const got = untilThrow(['a\nb\nx\nc\n'], {
        ...D,
        batchSize: 2,
        transform: (value) => {
          if (value === 'x') throw failure;
          return value;
        },
      });
      expect(got.thrown).toBe(failure);
      expect(got.batches.map((batch) => batch.data)).toStrictEqual([[['a'], ['b']]]);
      expect(got.after).toBeUndefined();
    });
  });

  it('a batch’s meta.fields is its own array: changing it changes no later row', () => {
    const builder = new BatchBuilder(resolveParseConfig({ ...D, header: true }, 'main'), {
      batchSize: 1,
      maxRecordLength: 0,
    });
    builder.push('a,b\n1,2\n3,4\n');
    const first = builder.take();
    first?.meta.fields?.reverse();
    const second = builder.take();
    expect(second?.data).toStrictEqual([{ a: '3', b: '4' }]);
    expect(second?.meta.fields).toStrictEqual(['a', 'b']);
  });
});

// The start-up: the BOM, skipFirstNLines, the detection window (S2, S3, S7) and preview counted in
// lines with fastMode: true.

const WINDOW = 1_048_576;
const PER_DIALECT = 140;
const START_SIZES = [1, 2, 1024];

/**
 * What each start-up equality test covered per batchSize: inputs, runs, inputs both sides reject,
 * batches of the unsplit runs, runs with batches before a throw (S6), inputs where S2 applies.
 */
const EXPECTED_START: Record<string, Record<number, unknown>> = {
  drawn: {
    1: { inputs: 5040, splits: 346455, throwing: 98, batches: 13100, early: 0, s2: 0 },
    2: { inputs: 5040, splits: 346455, throwing: 98, batches: 8259, early: 0, s2: 0 },
    1024: { inputs: 5040, splits: 346455, throwing: 98, batches: 4942, early: 0, s2: 0 },
  },
  fast: {
    1: { inputs: 2700, splits: 137395, throwing: 180, batches: 6217, early: 0, s2: 0 },
    2: { inputs: 2700, splits: 137395, throwing: 180, batches: 3828, early: 0, s2: 0 },
    1024: { inputs: 2700, splits: 137395, throwing: 180, batches: 2520, early: 0, s2: 0 },
  },
  long: {
    1: { inputs: 126, splits: 73806, throwing: 0, batches: 2844, early: 0, s2: 17 },
    2: { inputs: 126, splits: 73806, throwing: 0, batches: 1459, early: 0, s2: 17 },
    1024: { inputs: 126, splits: 73806, throwing: 0, batches: 126, early: 0, s2: 17 },
  },
};

/** The inputs and runs of each start-up test with a misled RecordEnd. */
const EXPECTED_START_MISLED = [343, 45_300];

/** The fuzz of test/differential.ts as it draws: 0 to 3 of all OVERLAYS per pair, one soup and one record input. */
function drawn(seed: number, perDialect: number): Case[] {
  const random = mulberry32(seed);
  const list: Case[] = [];
  for (const dialect of DIALECTS) {
    for (let k = 0; k < perDialect; k++) {
      const overlays: number[] = [];
      let config: ParseConfig = { ...dialect };
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const index = Math.floor(random() * OVERLAYS.length);
        overlays.push(index);
        config = overlaid(config, dialect, index, random);
      }
      const given = config.delimiter;
      const delimiter = typeof given === 'string' && given !== '' ? given : dialect.delimiter;
      const newline = config.newline || dialect.newline;
      for (const input of [soup(random), records(random, delimiter, newline, config.quoteChar)]) {
        list.push({ input, config, overlays });
      }
    }
  }
  return list;
}

const LINES = ['a', '#c', '', 'b,c', '//x', ';k', '"q', 'true', '#'];

/** Up to 8 short lines, comment lines of every fuzz marker among them. */
function lines(random: () => number, newline: string): string {
  const list = Array.from(
    { length: Math.floor(random() * 9) },
    () => LINES[Math.floor(random() * LINES.length)] ?? '',
  );
  return list.join(newline) + (random() < 0.5 ? newline : '');
}

const PREVIEWS = [10, 11, 12, 13, 14];
const COMMENTS = [4, 5, 6, 7];
const FAST_MODE = 18;

/** fastMode: true with each preview overlay, alone and with each comments overlay, for every dialect, twice. */
function fastCases(): Case[] {
  const random = mulberry32(SEED + 4);
  const list: Case[] = [];
  for (const dialect of DIALECTS) {
    for (const preview of PREVIEWS) {
      for (const overlays of [[], ...COMMENTS.map((index) => [index])]) {
        let config: ParseConfig = { ...dialect };
        for (const index of [FAST_MODE, preview, ...overlays]) {
          config = overlaid(config, dialect, index, random);
        }
        const { delimiter, newline } = dialect;
        for (let n = 0; n < 2; n++) {
          for (const input of [
            soup(random),
            records(random, delimiter, newline),
            lines(random, newline),
          ]) {
            list.push({ input, config, overlays: [FAST_MODE, preview, ...overlays] });
          }
        }
      }
    }
  }
  return list;
}

const omit = (config: ParseConfig, ...keys: string[]): ParseConfig =>
  Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));

const DETECTING: ReadonlyArray<(dialect: Dialect) => ParseConfig> = [
  (dialect) => omit(dialect, 'delimiter'),
  (dialect) => omit(dialect, 'newline'),
  (dialect) => omit(dialect, 'delimiter', 'newline'),
  (dialect) => ({ ...dialect, delimiter: () => dialect.delimiter }),
  (dialect) => ({ ...omit(dialect, 'delimiter'), comments: '#' }),
  (dialect) => ({ ...omit(dialect, 'delimiter', 'newline'), comments: '#', skipFirstNLines: 1 }),
  (dialect) => ({ ...omit(dialect, 'delimiter'), comments: '#', fastMode: true, preview: 3 }),
];

/**
 * Inputs of 6 to 36 records, so that the detection window can end before the text does. With
 * comments, comment lines stand between the blocks, and in half of the inputs the first four
 * blocks have no quote, so that a window without one can come before a quote (S2).
 */
function longCases(): Case[] {
  const random = mulberry32(SEED + 5);
  const list: Case[] = [];
  for (const dialect of DIALECTS) {
    for (const [index, detecting] of DETECTING.entries()) {
      const config = detecting(dialect);
      {
        const { delimiter, newline } = dialect;
        const plain = config.comments === '#' && random() < 0.5;
        let input = '';
        for (let block = 0; block < 6; block++) {
          let text = records(random, delimiter, newline);
          if (plain && block < 4) text = text.replaceAll('"', '');
          if (!text.endsWith(newline)) text += newline;
          if (config.comments === '#' && random() < 0.5) text = `#c${newline}${text}`;
          input += text;
        }
        list.push({ input, config, overlays: [index] });
      }
    }
  }
  return list;
}

/** checkSplits over every case: the first five failures and what was covered. */
function compareAll(list: readonly Case[], batchSize: number, random: () => number) {
  const failures: unknown[] = [];
  const counts = { inputs: 0, splits: 0, throwing: 0, batches: 0, early: 0, s2: 0 };
  for (const { input, config } of list) {
    const check = checkSplits(input, config, batchSize, random, 5);
    counts.inputs++;
    counts.splits += check.splits;
    counts.batches += check.batches;
    counts.early += check.early;
    if (check.throwing) counts.throwing++;
    if (check.s2) counts.s2++;
    if (check.failure !== null && failures.length < 5) {
      failures.push({ ...check.failure, input, config });
    }
  }
  return { failures, counts };
}

const chunks = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

/** Feeds pieces as buildBatches does and also reports the pushes made when the first batch came (null: after end()). */
function fed(pieces: readonly string[], config: StreamTestConfig) {
  const { batchSize = 1024, maxRecordLength = 0, ...parseConfig } = config;
  const builder = new BatchBuilder(resolveParseConfig(parseConfig, 'main'), {
    batchSize,
    maxRecordLength,
  });
  const batches: ParseBatch<unknown>[] = [];
  let pushes = 0;
  let ended = false;
  let first: number | null = null;
  let thrown: unknown;
  const take = () => {
    for (let b = builder.take(); b !== undefined; b = builder.take()) {
      if (batches.length === 0 && !ended) first = pushes;
      batches.push(b);
    }
  };
  try {
    for (const piece of pieces) {
      builder.push(piece);
      pushes++;
      take();
    }
    ended = true;
    builder.end();
    take();
  } catch (error) {
    thrown = error;
  }
  return { pushes, first, batches, thrown, after: builder.take() };
}

/** The whole text and every split give `expected`, which is also what bulk gives (rules a-c). */
function everySplit(text: string, config: StreamTestConfig, expected: ParseBatch<unknown>[]) {
  const random = mulberry32(SEED);
  for (const pieces of [[text], ...splits(text, random, 5)]) {
    expect([pieces, buildBatches(pieces, config)]).toStrictEqual([pieces, { batches: expected }]);
  }
  const parseConfig = omit(config, 'batchSize', 'maxRecordLength');
  expect(streamDifference(expected, text, parseConfig, config.batchSize ?? 1024)).toBeNull();
}

describe('BatchBuilder, start-up', () => {
  describe('the BOM and skipFirstNLines', () => {
    it('P9: the cursor counts after the BOM (8) and after the skipped line (7)', () => {
      const rows = (first: string[]) => [first, ['1', '2']];
      everySplit('﻿😀,b\n1,2', {}, [
        { data: rows(['😀', 'b']), errors: [], meta: meta({ cursor: 8 }) },
      ]);
      everySplit('x\na,b\n1,2', { skipFirstNLines: 1 }, [
        { data: rows(['a', 'b']), errors: [], meta: meta({ cursor: 7 }) },
      ]);
      everySplit('﻿x\na,b\n1,2', { ...D, skipFirstNLines: 1 }, [
        { data: rows(['a', 'b']), errors: [], meta: meta({ cursor: 7 }) },
      ]);
    });

    it('the BOM alone in the first piece is removed; a second U+FEFF is data', () => {
      expect(buildBatches(['﻿', 'a,b\n1,2'], {}).batches).toStrictEqual(
        buildBatches(['a,b\n1,2'], {}).batches,
      );
      expect(buildBatches(['﻿', '﻿a,b\n1,2'], {}).batches[0]?.data).toStrictEqual([
        ['﻿a', 'b'],
        ['1', '2'],
      ]);
      const empty = (config: ParseConfig) => [
        { data: [], errors: parse('', config).errors, meta: meta({}) },
      ];
      for (const config of [{}, { skipFirstNLines: 2 }, { newline: '\n' } as const]) {
        expect(parse('', config).errors.map((error) => error.code)).toStrictEqual([
          'UndetectableDelimiter',
        ]);
        expect(buildBatches([], config).batches).toStrictEqual(empty(config));
        expect(buildBatches(['﻿'], config).batches).toStrictEqual(empty(config));
      }
    });

    it.each<[string, string, StreamTestConfig, number, unknown[]]>([
      [
        'a "\\r\\n" cut between two pieces counts once',
        'x\r\ny\r\na,b\r\n1,2',
        { newline: '\r\n', skipFirstNLines: 2 },
        8,
        [
          ['a', 'b'],
          ['1', '2'],
        ],
      ],
      [
        'the newline of the skip is guessed',
        'x\r\ny\r\na,b\r\n1,2',
        { skipFirstNLines: 2 },
        8,
        [
          ['a', 'b'],
          ['1', '2'],
        ],
      ],
      [
        '"\\r\\r\\n" under "\\r\\n" is one line break',
        'x\r\r\na,b\r\n1,2',
        { newline: '\r\n', skipFirstNLines: 1, delimiter: ',' },
        8,
        [
          ['a', 'b'],
          ['1', '2'],
        ],
      ],
      [
        'a quoted line break is a line break for the skip',
        '"x\ny"\na,b\n1,2',
        { ...D, skipFirstNLines: 1 },
        10,
        [['y"'], ['a', 'b'], ['1', '2']],
      ],
      [
        'exactly the lines asked: the [""] record of an empty text is not made',
        'x\ny\n',
        { ...D, skipFirstNLines: 2 },
        0,
        [],
      ],
      ['fewer lines than asked leaves an empty text', 'x\ny', { ...D, skipFirstNLines: 2 }, 0, []],
    ])('%s (every split)', (_, text, config, cursor, data) => {
      const linebreak = text.includes('\r\n') ? '\r\n' : '\n';
      everySplit(text, config, [{ data, errors: [], meta: meta({ cursor, linebreak }) }]);
    });
  });

  describe('fastMode: true', () => {
    it('a quote is data: no record spans a line break and no Quotes error is made', () => {
      everySplit('"a\nb"x\n', { ...D, fastMode: true }, [
        { data: [['"a'], ['b"x'], ['']], errors: [], meta: meta({ cursor: 7 }) },
      ]);
    });

    it('a "\\r" before the skip\u2019s last line break is not kept for the lines of the preview', () => {
      const config = {
        ...D,
        newline: '\r\n',
        skipFirstNLines: 1,
        preview: 2,
        fastMode: true,
      } as const;
      // The skip ends in the second piece; the "\n" that starts the third is data, not half a line break.
      const pieces = ['x\r', 'y\r\n', '\na\r\nb\r\nc\r\nd'];
      const expected = [
        {
          data: [['\na'], ['b']],
          errors: [],
          meta: meta({ linebreak: '\r\n', cursor: 10, truncated: true }),
        },
      ];
      expect(buildBatches(pieces, config)).toStrictEqual({ batches: expected });
      everySplit(pieces.join(''), config, expected);
    });

    it('preview 2 with fastMode true and with false: both equal bulk; omitted counts records (S1)', () => {
      const text = 'a\nb\nc\nd';
      const data = [['a'], ['b']];
      const batch = (cursor: number) => [
        { data, errors: [], meta: meta({ cursor, truncated: true }) },
      ];
      everySplit(text, { ...D, preview: 2, fastMode: true }, batch(6));
      everySplit(text, { ...D, preview: 2, fastMode: false }, batch(4));
      // S1: bulk counts lines when the text has no quote, the stream counts records.
      const bulkResult = parse(text, { ...D, preview: 2 });
      expect([bulkResult.data, bulkResult.meta.cursor]).toStrictEqual([data, 6]);
      everySplit(text, { ...D, preview: 2 }, batch(4));
    });

    it('S1: "#x\\n#y\\na\\nb\\nc" with comments and preview 2: bulk [["a"]] at 8, the stream [["a"],["b"]] at 10', () => {
      const text = '#x\n#y\na\nb\nc';
      const config = { ...D, comments: true, preview: 2 } as const;
      const bulkResult = parse(text, config);
      expect([bulkResult.data, bulkResult.meta.cursor, bulkResult.meta.truncated]).toStrictEqual([
        [['a']],
        8,
        true,
      ]);
      const counted = parse(text, { ...config, fastMode: false });
      expect([counted.data, counted.meta.cursor]).toStrictEqual([[['a'], ['b']], 10]);
      everySplit(text, config, [
        { data: [['a'], ['b']], errors: [], meta: meta({ cursor: 10, truncated: true }) },
      ]);
      // With fastMode: true the stream counts lines, as bulk does.
      everySplit(text, { ...config, fastMode: true }, [
        { data: [['a']], errors: [], meta: meta({ cursor: 8, truncated: true }) },
      ]);
    });

    const C = { ...D, comments: '#' } as const;
    it.each<[string, ParseConfig, number, unknown[], number, boolean]>([
      ['a\nb', D, 2, [['a'], ['b']], 3, false],
      ['a\nb\n', D, 2, [['a'], ['b']], 4, true],
      ['a\nb\nc\nd', D, 2, [['a'], ['b']], 6, true],
      ['a\n#c\nb\nc\n', C, 2, [['a'], ['b']], 7, true],
      ['a\n#c\n#d', C, 2, [['a']], 2, false],
      ['a\n#c\n#d\n', C, 2, [['a'], ['']], 8, true],
      ['a\n#c', C, 1, [['a']], 2, false],
      ['a\n#c\n', C, 1, [['a']], 5, true],
      ['#a\n#b\n#c', C, 2, [], 0, false],
      ['#a\n#b\n#c\n', C, 2, [['']], 9, true],
      ['#c\na\n', C, 2, [['a'], ['']], 5, true],
      ['a\r\nb\r\nc\r\nd', { ...D, newline: '\r\n' }, 2, [['a'], ['b']], 9, true],
      ['"a\nb"\nc\n', D, 1, [['"a']], 6, true],
    ])(
      '%j with %j and preview %i (every split)',
      (text, config, preview, data, cursor, truncated) => {
        const linebreak = (config.newline ?? '\n') as Newline;
        const fast = { ...config, preview, fastMode: true } as const;
        const whole = parse(text, fast);
        expect([whole.data, whole.meta.cursor, whole.meta.truncated]).toStrictEqual([
          data,
          cursor,
          truncated,
        ]);
        everySplit(text, fast, [
          { data, errors: [], meta: meta({ cursor, truncated, linebreak }) },
        ]);
      },
    );

    it('the dropped line calls no callback; with a header the header line counts', () => {
      const seen: string[] = [];
      const transform = (value: string) => {
        seen.push(value);
        return value;
      };
      const got = buildBatches(['a\n', 'b\nc\nd'], { ...D, preview: 2, fastMode: true, transform });
      expect(got.batches.map((batch) => batch.data)).toStrictEqual([[['a'], ['b']]]);
      expect(seen).toStrictEqual(['a', 'b']);
      everySplit(
        'h\na\nb\nc\nd',
        { ...D, header: true, preview: 2, fastMode: true, batchSize: 1 },
        [
          { data: [{ h: 'a' }], errors: [], meta: meta({ fields: ['h'], cursor: 4, done: false }) },
          {
            data: [{ h: 'b' }],
            errors: [],
            meta: meta({ fields: ['h'], rowOffset: 1, cursor: 6, done: false }),
          },
          // Whether line 3 is the last is known only after the line that is dropped.
          {
            data: [],
            errors: [],
            meta: meta({ fields: ['h'], rowOffset: 2, cursor: 8, truncated: true }),
          },
        ],
      );
    });
  });

  describe(`every overlay, every split (seed ${String(SEED)})`, () => {
    const DRAWN = drawn(SEED + 1, PER_DIALECT);
    const FAST = fastCases();
    const LONG = longCases();

    it('draws from all of OVERLAYS and DIALECTS as fuzz does, at least 5,000 inputs', () => {
      expect(DRAWN).toHaveLength(DIALECTS.length * PER_DIALECT * 2);
      expect(DRAWN.length).toBeGreaterThanOrEqual(5000);
      const used = new Set(DRAWN.flatMap((c) => c.overlays));
      expect([...used].sort((a, b) => a - b)).toStrictEqual(OVERLAYS.map((_, index) => index));
      expect(Math.max(...DRAWN.map((c) => c.overlays.length))).toBe(3);
      // Outside the fixed dialect's config: what the start-up adds.
      expect(DRAWN.filter((c) => !inScope(c.config)).length).toBeGreaterThan(1000);
      expect(OVERLAYS.slice(10, 15)).toStrictEqual([1, 2, 3, 4, 5].map((preview) => ({ preview })));
      expect(OVERLAYS.slice(4, 8)).toStrictEqual(
        ['#', true, '//', ';'].map((comments) => ({ comments })),
      );
      expect(OVERLAYS[FAST_MODE]).toStrictEqual({ fastMode: true });
      expect(FAST).toHaveLength(DIALECTS.length * PREVIEWS.length * (1 + COMMENTS.length) * 6);
      expect(LONG).toHaveLength(DIALECTS.length * DETECTING.length);
    });

    it.each(START_SIZES)(
      'batchSize %i: the fuzz draw, rules (a)-(d), callback calls and thrown messages',
      (batchSize) => {
        const { failures, counts } = compareAll(DRAWN, batchSize, mulberry32(SEED + batchSize));
        expect(failures).toStrictEqual([]);
        expect(counts).toStrictEqual(EXPECTED_START.drawn?.[batchSize]);
      },
      900_000,
    );

    it.each(START_SIZES)(
      'batchSize %i: fastMode true forced with each preview overlay and each comments overlay',
      (batchSize) => {
        const { failures, counts } = compareAll(FAST, batchSize, mulberry32(SEED + batchSize));
        expect(failures).toStrictEqual([]);
        expect(counts).toStrictEqual(EXPECTED_START.fast?.[batchSize]);
      },
      900_000,
    );

    it.each(START_SIZES)(
      'batchSize %i: detection on inputs of 6 to 36 records, where the window ends before the text',
      (batchSize) => {
        const { failures, counts } = compareAll(LONG, batchSize, mulberry32(SEED + batchSize));
        expect(failures).toStrictEqual([]);
        expect(counts).toStrictEqual(EXPECTED_START.long?.[batchSize]);
      },
      900_000,
    );

    describe('a RecordEnd that answers early or late costs time, never data', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });
      const SAMPLE = [
        ...LONG.filter((_, i) => i % 2 === 0),
        ...FAST.filter((_, i) => i % 9 === 0),
      ].filter((c) => bulk(c.input, c.config).thrown === null);

      it.each<[string, (text: string) => number]>([
        ['late: it never finds the end', () => -1],
        ['early: the record ends after one unit of every text', () => 1],
      ])(
        '%s',
        (_, feed) => {
          const random = mulberry32(SEED);
          const failures: unknown[] = [];
          let runs = 0;
          let unreset = 0;
          for (const { input, config } of SAMPLE) {
            const whole = buildBatches([input], { ...config, batchSize: 2 }).batches;
            // RecordEnd's rule, for each of the builder's readers: after an answer other
            // than -1, reset() comes before the next feed().
            const answered = new WeakSet<RecordEnd>();
            const reset = vi.spyOn(RecordEnd.prototype, 'reset').mockImplementation(function (
              this: RecordEnd,
            ) {
              answered.delete(this);
            });
            const spy = vi.spyOn(RecordEnd.prototype, 'feed').mockImplementation(function (
              this: RecordEnd,
              text,
            ) {
              if (answered.has(this)) unreset++;
              const answer = feed(text);
              if (answer !== -1) answered.add(this);
              return answer;
            });
            for (const pieces of [[input], ...splits(input, random, 5)]) {
              runs++;
              const got = buildBatches(pieces, { ...config, batchSize: 2 });
              const same =
                got.thrown === undefined &&
                sameBatches(got.batches, whole) &&
                streamDifference(got.batches, input, config, 2) === null;
              if (!same && failures.length < 5) failures.push({ input, config, pieces });
            }
            spy.mockRestore();
            reset.mockRestore();
          }
          expect(failures).toStrictEqual([]);
          expect(unreset).toBe(0);
          expect([SAMPLE.length, runs]).toStrictEqual(EXPECTED_START_MISLED);
        },
        900_000,
      );
    });
  });

  describe('the detection window', () => {
    const TEXT = 'ab;cd\n'.repeat(180_000).slice(0, WINDOW + 100);

    it('newline omitted: no batch before 1,048,576 units are held, and the result equals bulk', () => {
      const config = { delimiter: ';' } as const;
      const whole = buildBatches([TEXT], config).batches;
      expect(whole).toHaveLength(Math.ceil((WINDOW + 100) / 6 / 1024));
      expect(streamDifference(whole, TEXT, config, 1024)).toBeNull();
      // [piece size, the pushes made when the first batch came]
      for (const [size, first] of [
        [65_536, 16],
        [100_003, 11],
        [WINDOW - 1, 2],
        [WINDOW, 1],
        [1_000_000, 2],
      ] as const) {
        const got = fed(chunks(TEXT, size), config);
        expect([size, got.first, got.thrown]).toStrictEqual([size, first, undefined]);
        expect([size, sameBatches(got.batches, whole)]).toStrictEqual([size, true]);
      }
      // A shorter text: all of it is the window, and the first batch comes after end().
      const short = TEXT.slice(0, WINDOW - 1);
      const got = fed(chunks(short, 65_536), config);
      expect([got.first, got.batches.length]).toStrictEqual([null, 171]);
      expect(streamDifference(got.batches, short, config, 1024)).toBeNull();
    });

    it('delimiter omitted, newline given: the window is the 10 records of the candidate that needs the most text', () => {
      // One record per piece: the first batch comes with the push that ends the tenth record.
      const records = Array.from({ length: 14 }, (_, i) => `a${String(i)};b\n`);
      const config = { newline: '\n', batchSize: 1 } as const;
      const got = fed(records, config);
      expect([got.first, got.batches.length]).toStrictEqual([10, 15]);
      expect(got.batches[0]?.meta.delimiter).toBe(';');
      const text = records.join('');
      const random = mulberry32(SEED);
      for (const pieces of splits(text, random, 5)) {
        const split = fed(pieces, config);
        // The push that brings the line break of the tenth record.
        let held = 0;
        const tenth = records.slice(0, 10).join('').length;
        const push = pieces.findIndex((piece) => (held += piece.length) >= tenth) + 1;
        expect([pieces, split.first]).toStrictEqual([pieces, push]);
        expect([pieces, sameBatches(split.batches, got.batches)]).toStrictEqual([pieces, true]);
      }
      expect(streamDifference(got.batches, text, { newline: '\n' }, 1)).toBeNull();
      // Under the candidate ";" the quoted field holds two line breaks, so its ten records end later
      // than the ten lines every other candidate reads.
      const quoted = ['b;"x\n', 'y\n', 'z"\n', ...records];
      const later = fed(quoted, config);
      expect([later.first, later.batches[0]?.meta.delimiter]).toStrictEqual([12, ';']);
      expect(streamDifference(later.batches, quoted.join(''), { newline: '\n' }, 1)).toBeNull();
      // After the window the carry is followed with the delimiter found: a record over two
      // pieces comes with the piece that ends it (a reader with "," would not see its end).
      const builder = new BatchBuilder(resolveParseConfig({ newline: '\n' }, 'main'), {
        batchSize: 1,
        maxRecordLength: 0,
      });
      builder.push(text);
      while (builder.take() !== undefined);
      builder.push('"x');
      expect(builder.take()).toBeUndefined();
      builder.push('";b\n');
      expect(builder.take()?.data).toStrictEqual([['x', 'b']]);
    });

    it('S2: with comments, a window without a quote before a text with one detects as bulk does on the window', () => {
      const window = '#c\n'.repeat(9) + 'a;b;c\nx;y;z\n' + 'p,q,r,s\n'.repeat(8);
      const text = `${window}"q"\n`;
      const config = { newline: '\n', comments: '#' } as const;
      // Bulk reads ten records of the whole text; on the window alone it counts lines.
      expect(parse(text, config).meta.delimiter).toBe(',');
      expect(parse(window, config).meta.delimiter).toBe(';');
      expect(s2Delimiter(text, config)).toBe(';');
      expect(s2Delimiter(window, config)).toBeNull();
      const expected = parse(text, { ...config, delimiter: ';' });
      expect(expected.data.slice(0, 3)).toStrictEqual([
        ['a', 'b', 'c'],
        ['x', 'y', 'z'],
        ['p,q,r,s'],
      ]);
      const random = mulberry32(SEED);
      for (const pieces of [[text], ...splits(text, random, 5)]) {
        const { batches } = buildBatches(pieces, config);
        expect(batches).toHaveLength(1);
        expect([pieces, batches[0]?.data]).toStrictEqual([pieces, expected.data]);
        expect([pieces, batches[0]?.meta.delimiter]).toStrictEqual([pieces, ';']);
      }
      // Without the quote after the window, and with one inside it, there is no difference.
      for (const same of [window, `${window}q\n`, `"q"\n${text}`]) {
        expect(s2Delimiter(same, config)).toBeNull();
        expect(
          streamDifference(buildBatches([same], config).batches, same, config, 1024),
        ).toBeNull();
      }
    });

    it('S3: a delimiter function is called once, with the first 1,048,576 units or the whole text', () => {
      for (const config of [{ newline: '\n' }, {}] as const) {
        for (const size of [65_536, 100_003, WINDOW + 100]) {
          const seen: string[] = [];
          const delimiter = (text: string) => {
            seen.push(text);
            return ';';
          };
          const got = fed(chunks(TEXT, size), { ...config, delimiter });
          expect(seen.map((text) => text.length)).toStrictEqual([WINDOW]);
          expect(seen[0]).toBe(TEXT.slice(0, WINDOW));
          expect([size, got.first]).toStrictEqual([size, Math.ceil(WINDOW / size)]);
          expect(
            streamDifference(got.batches, TEXT, { ...config, delimiter: ';' }, 1024),
          ).toBeNull();
        }
      }
      // A short text: all of it, after the BOM and the skipped lines, at every split.
      const short = '﻿x\na;b\n1;2';
      const random = mulberry32(SEED);
      for (const pieces of [[short], ...splits(short, random, 5)]) {
        const seen: string[] = [];
        const delimiter = (text: string) => {
          seen.push(text);
          return ';';
        };
        const { batches } = buildBatches(pieces, { skipFirstNLines: 1, delimiter });
        expect([pieces, seen]).toStrictEqual([pieces, ['a;b\n1;2']]);
        expect(batches[0]?.data).toStrictEqual([
          ['a', 'b'],
          ['1', '2'],
        ]);
      }
      const seen: string[] = [];
      buildBatches([], {
        delimiter: (text: string) => {
          seen.push(text);
          return ';';
        },
      });
      expect(seen).toStrictEqual(['']);
    });

    it('UndetectableDelimiter is in the first batch only, after its Quotes errors and before its FieldMismatch errors', () => {
      const text = 'h\n"x"y"\nq,r\n1\n2\n';
      const config = { header: true } as const;
      const whole = parse(text, config);
      expect(whole.errors.map((error) => error.type)).toStrictEqual([
        'Quotes',
        'Delimiter',
        'FieldMismatch',
      ]);
      const random = mulberry32(SEED);
      for (const pieces of [[text], ...splits(text, random, 5)]) {
        expect(buildBatches(pieces, config).batches.map((batch) => batch.errors)).toStrictEqual([
          whole.errors,
        ]);
        const small = buildBatches(pieces, { ...config, batchSize: 2 }).batches;
        expect(small.map((batch) => batch.errors.map((error) => error.type))).toStrictEqual([
          ['Quotes', 'Delimiter', 'FieldMismatch'],
          [],
          [],
        ]);
      }
    });

    it('a comment marker equal to the delimiter found or returned is rejected when detection runs', () => {
      const same = new Error('Comment character same as delimiter');
      for (const config of [{ comments: ';' }, { comments: ';', delimiter: () => ';' }] as const) {
        const got = fed(['a;b\n', '1;2\n'], { ...config, newline: '\n' });
        expect([got.batches, got.thrown, got.after]).toStrictEqual([[], same, undefined]);
        expect(() => parse('a;b\n1;2\n', config)).toThrow(same);
      }
      // true is compared as given: a returned "#" is not rejected, in bulk or here.
      const marker = { comments: true, delimiter: () => '#' } as const;
      const { batches } = buildBatches(['a#b\n', 'c\n'], marker);
      expect(streamDifference(batches, 'a#b\nc\n', marker, 1024)).toBeNull();
    });

    it('what a delimiter function throws is thrown by take(), which then returns undefined', () => {
      const failure = new Error('no delimiter');
      const got = fed(['a,b\n'], {
        delimiter: () => {
          throw failure;
        },
      });
      expect(got.thrown).toBe(failure);
      expect([got.batches, got.after]).toStrictEqual([[], undefined]);
    });
  });

  describe('the bound of the window without maxRecordLength: S7 applies to every stream', () => {
    // The allowance for detection only: 1,048,576 + 10 x (1,048,576 + 2) units.
    const BOUND = WINDOW + 10 * (WINDOW + 2);

    it('an ordinary file with a quoted first field: the first batch comes at the push that crosses the bound, with bulk’s delimiter', () => {
      expect(BOUND).toBe(11_534_356);
      // Under every candidate but "," the record that "name" opens never ends.
      const text = '"name",age\n'.repeat(1_100_000);
      const config = { newline: '\n' } as const;
      expect(parse(text, config).meta.delimiter).toBe(',');
      // 176 pieces hold 11,534,336 units, 20 short of the bound.
      const got = fed(chunks(text, 65_536), config);
      expect([got.first, got.thrown, got.batches[0]?.meta.delimiter]).toStrictEqual([
        177,
        undefined,
        ',',
      ]);
      expect(streamDifference(got.batches, text, config, 1024)).toBeNull();
      const other = fed(chunks(text, 1_000_003), config);
      expect([other.first, sameBatches(other.batches, got.batches)]).toStrictEqual([12, true]);
      // The probe's 100,000 rows end before the bound: all of the text is the window.
      const short = fed(chunks(text.slice(0, 1_100_000), 65_536), config);
      expect([short.first, short.batches[0]?.meta.delimiter]).toStrictEqual([null, ',']);
    }, 120_000);

    it('the allowance is not a record limit: a record of more than 1,048,576 units passes', () => {
      const text = `"${'x'.repeat(1_200_000)}",b\n${'c,d\n'.repeat(12)}`;
      const got = fed(chunks(text, 65_536), { newline: '\n' });
      expect(got.thrown).toBeUndefined();
      expect(streamDifference(got.batches, text, { newline: '\n' }, 1024)).toBeNull();
    });

    it('S7 without maxRecordLength: ten sampled records that span more than the bound are detected on what the bound holds', () => {
      // One record, 12,000,000 units of comment lines, then nine records.
      const text = `a,b;c;"d"\n${`#${'z'.repeat(98)}\n`.repeat(120_000)}${'x,y\n'.repeat(9)}`;
      const config = { newline: '\n', comments: '#' } as const;
      expect(text.length).toBe(12_000_046);
      // Bulk reads all ten records: ",". The window holds one: ";".
      expect(parse(text, config).meta.delimiter).toBe(',');
      const got = fed(chunks(text, 65_536), { ...config, batchSize: 1 });
      expect([got.first, got.thrown, got.batches[0]?.meta.delimiter]).toStrictEqual([
        177,
        undefined,
        ';',
      ]);
      expect(got.batches[0]?.data[0]).toStrictEqual(['a,b', 'c', 'd']);
      expect(streamDifference(got.batches, text, { ...config, delimiter: ';' }, 1)).toBeNull();
      const other = fed(chunks(text, 999_983), { ...config, batchSize: 1 });
      expect(sameBatches(other.batches, got.batches)).toBe(true);
    });
  });

  describe('the bound of the window with maxRecordLength (S7)', () => {
    const M = 100;
    const BOUND = WINDOW + 10 * (M + 2);
    const OPEN = `"${'x'.repeat(20 * 65_536 - 1)}`;
    const tooLong = new RangeError('Record at offset 0 is longer than maxRecordLength (100)');

    it('an unclosed quote with the delimiter omitted: text is asked for up to 1,048,576 + 10 x 102 units, then the RangeError', () => {
      expect(BOUND).toBe(1_049_596);
      for (const config of [{ newline: '\n' }, {}] as const) {
        // [piece size, pushes before the throw]: not at 1,048,576 units, and not after the bound.
        for (const [size, pushes] of [
          [65_536, 17],
          [104_900, 11],
          [BOUND - 1, 2],
          [BOUND, 1],
          [OPEN.length, 1],
        ] as const) {
          const got = fed(chunks(OPEN, size), { ...config, maxRecordLength: M });
          expect([size, got.pushes, got.batches, got.thrown, got.after]).toStrictEqual([
            size,
            pushes,
            [],
            tooLong,
            undefined,
          ]);
        }
      }
      // A text that ends inside the bound: detection runs at end(), then the same error.
      const got = fed(chunks(OPEN.slice(0, BOUND - 1), 65_536), { maxRecordLength: M });
      expect([got.pushes, got.thrown]).toStrictEqual([17, tooLong]);
    });

    it('the same text with delimiter and newline given rejects on the push that crosses M', () => {
      const got = fed(chunks(OPEN.slice(0, 1000), 50), { ...D, maxRecordLength: M });
      expect([got.pushes, got.batches, got.thrown]).toStrictEqual([3, [], tooLong]);
      // With only the newline to detect the window is 1,048,576 units, bound or not.
      const guessed = fed(chunks(OPEN, 65_536), { delimiter: ',', maxRecordLength: M });
      expect([guessed.pushes, guessed.thrown]).toStrictEqual([16, tooLong]);
    });

    it('S7: ten sampled records that do not fit in the bound are detected on what the bound holds', () => {
      // One record, 1,050,000 units of comment lines of 99 units, then nine records.
      const text = `a,b;c;"d"\n${`#${'z'.repeat(98)}\n`.repeat(10_500)}${'x,y\n'.repeat(9)}`;
      const config = { newline: '\n', comments: '#' } as const;
      expect(text.length).toBe(1_050_046);
      // Bulk and the unbounded stream read all ten records: ",".
      expect(parse(text, config).meta.delimiter).toBe(',');
      // batchSize 1: the first batch comes with the push that completes the window.
      const free = fed(chunks(text, 1000), { ...config, batchSize: 1 });
      expect([free.first, free.thrown]).toStrictEqual([1051, undefined]);
      expect(streamDifference(free.batches, text, config, 1)).toBeNull();
      // Bounded, the window ends in the comment lines and holds one record: ";".
      const bounded = fed(chunks(text, 1000), { ...config, batchSize: 1, maxRecordLength: M });
      expect([bounded.first, bounded.thrown]).toStrictEqual([1050, undefined]);
      expect(bounded.batches[0]?.meta.delimiter).toBe(';');
      expect(bounded.batches[0]?.data[0]).toStrictEqual(['a,b', 'c', 'd']);
      expect(streamDifference(bounded.batches, text, { ...config, delimiter: ';' }, 1)).toBeNull();
      // Where the pieces split changes nothing.
      for (const size of [65_536, 999_983, text.length]) {
        const other = fed(chunks(text, size), { ...config, batchSize: 1, maxRecordLength: M });
        expect([size, sameBatches(other.batches, bounded.batches)]).toStrictEqual([size, true]);
      }
    });
  });
});

// The bound on a batch's text: a batch closes when it holds batchSize rows, or when its text
// reaches BATCH_TEXT units, whichever comes first. Its text is the units read for it, from the end
// of the batch before to the end of the record that gives it a row, less the line break that ends
// each record read; every batch but the last holds at least one row.
describe('BatchBuilder, the bound on a batch’s text', () => {
  /** Records of these lengths, each ended by the newline. */
  const lines = (lengths: readonly number[], newline = '\n') =>
    lengths.map((length, i) => String(i % 10).repeat(length) + newline).join('');
  /** [rows, rowOffset, cursor] of each batch. */
  const shape = (batches: readonly ParseBatch<unknown>[]) =>
    batches.map(({ data, meta }) => [data.length, meta.rowOffset, meta.cursor]);
  /** The batches of text whole, which every split below gives too; they equal bulk (rules a-c). */
  function batchesOf(text: string, config: StreamTestConfig): ParseBatch<unknown>[] {
    const whole = buildBatches([text], config);
    expect(whole.thrown).toBeUndefined();
    for (const size of [65_536, 1_000_003, 333_331]) {
      expect([
        size,
        sameBatches(buildBatches(chunks(text, size), config).batches, whole.batches),
      ]).toStrictEqual([size, true]);
    }
    const parseConfig = omit(config, 'batchSize', 'maxRecordLength');
    expect(streamDifference(whole.batches, text, parseConfig, config.batchSize ?? 1024)).toBeNull();
    return whole.batches;
  }

  it('is 1,048,576 units', () => {
    expect(BATCH_TEXT).toBe(1_048_576);
  });

  it('long records under batchSize: a batch closes at the record whose text brings it to the bound', () => {
    // Four records of 300,000 units reach it; the last batch has the rest and the [''] record.
    const text = lines(Array.from({ length: 10 }, () => 300_000));
    expect(shape(batchesOf(text, D))).toStrictEqual([
      [4, 0, 1_200_004],
      [4, 4, 2_400_008],
      [3, 8, 3_000_010],
    ]);
    // With maxRecordLength the records are scanned one per call: the same batches.
    expect(shape(batchesOf(text, { ...D, maxRecordLength: 300_000 }))).toStrictEqual([
      [4, 0, 1_200_004],
      [4, 4, 2_400_008],
      [3, 8, 3_000_010],
    ]);
  }, 120_000);

  it('the bound is reached at exactly 1,048,576 units, and a line break does not count', () => {
    const config = { ...D, newline: '\r\n' } as const;
    expect(shape(batchesOf(lines([524_288, 524_288, 5], '\r\n'), config))).toStrictEqual([
      [2, 0, 1_048_580],
      [2, 2, 1_048_587],
    ]);
    // One unit less: the third record closes the batch.
    expect(shape(batchesOf(lines([524_288, 524_287, 5, 5], '\r\n'), config))).toStrictEqual([
      [3, 0, 1_048_586],
      [2, 3, 1_048_593],
    ]);
  }, 120_000);

  it('a record longer than the bound is a batch of its own, or ends the batch it comes in', () => {
    expect(shape(batchesOf(lines([2_000_000, 3, 3]), D))).toStrictEqual([
      [1, 0, 2_000_001],
      [3, 1, 2_000_009],
    ]);
    expect(shape(batchesOf(lines([10, 10, 2_000_000, 10]), D))).toStrictEqual([
      [3, 0, 2_000_023],
      [2, 3, 2_000_034],
    ]);
    // Without a final line break the long record is the last batch.
    expect(shape(batchesOf('a\n' + 'x'.repeat(1_500_000), D))).toStrictEqual([[2, 0, 1_500_002]]);
  }, 120_000);

  it('short records are unaffected: every batch but the last holds batchSize rows', () => {
    // 1,024 rows of 1,024 units reach the bound with the row that fills the batch.
    const exact = lines(Array.from({ length: 3000 }, () => 1024));
    expect(shape(batchesOf(exact, D)).map(([rows]) => rows)).toStrictEqual([1024, 1024, 953]);
    const short = lines(Array.from({ length: 20_000 }, (_, i) => i % 97));
    const sizes = shape(batchesOf(short, { ...D, batchSize: 1000 })).map(([rows]) => rows);
    expect(sizes).toStrictEqual([...Array.from({ length: 20 }, () => 1000), 1]);
  }, 120_000);

  it('the header record, comment lines and records skipEmptyLines removes count; a batch holds at least one row', () => {
    // A header of 1,100,000 units: the first row closes the first batch.
    const header = `${'h'.repeat(1_100_000)}\n${lines([5, 5, 5])}`;
    expect(batchesOf(header, { ...D, header: true }).map(({ data }) => data.length)).toStrictEqual([
      1, 3,
    ]);
    // A comment line of 1,100,000 units after two rows: the next row closes the batch.
    const comment = `a\nb\n#${'c'.repeat(1_100_000)}\nd\ne\n`;
    expect(shape(batchesOf(comment, { ...D, comments: '#' }))).toStrictEqual([
      [3, 0, 1_100_008],
      [2, 3, 1_100_010],
    ]);
    // Removed whitespace records of 600,000 units each: the row after two of them closes it.
    const blank = ` ${' '.repeat(600_000)}\n${' '.repeat(600_000)}\nf\ng\n`;
    expect(
      batchesOf(blank, { ...D, skipEmptyLines: 'greedy' }).map(({ data }) => data),
    ).toStrictEqual([[['f']], [['g']]]);
  }, 120_000);

  describe('one text longer than the bound is read in prefixes that end where the batch may', () => {
    const many = { ...D, batchSize: 2_000_000 };

    it('a quote that only comes after the first prefix', () => {
      // Records of 3 units: the 349,526th brings the text to 1,048,578 units.
      const text = 'a,b\n'.repeat(400_000) + '"x,y",z\n'.repeat(5) + '"p\nq",r\n';
      expect(batchesOf(text, many).map(({ data }) => data.length)).toStrictEqual([349_526, 50_481]);
    }, 120_000);

    it('a delimiter that only comes after the first prefix, also one of two units cut by its end', () => {
      const text = 'a\n'.repeat(1_200_000) + 'b,c\n'.repeat(5);
      expect(batchesOf(text, many).map(({ data }) => data.length)).toStrictEqual([
        1_048_576, 151_430,
      ]);
      // "::" at units 1,048,575 and 1,048,576: the first prefix ends between them.
      const cut = 'a\n'.repeat(524_287) + 'x::y\n' + 'v::w\n'.repeat(3);
      expect(cut.indexOf('::')).toBe(BATCH_TEXT - 1);
      const config = { ...D, delimiter: '::', batchSize: 1000 };
      expect(batchesOf(cut, config).at(-1)?.data.slice(-5)).toStrictEqual([
        ['x', 'y'],
        ['v', 'w'],
        ['v', 'w'],
        ['v', 'w'],
        [''],
      ]);
    }, 120_000);

    it('a line break or a delimiter of two units, found in the text before, that a prefix’s end cuts', () => {
      // The scan has already found the "\r\n" (or "::") that the next prefix ends inside. With
      // fastMode: true there is no quote, and a record that the prefix lets end past its end must
      // not loop there. Here 262,144 records of 2 units fill the first prefix exactly, and the
      // second ends between the "\r" and the "\n".
      const crlf = { ...D, newline: '\r\n', fastMode: true, batchSize: 1_000_000 } as const;
      const text = `${'ab\r\n'.repeat(262_144)}${'x'.repeat(524_287)}\r\nc\r\n`;
      expect(text.indexOf('\r\n', BATCH_TEXT)).toBe(BATCH_TEXT + 524_288 - 1);
      expect(shape(batchesOf(text, crlf))).toStrictEqual([
        [262_146, 0, BATCH_TEXT + 524_292],
        [1, 262_146, BATCH_TEXT + 524_292],
      ]);
      // The first batch is a and b; the next prefix ends inside the "::" after the long field.
      const colons = { ...D, delimiter: '::', fastMode: true, batchSize: 2 } as const;
      const fields = `a\nb\n${'x'.repeat(BATCH_TEXT - 1)}::y\nc\n`;
      expect(fields.indexOf('::')).toBe(4 + BATCH_TEXT - 1);
      const batches = batchesOf(fields, colons);
      expect(shape(batches)).toStrictEqual([
        [2, 0, 4],
        [1, 2, BATCH_TEXT + 7],
        [2, 3, BATCH_TEXT + 9],
      ]);
      expect((batches[1]?.data[0] as string[])[1]).toBe('y');
    }, 120_000);

    it('a "\\r\\n" cut by the end of the first prefix', () => {
      const text = 'xyz\r\n' + 'ab\r\n'.repeat(300_000);
      expect(text.slice(BATCH_TEXT - 1, BATCH_TEXT + 1)).toBe('\r\n');
      expect(batchesOf(text, { ...many, newline: '\r\n' })).toHaveLength(1);
    }, 120_000);
  });
});
