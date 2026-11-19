import Papa from 'papaparse';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseDetailed } from '../src/detailed.ts';
import papaEntry, { parse as papaEntryParse } from '../src/papa.ts';
import { parse } from '../src/parse.ts';
import type { PapaParseConfig, PapaUnparseConfig, UnparseConfig } from '../src/types.ts';
import { excel, excelSemicolon, unparse } from '../src/unparse.ts';

// The Excel options. Reading: the "sep=" line of parseDetailed. Writing: bom, sepLine and the
// presets of unparse.

describe('sep= line: read', () => {
  it('skips the line, uses its delimiter and reports meta.sepLine', () => {
    const result = parseDetailed('sep=;\na;b\n1;2', { sepLine: true });
    expect(result).toStrictEqual({
      data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      errors: [],
      meta: {
        delimiter: ';',
        linebreak: '\n',
        aborted: false,
        truncated: false,
        cursor: 7,
        renamedHeaders: null,
        sepLine: true,
      },
    });
    expect(Object.keys(result.meta).at(-1)).toBe('sepLine');
    expect(parseDetailed('sep=\t\na\tb\n1\t2', { sepLine: true, header: true })).toMatchObject({
      data: [{ a: '1', b: '2' }],
      meta: { delimiter: '\t', fields: ['a', 'b'] },
    });
  });

  it('names a delimiter the guess would not find, and no UndetectableDelimiter is reported', () => {
    // One column, and "^" is no candidate of the guess.
    expect(parseDetailed('sep=^\na\n1', { sepLine: true })).toMatchObject({
      data: [['a'], ['1']],
      errors: [],
      meta: { delimiter: '^', sepLine: true },
    });
    expect(parseDetailed('sep=^\na^b\n1^2', { sepLine: true }).data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('an explicit delimiter wins over the line, which is skipped either way', () => {
    const result = parseDetailed('sep=;\na;b,c\n1;2,3', { sepLine: true, delimiter: ',' });
    expect(result.data).toStrictEqual([
      ['a;b', 'c'],
      ['1;2', '3'],
    ]);
    expect(result.meta.delimiter).toBe(',');
    expect(result.meta.sepLine).toBe(true);
    // A delimiter function is explicit too, and is called with the text after the line.
    const texts: string[] = [];
    const byFunction = parseDetailed('sep=;\na;b|c', {
      sepLine: true,
      delimiter: (text) => {
        texts.push(text);
        return '|';
      },
    });
    expect(texts).toStrictEqual(['a;b|c']);
    expect(byFunction.data).toStrictEqual([['a;b', 'c']]);
    // '' means detect, as an omitted delimiter does: the line decides.
    expect(parseDetailed('sep=;\na;b', { sepLine: true, delimiter: '' }).meta.delimiter).toBe(';');
  });

  it('ends at "\\r\\n", "\\n" or "\\r", or at the end of the text; a BOM may come first', () => {
    const rows = [
      ['a', 'b'],
      ['1', '2'],
    ];
    const crlf = parseDetailed('\ufeffsep=;\r\na;b\r\n1;2', { sepLine: true });
    expect(crlf.data).toStrictEqual(rows);
    expect(crlf.meta).toMatchObject({ delimiter: ';', linebreak: '\r\n', sepLine: true });
    const cr = parseDetailed('sep=;\ra;b\r1;2', { sepLine: true });
    expect(cr.data).toStrictEqual(rows);
    expect(cr.meta).toMatchObject({ linebreak: '\r', sepLine: true });
    expect(parseDetailed('sep=;', { sepLine: true })).toStrictEqual({
      data: [],
      errors: [],
      meta: {
        delimiter: ';',
        linebreak: '\n',
        aborted: false,
        truncated: false,
        cursor: 0,
        renamedHeaders: null,
        sepLine: true,
      },
    });
    // With a given newline the first line ends there: "sep=;\r" is no sep= line under "\n".
    const given = parseDetailed('sep=;\r\na;b', { sepLine: true, newline: '\n' });
    expect(given.meta).not.toHaveProperty('sepLine');
    expect(given.data[0]).toStrictEqual(['sep=', '\r']);
    expect(parseDetailed('sep=;\r\na;b', { sepLine: true, newline: '\r\n' }).data).toStrictEqual([
      ['a', 'b'],
    ]);
  });

  it('is read before skipFirstNLines counts its lines', () => {
    const result = parseDetailed('sep=;\njunk\na;b', { sepLine: true, skipFirstNLines: 1 });
    expect(result.data).toStrictEqual([['a', 'b']]);
    expect(result.meta.sepLine).toBe(true);
  });

  it.each([
    ['no unit after "sep="', 'sep=\na;b\n1;2'],
    ['two units', 'sep=ab\na;b\n1;2'],
    ['a quote, which is no delimiter', 'sep="\na;b\n1;2'],
    ['U+FEFF, which is no delimiter', 'sep=\ufeff\na;b\n1;2'],
    ['a line break as the unit', 'sep=\n\na;b\n1;2'],
    ['other text before it', ' sep=;\na;b\n1;2'],
    ['another case', 'SEP=;\na;b\n1;2'],
    ['not the first line', 'a;b\nsep=;\n1;2'],
    ['text after the unit', 'sep=; \na;b\n1;2'],
  ])('a first line with %s is data, and meta has no sepLine', (_name, input) => {
    const result = parseDetailed(input, { sepLine: true });
    expect(result.meta).not.toHaveProperty('sepLine');
    expect(result).toStrictEqual(parse(input));
  });

  it('throws when the line names the comment marker, as a given delimiter would', () => {
    expect(() => parseDetailed('sep=#\na#b', { sepLine: true, comments: '#' })).toThrow(
      new Error('Comment character same as delimiter'),
    );
  });

  it('meta.cursor and Quotes.index count from the text that is scanned, after the line (D2-h); offset counts the line', () => {
    const input = 'sep=;\na;b\n"x';
    const scanned = parse('a;b\n"x', { delimiter: ';' });
    const result = parseDetailed(input, { sepLine: true });
    expect(result.meta.cursor).toBe(6);
    expect(result.errors).toStrictEqual([
      {
        type: 'Quotes',
        code: 'MissingQuotes',
        message: 'Quoted field unterminated',
        row: 1,
        index: 5,
      },
    ]);
    expect(result.errors).toStrictEqual(scanned.errors);
    expect(result.data).toStrictEqual(scanned.data);
    expect(result.meta).toStrictEqual({ ...scanned.meta, sepLine: true });
    const located = parseDetailed(input, { sepLine: true, positions: true });
    expect(located.meta).toStrictEqual(result.meta);
    expect(located.errors).toStrictEqual([
      { ...scanned.errors[0], line: 3, column: 1, offset: 10, snippet: '"x' },
    ]);
  });
});

describe('without sepLine the line is data, in both entries (R)', () => {
  const inputs = ['sep=;\na;b\n1;2', '\ufeffsep=,\r\na,b\r\n1,2\r\n', 'sep=;'];

  it.each(inputs)('%j', (input) => {
    const reference = Papa.parse(input);
    for (const result of [
      parse(input),
      parseDetailed(input),
      parseDetailed(input, { sepLine: false }),
      parseDetailed(input, { positions: true }),
      papaEntryParse(input),
      papaEntryParse(input, { sepLine: true } as PapaParseConfig),
    ]) {
      expect(result).toStrictEqual(reference);
      expect(result.meta).not.toHaveProperty('sepLine');
    }
    expect((reference.data as string[][])[0]?.[0]).toMatch(/^sep=/);
  });
});

const ROWS = [
  ['a', 'b'],
  ['1', '2'],
];

describe('bom', () => {
  it('writes U+FEFF before everything else', () => {
    expect(unparse(ROWS, { bom: true })).toBe('\ufeffa,b\r\n1,2');
    expect(unparse([{ a: '1' }], { bom: true })).toBe('\ufeffa\r\n1');
    expect(unparse([], { bom: true })).toBe('\ufeff');
  });

  it('false and undefined write nothing', () => {
    // undefined means omitted at run time; UnparseConfig does not declare it.
    for (const bom of [false, undefined]) {
      expect(unparse(ROWS, { bom } as UnparseConfig)).toBe('a,b\r\n1,2');
    }
  });

  it('parse strips what unparse wrote', () => {
    const text = unparse(ROWS, { bom: true });
    const result = parse(text);
    expect(result.data).toStrictEqual(ROWS);
    expect(result.data.flat().some((field) => field.includes('\ufeff'))).toBe(false);
    expect(parse(text, { header: true }).meta.fields).toStrictEqual(['a', 'b']);
  });
});

describe('sep= line: write', () => {
  it('writes "sep=", the delimiter and the newline first', () => {
    expect(unparse(ROWS, { sepLine: true, delimiter: ';' })).toBe('sep=;\r\na;b\r\n1;2');
    expect(unparse(ROWS, { sepLine: true })).toBe('sep=,\r\na,b\r\n1,2');
    expect(unparse(ROWS, { sepLine: true, delimiter: '\t', newline: '\n' })).toBe(
      'sep=\t\na\tb\n1\t2',
    );
    for (const sepLine of [false, undefined]) {
      expect(unparse(ROWS, { sepLine } as UnparseConfig)).toBe('a,b\r\n1,2');
    }
  });

  it('comes first with header: false and with an array of objects or {fields, data}', () => {
    const objects = [{ a: '1', b: '2' }];
    expect(unparse(objects, { sepLine: true })).toBe('sep=,\r\na,b\r\n1,2');
    expect(unparse(objects, { sepLine: true, header: false })).toBe('sep=,\r\n1,2');
    expect(unparse(ROWS, { sepLine: true, header: false })).toBe('sep=,\r\na,b\r\n1,2');
    expect(unparse({ fields: ['a', 'b'], data: [['1', '2']] }, { sepLine: true })).toBe(
      'sep=,\r\na,b\r\n1,2',
    );
  });

  it('with bom, the BOM comes first', () => {
    expect(unparse(ROWS, { bom: true, sepLine: true })).toBe('\ufeffsep=,\r\na,b\r\n1,2');
  });

  it('is written for no records too, and reads back as no rows', () => {
    expect(unparse([], { sepLine: true })).toBe('sep=,\r\n');
    expect(unparse([], { bom: true, sepLine: true })).toBe('\ufeffsep=,\r\n');
    expect(parseDetailed('\ufeffsep=,\r\n', { sepLine: true })).toMatchObject({
      data: [],
      errors: [],
      meta: { delimiter: ',', sepLine: true },
    });
  });

  it('uses newline as given, "" included', () => {
    expect(unparse(ROWS, { sepLine: true, newline: '' })).toBe('sep=,a,b1,2');
  });

  it('needs a delimiter of one UTF-16 code unit', () => {
    for (const delimiter of ['::', '\u{1f600}']) {
      const call = () => unparse(ROWS, { sepLine: true, delimiter });
      expect(call).toThrow(TypeError);
      expect(call).toThrow('Unparse option "sepLine" needs a delimiter of one UTF-16 code unit');
      expect(unparse(ROWS, { delimiter })).toBe(`a${delimiter}b\r\n1${delimiter}2`);
    }
  });
});

// The round-trip fixture, with the reason for each value. The round trips show that csvloom
// reads back what it wrote for these values; they say nothing about what Excel displays.
const FIXTURE: ReadonlyArray<readonly [value: string, readBack: string, reason: string]> = [
  ['a,b', 'a,b', 'holds ",", the delimiter of excel'],
  ['a;b', 'a;b', 'holds ";", the delimiter of excelSemicolon'],
  ['say "hi"', 'say "hi"', 'holds a quote'],
  ['line 1\nline 2', 'line 1\nline 2', 'holds a line break'],
  ['İzmir ılık', 'İzmir ılık', 'Turkish dotted capital I and dotless i'],
  ['東京都', '東京都', 'CJK'],
  ['007', '007', 'a leading-zero string stays text'],
  ['=1+1', "'=1+1", 'formula-like: escapeFormulae writes it with "\'", which comes back'],
];
const TABLE = [['id', 'text'], ...FIXTURE.map(([value], i) => [String(i), value])];
const READ_BACK = [['id', 'text'], ...FIXTURE.map(([, back], i) => [String(i), back])];

describe('preset values', () => {
  it('are the exact objects, frozen', () => {
    expect(excel).toStrictEqual({
      bom: true,
      newline: '\r\n',
      delimiter: ',',
      escapeFormulae: true,
    });
    expect(excelSemicolon).toStrictEqual({
      bom: true,
      newline: '\r\n',
      delimiter: ';',
      escapeFormulae: true,
    });
    expect(Object.isFrozen(excel)).toBe(true);
    expect(Object.isFrozen(excelSemicolon)).toBe(true);
    expectTypeOf(excel).toEqualTypeOf<{
      readonly bom: true;
      readonly newline: '\r\n';
      readonly delimiter: ',';
      readonly escapeFormulae: true;
    }>();
    expectTypeOf(excelSemicolon).toEqualTypeOf<{
      readonly bom: true;
      readonly newline: '\r\n';
      readonly delimiter: ';';
      readonly escapeFormulae: true;
    }>();
    expectTypeOf(excel).toExtend<UnparseConfig>();
    expectTypeOf(excelSemicolon).toExtend<UnparseConfig>();
  });

  it('spread into a config', () => {
    expect(unparse([{ a: '1', b: '2' }], { ...excel, columns: ['a'] })).toBe('\ufeffa\r\n1');
    expect(unparse(ROWS, { ...excelSemicolon, sepLine: true })).toBe('\ufeffsep=;\r\na;b\r\n1;2');
  });

  it('write the fixture as these exact strings', () => {
    expect(unparse(TABLE, excel)).toBe(
      '\ufeffid,text\r\n0,"a,b"\r\n1,a;b\r\n2,"say ""hi"""\r\n3,"line 1\nline 2"\r\n' +
        '4,İzmir ılık\r\n5,東京都\r\n6,007\r\n7,"\'=1+1"',
    );
    expect(unparse(TABLE, excelSemicolon)).toBe(
      '\ufeffid;text\r\n0;a,b\r\n1;"a;b"\r\n2;"say ""hi"""\r\n3;"line 1\nline 2"\r\n' +
        '4;İzmir ılık\r\n5;東京都\r\n6;007\r\n7;"\'=1+1"',
    );
  });
});

describe('preset round trip', () => {
  it('excel: parseDetailed with sepLine and plain parse read the fixture back', () => {
    const text = unparse(TABLE, excel);
    const detailed = parseDetailed(text, { sepLine: true });
    expect(detailed.data).toStrictEqual(READ_BACK);
    expect(detailed.errors).toStrictEqual([]);
    expect(detailed.meta.delimiter).toBe(',');
    expect(detailed.meta).not.toHaveProperty('sepLine');
    expect(parse(text).data).toStrictEqual(READ_BACK);
  });

  it('excelSemicolon: the delimiter guess finds ";"', () => {
    const text = unparse(TABLE, excelSemicolon);
    const detailed = parseDetailed(text, { sepLine: true });
    expect(detailed.data).toStrictEqual(READ_BACK);
    expect(detailed.errors).toStrictEqual([]);
    expect(detailed.meta.delimiter).toBe(';');
    expect(parse(text).data).toStrictEqual(READ_BACK);
  });
});

describe('round trip through sepLine', () => {
  it('parseDetailed reads the line unparse wrote, with and without the BOM', () => {
    for (const config of [
      { sepLine: true, delimiter: ';' },
      { sepLine: true, delimiter: '|' },
      { ...excelSemicolon, sepLine: true },
    ]) {
      const result = parseDetailed(unparse(TABLE, config), { sepLine: true });
      expect(result.data).toStrictEqual(READ_BACK);
      expect(result.errors).toStrictEqual([]);
      expect(result.meta).toMatchObject({ delimiter: config.delimiter, sepLine: true });
    }
  });
});

describe('csvloom/papa ignores bom and sepLine', () => {
  it('(R) writes what it writes without them, as Papa Parse 5.7.1 does', () => {
    const config = { bom: true, sepLine: true } as PapaUnparseConfig;
    const expected =
      'id,text\r\n0,"a,b"\r\n1,a;b\r\n2,"say ""hi"""\r\n3,"line 1\nline 2"\r\n' +
      '4,İzmir ılık\r\n5,東京都\r\n6,007\r\n7,=1+1';
    expect(papaEntry.unparse(TABLE, config)).toBe(expected);
    expect(papaEntry.unparse(TABLE)).toBe(expected);
    expect(Papa.unparse(structuredClone(TABLE), config as Papa.UnparseConfig)).toBe(expected);
  });
});
