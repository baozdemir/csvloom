import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { parseDetailed } from '../src/detailed.ts';
import { advance, formatError, positionsAt, recordStarts, START } from '../src/locate.ts';
import { scanRows, type ScanDialect } from '../src/parser.ts';
import type { ParseError } from '../src/types.ts';
import { DELIMITERS, NEWLINES, records, soup } from './differential.ts';

// Every scanRows call is counted, so the linearity of recordStarts is asserted by the units it
// scans, not by a clock.
const scanned = vi.hoisted(() => ({ units: 0, calls: 0 }));
vi.mock('../src/parser.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/parser.ts')>();
  return {
    ...real,
    scanRows: (...args: Parameters<typeof real.scanRows>) => {
      scanned.units += args[0].length;
      scanned.calls++;
      return real.scanRows(...args);
    },
  };
});

/** recordStarts with the scanRows calls it made and the units they were given. */
function counted(text: string, dialect: ScanDialect, ordinals: readonly number[]) {
  scanned.units = 0;
  scanned.calls = 0;
  const starts = recordStarts(text, dialect, ordinals);
  return { starts, units: scanned.units, calls: scanned.calls };
}

const DIALECT: ScanDialect = {
  delimiter: ',',
  newline: '\n',
  quoteChar: '"',
  escapeChar: '"',
  comments: '',
  preview: 0,
  fastMode: false,
};

/** The overlays of test/differential.ts that change what scanRows reads. */
const OVERLAYS: readonly Partial<ScanDialect>[] = [
  {},
  { quoteChar: "'", escapeChar: "'" },
  { escapeChar: '\\' },
  { delimiter: '::' },
  { delimiter: '|' },
  { comments: '#' },
  { comments: '//' },
];

/**
 * Seeded inputs of the differential generators in every explicit dialect and overlay: short
 * soup and records, and long ones, so that records also start past the first window.
 */
function* fuzzInputs(
  seed: number,
  perDialect: number,
  joined: number,
): Generator<[string, ScanDialect]> {
  const random = mulberry32(seed);
  for (const delimiter of DELIMITERS) {
    for (const newline of NEWLINES) {
      for (const overlay of OVERLAYS) {
        const dialect = { ...DIALECT, delimiter, newline, ...overlay } as ScanDialect;
        const write = () => records(random, dialect.delimiter, newline, dialect.quoteChar);
        for (let k = 0; k < perDialect; k++) {
          yield [soup(random), dialect];
          yield [write(), dialect];
          yield [soup(random, 400), dialect];
          yield [Array.from({ length: joined }, write).join(newline), dialect];
        }
      }
    }
  }
}

/** The same lookups as recordStarts, over text.slice(from) without a window. */
function unbounded(text: string, dialect: ScanDialect, ordinals: readonly number[]): number[] {
  const { comments, newline, quoteChar } = dialect;
  const quote = quoteChar.length === 1 ? quoteChar : undefined;
  const afterComments = (at: number) => {
    while (comments !== '' && text[at] !== quote && text.startsWith(comments, at)) {
      const end = text.indexOf(newline, at);
      if (end === -1) return -1;
      at = end + newline.length;
    }
    return at;
  };
  let from = text === '' ? -1 : afterComments(0);
  let at = 0;
  return ordinals.map((ordinal) => {
    if (from !== -1 && ordinal > at) {
      const scan = scanRows(
        text.slice(from),
        { ...dialect, preview: ordinal - at, fastMode: false },
        () => undefined,
      );
      from = scan.truncated ? afterComments(from + scan.cursor) : -1;
      at = ordinal;
    }
    return from;
  });
}

/** Whether a record that starts at start would be read as a comment line by the scanner. */
const isCommentLine = (text: string, start: number, { comments, quoteChar }: ScanDialect) =>
  comments !== '' && text[start] !== quoteChar && text.startsWith(comments, start);

describe('recordStarts', () => {
  it('equals a direct count for every seeded input, dialect and ordinal', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [input, dialect] of fuzzInputs(0x5eed, 8, 20)) {
      const rows = scanRows(input, dialect).rows;
      const ordinals = rows.map((_, k) => k);
      const all = recordStarts(input, dialect, ordinals);
      const fail = (what: string) =>
        failures.push(`${what}: ${JSON.stringify({ input, dialect })}`);
      for (const k of ordinals) {
        checked++;
        const [start = -2] = recordStarts(input, dialect, [k]);
        if (start !== all[k])
          fail(`ordinal ${String(k)} alone ${String(start)}, in all ${String(all[k])}`);
        if (start < 0 || start > input.length) fail(`ordinal ${String(k)} at ${String(start)}`);
        else if (start < input.length) {
          const first = scanRows(input.slice(start), dialect).rows[0];
          if (JSON.stringify(first) !== JSON.stringify(rows[k])) fail(`record ${String(k)}`);
          if (isCommentLine(input, start, dialect)) fail(`ordinal ${String(k)} on a comment line`);
        } else if (JSON.stringify(rows[k]) !== '[""]' || k !== rows.length - 1) {
          fail(`ordinal ${String(k)} at the end`);
        }
      }
      if (recordStarts(input, dialect, [rows.length])[0] !== -1) fail('past the last record');
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(50_000);
  }, 60_000);

  it('equals the scan over text.slice(from) without a window', () => {
    const failures: string[] = [];
    for (const [input, dialect] of fuzzInputs(0xb0b, 12, 60)) {
      const count = scanRows(input, dialect).rows.length;
      // Every ordinal, repeated ones, and ones past the last record.
      const ordinals = Array.from({ length: count + 2 }, (_, k) => k).flatMap((k) =>
        k % 3 === 0 ? [k, k] : [k],
      );
      const actual = recordStarts(input, dialect, ordinals);
      if (JSON.stringify(actual) !== JSON.stringify(unbounded(input, dialect, ordinals))) {
        failures.push(JSON.stringify({ input, dialect, actual }));
        if (failures.length > 5) break;
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('answers ordinal 0 without a scan: offset 0, then the comment lines', () => {
    expect(counted('a,b\n1,2\n', DIALECT, [0])).toEqual({ starts: [0], units: 0, calls: 0 });
    const comments = { ...DIALECT, comments: '#' };
    expect(counted('#x\n#y\na\n', comments, [0])).toEqual({ starts: [6], units: 0, calls: 0 });
    expect(counted('#x\n#y', comments, [0])).toEqual({ starts: [-1], units: 0, calls: 0 });
    // A quote opens a field where the marker starts with it: not a comment line.
    expect(recordStarts('"#x"\n', { ...DIALECT, comments: '"#' }, [0])).toEqual([0]);
    expect(counted('', DIALECT, [0, 1])).toEqual({ starts: [-1, -1], units: 0, calls: 0 });
  });

  it('returns the same start for a repeated ordinal and -1 past the last record', () => {
    const text = Array.from({ length: 10 }, (_, k) => `r${String(k)}\n`).join('');
    expect(recordStarts(text, DIALECT, [3, 3, 7])).toEqual([9, 9, 21]);
    expect(recordStarts(text, DIALECT, [9, 10, 11, 12])).toEqual([27, 30, -1, -1]);
    expect(recordStarts('a\nb', DIALECT, [1, 2])).toEqual([2, -1]);
  });

  it('steps over comment lines before the record, and finds none after the last', () => {
    const comments = { ...DIALECT, comments: '#' };
    expect(recordStarts('a\n#c\nb\n', comments, [1, 2])).toEqual([5, 7]);
    // A comment line that ends the input ends the scan without a record.
    expect(recordStarts('a\n#c', comments, [1])).toEqual([-1]);
    // With its line break, the final [''] record follows it.
    expect(scanRows('a\n#c\n', comments).rows).toEqual([['a'], ['']]);
    expect(recordStarts('a\n#c\n', comments, [1, 2])).toEqual([5, -1]);
    expect(
      recordStarts('a\r\n//x\r\n//y\r\nb', { ...comments, newline: '\r\n', comments: '//' }, [1]),
    ).toEqual([13]);
  });

  it('finds records that end past many windows', () => {
    const long = 'x'.repeat(100_000);
    const text = `${long}\n"${long}\n${long}"\nb`;
    expect(recordStarts(text, DIALECT, [1, 2, 3])).toEqual([100_001, 300_005, -1]);
    expect(recordStarts(text, DIALECT, [2])).toEqual([300_005]);
  });

  describe('scans a number of units linear in the text and the ordinals', () => {
    const bound = (text: string, ordinals: readonly number[]) =>
      4 * text.length + 512 * ordinals.length;
    // The first ordinal whose start is not step units per record, or -1: a short failure message
    // where a diff of 100,001 numbers would take minutes.
    const wrong = (starts: readonly number[], ordinals: readonly number[], step: number) =>
      starts.length === ordinals.length
        ? starts.findIndex((start, k) => start !== step * (ordinals[k] ?? Number.NaN))
        : -2;
    const lines = 'abcdefgh\n'.repeat(100_000);
    const every = Array.from({ length: 100_001 }, (_, k) => k);

    it('100,000 one-field lines without a quote, all ordinals', () => {
      const { starts, units } = counted(lines, DIALECT, every);
      expect(wrong(starts, every, 9)).toBe(-1);
      expect(units).toBeLessThanOrEqual(bound(lines, every));
    });

    it('100,000 lines of one unit each, all ordinals', () => {
      const text = 'x\n'.repeat(100_000);
      const { starts, units } = counted(text, DIALECT, every);
      expect(wrong(starts, every, 2)).toBe(-1);
      expect(units).toBeLessThanOrEqual(bound(text, every));
    });

    it('the same lines with a delimiter that never occurs', () => {
      const { starts, units } = counted(lines, { ...DIALECT, delimiter: '::' }, every);
      expect(wrong(starts, every, 9)).toBe(-1);
      expect(units).toBeLessThanOrEqual(bound(lines, every));
    });

    const big = `${'x'.repeat(31)}\n`.repeat(1 << 20);

    it('1,000 ordinals spread evenly over a 32 MiB text', () => {
      expect(big.length).toBe(32 * 1024 * 1024);
      const spread = Array.from({ length: 1000 }, (_, k) => k * 1048);
      const { starts, units } = counted(big, DIALECT, spread);
      expect(wrong(starts, spread, 32)).toBe(-1);
      expect(units).toBeLessThanOrEqual(bound(big, spread));
    });

    it('one ordinal at the very end', () => {
      for (const ordinal of [(1 << 20) - 1, 1 << 20]) {
        const { starts, units } = counted(big, DIALECT, [ordinal]);
        expect(starts).toEqual([32 * ordinal]);
        expect(units).toBeLessThanOrEqual(bound(big, [ordinal]));
      }
    });

    it('stays within 6 x length + 256 x ordinals when each long record is followed by short ones', () => {
      // A record just longer than a window, then as many one-unit records as the halving
      // window takes to come back to 256: the case closest to the bound in the comment of
      // recordStarts.
      const segment = `${'y'.repeat(1 << 17)}\n${'z\n'.repeat(10)}`;
      const text = segment.repeat(8);
      const ordinals = Array.from({ length: 8 * 11 + 1 }, (_, k) => k);
      const { starts, units } = counted(text, DIALECT, ordinals);
      expect(starts).toEqual(unbounded(text, DIALECT, ordinals));
      expect(units).toBeLessThanOrEqual(6 * text.length + 256 * ordinals.length);
    });
  });
});

/** Line and column of offset in input by one regular expression, sharing no code with positionsAt. */
function oracle(input: string, offset: number) {
  const breaks = [...input.slice(0, offset).matchAll(/\r\n|\r|\n/g)];
  const last = breaks.at(-1);
  const lineStart = last === undefined ? 0 : last.index + last[0].length;
  return { line: breaks.length + 1, column: offset - lineStart + 1, lineStart };
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('positionsAt', () => {
  it('counts "\\r\\n", "\\r" and "\\n" as one line break each', () => {
    expect(positionsAt('a\r\nb\rc\nd', [0, 3, 4, 5, 7])).toEqual([
      { line: 1, column: 1, offset: 0, snippet: 'a' },
      { line: 2, column: 1, offset: 3, snippet: 'b' },
      { line: 2, column: 2, offset: 4, snippet: 'b' },
      { line: 3, column: 1, offset: 5, snippet: 'c' },
      { line: 4, column: 1, offset: 7, snippet: 'd' },
    ]);
    // The "\n" of a "\r\n" is at column 1 of the line the "\r" ended, as the unit after it.
    expect(positionsAt('a\r\nb', [1, 2])).toEqual([
      { line: 1, column: 2, offset: 1, snippet: 'a' },
      { line: 2, column: 1, offset: 2, snippet: 'b' },
    ]);
  });

  it('counts a BOM as a unit of the first line', () => {
    expect(positionsAt('\ufeffa,b', [1])).toEqual([
      { line: 1, column: 2, offset: 1, snippet: '\ufeffa,b' },
    ]);
  });

  it('counts a line break inside a quoted field', () => {
    expect(positionsAt('a,"x\ny"\nb', [2, 8])).toEqual([
      { line: 1, column: 3, offset: 2, snippet: 'a,"x' },
      { line: 3, column: 1, offset: 8, snippet: 'b' },
    ]);
  });

  it('gives the line and column of a one-expression oracle for every offset', () => {
    const random = mulberry32(0x11e5);
    for (let n = 0; n < 500; n++) {
      const input = soup(random, 40);
      const offsets = Array.from({ length: input.length + 1 }, (_, k) => k);
      const positions = positionsAt(input, offsets);
      for (const offset of offsets) {
        const { line, column } = oracle(input, offset);
        expect(positions[offset]).toMatchObject({ line, column, offset });
      }
    }
  });

  it('gives the whole line as snippet when it is 120 units or fewer', () => {
    const line = 'q'.repeat(120);
    expect(positionsAt(`a\n${line}\nb`, [2, 121])).toEqual([
      { line: 2, column: 1, offset: 2, snippet: line },
      { line: 2, column: 120, offset: 121, snippet: line },
    ]);
  });

  it('cuts a longer line to the 120 units around the column, with "…"', () => {
    // 500 distinct units, so each place in the snippet names one unit of the line.
    const line = Array.from({ length: 500 }, (_, k) => String.fromCharCode(0x4e00 + k)).join('');
    const [position] = positionsAt(line, [299]);
    expect(position?.column).toBe(300);
    const snippet = position?.snippet ?? '';
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(snippet).toBe(`…${line.slice(239, 359)}…`);
    expect(snippet[61]).toBe(line[299]);
    expect(positionsAt(line, [0])[0]?.snippet).toBe(`${line.slice(0, 120)}…`);
    expect(positionsAt(line, [499])[0]?.snippet).toBe(`…${line.slice(439)}`);
    for (let offset = 0; offset < 500; offset++) {
      const cut = positionsAt(line, [offset])[0]?.snippet ?? '';
      expect(cut.length).toBeLessThanOrEqual(122);
      expect(cut).toContain(line[offset]);
    }
  });

  it('never cuts a line inside a surrogate pair', () => {
    const line = '😀'.repeat(250);
    expect(positionsAt(line, [299])[0]?.snippet).toBe(`…${line.slice(240, 358)}…`);
    for (let offset = 0; offset < 500; offset++) {
      const snippet = positionsAt(line, [offset])[0]?.snippet ?? '';
      expect(snippet).not.toMatch(LONE_SURROGATE);
      expect(snippet.length).toBeLessThanOrEqual(122);
    }
  });

  const NAMED = [
    'a\r\nb\rc\nd',
    '\ufeffa,b',
    'a,"x\ny"\nb',
    'x\r\n\r\ny\n\rz\r',
    '\n\r\r\n\n',
    `h\r\n${'w'.repeat(130)}\r\nt`,
  ];

  it('equals the whole-input positions for a text cut at every split', () => {
    for (const input of NAMED) {
      const offsets = Array.from({ length: input.length + 1 }, (_, k) => k);
      const whole = positionsAt(input, offsets);
      for (let k = 0; k <= input.length; k++) {
        const before = advance(input, k);
        for (let j = 0; j <= k; j++) {
          expect(advance(input.slice(j), k - j, advance(input, j))).toEqual(before);
        }
        // Offsets whose line starts in the second part, the split between "\r" and "\n" included.
        const kept = offsets.filter(
          (offset) => offset >= k && oracle(input, offset).lineStart >= k,
        );
        const part = positionsAt(
          input.slice(k),
          kept.map((offset) => offset - k),
          before,
        );
        expect(part).toEqual(kept.map((offset) => whole[offset]));
      }
    }
  });

  it('starts from START', () => {
    expect(START).toEqual({ offset: 0, line: 0, column: 0, afterCR: false });
    expect(advance('ab\r', 3)).toEqual({ offset: 3, line: 1, column: 0, afterCR: true });
    expect(advance('ab\r\ncd', 6)).toEqual({ offset: 6, line: 1, column: 2, afterCR: false });
  });
});

describe('formatError', () => {
  const tooFew = {
    type: 'FieldMismatch',
    code: 'TooFewFields',
    message: 'Too few fields: expected 3 fields but parsed 2',
    row: 0,
  } as const;

  it('formats a short example', () => {
    const [position] = positionsAt('a,b,c\n1,2\n', [6]);
    expect(position).toEqual({ line: 2, column: 1, offset: 6, snippet: '1,2' });
    expect(formatError({ ...tooFew, ...position })).toBe(
      'Too few fields: expected 3 fields but parsed 2 [TooFewFields] at line 2, column 1 (row 0, offset 6)\n  2 | 1,2\n    | ^',
    );
  });

  it('pads the caret line to a two-digit line number', () => {
    const input = `${'x\n'.repeat(11)}a,"b`;
    const [position] = positionsAt(input, [24]);
    expect(position).toEqual({ line: 12, column: 3, offset: 24, snippet: 'a,"b' });
    const error: ParseError = {
      type: 'Quotes',
      code: 'MissingQuotes',
      message: 'Quoted field unterminated',
      row: 11,
      index: 25,
    };
    expect(formatError({ ...error, ...position })).toBe(
      'Quoted field unterminated [MissingQuotes] at line 12, column 3 (row 11, offset 24)\n  12 | a,"b\n     |   ^',
    );
  });

  it('formats an error without a position', () => {
    expect(formatError(tooFew)).toBe(
      'Too few fields: expected 3 fields but parsed 2 [TooFewFields] (row 0)',
    );
    expect(
      formatError({
        type: 'Delimiter',
        code: 'UndetectableDelimiter',
        message: "Unable to auto-detect delimiting character; defaulted to ','",
      }),
    ).toBe("Unable to auto-detect delimiting character; defaulted to ',' [UndetectableDelimiter]");
  });

  it('puts the caret under the unit at offset when the snippet was cut on the left', () => {
    const line = `${'x'.repeat(299)}"${'x'.repeat(200)}`;
    const [position] = positionsAt(line, [299]);
    expect(position?.column).toBe(300);
    const [, shown = '', caret = ''] = formatError({
      type: 'Quotes',
      code: 'InvalidQuotes',
      message: 'Trailing quote on quoted field is malformed',
      row: 0,
      index: 300,
      ...position,
    }).split('\n');
    expect(caret.indexOf('^')).toBe(shown.indexOf('"'));
    expect(shown).toBe(`  1 | …${'x'.repeat(60)}"${'x'.repeat(59)}…`);
  });

  it('formats a Schema error like any other', () => {
    const error = {
      type: 'Schema',
      code: 'InvalidRow',
      message: 'Expected a number',
      row: 1,
      path: ['age'],
      value: { age: 'x' },
      line: 3,
      column: 1,
      offset: 6,
      snippet: 'x',
    } as const;
    expect(formatError(error)).toBe(
      'Expected a number [InvalidRow] at line 3, column 1 (row 1, offset 6)\n  3 | x\n    | ^',
    );
  });

  it('does not modify its argument', () => {
    const error = Object.freeze({ ...tooFew, line: 2, column: 1, offset: 6, snippet: '1,2' });
    const copy = structuredClone(error);
    formatError(error);
    expect(error).toEqual(copy);
  });
});

describe('positions through parseDetailed', () => {
  const tooFew = (expected: number, parsed: number, row: number) => ({
    type: 'FieldMismatch',
    code: 'TooFewFields',
    message: `Too few fields: expected ${String(expected)} fields but parsed ${String(parsed)}`,
    row,
  });

  it('positions: named cases (the short example, and formatError of it)', () => {
    const { errors } = parseDetailed('a,b,c\n1,2\n', {
      header: true,
      delimiter: ',',
      newline: '\n',
      positions: true,
    });
    expect(errors).toStrictEqual([
      { ...tooFew(3, 2, 0), line: 2, column: 1, offset: 6, snippet: '1,2' },
      // The final [''] record starts where the text ends.
      { ...tooFew(3, 1, 1), line: 3, column: 1, offset: 10, snippet: '' },
    ]);
    expect(Object.keys(errors[0] ?? {})).toStrictEqual([
      'type',
      'code',
      'message',
      'row',
      'line',
      'column',
      'offset',
      'snippet',
    ]);
    const [first] = errors;
    expect(first && formatError(first)).toBe(
      'Too few fields: expected 3 fields but parsed 2 [TooFewFields] at line 2, column 1 (row 0, offset 6)\n  2 | 1,2\n    | ^',
    );
  });

  it('positions count the BOM and skipped lines: index keeps its meaning, offset is in the input as given', () => {
    expect(
      parseDetailed('\ufeffa,b\n"x', { header: true, delimiter: ',', positions: true }).errors,
    ).toStrictEqual([
      {
        type: 'Quotes',
        code: 'MissingQuotes',
        message: 'Quoted field unterminated',
        row: 1,
        index: 5,
        line: 2,
        column: 1,
        offset: 5,
        snippet: '"x',
      },
      { ...tooFew(2, 1, 0), line: 2, column: 1, offset: 5, snippet: '"x' },
    ]);
    // A position on line 1 has the BOM in its column and its snippet.
    expect(
      parseDetailed('\ufeffa,"b"x', { delimiter: ',', positions: true }).errors.map((error) => ({
        code: error.code,
        line: error.line,
        column: error.column,
        offset: error.offset,
        snippet: error.snippet,
      })),
    ).toStrictEqual([
      { code: 'InvalidQuotes', line: 1, column: 4, offset: 3, snippet: '\ufeffa,"b"x' },
      { code: 'MissingQuotes', line: 1, column: 4, offset: 3, snippet: '\ufeffa,"b"x' },
    ]);
    expect(
      parseDetailed('junk\na,b\n1\n', {
        header: true,
        delimiter: ',',
        skipFirstNLines: 1,
        positions: true,
      }).errors,
    ).toStrictEqual([
      { ...tooFew(2, 1, 0), line: 3, column: 1, offset: 9, snippet: '1' },
      { ...tooFew(2, 1, 1), line: 4, column: 1, offset: 11, snippet: '' },
    ]);
    expect(
      parseDetailed('sep=;\na;b\n1\n', { header: true, sepLine: true, positions: true }).errors,
    ).toStrictEqual([
      { ...tooFew(2, 1, 0), line: 3, column: 1, offset: 10, snippet: '1' },
      { ...tooFew(2, 1, 1), line: 4, column: 1, offset: 12, snippet: '' },
    ]);
    // All three together: a BOM (1 unit), the sep= line (7) and one skipped line (5).
    expect(
      parseDetailed('\ufeffsep=;\r\njunk\na;b\n1\n', {
        header: true,
        sepLine: true,
        skipFirstNLines: 1,
        positions: true,
      }).errors[0],
    ).toStrictEqual({ ...tooFew(2, 1, 0), line: 4, column: 1, offset: 17, snippet: '1' });
  });

  it('counts "\\r\\n" as one line break, and a record that spans lines starts on its first', () => {
    const { errors } = parseDetailed('a,b\r\n1\r\n"x\r\ny",2,3\r\n4,5', {
      header: true,
      positions: true,
    });
    expect(errors).toStrictEqual([
      { ...tooFew(2, 1, 0), line: 2, column: 1, offset: 5, snippet: '1' },
      {
        type: 'FieldMismatch',
        code: 'TooManyFields',
        message: 'Too many fields: expected 2 fields but parsed 3',
        row: 1,
        line: 3,
        column: 1,
        offset: 8,
        snippet: '"x',
      },
    ]);
  });

  it('a Quotes error is at the opening quote of its field', () => {
    const { errors } = parseDetailed('a,"b"x",c\n', { delimiter: ',', positions: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'InvalidQuotes',
      index: 3,
      line: 1,
      column: 3,
      offset: 2,
      snippet: 'a,"b"x",c',
    });
  });

  it('finds the record of a row past comment lines and records skipEmptyLines removed', () => {
    const { data, errors } = parseDetailed('#c\na,b\n\n#d\n1\n', {
      header: true,
      delimiter: ',',
      comments: true,
      skipEmptyLines: true,
      positions: true,
    });
    expect(data).toStrictEqual([{ a: '1' }]);
    expect(errors).toStrictEqual([
      { ...tooFew(2, 1, 0), line: 5, column: 1, offset: 11, snippet: '1' },
    ]);
  });

  it('UndetectableDelimiter has no place and gains nothing', () => {
    expect(parseDetailed('abc', { positions: true }).errors).toStrictEqual([
      {
        type: 'Delimiter',
        code: 'UndetectableDelimiter',
        message: "Unable to auto-detect delimiting character; defaulted to ','",
      },
    ]);
  });

  it('data, meta and the old error keys are unchanged by positions; without the key no error has a position', () => {
    const input = '\ufeffa,b\n1\n"x"y,2,3\n';
    const plain = parseDetailed(input, { header: true, delimiter: ',' });
    const located = parseDetailed(input, { header: true, delimiter: ',', positions: true });
    expect(plain.errors.length).toBeGreaterThan(2);
    expect(located.data).toStrictEqual(plain.data);
    expect(located.meta).toStrictEqual(plain.meta);
    expect(
      located.errors.map(({ line, column, offset, snippet, ...rest }) => {
        expect([typeof line, typeof column, typeof offset, typeof snippet]).toStrictEqual([
          'number',
          'number',
          'number',
          'string',
        ]);
        return rest;
      }),
    ).toStrictEqual(plain.errors);
    // Another feature key without positions: the errors have no place either.
    for (const error of parseDetailed(input, { header: true, delimiter: ',', sepLine: true })
      .errors) {
      expect(error).not.toHaveProperty('offset');
      expect(error).not.toHaveProperty('line');
    }
  });

  it('skipFirstNLines cuts the text where parse cuts it, for each newline and count', () => {
    // The copy of skipLines in src/detailed.ts against the one parse uses.
    const texts = [
      'x\ny\nz\na,b\n1',
      'x\r\ny\r\na,b\r\n1',
      'x\ry\ra,b\r1',
      'x\ny\r\na,b\r1\n',
      '',
      'x',
    ];
    for (const text of texts) {
      for (const newline of ['\n', '\r\n', '\r', undefined] as const) {
        for (const skipFirstNLines of [0, 1, 2, 3, 9]) {
          const config = { skipFirstNLines, delimiter: ',', ...(newline && { newline }) };
          const expected = parseDetailed(text, config);
          const { errors, ...rest } = parseDetailed(text, { ...config, positions: true });
          expect(rest).toStrictEqual({ data: expected.data, meta: expected.meta });
          expect(errors).toHaveLength(expected.errors.length);
        }
      }
    }
  });
});
