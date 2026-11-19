import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { parseDetailed } from '../src/detailed.ts';
import { guessNewline } from '../src/dialect.ts';
import { START, type Before } from '../src/locate.ts';
import { parse } from '../src/parse.ts';
import { scanRows, type ScanDialect } from '../src/parser.ts';
import { mixedNewline, repairRows } from '../src/repair.ts';
import type { Newline, Repair, RepairRule } from '../src/types.ts';
import { DELIMITERS, NEWLINES, records } from './differential.ts';

/** The five rules in the order they run. */
const ALL: readonly RepairRule[] = [
  'unclosed-quote',
  'mixed-newline',
  'trailing-empty-record',
  'drop-trailing-empty',
  'pad-missing',
];

const DIALECT: ScanDialect = {
  delimiter: ',',
  newline: '\n',
  quoteChar: '"',
  escapeChar: '"',
  comments: '',
  preview: 0,
  fastMode: false,
};

interface Options {
  dialect?: Partial<ScanDialect>;
  header?: boolean;
  skipEmptyLines?: boolean | 'greedy';
  width?: number;
  atEnd?: boolean;
  before?: Before;
}

/** Scans text and repairs the scan with exactly these rules; rows and errors are the scan's, repaired. */
function repair(text: string, rules: readonly RepairRule[], options: Options = {}) {
  const dialect: ScanDialect = { ...DIALECT, ...options.dialect };
  const { rows, errors } = scanRows(text, dialect);
  const { entries, counts } = repairRows({
    text,
    dialect,
    rows,
    errors,
    width: options.width,
    header: options.header ?? false,
    skipEmptyLines: options.skipEmptyLines ?? false,
    rules: new Set(rules),
    atEnd: options.atEnd ?? true,
    before: options.before ?? START,
  });
  return { rows, errors, entries, counts };
}

/** repairCounts with these values and 0 for every other rule, in the type's key order. */
const counted = (values: Partial<Record<RepairRule, number>>): Record<RepairRule, number> => ({
  'pad-missing': 0,
  'drop-trailing-empty': 0,
  'trailing-empty-record': 0,
  'mixed-newline': 0,
  'unclosed-quote': 0,
  ...values,
});

const missingQuotes = (row: number, index: number) => ({
  type: 'Quotes',
  code: 'MissingQuotes',
  message: 'Quoted field unterminated',
  row,
  index,
});
const invalidQuotes = (row: number, index: number) => ({
  type: 'Quotes',
  code: 'InvalidQuotes',
  message: 'Trailing quote on quoted field is malformed',
  row,
  index,
});

describe('rule pad-missing: trigger, output, log', () => {
  it('pads every short record to W, the final [""] included (rules: pad-missing)', () => {
    const result = repair('a,b,c\n1,2\n3\n', ['pad-missing']);
    expect(result.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['3', '', ''],
      ['', '', ''],
    ]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'pad-missing',
        row: 1,
        line: 2,
        column: 1,
        offset: 6,
        snippet: '1,2',
        length: 3,
        before: '1,2',
        after: [['1', '2', '']],
      },
      {
        rule: 'pad-missing',
        row: 2,
        line: 3,
        column: 1,
        offset: 10,
        snippet: '3',
        length: 1,
        before: '3',
        after: [['3', '', '']],
      },
      {
        rule: 'pad-missing',
        row: 3,
        line: 4,
        column: 1,
        offset: 12,
        snippet: '',
        length: 0,
        before: '',
        after: [['', '', '']],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'pad-missing': 3 }));
    expect(result.errors).toEqual([]);
  });

  it('gives every entry the keys rule, row, line, column, offset, snippet, length, before, after in that order (rules: pad-missing)', () => {
    const [entry] = repair('a,b\n1', ['pad-missing']).entries;
    expect(Object.keys(entry ?? {})).toEqual([
      'rule',
      'row',
      'line',
      'column',
      'offset',
      'snippet',
      'length',
      'before',
      'after',
    ]);
  });

  it('takes W from the header with header: true, and a short header pads nothing (rules: pad-missing)', () => {
    const short = repair('a\n1,2\n3,4', ['pad-missing'], { header: true });
    expect(short.rows).toEqual([['a'], ['1', '2'], ['3', '4']]);
    expect(short.entries).toEqual([]);
    expect(short.counts).toStrictEqual(counted({}));

    const result = repair('a,b,c\n1,2\n', ['pad-missing'], { header: true });
    expect(result.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['', '', ''],
    ]);
    expect(result.entries.map(({ row, offset, length }) => [row, offset, length])).toEqual([
      [0, 6, 3],
      [1, 10, 0],
    ]);
  });

  it('skips records that skipEmptyLines removes, which are not rows (rules: pad-missing)', () => {
    const result = repair('\na,b\n\n1\n', ['pad-missing'], { skipEmptyLines: true });
    expect(result.rows).toEqual([[''], ['a', 'b'], [''], ['1', ''], ['']]);
    expect(result.entries).toMatchObject([{ rule: 'pad-missing', row: 1, offset: 6, length: 1 }]);
    expect(result.counts).toStrictEqual(counted({ 'pad-missing': 1 }));

    const greedy = repair('a,b\n , \n1', ['pad-missing'], { skipEmptyLines: 'greedy' });
    expect(greedy.rows).toEqual([
      ['a', 'b'],
      [' ', ' '],
      ['1', ''],
    ]);
    expect(greedy.entries).toMatchObject([{ row: 1, offset: 8 }]);
  });

  it('finds the header as skipEmptyLines does: one U+FEFF removed per cell of record 0, a repeated name renamed (rules: pad-missing)', () => {
    // Record 0 is a second U+FEFF: an empty name, so the header is the next record.
    const bom = repair('﻿\na,b\n1', ['pad-missing'], { header: true, skipEmptyLines: true });
    expect(bom.rows).toEqual([['﻿'], ['a', 'b'], ['1', '']]);
    expect(bom.entries).toMatchObject([{ row: 0, offset: 6 }]);
    // Two empty names become '' and '_1', which is not empty: record 0 is the header.
    const renamed = repair(',\n1', ['pad-missing'], { header: true, skipEmptyLines: 'greedy' });
    expect(renamed.rows).toEqual([
      ['', ''],
      ['1', ''],
    ]);
    expect(renamed.entries).toMatchObject([{ row: 0, offset: 2 }]);
  });

  it('uses a given width, and then the rows hold no header record (rules: pad-missing)', () => {
    const result = repair('1\n2,3', ['pad-missing'], { width: 2, header: true });
    expect(result.rows).toEqual([
      ['1', ''],
      ['2', '3'],
    ]);
    expect(result.entries).toMatchObject([{ rule: 'pad-missing', row: 0, offset: 0, length: 1 }]);
  });

  it('leaves the comment lines after a record out of its span (rules: pad-missing)', () => {
    const result = repair('a,b\n1\n#c\n2,3', ['pad-missing'], { dialect: { comments: '#' } });
    expect(result.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['2', '3'],
    ]);
    expect(result.entries).toMatchObject([{ row: 1, offset: 4, length: 1, before: '1' }]);
  });

  it('shifts the positions by before (rules: pad-missing)', () => {
    const before: Before = { offset: 7, line: 2, column: 0, afterCR: false };
    const [entry] = repair('a,b\n1', ['pad-missing'], { before }).entries;
    expect(entry).toMatchObject({ line: 4, column: 1, offset: 11, length: 1, before: '1' });
  });
});

describe('rule drop-trailing-empty: trigger, output, log', () => {
  it('cuts a record whose extra fields are all empty to W (rules: drop-trailing-empty)', () => {
    const result = repair('a,b\n1,2,,\n', ['drop-trailing-empty']);
    expect(result.rows).toEqual([['a', 'b'], ['1', '2'], ['']]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'drop-trailing-empty',
        row: 1,
        line: 2,
        column: 1,
        offset: 4,
        snippet: '1,2,,',
        length: 5,
        before: '1,2,,',
        after: [['1', '2']],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'drop-trailing-empty': 1 }));
    expect(result.errors).toEqual([]);
  });

  it('counts rows from the first after the header with header: true (rules: drop-trailing-empty)', () => {
    const result = repair('a,b\n1,2,,\n', ['drop-trailing-empty'], { header: true });
    expect(result.entries).toMatchObject([{ row: 0, offset: 4, after: [['1', '2']] }]);
  });

  it('leaves a record with a non-empty extra field unchanged (rules: drop-trailing-empty)', () => {
    const result = repair('a,b\n1,2,x\n', ['drop-trailing-empty']);
    expect(result.rows).toEqual([['a', 'b'], ['1', '2', 'x'], ['']]);
    expect(result.entries).toEqual([]);
    expect(result.counts).toStrictEqual(counted({}));
  });
});

describe('rule trailing-empty-record: trigger, output, log', () => {
  it('removes the final [""] and logs the final line break as the span (rules: trailing-empty-record)', () => {
    const result = repair('a\n1\n', ['trailing-empty-record']);
    expect(result.rows).toEqual([['a'], ['1']]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'trailing-empty-record',
        row: -1,
        line: 2,
        column: 2,
        offset: 3,
        snippet: '1',
        length: 1,
        before: '\n',
        after: [],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'trailing-empty-record': 1 }));
  });

  it('logs a "\\r\\n" as two units (rules: trailing-empty-record)', () => {
    const result = repair('a\r\n1\r\n', ['trailing-empty-record'], {
      dialect: { newline: '\r\n' },
    });
    expect(result.rows).toEqual([['a'], ['1']]);
    expect(result.entries).toMatchObject([{ offset: 4, length: 2, before: '\r\n', line: 2 }]);
  });

  it('takes into the span the whitespace that only closed the quoted field before the line break (rules: trailing-empty-record)', () => {
    // Scanned with "\n", the "\r" is space after a closing quote: at the end of the text it would
    // no longer close the field, so the span starts at it.
    const result = repair('a,"b"\r\n', ['trailing-empty-record']);
    expect(result.rows).toEqual([['a', 'b']]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'trailing-empty-record',
        row: -1,
        line: 1,
        column: 6,
        offset: 5,
        snippet: 'a,"b"',
        length: 2,
        before: '\r\n',
        after: [],
      },
    ]);
    // Whitespace that is data stays; a logged record before it holds the whitespace in its span.
    expect(repair('a,b \n', ['trailing-empty-record']).entries).toMatchObject([
      { offset: 4, length: 1 },
    ]);
    const logged = repair('a,b,c\n1,"b"\r\n', ['trailing-empty-record', 'pad-missing']);
    expect(logged.entries.map(({ rule, offset, length }) => [rule, offset, length])).toEqual([
      ['pad-missing', 6, 6],
      ['trailing-empty-record', 12, 1],
    ]);
  });

  it('does nothing without a final line break, and removes only the last of two empty records (rules: trailing-empty-record)', () => {
    const none = repair('a\n1', ['trailing-empty-record']);
    expect(none.rows).toEqual([['a'], ['1']]);
    expect(none.entries).toEqual([]);
    const quoted = repair('a\n""', ['trailing-empty-record']);
    expect(quoted.rows).toEqual([['a'], ['']]);
    expect(quoted.entries).toEqual([]);

    // Without its line break the text would hold no record at all.
    const alone = repair('\n', ['trailing-empty-record']);
    expect(alone.rows).toEqual([[''], ['']]);
    expect(alone.entries).toEqual([]);

    const result = repair('a\n1\n\n', ['trailing-empty-record']);
    expect(result.rows).toEqual([['a'], ['1'], ['']]);
    expect(result.entries).toMatchObject([
      { offset: 4, length: 1, before: '\n', line: 3, column: 1 },
    ]);
  });
});

describe('rule mixed-newline: trigger, output, log', () => {
  it('mixedNewline: two kinds of line break outside quotes, and the newline to scan with', () => {
    expect(mixedNewline('a\r\nb\nc', '"')).toBe('\n');
    expect(mixedNewline('a\nb\rc', '"')).toBe('\n');
    expect(mixedNewline('a\r\nb\rc', '"')).toBe('\r\n');
    expect(mixedNewline('a\nb\n', '"')).toBeUndefined();
    expect(mixedNewline('a\r\nb\r\n', '"')).toBeUndefined();
    // A clean spreadsheet export: CRLF records, LF or CR only inside quoted cells.
    expect(mixedNewline('a,"x\ny"\r\nb,c\r\n', '"')).toBeUndefined();
    expect(mixedNewline('a,"x\ry"\r\nb,c\r\n', '"')).toBeUndefined();
    expect(mixedNewline("a,'x\ny'\r\nb,c\r\n", "'")).toBeUndefined();
  });

  it('mixedNewline: reads the first 1,048,576 units; a "\\r\\n" cut by that limit is not a lone "\\r"', () => {
    const cut = `${'x'.repeat(1_048_575)}\r\na\r\n`;
    expect(mixedNewline(cut, '"')).toBeUndefined();
    expect(mixedNewline(`${'x'.repeat(1_048_575)}\r\na\n`, '"')).toBeUndefined();
    expect(mixedNewline(`${'x'.repeat(1_048_574)}\r\r\n`, '"')).toBe('\r\n');
    expect(mixedNewline('a\nb\r', '"')).toBe('\n');
  });

  it('mixedNewline: ignores the sample after a quote that does not close in it, such as a cut quoted cell', () => {
    // A clean CRLF export whose quoted cell holds an LF and is cut by the limit after that LF.
    const head = 'v\r\n'.repeat(349_524);
    expect(head.length).toBe(1_048_572);
    expect(mixedNewline(`${head}"p\nq"\r\nw\r\n`, '"')).toBeUndefined();
    expect(mixedNewline('a\r\n"b\nc', '"')).toBeUndefined();
    // Line breaks before that quote still count.
    expect(mixedNewline('a\r\nb\n"c\rd', '"')).toBe('\n');
  });

  it('removes a "\\r" before the line break outside quotes (rules: mixed-newline)', () => {
    const text = 'a,b\r\n1,2\n3,4\r\n';
    expect(mixedNewline(text, '"')).toBe('\n');
    const result = repair(text, ['mixed-newline']);
    expect(result.rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['']]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'mixed-newline',
        row: 0,
        line: 1,
        column: 1,
        offset: 0,
        snippet: 'a,b',
        length: 4,
        before: 'a,b\r',
        after: [['a', 'b']],
      },
      {
        rule: 'mixed-newline',
        row: 2,
        line: 3,
        column: 1,
        offset: 9,
        snippet: '3,4',
        length: 4,
        before: '3,4\r',
        after: [['3', '4']],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'mixed-newline': 2 }));

    const header = repair(text, ['mixed-newline'], { header: true });
    expect(header.entries.map(({ row, offset }) => [row, offset])).toEqual([
      [-1, 0],
      [1, 9],
    ]);
  });

  it('keeps a "\\r" inside quotes (rules: mixed-newline)', () => {
    const result = repair('a,"b\r"\n1\r\n2\n', ['mixed-newline']);
    expect(result.rows).toEqual([['a', 'b\r'], ['1'], ['2'], ['']]);
    expect(result.entries).toMatchObject([
      { row: 1, line: 3, offset: 7, length: 2, before: '1\r', after: [['1']] },
    ]);
  });

  it('splits a record at a lone "\\r" outside quotes, one entry for the record (rules: mixed-newline)', () => {
    const result = repair('a,b\n1,2\r3,4\n', ['mixed-newline']);
    expect(result.rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['']]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'mixed-newline',
        row: 1,
        line: 2,
        column: 1,
        offset: 4,
        snippet: '1,2',
        length: 7,
        before: '1,2\r3,4',
        after: [
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'mixed-newline': 1 }));
  });

  it('does not split a quoted field at its "\\r" (rules: mixed-newline)', () => {
    const result = repair('x,"p\rq"\n1\r2\n', ['mixed-newline']);
    expect(result.rows).toEqual([['x', 'p\rq'], ['1'], ['2'], ['']]);
    expect(result.entries).toMatchObject([
      { row: 1, line: 3, offset: 8, length: 3, before: '1\r2', after: [['1'], ['2']] },
    ]);
  });

  it('scans with "\\r\\n" when no lone "\\n" exists, and splits at a lone "\\r" (rules: mixed-newline)', () => {
    const text = 'a,b\r\n1\r2\r\n';
    expect(mixedNewline(text, '"')).toBe('\r\n');
    const result = repair(text, ['mixed-newline'], { dialect: { newline: '\r\n' } });
    expect(result.rows).toEqual([['a', 'b'], ['1'], ['2'], ['']]);
    expect(result.entries).toMatchObject([{ row: 1, offset: 5, length: 3, after: [['1'], ['2']] }]);
  });

  it('leaves a clean spreadsheet export untouched, with every rule (rules: all five)', () => {
    const text = 'a,"x\ny"\r\nb,"p\rq"\r\n';
    expect(mixedNewline(text, '"')).toBeUndefined();
    const newline = guessNewline(text, '"');
    expect(newline).toBe('\r\n');
    const result = repair(text, ALL, { dialect: { newline } });
    expect(result.rows).toEqual([
      ['a', 'x\ny'],
      ['b', 'p\rq'],
    ]);
    expect(result.entries.filter(({ rule }) => rule !== 'trailing-empty-record')).toEqual([]);
    expect(result.counts).toStrictEqual(counted({ 'trailing-empty-record': 1 }));
  });

  it('leaves a record with a quote error as it is, and its error stays (rules: mixed-newline)', () => {
    const result = repair('"a"\rb",c\n', ['mixed-newline']);
    expect(result.rows).toEqual([['a"\rb', 'c'], ['']]);
    expect(result.errors).toEqual([invalidQuotes(0, 1)]);
    expect(result.entries).toEqual([]);
    // Read again with "\r", the record keeps its fields but raises the same error: it keeps its "\r" too.
    const kept = repair('"a"x",b\r\n', ['mixed-newline']);
    expect(kept.rows).toEqual([['a"x', 'b\r'], ['']]);
    expect(kept.errors).toEqual([invalidQuotes(0, 1)]);
    expect(kept.entries).toEqual([]);
  });

  it('leaves a record whose re-reading would change more than its "\\r"s (rules: mixed-newline)', () => {
    // The "\r" after "z" is dropped as space before the delimiter; read as a line break it would
    // add an empty field.
    const result = repair('x\ry,"z"\r,w\n', ['mixed-newline']);
    expect(result.rows).toEqual([['x\ry', 'z', 'w'], ['']]);
    expect(result.entries).toEqual([]);
  });

  it('removes a "\\r" that ends the input like one before a line break (rules: all five)', () => {
    const result = repair('a\nb\r', ALL);
    expect(result.rows).toEqual([['a'], ['b']]);
    expect(result.entries).toMatchObject([
      { rule: 'mixed-newline', row: 1, offset: 2, length: 2, before: 'b\r', after: [['b']] },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'mixed-newline': 1 }));
  });

  it('keeps a record that starts with the comment marker after a split (rules: mixed-newline)', () => {
    const result = repair('a\r#b\n', ['mixed-newline'], { dialect: { comments: '#' } });
    expect(result.rows).toEqual([['a'], ['#b'], ['']]);
    expect(result.entries).toMatchObject([{ offset: 0, length: 4, after: [['a'], ['#b']] }]);
  });
});

describe('rule unclosed-quote: trigger, output, log', () => {
  it('reads the line of the opening quote again with quotes as ordinary characters (rules: unclosed-quote)', () => {
    const text = 'a,"b\n1,2\n3,4';
    expect(scanRows(text, DIALECT).rows).toEqual([['a', 'b\n1,2\n3,4']]);
    const result = repair(text, ['unclosed-quote']);
    expect(result.rows).toEqual([
      ['a', '"b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.entries).toStrictEqual([
      {
        rule: 'unclosed-quote',
        row: 0,
        line: 1,
        column: 1,
        offset: 0,
        snippet: 'a,"b',
        length: 4,
        before: 'a,"b',
        after: [['a', '"b']],
      },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'unclosed-quote': 1 }));
  });

  it('keeps the quoted fields before it, and a closed quoted field after the line parses as quoted (rules: unclosed-quote)', () => {
    const before = repair('"p,q",x,"b\n1', ['unclosed-quote']);
    expect(before.rows).toEqual([['p,q', 'x', '"b'], ['1']]);
    expect(before.entries).toMatchObject([{ offset: 0, length: 10, after: [['p,q', 'x', '"b']] }]);

    const after = repair('a,"b\n"",c\n', ['unclosed-quote']);
    expect(after.rows).toEqual([['a', '"b'], ['', 'c'], ['']]);
    expect(after.errors).toEqual([]);
  });

  it('logs the whole record when it began on an earlier line (rules: unclosed-quote)', () => {
    const result = repair('a,"x\ny","b\n1', ['unclosed-quote']);
    expect(result.rows).toEqual([['a', 'x\ny', '"b'], ['1']]);
    expect(result.entries).toMatchObject([
      {
        row: 0,
        line: 1,
        offset: 0,
        length: 10,
        before: 'a,"x\ny","b',
        after: [['a', 'x\ny', '"b']],
      },
    ]);
  });

  it('repairs a second unclosed field that the resumed scan opens, and its InvalidQuotes go with it (rules: unclosed-quote)', () => {
    const text = 'a,"b\n"c" x\n1,2';
    expect(scanRows(text, DIALECT).errors).toEqual([
      invalidQuotes(0, 3),
      invalidQuotes(0, 3),
      missingQuotes(0, 3),
    ]);
    const result = repair(text, ['unclosed-quote']);
    expect(result.rows).toEqual([['a', '"b'], ['"c" x'], ['1', '2']]);
    expect(result.errors).toEqual([]);
    expect(result.entries).toMatchObject([
      { row: 0, offset: 0, length: 4, after: [['a', '"b']] },
      { row: 1, line: 2, column: 1, offset: 5, snippet: '"c" x', length: 5, after: [['"c" x']] },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'unclosed-quote': 2 }));
  });

  it('repairs at most 100 times; the 101st error stays, re-based to the whole text (rules: unclosed-quote)', () => {
    const text = `${'"x\n'.repeat(100)}"x`;
    const result = repair(text, ['unclosed-quote']);
    expect(result.rows).toEqual([...Array.from({ length: 100 }, () => ['"x']), ['x']]);
    expect(result.entries).toHaveLength(100);
    expect(result.counts).toStrictEqual(counted({ 'unclosed-quote': 100 }));
    expect(result.errors).toEqual([missingQuotes(100, 301)]);
    expect(result.entries.at(-1)).toMatchObject({ row: 99, line: 100, offset: 297 });

    const invalid = repair(`${'"x"y\n'.repeat(100)}"x"y`, ['unclosed-quote']);
    expect(invalid.errors).toEqual([invalidQuotes(100, 501), missingQuotes(100, 501)]);
  });

  it('adds the final [""] when the repaired line ends with the last line break (rules: unclosed-quote)', () => {
    const result = repair('a,"b\n', ['unclosed-quote']);
    expect(result.rows).toEqual([['a', '"b'], ['']]);
    expect(result.entries).toMatchObject([{ offset: 0, length: 4 }]);
  });

  it('a repaired issue is logged once and is not an error (rules: unclosed-quote)', () => {
    const result = repair('a,"b\n1,2', ['unclosed-quote']);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('an unrepaired issue stays an error: InvalidQuotes in a closed field (rules: all five)', () => {
    const result = repair('a,"b"x",c\n', ALL);
    expect(result.rows).toEqual([['a', 'b"x', 'c']]);
    expect(result.errors).toEqual([invalidQuotes(0, 3)]);
    expect(result.entries.map(({ rule }) => rule)).toEqual(['trailing-empty-record']);
  });
});

describe('atEnd: false', () => {
  it('trailing-empty-record and unclosed-quote wait; the other rules behave the same (rules: all five)', () => {
    const quote = repair('a,"b\n1,2', ALL, { atEnd: false });
    expect(quote.rows).toEqual([['a', 'b\n1,2']]);
    expect(quote.errors).toEqual([missingQuotes(0, 3)]);
    expect(quote.entries).toEqual([]);
    expect(quote.counts).toStrictEqual(counted({}));

    const rest = repair('a,b,c\r\n1,2\n', ALL, { atEnd: false });
    expect(rest.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['', '', ''],
    ]);
    expect(rest.entries.map(({ rule, offset }) => [rule, offset])).toEqual([
      ['mixed-newline', 0],
      ['pad-missing', 7],
      ['pad-missing', 11],
    ]);
  });
});

describe('all five rules together', () => {
  it('logs in input order, each record where it starts and the final line break last (rules: all five)', () => {
    const result = repair('a,b,c\n1,2\n', ALL, { header: true });
    expect(result.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ]);
    expect(result.entries).toMatchObject([
      { rule: 'pad-missing', row: 0, offset: 6, length: 3, after: [['1', '2', '']] },
      { rule: 'trailing-empty-record', row: -1, offset: 9, length: 1, after: [] },
    ]);
    expect(result.counts).toStrictEqual(counted({ 'pad-missing': 1, 'trailing-empty-record': 1 }));
  });

  it('gives two rules on one record the same span, the later one with the record as it ends (rules: all five)', () => {
    const result = repair('a,b,c\r\n1,2\r\n3\n', ALL);
    expect(result.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['3', '', ''],
    ]);
    expect(
      result.entries.map(({ rule, row, offset, length, after }) => [
        rule,
        row,
        offset,
        length,
        after,
      ]),
    ).toEqual([
      ['mixed-newline', 0, 0, 6, [['a', 'b', 'c']]],
      ['mixed-newline', 1, 7, 4, [['1', '2']]],
      ['pad-missing', 1, 7, 4, [['1', '2', '']]],
      ['pad-missing', 2, 12, 1, [['3', '', '']]],
      ['trailing-empty-record', -1, 13, 1, []],
    ]);
  });

  it('pads the pieces of a split record in one entry (rules: mixed-newline, pad-missing)', () => {
    const result = repair('a,b\n1\r2\n', ['mixed-newline', 'pad-missing']);
    expect(result.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['2', ''],
      ['', ''],
    ]);
    expect(
      result.entries.map(({ rule, row, offset, after }) => [rule, row, offset, after]),
    ).toEqual([
      ['mixed-newline', 1, 4, [['1'], ['2']]],
      [
        'pad-missing',
        1,
        4,
        [
          ['1', ''],
          ['2', ''],
        ],
      ],
      ['pad-missing', 3, 8, [['', '']]],
    ]);
    expect(result.counts).toStrictEqual(counted({ 'mixed-newline': 1, 'pad-missing': 2 }));
  });

  it('mixed-newline leaves a line unclosed-quote re-read (rules: all five)', () => {
    // The line breaks before the unclosed quote trigger the rule.
    const text = 'p\r\nq\na,"b\rc\n1\r\n';
    expect(mixedNewline(text, '"')).toBe('\n');
    const result = repair(text, ALL);
    expect(result.rows).toEqual([['p'], ['q'], ['a', '"b\rc'], ['1']]);
    expect(result.errors).toEqual([]);
    expect(result.entries.map(({ rule, offset, length }) => [rule, offset, length])).toEqual([
      ['mixed-newline', 0, 2],
      ['unclosed-quote', 5, 6],
      ['mixed-newline', 12, 2],
      ['trailing-empty-record', 14, 1],
    ]);
  });

  it('repairs is present and empty on clean input (rules: all five)', () => {
    for (const text of ['a,b\n1,2', 'a,"x\ny"\r\nb,c', '']) {
      const newline = guessNewline(text, '"');
      const result = repair(text, ALL, { dialect: { newline }, header: true });
      expect(result.entries).toEqual([]);
      expect(result.counts).toStrictEqual(counted({}));
    }
  });

  it('repairs the rows in place', () => {
    const rows = [['a', 'b'], ['1']];
    repairRows({
      text: 'a,b\n1',
      dialect: DIALECT,
      rows,
      errors: [],
      width: undefined,
      header: false,
      skipEmptyLines: false,
      rules: new Set(['pad-missing']),
      atEnd: true,
      before: START,
    });
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
});

describe('the log is bounded', () => {
  it('keeps the first 10,000 entries and counts all 10,050 changes (rules: pad-missing)', () => {
    const text = `a,b\n${Array.from({ length: 10_050 }, () => '1').join('\n')}`;
    const result = repair(text, ['pad-missing']);
    expect(result.rows).toHaveLength(10_051);
    expect(result.rows.slice(1).every((row) => row.length === 2 && row[1] === '')).toBe(true);
    expect(result.entries).toHaveLength(10_000);
    expect(result.counts).toStrictEqual(counted({ 'pad-missing': 10_050 }));
    expect(result.entries[0]).toMatchObject({ row: 1, offset: 4 });
    expect(result.entries.at(-1)).toMatchObject({
      row: 10_000,
      line: 10_001,
      offset: 4 + 2 * 9_999,
    });
  });

  it('keeps the first 10,000 in input order across rules (rules: drop-trailing-empty, pad-missing)', () => {
    const text = `a,b\n${'1\n1,2,\n'.repeat(6_000)}`;
    const result = repair(text, ['drop-trailing-empty', 'pad-missing']);
    expect(result.counts).toStrictEqual(
      counted({ 'pad-missing': 6_001, 'drop-trailing-empty': 6_000 }),
    );
    expect(result.entries).toHaveLength(10_000);
    const offsets = result.entries.map(({ offset }) => offset);
    expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
    expect(result.entries.filter(({ rule }) => rule === 'pad-missing')).toHaveLength(5_000);
    expect(result.entries.at(-1)).toMatchObject({
      rule: 'drop-trailing-empty',
      row: 10_000,
      offset: 6 + 7 * 4_999,
    });
  });

  it('keeps 256 units of before for a 5,000-unit record (rules: pad-missing)', () => {
    const long = 'x'.repeat(5_000);
    const result = repair(`a,b\n${long}`, ['pad-missing']);
    expect(result.entries).toStrictEqual([
      {
        rule: 'pad-missing',
        row: 1,
        line: 2,
        column: 1,
        offset: 4,
        snippet: `${'x'.repeat(120)}…`,
        length: 5_000,
        before: 'x'.repeat(256),
        after: [[long, '']],
      },
    ]);
  });

  it('stops before at 255 units where 256 would split a surrogate pair (rules: pad-missing)', () => {
    const split = repair(`a,b\n${'x'.repeat(255)}😀y`, ['pad-missing']);
    expect(split.entries).toMatchObject([{ length: 258, before: 'x'.repeat(255) }]);
    const whole = repair(`a,b\n${'x'.repeat(254)}😀y`, ['pad-missing']);
    expect(whole.entries).toMatchObject([{ length: 257, before: `${'x'.repeat(254)}😀` }]);
  });
});

// The repair properties, over seeded damaged inputs.

const pick = <T>(random: () => number, items: readonly T[]) =>
  items[Math.floor(random() * items.length)] as T;

/**
 * records() of test/differential.ts, cut into its lines (a separator soup never holds), with lines
 * cut short at their last delimiter or given empty extra fields, joined with one line break or with
 * mixed ones, with a final line break or not.
 */
function damaged(random: () => number, delimiter: string, quote: string): string {
  const lines = records(random, delimiter, '\0', quote).split('\0');
  if (lines.at(-1) === '') lines.pop();
  const breaks = random() < 0.5 ? [pick(random, NEWLINES)] : NEWLINES;
  let text = '';
  lines.forEach((line, i) => {
    const r = random();
    const changed =
      r < 0.25
        ? line.slice(0, Math.max(0, line.lastIndexOf(delimiter)))
        : r < 0.5
          ? line + delimiter.repeat(1 + Math.floor(random() * 3))
          : line;
    text += (i === 0 ? '' : pick(random, breaks)) + changed;
  });
  return random() < 0.5 ? text + pick(random, breaks) : text;
}

interface Case {
  text: string;
  dialect: ScanDialect;
  header: boolean;
  skipEmptyLines: boolean | 'greedy';
}

/** Seeded cases; the newline is the one parse would scan with under these rules. */
function* cases(
  seed: number,
  count: number,
  comments = ['', '#'],
): Generator<(rules: readonly RepairRule[]) => Case> {
  const random = mulberry32(seed);
  for (let n = 0; n < count; n++) {
    const delimiter = pick(random, DELIMITERS);
    const quote = pick(random, ['"', "'"]);
    const text = damaged(random, delimiter, quote);
    const base = {
      ...DIALECT,
      delimiter,
      quoteChar: quote,
      escapeChar: quote,
      comments: pick(random, comments),
    };
    const header = random() < 0.5;
    const skipEmptyLines = pick(random, [false, true, 'greedy'] as const);
    yield (rules) => {
      const guessed: Newline = guessNewline(text, quote);
      const newline = rules.includes('mixed-newline')
        ? (mixedNewline(text, quote) ?? guessed)
        : guessed;
      return { text, dialect: { ...base, newline }, header, skipEmptyLines };
    };
  }
}

/** A record as text that scans back to fields: quoted when a field holds what the scan would read. */
function write(fields: readonly string[], { delimiter, quoteChar, comments }: ScanDialect): string {
  return fields
    .map((field, i) =>
      field.includes(delimiter) ||
      field.includes(quoteChar) ||
      /[\r\n]/.test(field) ||
      (i === 0 && comments !== '' && field.startsWith(comments)) ||
      // parse removes a U+FEFF that starts the text.
      (i === 0 && field.startsWith('\ufeff'))
        ? quoteChar + field.replaceAll(quoteChar, quoteChar + quoteChar) + quoteChar
        : field,
    )
    .join(delimiter);
}

/**
 * The input with each logged span replaced by its after, applied from the last entry: an entry
 * followed by one for the same span (a later rule on the same record) is superseded by it.
 */
function applyLog(text: string, entries: readonly Repair[], dialect: ScanDialect): string {
  let out = text;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const next = entries[i + 1];
    if (entry === undefined) continue;
    if (next?.offset === entry.offset && next.length === entry.length) continue;
    const records = entry.after.map((fields) => write(fields, dialect)).join(dialect.newline);
    out = out.slice(0, entry.offset) + records + out.slice(entry.offset + entry.length);
  }
  return out;
}

/** What is wrong with the log's spans: out of input order, overlapping, or before not their start. */
function spanFault(text: string, entries: readonly Repair[]): string | undefined {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];
    if (entry === undefined) continue;
    const span = text.slice(entry.offset, entry.offset + entry.length);
    const splitsPair =
      /[\ud800-\udbff]$/.test(span.slice(0, 256)) && /^[\udc00-\udfff]/.test(span.slice(256));
    if (entry.before !== span.slice(0, splitsPair ? 255 : 256))
      return `before of entry ${String(i)}`;
    const same = next?.offset === entry.offset && next.length === entry.length;
    if (next !== undefined && !same && entry.offset + entry.length > next.offset) {
      return `entries ${String(i)} and ${String(i + 1)} overlap`;
    }
  }
  return undefined;
}

const RULE_SETS: readonly (readonly RepairRule[])[] = [...ALL.map((rule) => [rule]), ALL];

describe('repair equals parsing the repaired text', () => {
  it('for 3,000 seeded inputs under each rule alone and all five: the log applied to the input scans to the repaired rows', () => {
    const failures: string[] = [];
    const totals = counted({});
    for (const make of cases(0x7e9a12, 3_000)) {
      for (const rules of RULE_SETS) {
        const { text, dialect, header, skipEmptyLines } = make(rules);
        const result = repair(text, rules, { dialect, header, skipEmptyLines });
        for (const rule of ALL) {
          totals[rule] += result.counts[rule];
          if (result.counts[rule] !== result.entries.filter((e) => e.rule === rule).length) {
            failures.push(JSON.stringify({ fault: `count of ${rule}`, text, rules, dialect }));
          }
        }
        const fault = spanFault(text, result.entries);
        const scanned = scanRows(applyLog(text, result.entries, dialect), dialect).rows;
        if (fault !== undefined || JSON.stringify(scanned) !== JSON.stringify(result.rows)) {
          failures.push(
            JSON.stringify({
              fault: fault ?? 'rows',
              text,
              rules,
              dialect,
              header,
              skipEmptyLines,
            }),
          );
        }
      }
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    for (const rule of ALL) expect(totals[rule]).toBeGreaterThan(200);
  }, 60_000);
});

const nonEmpty = (rows: readonly (readonly string[])[]) =>
  rows
    .flat()
    .filter((field) => field !== '')
    .sort();

function characters(strings: Iterable<string>, sign: number, into = new Map<string, number>()) {
  for (const string of strings) {
    for (const char of string) into.set(char, (into.get(char) ?? 0) + sign);
  }
  return into;
}

describe('nothing but empties is removed', () => {
  it('pad-missing, drop-trailing-empty, trailing-empty-record keep the multiset of non-empty fields (rules: each alone and the three together)', () => {
    const sets: readonly (readonly RepairRule[])[] = [
      ['pad-missing'],
      ['drop-trailing-empty'],
      ['trailing-empty-record'],
      ['trailing-empty-record', 'drop-trailing-empty', 'pad-missing'],
    ];
    const failures: string[] = [];
    let changes = 0;
    for (const make of cases(0x51a7, 2_000)) {
      for (const rules of sets) {
        const { text, dialect, header, skipEmptyLines } = make(rules);
        const unrepaired = scanRows(text, dialect).rows;
        const result = repair(text, rules, { dialect, header, skipEmptyLines });
        changes += result.entries.length;
        if (JSON.stringify(nonEmpty(result.rows)) !== JSON.stringify(nonEmpty(unrepaired))) {
          failures.push(JSON.stringify({ text, rules, dialect }));
        }
      }
    }
    expect(failures).toEqual([]);
    expect(changes).toBeGreaterThan(1_000);
  });

  it('mixed-newline removes only "\\r"s: the fields joined without "\\r" are the same, and each entry removes one or more (rules: mixed-newline)', () => {
    const rules: readonly RepairRule[] = ['mixed-newline'];
    const failures: string[] = [];
    let changes = 0;
    for (const make of cases(0x3e7, 2_000)) {
      const { text, dialect, header, skipEmptyLines } = make(rules);
      const unrepaired = scanRows(text, dialect).rows.flat().join('');
      const result = repair(text, rules, { dialect, header, skipEmptyLines });
      const repaired = result.rows.flat().join('');
      const removed = unrepaired.split('\r').length - repaired.split('\r').length;
      changes += result.entries.length;
      if (
        unrepaired.replaceAll('\r', '') !== repaired.replaceAll('\r', '') ||
        removed < result.entries.length
      ) {
        failures.push(JSON.stringify({ text, dialect }));
      }
    }
    expect(failures).toEqual([]);
    expect(changes).toBeGreaterThan(200);
  });

  it('unclosed-quote keeps every character but syntax, plus each re-read quote (rules: unclosed-quote)', () => {
    const rules: readonly RepairRule[] = ['unclosed-quote'];
    const failures: string[] = [];
    let changes = 0;
    // Without comments: a comment line inside the unclosed field is a comment once read again.
    for (const make of cases(0xc0de, 2_000, [''])) {
      const { text, dialect, header, skipEmptyLines } = make(rules);
      const unrepaired = scanRows(text, dialect).rows.flat();
      const result = repair(text, rules, { dialect, header, skipEmptyLines });
      changes += result.entries.length;
      const quotes = Array.from(result.entries, () => dialect.quoteChar);
      const diff = characters(result.rows.flat(), -1, characters([...unrepaired, ...quotes], 1));
      const syntax = dialect.delimiter + dialect.quoteChar + dialect.escapeChar;
      for (const [char, count] of diff) {
        if (count < 0 || (count > 0 && !syntax.includes(char) && !/\s/.test(char))) {
          failures.push(JSON.stringify({ char, count, text, dialect }));
          break;
        }
      }
    }
    expect(failures).toEqual([]);
    expect(changes).toBeGreaterThan(200);
  });
});

describe('repair through parseDetailed', () => {
  const padEntry = {
    rule: 'pad-missing',
    row: 0,
    line: 2,
    column: 1,
    offset: 6,
    snippet: '1,2',
    length: 3,
    before: '1,2',
    after: [['1', '2', '']],
  };

  it('pads, removes the final empty record and logs both; the result has repairs and repairCounts', () => {
    const result = parseDetailed('a,b,c\n1,2\n', { header: true, repair: true });
    expect(Object.keys(result)).toStrictEqual([
      'data',
      'errors',
      'meta',
      'repairs',
      'repairCounts',
    ]);
    expect(result).toStrictEqual({
      data: [{ a: '1', b: '2', c: '' }],
      errors: [],
      meta: {
        delimiter: ',',
        linebreak: '\n',
        aborted: false,
        truncated: false,
        cursor: 10,
        renamedHeaders: null,
        fields: ['a', 'b', 'c'],
      },
      repairs: [
        padEntry,
        {
          rule: 'trailing-empty-record',
          row: -1,
          line: 2,
          column: 4,
          offset: 9,
          snippet: '1,2',
          length: 1,
          before: '\n',
          after: [],
        },
      ],
      repairCounts: counted({ 'pad-missing': 1, 'trailing-empty-record': 1 }),
    });
    expect(Object.keys(result.repairs?.[0] ?? {})).toStrictEqual(Object.keys(padEntry));
    expect(Object.keys(result.repairCounts ?? {})).toStrictEqual(Object.keys(counted({})));
  });

  it('a padded field goes through dynamicTyping and transform like a written empty field', () => {
    const typed = parseDetailed('a,b,c\n1,2\n', {
      header: true,
      repair: true,
      dynamicTyping: true,
    });
    expect(typed.data).toStrictEqual([{ a: 1, b: 2, c: null }]);
    const calls: unknown[][] = [];
    const transformed = parseDetailed('a,b,c\n1,2\n', {
      header: true,
      repair: true,
      transform: (value, field) => {
        calls.push([value, field]);
        return `<${value}>`;
      },
    });
    expect(calls).toStrictEqual([
      ['1', 'a'],
      ['2', 'b'],
      ['', 'c'],
    ]);
    expect(transformed.data).toStrictEqual([{ a: '<1>', b: '<2>', c: '<>' }]);
    expect(transformed.repairs?.[0]?.after).toStrictEqual([['1', '2', '']]);
  });

  it('repair: ["pad-missing"] pads the final [""] record like any other, so no TooFewFields remains', () => {
    const result = parseDetailed('a,b,c\n1,2\n', { header: true, repair: ['pad-missing'] });
    expect(result.data).toStrictEqual([
      { a: '1', b: '2', c: '' },
      { a: '', b: '', c: '' },
    ]);
    expect(result.errors).toStrictEqual([]);
    expect(result.repairs).toStrictEqual([
      padEntry,
      {
        rule: 'pad-missing',
        row: 1,
        line: 3,
        column: 1,
        offset: 10,
        snippet: '',
        length: 0,
        before: '',
        after: [['', '', '']],
      },
    ]);
    expect(result.repairCounts).toStrictEqual(counted({ 'pad-missing': 2 }));
  });

  it('repairs is present and empty on clean input', () => {
    const result = parseDetailed('a,b\n1,2', { header: true, repair: true });
    expect(result.data).toStrictEqual([{ a: '1', b: '2' }]);
    expect(result.repairs).toStrictEqual([]);
    expect(result.repairCounts).toStrictEqual(counted({}));
    // A clean spreadsheet export: CRLF records, LF inside quotes.
    const exported = parseDetailed('a,"x\ny"\r\nb,c', { delimiter: ',', repair: true });
    expect(exported.data).toStrictEqual([
      ['a', 'x\ny'],
      ['b', 'c'],
    ]);
    expect(exported.meta.linebreak).toBe('\r\n');
    expect(exported.repairs).toStrictEqual([]);
  });

  it('an unrepaired issue stays an error, and has a position only with positions: true', () => {
    const input = 'a,b\n1,2,x\n';
    const tooMany = {
      type: 'FieldMismatch',
      code: 'TooManyFields',
      message: 'Too many fields: expected 2 fields but parsed 3',
      row: 0,
    };
    const result = parseDetailed(input, { header: true, repair: true });
    expect(result.errors).toStrictEqual([tooMany]);
    expect(result.repairs?.map((entry) => entry.rule)).toStrictEqual(['trailing-empty-record']);
    // The log is never without a place.
    expect(result.repairs?.[0]).toMatchObject({ line: 2, column: 6, offset: 9, snippet: '1,2,x' });
    expect(
      parseDetailed(input, { header: true, repair: true, positions: true }).errors,
    ).toStrictEqual([{ ...tooMany, line: 2, column: 1, offset: 4, snippet: '1,2,x' }]);
  });

  it('logs positions in the input as given: a BOM, a sep= line and skipped lines count', () => {
    const result = parseDetailed('\ufeffsep=;\njunk\na;b;c\n1;2\n', {
      header: true,
      repair: true,
      sepLine: true,
      skipFirstNLines: 1,
    });
    expect(result.data).toStrictEqual([{ a: '1', b: '2', c: '' }]);
    expect(result.repairs).toStrictEqual([
      { ...padEntry, line: 4, offset: 18, snippet: '1;2', before: '1;2' },
      {
        rule: 'trailing-empty-record',
        row: -1,
        line: 4,
        column: 4,
        offset: 21,
        snippet: '1;2',
        length: 1,
        before: '\n',
        after: [],
      },
    ]);
    // On line 1 the BOM is in the column and in the snippet, as for an error.
    const first = parseDetailed('\ufeffa,"b\nc,d', { delimiter: ',', repair: true });
    expect(first.data).toStrictEqual([
      ['a', '"b'],
      ['c', 'd'],
    ]);
    expect(first.errors).toStrictEqual([]);
    expect(first.repairs).toStrictEqual([
      {
        rule: 'unclosed-quote',
        row: 0,
        line: 1,
        column: 2,
        offset: 1,
        snippet: '\ufeffa,"b',
        length: 4,
        before: 'a,"b',
        after: [['a', '"b']],
      },
    ]);
  });

  it('mixed-newline: applied with the newline it names when newline is omitted, never under a given newline', () => {
    const input = 'a,b\r\n1,2\n3,4\r\n';
    const result = parseDetailed(input, { delimiter: ',', repair: true });
    expect(result.meta.linebreak).toBe('\n');
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(result.repairs).toStrictEqual([
      {
        rule: 'mixed-newline',
        row: 0,
        line: 1,
        column: 1,
        offset: 0,
        snippet: 'a,b',
        length: 4,
        before: 'a,b\r',
        after: [['a', 'b']],
      },
      {
        rule: 'mixed-newline',
        row: 2,
        line: 3,
        column: 1,
        offset: 9,
        snippet: '3,4',
        length: 4,
        before: '3,4\r',
        after: [['3', '4']],
      },
      {
        rule: 'trailing-empty-record',
        row: -1,
        // The "\n" of the last "\r\n": the line after the "\r", which is empty.
        line: 4,
        column: 1,
        offset: 13,
        snippet: '',
        length: 1,
        before: '\n',
        after: [],
      },
    ]);
    expect(result.repairCounts).toStrictEqual(
      counted({ 'mixed-newline': 2, 'trailing-empty-record': 1 }),
    );
    const given = parseDetailed(input, { delimiter: ',', newline: '\n', repair: true });
    expect(given.data).toStrictEqual([
      ['a', 'b\r'],
      ['1', '2'],
      ['3', '4\r'],
    ]);
    expect(given.repairs?.map((entry) => entry.rule)).toStrictEqual(['trailing-empty-record']);
    expect(given.repairCounts?.['mixed-newline']).toBe(0);
    // One kind of line break: the rule is not applied, and a "\r" in a field stays.
    const one = parseDetailed('a,b\r1,2', { delimiter: ',', repair: ['mixed-newline'] });
    expect(one.meta.linebreak).toBe('\r');
    expect(one.repairs).toStrictEqual([]);
  });

  it('unclosed-quote: the line is read again, nothing is an error, and the rows after it are located', () => {
    const result = parseDetailed('a,"b\n1,2\n3,4', { delimiter: ',', repair: true });
    expect(result.data).toStrictEqual([
      ['a', '"b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(result.errors).toStrictEqual([]);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs?.[0]).toMatchObject({ rule: 'unclosed-quote', before: 'a,"b', row: 0 });
    expect(result.repairCounts).toStrictEqual(counted({ 'unclosed-quote': 1 }));

    // Records after the re-read line are scanned again from there: their errors keep their place.
    const located = parseDetailed('a,b\n"x\n1,2,3\n', {
      header: true,
      delimiter: ',',
      repair: ['unclosed-quote'],
      positions: true,
    });
    expect(located.data).toStrictEqual([
      { a: '"x' },
      { a: '1', b: '2', __parsed_extra: ['3'] },
      { a: '' },
    ]);
    expect(located.repairs).toStrictEqual([
      {
        rule: 'unclosed-quote',
        row: 0,
        line: 2,
        column: 1,
        offset: 4,
        snippet: '"x',
        length: 2,
        before: '"x',
        after: [['"x']],
      },
    ]);
    expect(
      located.errors.map((error) => ({
        code: error.code,
        row: 'row' in error ? error.row : undefined,
        line: error.line,
        column: error.column,
        offset: error.offset,
        snippet: error.snippet,
      })),
    ).toStrictEqual([
      { code: 'TooFewFields', row: 0, line: 2, column: 1, offset: 4, snippet: '"x' },
      { code: 'TooManyFields', row: 1, line: 3, column: 1, offset: 7, snippet: '1,2,3' },
      { code: 'TooFewFields', row: 2, line: 4, column: 1, offset: 13, snippet: '' },
    ]);
  });

  it('locates each piece of a record mixed-newline split where the piece starts', () => {
    const result = parseDetailed('a,b\n1,2\r3\n4\n5,6\r\n', {
      header: true,
      delimiter: ',',
      repair: ['mixed-newline'],
      positions: true,
    });
    expect(result.data).toStrictEqual([
      { a: '1', b: '2' },
      { a: '3' },
      { a: '4' },
      { a: '5', b: '6' },
      { a: '' },
    ]);
    expect(result.repairs).toStrictEqual([
      {
        rule: 'mixed-newline',
        row: 0,
        line: 2,
        column: 1,
        offset: 4,
        snippet: '1,2',
        length: 5,
        before: '1,2\r3',
        after: [['1', '2'], ['3']],
      },
      {
        rule: 'mixed-newline',
        row: 3,
        line: 5,
        column: 1,
        offset: 12,
        snippet: '5,6',
        length: 4,
        before: '5,6\r',
        after: [['5', '6']],
      },
    ]);
    const tooFew = (row: number) => ({
      type: 'FieldMismatch',
      code: 'TooFewFields',
      message: 'Too few fields: expected 2 fields but parsed 1',
      row,
    });
    expect(result.errors).toStrictEqual([
      // The second piece of the split record: after its "\r", not where the record starts.
      { ...tooFew(1), line: 3, column: 1, offset: 8, snippet: '3' },
      { ...tooFew(2), line: 4, column: 1, offset: 10, snippet: '4' },
      { ...tooFew(4), line: 6, column: 1, offset: 17, snippet: '' },
    ]);
    // Three pieces, each short: every one at its own start.
    const three = parseDetailed('a,b\n1\r2\r3\n4,5\r\n', {
      header: true,
      delimiter: ',',
      repair: ['mixed-newline', 'trailing-empty-record'],
      positions: true,
    });
    expect(three.errors.map((error) => [error.offset, error.line, error.snippet])).toStrictEqual([
      [4, 2, '1'],
      [6, 3, '2'],
      [8, 4, '3'],
    ]);
  });

  it('Repair.row of a split record is the first of its pieces that is a row: not the header record, not a piece skipEmptyLines removes', () => {
    const entryOf = (input: string, config: object) => {
      const result = parseDetailed(input, { delimiter: ',', repair: ['mixed-newline'], ...config });
      return {
        data: result.data,
        repairs: result.repairs?.map(({ row, offset, after }) => ({ row, offset, after })),
      };
    };
    // The first piece is the header record: row is the data row the second piece became.
    expect(entryOf('a,b\r1,2\n3,4\n', { header: true })).toStrictEqual({
      data: [{ a: '1', b: '2' }, { a: '3', b: '4' }, { a: '' }],
      repairs: [
        {
          row: 0,
          offset: 0,
          after: [
            ['a', 'b'],
            ['1', '2'],
          ],
        },
      ],
    });
    // The record is the header record and nothing else (its "\r" was removed): no row.
    expect(entryOf('a,b\r\n1,2\n3,4', { header: true }).repairs).toStrictEqual([
      { row: -1, offset: 0, after: [['a', 'b']] },
    ]);
    // The first piece is empty and skipEmptyLines removes it: row is the piece after it.
    expect(entryOf('p\n\r64\nq', { skipEmptyLines: true })).toStrictEqual({
      data: [['p'], ['64'], ['q']],
      repairs: [{ row: 1, offset: 2, after: [[''], ['64']] }],
    });
    // Without skipEmptyLines the empty piece is a row, and row names it.
    expect(entryOf('p\n\r64\nq', {})).toStrictEqual({
      data: [['p'], [''], ['64'], ['q']],
      repairs: [{ row: 1, offset: 2, after: [[''], ['64']] }],
    });
    // Every piece is removed: no row.
    expect(entryOf('p\n\r\r\nq\n', { skipEmptyLines: true }).repairs).toStrictEqual([
      { row: -1, offset: 2, after: [[''], ['']] },
    ]);
  });

  it('under preview the scan may stop before the end: the final record and an unclosed quote are left alone', () => {
    // The scan stopped after two records, so its last record is not the input's last.
    const stopped = parseDetailed('a\n\nb\n', { delimiter: ',', preview: 2, repair: true });
    const plain = parseDetailed('a\n\nb\n', { delimiter: ',', preview: 2 });
    expect(stopped.data).toStrictEqual(plain.data);
    expect(stopped.meta).toStrictEqual(plain.meta);
    expect(stopped.meta.truncated).toBe(true);
    expect(stopped.repairs).toStrictEqual([]);
    // Reading the line again would resume the scan past the limit.
    const quoted = parseDetailed('a,"b\n1\n2\n3', { delimiter: ',', preview: 2, repair: true });
    const unrepaired = parseDetailed('a,"b\n1\n2\n3', { delimiter: ',', preview: 2 });
    expect(quoted.data).toStrictEqual(unrepaired.data);
    expect(quoted.errors).toStrictEqual(unrepaired.errors);
    expect(quoted.errors.map((error) => error.code)).toStrictEqual(['MissingQuotes']);
    expect(quoted.repairs).toStrictEqual([]);
    // Without the limit it is repaired.
    expect(parseDetailed('a,"b\n1\n2\n3', { delimiter: ',', repair: true }).data).toHaveLength(4);
  });

  it('judges the header record by its transformed names, and calls transformHeader once per cell', () => {
    // Record 0 is empty once trimmed, so skipEmptyLines removes it and the next record is the header.
    const calls: unknown[][] = [];
    const config = {
      header: true,
      delimiter: ',',
      skipEmptyLines: true,
      transformHeader: (name: string, index: number) => {
        calls.push([name, index]);
        return name.trim();
      },
    } as const;
    const input = ' \na,b\n1\n';
    const result = parseDetailed(input, { ...config, repair: true });
    expect(calls).toStrictEqual([[' ', 0]]);
    expect(result.meta.fields).toStrictEqual(['a', 'b']);
    expect(result.data).toStrictEqual([{ a: '1', b: '' }]);
    expect(result.errors).toStrictEqual([]);
    expect(result.repairs?.map(({ rule, row, offset }) => ({ rule, row, offset }))).toStrictEqual([
      { rule: 'pad-missing', row: 0, offset: 6 },
      { rule: 'trailing-empty-record', row: -1, offset: 7 },
    ]);
    calls.length = 0;
    const plain = parseDetailed(input, config);
    expect(calls).toStrictEqual([[' ', 0]]);
    expect(plain.meta.fields).toStrictEqual(['a', 'b']);
  });

  it('for 1,500 seeded inputs, with and without header, skipEmptyLines and dynamicTyping: parsing the repaired text gives the same data', () => {
    const failures: string[] = [];
    const totals = counted({});
    const seen = { quoteErrors: 0, afterSplit: 0, afterReread: 0 };
    let typed = 0;
    const random = mulberry32(0x7e9a13);
    for (const make of cases(0x7e9a13, 1_500)) {
      const { text, dialect, header, skipEmptyLines } = make(ALL);
      const dynamicTyping = random() < 0.5;
      if (dynamicTyping) typed++;
      const config = {
        delimiter: dialect.delimiter,
        quoteChar: dialect.quoteChar,
        comments: dialect.comments,
        header,
        skipEmptyLines,
        dynamicTyping,
      };
      const result = parseDetailed(text, { ...config, repair: true, positions: true });
      const repairs = result.repairs ?? [];
      const newline = result.meta.linebreak;
      for (const rule of ALL) totals[rule] += result.repairCounts?.[rule] ?? 0;
      let fault = spanFault(text, repairs);
      if (newline !== dialect.newline) fault ??= 'newline';
      const again = parseDetailed(applyLog(text, repairs, { ...dialect, newline }), {
        ...config,
        newline,
      });
      if (JSON.stringify(again.data) !== JSON.stringify(result.data)) fault ??= 'data';
      // The errors describe the repaired rows: they are the errors of the repaired text, row
      // included. A record that unclosed-quote or a width rule rewrote is written back with
      // its quoting made regular, so the Quotes errors inside such a record are left out.
      const keyed = (errors: readonly object[], type: string) =>
        JSON.stringify(
          (errors as Array<{ type: string; code: string; row?: number }>)
            .filter((error) => error.type === type)
            .map((error) => [error.code, error.row]),
        );
      if (keyed(again.errors, 'FieldMismatch') !== keyed(result.errors, 'FieldMismatch')) {
        fault ??= 'FieldMismatch errors';
      }
      const rules = new Set(repairs.map((entry) => entry.rule));
      const rewritten = repairs.filter(
        (entry) => entry.rule !== 'mixed-newline' && entry.rule !== 'trailing-empty-record',
      );
      const kept = result.errors.filter((error) => {
        const at = error.offset ?? 0;
        return !rewritten.some((entry) => at >= entry.offset && at < entry.offset + entry.length);
      });
      const quotes = kept.filter((error) => error.type === 'Quotes');
      const split = repairs.find((entry) => entry.after.length > 1);
      seen.quoteErrors += quotes.length;
      if (split && quotes.some((error) => (error.offset ?? 0) > split.offset)) seen.afterSplit++;
      if (rules.has('unclosed-quote') && quotes.length > 0) seen.afterReread++;
      if (keyed(again.errors, 'Quotes') !== keyed(kept, 'Quotes')) fault ??= 'Quotes errors';
      if (fault !== undefined) {
        const got = [...rules, keyed(kept, 'Quotes'), keyed(again.errors, 'Quotes')];
        failures.push(JSON.stringify({ fault, got, text, config }));
      }
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    expect(typed).toBeGreaterThan(500);
    for (const rule of ALL) expect(totals[rule]).toBeGreaterThan(100);
    // Seen with this seed: 964 Quotes errors compared, 69 inputs with one after a split record
    // and 56 with one beside a re-read line.
    expect(seen.quoteErrors).toBeGreaterThan(500);
    expect(seen.afterSplit).toBeGreaterThan(40);
    expect(seen.afterReread).toBeGreaterThan(30);
  }, 60_000);

  it('under preview, data is what parse gives for the repaired text: a split record is cut at the limit', () => {
    // The scan read two records, the first of which became two rows.
    const c1 = parseDetailed('a,b\rc,d\n1,2\n3,4\n', { delimiter: ',', preview: 2, repair: true });
    expect(c1.data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(c1.data).toStrictEqual(
      parse('a,b\nc,d\n1,2\n3,4\n', { delimiter: ',', preview: 2 }).data,
    );
    expect(c1.meta.truncated).toBe(true);
    expect(c1.repairs?.map((entry) => [entry.rule, entry.after])).toStrictEqual([
      [
        'mixed-newline',
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
      ],
    ]);
    // The header record counts as parse counts it, so one row is returned.
    const c2 = parseDetailed('a,b\n1,2\r3,4\r5,6\n7,8\n', {
      delimiter: ',',
      header: true,
      preview: 1,
      repair: true,
    });
    expect(c2.data).toStrictEqual([{ a: '1', b: '2' }]);
    expect(c2.data).toStrictEqual(
      parse('a,b\n1,2\n3,4\n5,6\n7,8\n', { delimiter: ',', header: true, preview: 1 }).data,
    );
    expect(c2.meta.truncated).toBe(true);
    // Where preview counts lines, comment lines count: "#x" is line 0, so "b" on line 2 ends it.
    const lines = parseDetailed('#x\na\rb\nc\nd\n', {
      delimiter: ',',
      comments: true,
      preview: 2,
      repair: true,
    });
    expect(lines.data).toStrictEqual([['a'], ['b']]);
    expect(lines.data).toStrictEqual(
      parse('#x\na\nb\nc\nd\n', { delimiter: ',', comments: true, preview: 2 }).data,
    );
    // Each pair: the input, and the repaired text with the same preview through parse.
    const counted: Array<[string, string, number, unknown[][]]> = [
      // Two comment lines come first, so the first record is on line 2 and ends the parse.
      ['#x\n#y\na\rb\nc\n', '#x\n#y\na\nb\nc\n', 2, [['a']]],
      // No comment line before them: "c" is on line 2 and two rows were read already.
      ['a\rb\rc\n#x\nd', 'a\nb\nc\n#x\nd', 2, [['a'], ['b']]],
      // Two comment lines between the rows: "b" is on line 3 and is the last row.
      ['a\n#x\n#y\nb\rc\rd\n', 'a\n#x\n#y\nb\nc\nd\n', 3, [['a'], ['b']]],
      ['a\rb\n#x\nc\nd\n', 'a\nb\n#x\nc\nd\n', 3, [['a'], ['b'], ['c']]],
    ];
    for (const [input, repairedText, preview, rows] of counted) {
      const config = { delimiter: ',', comments: true, preview } as const;
      expect([input, parse(repairedText, config).data]).toStrictEqual([input, rows]);
      expect([input, parseDetailed(input, { ...config, repair: true }).data]).toStrictEqual([
        input,
        rows,
      ]);
    }
    // The log holds the whole change to a record that was read, also the pieces past the limit.
    const one = parseDetailed('a,b\rc,d\n', { delimiter: ',', preview: 1, repair: true });
    expect(one.data).toStrictEqual([['a', 'b']]);
    expect(one.repairs?.[0]?.after).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    // No split: nothing is cut that parse returns.
    const whole = parseDetailed('a\rb\nc\n', { delimiter: ',', preview: 5, repair: true });
    expect(whole.data).toStrictEqual([['a'], ['b'], ['c']]);
  });

  it('under preview, the final empty record is removed when the scan read it, whatever meta.truncated says', () => {
    // Lines count here, the comment line included; the scan reads to the end and reports
    // truncated, and its last record is the final empty one.
    const config = { delimiter: ',', comments: true, preview: 2 } as const;
    expect(parse('#c\na\n', config)).toMatchObject({
      data: [['a'], ['']],
      meta: { truncated: true },
    });
    const c4 = parseDetailed('#c\na\n', { ...config, repair: true });
    expect(c4.data).toStrictEqual([['a']]);
    expect(c4.data).toStrictEqual(parse('#c\na', config).data);
    expect(c4.repairs?.map((entry) => [entry.rule, entry.offset, entry.before])).toStrictEqual([
      ['trailing-empty-record', 4, '\n'],
    ]);
    // An empty record that is not the last of the input stays, also when the scan ends on it.
    for (const input of ['a\n\n', 'a\n\nb\n', '#c\na\n\n']) {
      const kept = parseDetailed(input, { ...config, repair: true });
      expect([input, kept.data]).toStrictEqual([input, parse(input, config).data]);
      expect([input, kept.repairs]).toStrictEqual([input, []]);
    }
  });

  it('for 3,000 seeded inputs with preview 1 to 3: data is what parse gives for the repaired text with the same config', () => {
    const failures: string[] = [];
    const seen = { compared: 0, cut: 0, lineCounted: 0, skipped: 0 };
    const random = mulberry32(0x7e9a14);
    for (const make of cases(0x7e9a14, 3_000)) {
      const { text, dialect, header, skipEmptyLines } = make(ALL);
      const config = {
        delimiter: dialect.delimiter,
        quoteChar: dialect.quoteChar,
        comments: dialect.comments,
        header,
        skipEmptyLines,
        preview: 1 + Math.floor(random() * 3),
      };
      const result = parseDetailed(text, { ...config, repair: true });
      const repairs = result.repairs ?? [];
      const newline = result.meta.linebreak;
      const repairedText = applyLog(text, repairs, { ...dialect, newline });
      // Without a quote in the text preview counts lines; the test's writer may add the first.
      if (text.includes(dialect.quoteChar) !== repairedText.includes(dialect.quoteChar)) {
        seen.skipped++;
        continue;
      }
      seen.compared++;
      if (!text.includes(dialect.quoteChar)) seen.lineCounted++;
      const again = parse(repairedText, { ...config, newline });
      const rows = repairs.reduce((sum, entry) => sum + Math.max(entry.after.length - 1, 0), 0);
      if (rows > 0) seen.cut++;
      if (JSON.stringify(again.data) !== JSON.stringify(result.data)) {
        failures.push(JSON.stringify({ text, config, got: result.data, want: again.data }));
      }
      if (failures.length > 5) break;
    }
    expect(failures).toEqual([]);
    // Seen with this seed: 2,992 compared (8 skipped), 591 of them with a split record, 106
    // where preview counts lines.
    expect(seen.compared).toBeGreaterThan(2_900);
    expect(seen.cut).toBeGreaterThan(400);
    expect(seen.lineCounted).toBeGreaterThan(60);
  }, 60_000);

  it('re-bases the row of an error the scan raised after a record that was split', () => {
    const rowsOf = (input: string) =>
      parseDetailed(input, { delimiter: ',', repair: true, positions: true }).errors.map(
        (error) => [error.code, 'row' in error ? error.row : -1, error.line, error.offset],
      );
    // Rows a,b / c,d / 1,x"y,2: the error is in row 2, where the scan counted one record less.
    expect(rowsOf('a,b\rc,d\n1,"x"y",2\n')).toStrictEqual([['InvalidQuotes', 2, 3, 10]]);
    expect(rowsOf('a\rb\rc\n"x"y"\n')).toStrictEqual([['InvalidQuotes', 3, 4, 6]]);
    expect(rowsOf('a\rb\nc\rd\n"x"y"\n"p"q"\n')).toStrictEqual([
      ['InvalidQuotes', 4, 5, 8],
      ['InvalidQuotes', 5, 6, 14],
    ]);
    // An error before the split keeps its row.
    const before = parseDetailed('p\r\nq\n"x"y"\na\rb\n', { delimiter: ',', repair: true });
    expect(before.data).toStrictEqual([['p'], ['q'], ['x"y'], ['a'], ['b']]);
    expect(before.errors.map((error) => ('row' in error ? error.row : -1))).toStrictEqual([2]);
    // With header: Quotes.row counts the records, the header record included, as in parse.
    const header = parseDetailed('h\n1\r2\r3\n"x"y"\n', {
      delimiter: ',',
      header: true,
      repair: true,
    });
    expect(header.data).toStrictEqual([{ h: '1' }, { h: '2' }, { h: '3' }, { h: 'x"y' }]);
    expect(header.errors.map((error) => ('row' in error ? error.row : -1))).toStrictEqual([4]);
    // Errors of a quoted field that closes late, after a split.
    expect(rowsOf('a\rb\n"open\n"x"y"\nz')).toStrictEqual([
      ['InvalidQuotes', 2, 3, 4],
      ['InvalidQuotes', 2, 3, 4],
    ]);
  });
});
