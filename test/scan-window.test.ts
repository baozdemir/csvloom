import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { resolveParseConfig } from '../src/options.ts';
import { scanRows, SEARCH, type ScanDialect, type ScanWindow } from '../src/parser.ts';
import type { Newline, ParseConfig, QuoteError } from '../src/types.ts';
import { DIALECTS, OVERLAYS, records, soup } from './differential.ts';

// The scan window of scanRows: a scan spread over several calls gives what one bulk scan gives, and
// a scan of a text that is not the end of the input withholds exactly the record no line break
// ends.

const SEED = 20261111;
const INPUTS_PER_CONFIG = 25;
const MANY = 1000;

/** The overlays of test/differential.ts that keep an explicit dialect and change what scanRows reads. */
const SCAN_OVERLAYS = OVERLAYS.slice(0, 8) as ReadonlyArray<Partial<ParseConfig>>;

const windowAt = (cursor: number, limit: number, final: boolean): ScanWindow => ({
  cursor,
  limit,
  final,
  nextDelimiter: SEARCH,
  nextNewline: SEARCH,
  nextQuote: SEARCH,
  end: -1,
  stop: 'end',
});

/** The scan dialect parse makes of a config, with the defaults the main entry resolves. */
function dialectOf(config: ParseConfig): ScanDialect {
  const options = resolveParseConfig(config, 'main');
  return {
    delimiter: options.delimiter as string,
    newline: options.newline as Newline,
    quoteChar: options.quoteChar,
    escapeChar: options.escapeChar,
    comments: options.comments,
    preview: 0,
    fastMode: false,
  };
}

interface Scanned {
  rows: string[][];
  errors: QuoteError[];
  cursor: number;
  /** window.end of every call that read a record. */
  ends: number[];
  stop: ScanWindow['stop'];
}

/**
 * Calls scanRows with one reused window until it stops for another reason
 * than the limit; error rows are rebased by the records of the calls before.
 */
function drain(input: string, dialect: ScanDialect, window: ScanWindow, emit = false): Scanned {
  const rows: string[][] = [];
  const errors: QuoteError[] = [];
  const ends: number[] = [];
  for (let calls = 0; ; calls++) {
    if (calls > input.length + 1) throw new Error('scanRows does not advance');
    const before = rows.length;
    const result = emit
      ? scanRows(input, dialect, (row) => rows.push([...row]), window)
      : scanRows(input, dialect, undefined, window);
    rows.push(...result.rows);
    for (const error of result.errors) errors.push({ ...error, row: error.row + before });
    if (window.end !== -1) ends.push(window.end);
    if (window.stop !== 'limit') {
      return { rows, errors, cursor: result.cursor, ends, stop: window.stop };
    }
  }
}

/** Where a record or a comment line of the whole scan starts. */
function recordStarts(input: string, dialect: ScanDialect): Set<number> {
  const { comments, newline, quoteChar } = dialect;
  const starts = new Set([0, ...drain(input, dialect, windowAt(0, 1, true)).ends]);
  if (comments === '') return starts;
  for (let at of [...starts]) {
    while (input[at] !== quoteChar && input.startsWith(comments, at)) {
      const end = input.indexOf(newline, at);
      if (end === -1) break;
      at = end + newline.length;
      starts.add(at);
    }
  }
  return starts;
}

interface Case {
  input: string;
  config: ParseConfig;
  dialect: ScanDialect;
}

/** Seeded soup and record inputs for every dialect under no overlay, each one, and six random sets of two or three. */
function cases(): Case[] {
  const random = mulberry32(SEED);
  const list: Case[] = [];
  for (const base of DIALECTS.filter((dialect) => dialect.header !== true)) {
    const sets: number[][] = [[], ...SCAN_OVERLAYS.map((_, index) => [index])];
    for (let n = 0; n < 6; n++) {
      sets.push(
        Array.from({ length: 2 + Math.floor(random() * 2) }, () =>
          Math.floor(random() * SCAN_OVERLAYS.length),
        ),
      );
    }
    for (const set of sets) {
      let config: ParseConfig = { ...base };
      for (const index of set) config = { ...config, ...SCAN_OVERLAYS[index] };
      // The comments overlay ';' with the delimiter ';' is rejected by parse.
      if (config.comments === config.delimiter) continue;
      const dialect = dialectOf(config);
      for (let k = 0; k < INPUTS_PER_CONFIG; k++) {
        for (const input of [
          soup(random),
          records(random, dialect.delimiter, dialect.newline, dialect.quoteChar),
        ]) {
          list.push({ input, config, dialect });
        }
      }
    }
  }
  return list;
}

const CASES = cases();
const report = (c: Case, what: string) => ({ what, input: c.input, config: c.config });

describe('scan window', () => {
  it('uses the overlays of test/differential.ts that change the scan', () => {
    expect(SCAN_OVERLAYS).toStrictEqual([
      { quoteChar: "'" },
      { escapeChar: '\\' },
      { delimiter: '::' },
      { delimiter: '|' },
      { comments: '#' },
      { comments: true },
      { comments: '//' },
      { comments: ';' },
    ]);
    expect(CASES).toHaveLength(6500);
  });

  describe(`windowed equals whole (seed ${String(SEED)})`, () => {
    it.each([
      [1, 8860],
      [2, 6316],
      [3, 4704],
      [MANY, 0],
    ])('limit %i, final: true, until stop is "end"', (limit, expected) => {
      const failures: unknown[] = [];
      let limited = 0;
      for (const c of CASES) {
        const whole = scanRows(c.input, c.dialect);
        for (const emit of [false, true]) {
          const window = windowAt(0, limit, true);
          const parts = drain(c.input, c.dialect, window, emit);
          if (parts.ends.length > 1) limited++;
          const same =
            parts.stop === 'end' &&
            window.cursor === c.input.length &&
            isDeepStrictEqual(parts.rows, whole.rows) &&
            isDeepStrictEqual(parts.errors, whole.errors) &&
            parts.cursor === whole.cursor;
          if (!same && failures.length < 5) failures.push(report(c, emit ? 'emit' : 'rows'));
        }
      }
      expect(failures).toStrictEqual([]);
      // Scans, of two per input, in which more than one call read a record.
      expect(limited).toBe(expected);
    });
  });

  describe(`withholding (seed ${String(SEED)})`, () => {
    it('every prefix gives a prefix of the whole scan and resumes at a record start', () => {
      const failures: unknown[] = [];
      const fail = (c: Case, k: number, what: string) => {
        if (failures.length < 5) failures.push(report(c, `split ${String(k)}: ${what}`));
      };
      const stops = { tail: 0, end: 0, commentTail: 0 };
      for (const c of CASES) {
        const { input, dialect } = c;
        const whole = scanRows(input, dialect);
        const starts = recordStarts(input, dialect);
        for (let k = 0; k <= input.length; k++) {
          const text = input.slice(0, k);
          const window = windowAt(0, MANY, false);
          const head = scanRows(text, dialect, undefined, window);
          const { cursor, end, stop } = window;
          const records = head.rows.length;
          const errors = head.errors.length;
          if (stop === 'limit') fail(c, k, 'stop');
          else stops[stop]++;
          if (stop === 'end' && cursor !== k) fail(c, k, 'cursor at the end');
          if (!starts.has(cursor)) fail(c, k, 'cursor is not a record start');
          if (
            stop === 'tail' &&
            dialect.comments !== '' &&
            text.startsWith(dialect.comments, cursor)
          ) {
            stops.commentTail++;
          }
          if (head.cursor !== cursor) fail(c, k, 'result cursor');
          if (records === 0 ? end !== -1 : !starts.has(end) || end > cursor) fail(c, k, 'end');
          if (!isDeepStrictEqual(head.rows, whole.rows.slice(0, records))) fail(c, k, 'rows');
          if (!isDeepStrictEqual(head.errors, whole.errors.slice(0, errors))) fail(c, k, 'errors');

          // The rest of the input from there, in the same text and as a text of its own.
          const expected = {
            rows: whole.rows.slice(records),
            errors: whole.errors.slice(errors),
          };
          const restWindow = windowAt(cursor, MANY, true);
          const rest = scanRows(input, dialect, undefined, restWindow);
          const rebased = rest.errors.map((error) => ({ ...error, row: error.row + records }));
          // Comment lines that end the input leave bulk's cursor after the last record read.
          const lastEnd = restWindow.end === -1 ? Math.max(end, 0) : rest.cursor;
          if (
            !isDeepStrictEqual({ rows: rest.rows, errors: rebased }, expected) ||
            lastEnd !== whole.cursor
          ) {
            fail(c, k, 'rest in the same text');
          }
          if (cursor < input.length) {
            const own = scanRows(input.slice(cursor), dialect, undefined, windowAt(0, MANY, true));
            const moved = own.errors.map((error) => ({
              ...error,
              row: error.row + records,
              index: error.index + cursor,
            }));
            if (!isDeepStrictEqual({ rows: own.rows, errors: moved }, expected)) {
              fail(c, k, 'rest as its own text');
            }
          }

          // The same window, now final, on the same text: its cached positions give what a new window gives.
          window.final = true;
          const again = scanRows(text, dialect, undefined, window);
          const fresh = scanRows(text, dialect, undefined, windowAt(cursor, MANY, true));
          if (window.stop !== 'end' || !isDeepStrictEqual(again, fresh)) {
            fail(c, k, 'the window reused with final: true');
          }
        }
      }
      expect(failures).toStrictEqual([]);
      // One per split point: 415,773 prefixes.
      expect(stops).toStrictEqual({ tail: 393_864, end: 21_909, commentTail: 3030 });
    }, 120_000);
  });

  describe('named cases', () => {
    const LF: ScanDialect = {
      delimiter: ',',
      newline: '\n',
      quoteChar: '"',
      escapeChar: '"',
      comments: '',
      preview: 0,
      fastMode: false,
    };
    const scan = (input: string, dialect: ScanDialect, window: ScanWindow) => {
      const { rows, errors } = scanRows(input, dialect, undefined, window);
      const { stop, cursor, end } = window;
      return { rows, errors, stop, cursor, end };
    };

    it('withholds a record that no line break ends', () => {
      expect(scan('a,b\n1,2', LF, windowAt(0, MANY, false))).toStrictEqual({
        rows: [['a', 'b']],
        errors: [],
        stop: 'tail',
        cursor: 4,
        end: 4,
      });
    });

    it('reads the withheld record when the same window becomes final', () => {
      const window = windowAt(0, MANY, false);
      scan('a,b\n1,2', LF, window);
      window.final = true;
      expect(scan('a,b\n1,2', LF, window)).toStrictEqual({
        rows: [['1', '2']],
        errors: [],
        stop: 'end',
        cursor: 7,
        end: 7,
      });
    });

    it('makes the record after a final line break only when the input ends', () => {
      const window = windowAt(0, MANY, false);
      expect(scan('a\n', LF, window)).toStrictEqual({
        rows: [['a']],
        errors: [],
        stop: 'end',
        cursor: 2,
        end: 2,
      });
      expect(scan('a\n', LF, windowAt(2, MANY, true))).toStrictEqual({
        rows: [['']],
        errors: [],
        stop: 'end',
        cursor: 2,
        end: 2,
      });
    });

    it('reads nothing from an empty text', () => {
      for (const final of [false, true]) {
        const window = windowAt(0, MANY, final);
        const result = scanRows('', LF, undefined, window);
        expect(result).toStrictEqual({ rows: [], errors: [], cursor: 0, truncated: false });
        expect(window).toStrictEqual(windowAt(0, MANY, final));
      }
    });

    it('withholds a quoted field whose closing quote is the last unit', () => {
      expect(scan('"a"', LF, windowAt(0, MANY, false))).toStrictEqual({
        rows: [],
        errors: [],
        stop: 'tail',
        cursor: 0,
        end: -1,
      });
      expect(scan('"a"', LF, windowAt(0, MANY, true))).toStrictEqual({
        rows: [['a']],
        errors: [],
        stop: 'end',
        cursor: 3,
        end: 3,
      });
    });

    it('withholds an unterminated quoted field without its MissingQuotes error', () => {
      expect(scan('x\n"a', LF, windowAt(0, MANY, false))).toStrictEqual({
        rows: [['x']],
        errors: [],
        stop: 'tail',
        cursor: 2,
        end: 2,
      });
      expect(scan('x\n"a', LF, windowAt(0, MANY, true))).toStrictEqual({
        rows: [['x'], ['a']],
        errors: [
          {
            type: 'Quotes',
            code: 'MissingQuotes',
            message: 'Quoted field unterminated',
            row: 1,
            index: 3,
          },
        ],
        stop: 'end',
        cursor: 4,
        end: 4,
      });
    });

    it('reports an InvalidQuotes error once, with the record it belongs to', () => {
      expect(scan('"a" x\n', LF, windowAt(0, MANY, false))).toStrictEqual({
        rows: [],
        errors: [],
        stop: 'tail',
        cursor: 0,
        end: -1,
      });
      expect(scan('"a" x\ny"\nz\n', LF, windowAt(0, MANY, false))).toStrictEqual({
        rows: [['a" x\ny'], ['z']],
        errors: [
          {
            type: 'Quotes',
            code: 'InvalidQuotes',
            message: 'Trailing quote on quoted field is malformed',
            row: 0,
            index: 1,
          },
        ],
        stop: 'end',
        cursor: 11,
        end: 11,
      });
    });

    it('withholds a record that ends with half a line break', () => {
      expect(scan('a\r', { ...LF, newline: '\r\n' }, windowAt(0, MANY, false))).toStrictEqual({
        rows: [],
        errors: [],
        stop: 'tail',
        cursor: 0,
        end: -1,
      });
      expect(scan('"a"\r', { ...LF, newline: '\r\n' }, windowAt(0, MANY, false))).toStrictEqual({
        rows: [],
        errors: [],
        stop: 'tail',
        cursor: 0,
        end: -1,
      });
    });

    it('withholds a comment line that no line break ends, after the ones it consumed', () => {
      const dialect = { ...LF, comments: '#' };
      expect(scan('a\n#c\n#d', dialect, windowAt(0, MANY, false))).toStrictEqual({
        rows: [['a']],
        errors: [],
        stop: 'tail',
        cursor: 5,
        end: 2,
      });
      expect(scan('#c\n#d', dialect, windowAt(0, MANY, false))).toStrictEqual({
        rows: [],
        errors: [],
        stop: 'tail',
        cursor: 3,
        end: -1,
      });
      const window = windowAt(0, MANY, true);
      const result = scanRows('a\n#c\n#d', dialect, undefined, window);
      expect(result).toStrictEqual({ rows: [['a']], errors: [], cursor: 2, truncated: false });
      expect(window).toMatchObject({ stop: 'end', cursor: 7, end: 2 });
    });

    it('stops at the limit before the comment lines that follow', () => {
      const dialect = { ...LF, comments: '#' };
      const window = windowAt(0, 1, true);
      expect(scan('a\n#c\nb\n', dialect, window)).toStrictEqual({
        rows: [['a']],
        errors: [],
        stop: 'limit',
        cursor: 2,
        end: 2,
      });
      expect(scan('a\n#c\nb\n', dialect, window)).toStrictEqual({
        rows: [['b']],
        errors: [],
        stop: 'limit',
        cursor: 7,
        end: 7,
      });
      expect(scan('a\n#c\nb\n', dialect, window)).toStrictEqual({
        rows: [['']],
        errors: [],
        stop: 'end',
        cursor: 7,
        end: 7,
      });
    });

    it('numbers Quotes errors by the records of the call and the offsets of the text', () => {
      const window = windowAt(0, 1, true);
      scan('a\n"b"x\n', LF, window);
      expect(scan('a\n"b"x\n', LF, window).errors).toStrictEqual([
        {
          type: 'Quotes',
          code: 'InvalidQuotes',
          message: 'Trailing quote on quoted field is malformed',
          row: 0,
          index: 3,
        },
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 0,
          index: 3,
        },
      ]);
    });
  });

  describe('resume cost', () => {
    it('one record per call stays within 20 times one scan of 1 MiB (a guard, not a benchmark)', () => {
      // 100,000 one-field lines, 1,048,576 units, no quote.
      let input = '';
      for (let i = 0; i < 100_000; i++) input += i < 48_576 ? 'aaaaaaaaaa\n' : 'aaaaaaaaa\n';
      expect(input).toHaveLength(1_048_576);
      const dialect: ScanDialect = {
        delimiter: ',',
        newline: '\n',
        quoteChar: '"',
        escapeChar: '"',
        comments: '',
        preview: 0,
        fastMode: false,
      };
      const best = (run: () => number) => {
        let time = Infinity;
        for (let i = 0; i < 7; i++) {
          const start = performance.now();
          expect(run()).toBe(100_000);
          time = Math.min(time, performance.now() - start);
        }
        return time;
      };
      const whole = best(
        () => scanRows(input, dialect, undefined, windowAt(0, 1e9, false)).rows.length,
      );
      const stepped = best(() => {
        const window = windowAt(0, 1, false);
        let count = 0;
        do count += scanRows(input, dialect, undefined, window).rows.length;
        while (window.stop === 'limit');
        return count;
      });
      expect(stepped / whole).toBeLessThan(20);
    });
  });
});
