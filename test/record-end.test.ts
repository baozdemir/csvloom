import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { resolveParseConfig } from '../src/options.ts';
import { scanRows, SEARCH, type ScanDialect, type ScanWindow } from '../src/parser.ts';
import { RecordEnd } from '../src/record-end.ts';
import type { Newline, ParseConfig } from '../src/types.ts';
import { DIALECTS, NEWLINES, OVERLAYS, records, soup } from './differential.ts';

// RecordEnd finds where a record that spans several texts ends: where scanRows with a window, given
// text up to there, reads it.

const SEED = 20261112;
const INPUTS_PER_CONFIG = 100;
const SPACED_INPUTS = 400;

/** The overlays of test/differential.ts that keep an explicit dialect and change what scanRows reads. */
const SCAN_OVERLAYS = OVERLAYS.slice(0, 8) as ReadonlyArray<Partial<ParseConfig>>;
/** Delimiters that hold whitespace, and whitespace that String.prototype.trim removes. */
const SPACE_DELIMITERS = [' ', ' | ', ', ', '\t'];
const WHITESPACE = ['\u00a0', '\u2028', '\u3000', '\t', ' ', '  ', '   '];

const LF: ScanDialect = {
  delimiter: ',',
  newline: '\n',
  quoteChar: '"',
  escapeChar: '"',
  comments: '',
  preview: 0,
  fastMode: false,
};
const CRLF: ScanDialect = { ...LF, newline: '\r\n' };

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

/**
 * Every record and comment line of input as [start, end], end being where its
 * line break ends, or -1 for a last one that no line break ends. Records come
 * from scanRows with one window (final: false, limit: 1), one call each; the
 * comment lines a call skips before its record are found as scanRows skips them.
 */
function lines(input: string, dialect: ScanDialect): Array<[number, number]> {
  const { comments, newline, quoteChar } = dialect;
  const list: Array<[number, number]> = [];
  const window: ScanWindow = {
    cursor: 0,
    limit: 1,
    final: false,
    nextDelimiter: SEARCH,
    nextNewline: SEARCH,
    nextQuote: SEARCH,
    end: -1,
    stop: 'end',
  };
  for (;;) {
    let start = window.cursor;
    while (comments !== '' && input[start] !== quoteChar && input.startsWith(comments, start)) {
      const end = input.indexOf(newline, start);
      if (end === -1) break;
      list.push([start, end + newline.length]);
      start = end + newline.length;
    }
    scanRows(input, dialect, undefined, window);
    const { stop, cursor, end } = window;
    if (stop === 'limit' && end > start) list.push([start, end]);
    else if (stop === 'tail' && cursor === start) {
      list.push([start, -1]);
      return list;
    } else if (stop === 'end' && start === input.length) return list;
    else throw new Error(`the reference disagrees with scanRows at ${String(start)}`);
  }
}

/** Every answer RecordEnd gives for text, as an offset in text: fed whole, in two pieces at every split point, and one unit at a time. */
function answers(text: string, dialect: ScanDialect): number[] {
  const reader = new RecordEnd(dialect);
  const fed = (pieces: readonly string[]) => {
    reader.reset();
    let offset = 0;
    for (const piece of pieces) {
      const end = reader.feed(piece);
      if (end !== -1) return offset + end;
      offset += piece.length;
    }
    return -1;
  };
  const found = new Set([fed([text]), fed(text.split(''))]);
  for (let k = 1; k < text.length; k++) found.add(fed([text.slice(0, k), text.slice(k)]));
  return [...found];
}

interface Case {
  input: string;
  config: ParseConfig;
  dialect: ScanDialect;
}

/**
 * Soup and record inputs for every scan dialect of DIALECTS (header does not
 * reach scanRows) under no overlay, each one, and six random sets of two or three.
 */
function cases(random: () => number): Case[] {
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

/** text with a run of one to three WHITESPACE items after about half of its quotes, closing quotes among them. */
function spaced(random: () => number, text: string): string {
  let out = '';
  for (const unit of text) {
    out += unit;
    if (unit !== '"' || random() < 0.5) continue;
    for (let n = Math.floor(random() * 3); n >= 0; n--) {
      out += WHITESPACE[Math.floor(random() * WHITESPACE.length)] ?? '';
    }
  }
  return out;
}

/** The same generators with whitespace after quotes, under SPACE_DELIMITERS and every newline. */
function spacedCases(random: () => number): Case[] {
  const list: Case[] = [];
  for (const delimiter of SPACE_DELIMITERS) {
    for (const newline of NEWLINES) {
      const config: ParseConfig = { delimiter, newline: newline as Newline };
      const dialect = dialectOf(config);
      for (let k = 0; k < SPACED_INPUTS; k++) {
        for (const input of [soup(random), records(random, delimiter, newline)]) {
          list.push({ input: spaced(random, input), config, dialect });
        }
      }
    }
  }
  return list;
}

/** The first five lines of the cases on which RecordEnd disagrees with the reference, and what was checked. */
function agreement(list: readonly Case[]) {
  const failures: unknown[] = [];
  const counts = { lines: 0, open: 0, units: 0 };
  for (const c of list) {
    for (const [start, end] of lines(c.input, c.dialect)) {
      const rest = c.input.slice(start);
      const expected = end === -1 ? -1 : end - start;
      const got = answers(rest, c.dialect);
      counts.lines++;
      if (end === -1) counts.open++;
      counts.units += rest.length;
      if ((got.length !== 1 || got[0] !== expected) && failures.length < 5) {
        failures.push({ input: c.input, config: c.config, start, expected, got });
      }
    }
  }
  return { failures, counts };
}

/**
 * The units read while run() runs, counted at the methods RecordEnd reads
 * text with: a search (indexOf, a sticky RegExp test) counts the units from
 * where it starts to where it stops, any other call one. The methods are
 * restored before it returns.
 */
function unitsRead(run: () => void): number {
  const string = String.prototype;
  const regexp = RegExp.prototype;
  /* eslint-disable @typescript-eslint/unbound-method -- each is called with call() on its receiver */
  const { indexOf, startsWith, charCodeAt, slice } = string;
  const { test } = regexp;
  /* eslint-enable @typescript-eslint/unbound-method */
  let units = 0;
  string.indexOf = function (this: string, search: string, from = 0) {
    const at = indexOf.call(this, search, from);
    units += Math.max(0, (at === -1 ? this.length : at + search.length) - from);
    return at;
  };
  string.startsWith = function (this: string, search: string, at?: number) {
    units++;
    return startsWith.call(this, search, at);
  };
  string.charCodeAt = function (this: string, at: number) {
    units++;
    return charCodeAt.call(this, at);
  };
  string.slice = function (this: string, start?: number, end?: number) {
    units++;
    return slice.call(this, start, end);
  };
  regexp.test = function (this: RegExp, text: string) {
    const from = this.lastIndex;
    const result = test.call(this, text);
    units += this.sticky ? this.lastIndex - from + 1 : text.length;
    return result;
  };
  try {
    run();
  } finally {
    Object.assign(string, { indexOf, startsWith, charCodeAt, slice });
    regexp.test = test;
  }
  return units;
}

/** Feeds pieces until RecordEnd answers; the answer as an offset in their concatenation, or -1. */
function feedPieces(reader: RecordEnd, pieces: readonly string[]): number {
  let offset = 0;
  for (const piece of pieces) {
    const end = reader.feed(piece);
    if (end !== -1) return offset + end;
    offset += piece.length;
  }
  return -1;
}

const piecesOf = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

describe('RecordEnd', () => {
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
  });

  describe(`agreement with scanRows (seed ${String(SEED)})`, () => {
    const random = mulberry32(SEED);
    const fuzzed = cases(random);
    const spacedList = spacedCases(random);

    it('fuzz inputs under every scan dialect and scan overlay: whole, every split, unit by unit', () => {
      expect(fuzzed).toHaveLength(26000);
      const { failures, counts } = agreement(fuzzed);
      expect(failures).toStrictEqual([]);
      expect(counts).toStrictEqual({ lines: 79977, open: 18919, units: 4749926 });
    }, 300_000);

    it('whitespace after quotes, under delimiters that hold whitespace', () => {
      expect(spacedList).toHaveLength(9600);
      const { failures, counts } = agreement(spacedList);
      expect(failures).toStrictEqual([]);
      expect(counts).toStrictEqual({ lines: 30229, open: 7086, units: 2343888 });
    }, 300_000);
  });

  describe('named cases', () => {
    const PIPE = { ...LF, delimiter: ' | ' };
    const fed = (pieces: readonly string[], dialect = LF) => {
      const reader = new RecordEnd(dialect);
      return pieces.map((piece) => reader.feed(piece));
    };

    it('ends after a doubled quote', () => {
      expect(answers('"a""b"\n', LF)).toStrictEqual([7]);
    });

    it('closes a quoted field at the delimiter after whitespace', () => {
      expect(answers('"a"  ,b\n', LF)).toStrictEqual([8]);
    });

    it('takes U+00A0 and U+2028 after a closing quote as whitespace, split before and after it', () => {
      expect(answers('"a"\u00a0,b\n', LF)).toStrictEqual([7]);
      expect(answers('"a"\u2028\n', LF)).toStrictEqual([5]);
      expect(fed(['"a"', '\u00a0,b\n'])).toStrictEqual([-1, 4]);
      expect(fed(['"a"\u00a0', ',b\n'])).toStrictEqual([-1, 3]);
      expect(fed(['"a"', '\u2028\n'])).toStrictEqual([-1, 2]);
      expect(fed(['"a"\u2028', '\n'])).toStrictEqual([-1, 1]);
      // U+2028 is whitespace, not a line break: the quote is malformed and the field stays open.
      expect(answers('"a"\u2028x\n', LF)).toStrictEqual([-1]);
    });

    it('closes a field at a delimiter that holds whitespace, split inside the spaces', () => {
      expect(answers('"a" | b\n', PIPE)).toStrictEqual([8]);
      expect(answers('"a"  | b\n', PIPE)).toStrictEqual([9]);
      expect(fed(['"a" ', '| b\n'], PIPE)).toStrictEqual([-1, 4]);
      expect(fed(['"a"  ', '| b\n'], PIPE)).toStrictEqual([-1, 4]);
      expect(answers('"a"  b\n', { ...LF, delimiter: ' ' })).toStrictEqual([7]);
      expect(fed(['"a" ', ' b\n'], { ...LF, delimiter: ' ' })).toStrictEqual([-1, 3]);
      expect(answers('"a" , b\n', { ...LF, delimiter: ', ' })).toStrictEqual([8]);
      expect(answers('"a"\t\tb\n', { ...LF, delimiter: '\t' })).toStrictEqual([7]);
      // Not whitespace only before the delimiter: the quote is malformed.
      expect(answers('"a"  x | b"\n', PIPE)).toStrictEqual([12]);
    });

    it('keeps the field open after a malformed quote', () => {
      expect(answers('"a" x"\n', LF)).toStrictEqual([7]);
    });

    it('waits for the second unit of "\\r\\n"', () => {
      expect(answers('"a\nb"\r\n', CRLF)).toStrictEqual([7]);
      expect(fed(['"a\nb"\r', '\n'], CRLF)).toStrictEqual([-1, 1]);
      expect(answers('"a"\r', CRLF)).toStrictEqual([-1]);
    });

    it('waits for the second unit of the delimiter "::" after a closing quote', () => {
      const dialect = { ...LF, delimiter: '::' };
      expect(answers('"a"::b\n', dialect)).toStrictEqual([7]);
      expect(fed(['"a":', ':b\n'], dialect)).toStrictEqual([-1, 3]);
    });

    it('keeps a quote right after escapeChar as data, split after the escapeChar', () => {
      const dialect = { ...LF, escapeChar: '\\' };
      expect(answers('"a\\"b"\n', dialect)).toStrictEqual([7]);
      expect(fed(['"a\\', '"b"\n'], dialect)).toStrictEqual([-1, 4]);
    });

    it('ends a comment line at its line break, split inside the marker', () => {
      const dialect = { ...LF, comments: '//' };
      expect(answers('//x\n', dialect)).toStrictEqual([4]);
      expect(fed(['/', '/x\n'], dialect)).toStrictEqual([-1, 3]);
      // A comment line ends at its first newline, also where a quote follows a delimiter in it.
      expect(answers('//,"a\nb"\n', dialect)).toStrictEqual([6]);
      // Not the marker: a record, whose quoted field holds a newline.
      expect(answers('/x,"a\nb"\n', dialect)).toStrictEqual([9]);
      // A quote opens a field before the marker is tested, also a marker that starts with it.
      expect(answers('"#,"\n#\n', { ...LF, comments: '#' })).toStrictEqual([5]);
      expect(answers('"#a\nb"\n', { ...LF, comments: '"#' })).toStrictEqual([7]);
    });

    it('decides a quote that ends a piece by the next piece', () => {
      expect(fed(['"a"', '"b"\n'])).toStrictEqual([-1, 4]);
      expect(fed(['"a"', ',b\n'])).toStrictEqual([-1, 3]);
      expect(fed(['"a"', '\n'])).toStrictEqual([-1, 1]);
      expect(fed(['"a"', 'x"\n'])).toStrictEqual([-1, 3]);
    });

    it('returns -1 for every piece of a record that no line break ends', () => {
      for (const text of ['"a\nb', 'a,b', '"a"', '"a""', '"a" ']) {
        expect(answers(text, LF)).toStrictEqual([-1]);
      }
    });

    it('ignores an empty text, also while it holds units', () => {
      expect(fed(['', 'a', '', '\n'])).toStrictEqual([-1, -1, -1, 1]);
      expect(fed(['a\r', '', '\n'], CRLF)).toStrictEqual([-1, -1, 1]);
    });

    it('starts again at a record start after reset()', () => {
      const reader = new RecordEnd(LF);
      expect(reader.feed('"a\n')).toBe(-1);
      reader.reset();
      expect(reader.feed('b\n')).toBe(2);
    });

    it('answers no earlier than scanRows reads the record, so an early answer would only be carried again', () => {
      const texts: Array<[string, ScanDialect]> = [
        ['"a""b"\n', LF],
        ['"a"  ,b\n', LF],
        ['"a"\u2028\n', LF],
        ['"a"  | b\n', PIPE],
        ['"a\nb"\r\n', CRLF],
        ['"a" x"\n', LF],
      ];
      for (const [text, dialect] of texts) {
        const [end] = answers(text, dialect);
        expect(end).toBe(text.length);
        for (let k = 0; k <= text.length; k++) {
          const window: ScanWindow = {
            cursor: 0,
            limit: 1,
            final: false,
            nextDelimiter: SEARCH,
            nextNewline: SEARCH,
            nextQuote: SEARCH,
            end: -1,
            stop: 'end',
          };
          const { rows, errors } = scanRows(text.slice(0, k), dialect, undefined, window);
          const read = k === text.length ? 1 : 0;
          expect([k, rows.length, window.end]).toStrictEqual([k, read, read === 1 ? k : -1]);
          if (read === 0) expect([k, errors, window.cursor]).toStrictEqual([k, [], 0]);
        }
      }
    });
  });

  // Before the read count, which replaces String and RegExp methods while it counts.
  describe('linearity guard (GUARD: a coarse time ratio, not a measurement)', () => {
    const SIZE = 8 * 1024 * 1024;
    const shapes: Array<[string, string]> = [
      ['doubled quotes inside a quoted field', `"${'""'.repeat(SIZE / 2)}"\n`],
      ['"a" followed by spaces', `"a"${' '.repeat(SIZE)}\n`],
    ];

    it.each(shapes)(
      '8 MiB of %s: 1 KiB pieces take less than 8 times as long as 64 KiB pieces',
      (_, text) => {
        const best = (size: number) => {
          const pieces = piecesOf(text, size);
          let time = Infinity;
          for (let run = 0; run < 5; run++) {
            const reader = new RecordEnd(LF);
            const start = performance.now();
            const end = feedPieces(reader, pieces);
            time = Math.min(time, performance.now() - start);
            expect(end).toBe(text.length);
          }
          return time;
        };
        expect(best(1024) / best(65_536)).toBeLessThan(8);
      },
      120_000,
    );
  });

  describe('reads each unit once (a count of the units searched, not a timing)', () => {
    const N = 16_384;
    const shapes: Array<[string, ScanDialect, (n: number) => string]> = [
      ['doubled quotes', LF, (n) => `"${'""'.repeat(n / 2)}"\n`],
      ['malformed quotes', LF, (n) => `"${'a"'.repeat(n / 2)}\n`],
      ['escaped quotes', { ...LF, escapeChar: '\\' }, (n) => `"${'\\"'.repeat(n / 2)}"\n`],
      ['spaces after a closing quote', LF, (n) => `"a"${' '.repeat(n)}\n`],
      [
        'U+00A0 and U+2028 after a closing quote',
        LF,
        (n) => `"a"${'\u00a0\u2028'.repeat(n / 2)},\n`,
      ],
      [
        'spaces before the delimiter " | "',
        { ...LF, delimiter: ' | ' },
        (n) => `"a"${' '.repeat(n)}| b\n`,
      ],
      ['unquoted fields, newline "\\r\\n"', CRLF, (n) => `${'a\r,'.repeat(n / 3)}\r\n`],
      [
        'a comment line, newline "\\r\\n"',
        { ...CRLF, comments: '//' },
        (n) => `//${'x\r'.repeat(n / 2)}\r\n`,
      ],
    ];

    it.each(shapes)(
      '%s: twice the record, twice the units, in pieces of 1024, 3 and 1 units',
      (_, dialect, make) => {
        for (const size of [1024, 3, 1]) {
          const units = [N, 2 * N].map((n) => {
            const text = make(n);
            const pieces = piecesOf(text, size);
            const reader = new RecordEnd(dialect);
            let end = -1;
            const read = unitsRead(() => {
              end = feedPieces(reader, pieces);
            });
            expect([size, end]).toStrictEqual([size, text.length]);
            return read;
          });
          const [once = 0, twice = 0] = units;
          expect([size, once >= N, twice / once < 2.1]).toStrictEqual([size, true, true]);
        }
      },
    );
  });
});
