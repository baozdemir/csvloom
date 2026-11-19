import Papa from 'papaparse';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Characterization of the pinned reference (Papa Parse 5.7.1) for every row of
// the compatibility matrix (docs/compatibility.md). These assertions describe what the reference
// does, including quirks; where csvloom differs, docs/compatibility.md lists the exception.
// docs/compatibility.md links each matrix row to its describe block (R01...).

const UNDETECTABLE = {
  type: 'Delimiter',
  code: 'UndetectableDelimiter',
  message: "Unable to auto-detect delimiting character; defaulted to ','",
};

// @types/papaparse declares renamedHeaders optional; the reference always sets it, often to null.
function meta(overrides: Record<string, unknown> = {}) {
  return {
    delimiter: ',',
    linebreak: '\n',
    aborted: false,
    truncated: false,
    cursor: 0,
    renamedHeaders: null,
    ...overrides,
  };
}

const parse = (input: string, config: Papa.ParseConfig<unknown> = {}) =>
  Papa.parse<unknown>(input, config);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R01 parse(string, config) result', () => {
  it('returns data, errors and meta synchronously', () => {
    expect(parse('a,b\n1,2')).toStrictEqual({
      data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      errors: [],
      meta: meta({ cursor: 7 }),
    });
  });

  it('empty input yields no rows and an UndetectableDelimiter error', () => {
    expect(parse('')).toStrictEqual({ data: [], errors: [UNDETECTABLE], meta: meta() });
  });

  it('a trailing newline yields a final [""] row and can defeat delimiter detection', () => {
    expect(parse('a,b\n1,2\n')).toStrictEqual({
      data: [['a', 'b'], ['1', '2'], ['']],
      errors: [UNDETECTABLE],
      meta: meta({ cursor: 8 }),
    });
  });

  it('strips a leading BOM from the input', () => {
    expect(parse('﻿a,b\n1,2').data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty and trailing empty fields', () => {
    expect(parse(',,\n,').data).toStrictEqual([
      ['', '', ''],
      ['', ''],
    ]);
  });

  it('non-string, non-stream input throws an internal TypeError', () => {
    expect(() => {
      // @ts-expect-error -- probing the reference with an invalid input type
      Papa.parse(123);
    }).toThrow(TypeError);
  });

  it('writes normalized options back into the caller config object', () => {
    const config: Papa.ParseConfig<unknown> = {};
    parse('a,b', config);
    expect(config).toStrictEqual({ dynamicTyping: false, transform: false });
  });
});

describe('R02 delimiter', () => {
  it.each([
    [';', 'a;b\n1;2', 7],
    ['\t', 'a\tb\n1\t2', 7],
    ['::', 'a::b\n1::2', 9],
  ])('explicit %j', (delimiter, input, cursor) => {
    expect(parse(input, { delimiter })).toStrictEqual({
      data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      errors: [],
      meta: meta({ delimiter, cursor }),
    });
  });

  it('multi-character delimiter inside quotes is data', () => {
    expect(parse('a::"b::c"\n1::2', { delimiter: '::' }).data).toStrictEqual([
      ['a', 'b::c'],
      ['1', '2'],
    ]);
  });

  it('function delimiter receives the whole input and its result is reported', () => {
    const seen: string[] = [];
    const result = parse('a;b\n1;2', {
      delimiter: (input: string) => {
        seen.push(input);
        return ';';
      },
    });
    expect(seen).toStrictEqual(['a;b\n1;2']);
    expect(result.meta.delimiter).toBe(';');
  });

  it.each([
    ['a;b;c\n1;2;3', ';'],
    ['a\tb\n1\t2', '\t'],
    ['a|b\n1|2', '|'],
  ])('auto-detects %j', (input, delimiter) => {
    const result = parse(input);
    expect(result.meta.delimiter).toBe(delimiter);
    expect(result.errors).toStrictEqual([]);
  });

  it('empty-string delimiter means auto-detect', () => {
    expect(parse('a;b\n1;2', { delimiter: '' }).meta.delimiter).toBe(';');
  });

  it('undetectable delimiter falls back to comma with an error', () => {
    expect(parse('abc\ndef')).toStrictEqual({
      data: [['abc'], ['def']],
      errors: [UNDETECTABLE],
      meta: meta({ cursor: 7 }),
    });
  });

  it.each([['"'], ['\n']])('invalid delimiter %j silently becomes comma', (delimiter) => {
    const result = parse('a,b\nc,d', { delimiter });
    expect(result.meta.delimiter).toBe(',');
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('function returning an invalid delimiter silently becomes comma', () => {
    expect(parse('a,b', { delimiter: () => '\n' }).meta.delimiter).toBe(',');
  });

  it('ties between consistent delimiters go to the higher field count, then list order', () => {
    expect(parse('a,b;c\nd,e;f').meta.delimiter).toBe(',');
  });

  it('detection ignores delimiters inside quotes', () => {
    expect(parse('"a;x",b\n"c;y",d').meta.delimiter).toBe(',');
  });
});

describe('R03 delimitersToGuess and newline', () => {
  it('guesses only from the supplied list', () => {
    expect(parse('a~b\nc~d', { delimitersToGuess: ['|', '~'] }).meta.delimiter).toBe('~');
    expect(parse('a,b\nc,d', { delimitersToGuess: ['|', '~'] }).errors).toStrictEqual([
      UNDETECTABLE,
    ]);
  });

  it.each([
    ['a,b\r\nc,d', '\r\n'],
    ['a,b\rc,d', '\r'],
    ['a,b\nc,d', '\n'],
  ])('auto-detects the line ending of %j', (input, linebreak) => {
    const result = parse(input);
    expect(result.meta.linebreak).toBe(linebreak);
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('with mixed endings, the other ending stays inside unquoted fields', () => {
    const result = parse('a\r\nb\nc\r\nd');
    expect(result.meta.linebreak).toBe('\r\n');
    expect(result.data).toStrictEqual([['a'], ['b\nc'], ['d']]);
  });

  it('detection ignores line breaks inside quotes', () => {
    const result = parse('"x\ny",b\r\nc,d');
    expect(result.meta.linebreak).toBe('\r\n');
    expect(result.data).toStrictEqual([
      ['x\ny', 'b'],
      ['c', 'd'],
    ]);
  });

  it('an invalid newline option silently becomes \\n', () => {
    // @ts-expect-error -- probing the reference with an invalid newline value
    expect(parse('a,b\nc,d', { newline: 'x' }).meta.linebreak).toBe('\n');
  });
});

describe('R04 quoteChar and escapeChar', () => {
  it('handles delimiters, doubled quotes and newlines inside quotes', () => {
    expect(parse('a,"b,c","d""e"\n"f\ng",h').data).toStrictEqual([
      ['a', 'b,c', 'd"e'],
      ['f\ng', 'h'],
    ]);
  });

  it('custom quoteChar', () => {
    expect(parse("a,'b,c'", { quoteChar: "'" }).data).toStrictEqual([['a', 'b,c']]);
  });

  it('empty or multi-character quoteChar disables quoting without an error', () => {
    expect(parse('a,"b,c"', { quoteChar: '' }).data).toStrictEqual([['a', '"b', 'c"']]);
    expect(parse("a,''b,c''", { quoteChar: "''" }).data).toStrictEqual([['a', "''b", "c''"]]);
  });

  it('custom escapeChar replaces quote doubling', () => {
    expect(parse('a,"b\\"c",d', { escapeChar: '\\' }).data).toStrictEqual([['a', 'b"c', 'd']]);
    expect(parse('a,"b""c",d', { escapeChar: '\\' })).toStrictEqual({
      data: [['a', 'b""c', 'd']],
      errors: [
        {
          type: 'Quotes',
          code: 'InvalidQuotes',
          message: 'Trailing quote on quoted field is malformed',
          row: 0,
          index: 3,
        },
      ],
      meta: meta({ cursor: 10 }),
    });
  });

  it('missing closing quote keeps the rest of the input in the field', () => {
    expect(parse('a,"b,c\nd,e')).toStrictEqual({
      data: [['a', 'b,c\nd,e']],
      errors: [
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 0,
          index: 3,
        },
      ],
      meta: meta({ cursor: 10 }),
    });
  });

  it('text after a closing quote reports InvalidQuotes and merges following rows', () => {
    const result = parse('a,"b"x,c\nd,e,f');
    expect(result.data).toStrictEqual([['a', 'b"x,c\nd,e,f']]);
    expect(result.errors.map((e) => e.code)).toStrictEqual(['InvalidQuotes', 'MissingQuotes']);
  });

  it('spaces between a closing quote and the delimiter are dropped', () => {
    expect(parse('a,"b"  ,c').data).toStrictEqual([['a', 'b', 'c']]);
  });

  it('a quote inside an unquoted field is data', () => {
    expect(parse('a,b"c,d').data).toStrictEqual([['a', 'b"c', 'd']]);
  });
});

describe('R05 header and transformHeader', () => {
  it('returns objects and meta.fields', () => {
    expect(parse('a,b\n1,2\n3,4', { header: true })).toStrictEqual({
      data: [
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ],
      errors: [],
      meta: meta({ cursor: 11, fields: ['a', 'b'] }),
    });
  });

  it('header-only input yields no rows', () => {
    const result = parse('a,b', { header: true });
    expect(result.data).toStrictEqual([]);
    expect(result.meta.fields).toStrictEqual(['a', 'b']);
  });

  it('renames duplicates around existing names and warns on the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = parse('a,a,a_1,a\n1,2,3,4', { header: true });
    expect(result.meta.fields).toStrictEqual(['a', 'a_2', 'a_1', 'a_3']);
    expect(result.meta.renamedHeaders).toStrictEqual({ a_2: 'a', a_3: 'a' });
    expect(Object.keys(result.data[0] as object)).toStrictEqual(['a', 'a_2', 'a_1', 'a_3']);
    expect(warn).toHaveBeenCalledWith('Duplicate headers found and renamed.');
  });

  it('transformHeader gets (header, index) and collisions after it are renamed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      parse(' a , b \n1,2', { header: true, transformHeader: (h, i) => `${h.trim()}${String(i)}` })
        .meta.fields,
    ).toStrictEqual(['a0', 'b1']);
    const collided = parse('A,a\n1,2', { header: true, transformHeader: (h) => h.toLowerCase() });
    expect(collided.meta.fields).toStrictEqual(['a', 'a_1']);
    expect(collided.meta.renamedHeaders).toStrictEqual({ a_1: 'a' });
  });

  it('extra fields go to __parsed_extra; missing fields are absent; both are errors', () => {
    expect(parse('a,b\n1,2,3,4\n5', { header: true })).toStrictEqual({
      data: [{ a: '1', b: '2', __parsed_extra: ['3', '4'] }, { a: '5' }],
      errors: [
        {
          type: 'FieldMismatch',
          code: 'TooManyFields',
          message: 'Too many fields: expected 2 fields but parsed 4',
          row: 0,
        },
        {
          type: 'FieldMismatch',
          code: 'TooFewFields',
          message: 'Too few fields: expected 2 fields but parsed 1',
          row: 1,
        },
      ],
      meta: meta({ cursor: 13, fields: ['a', 'b'] }),
    });
  });

  it('quote-error rows count the header line; field-mismatch rows do not', () => {
    const result = parse('h1,h2\n1,2\n"3,4', { header: true, delimiter: ',' });
    expect(result.errors.map((e) => [e.code, e.row])).toStrictEqual([
      ['MissingQuotes', 2],
      ['TooFewFields', 1],
    ]);
  });

  it('a trailing newline adds a short row error when the delimiter is auto-detected', () => {
    expect(parse('a,b\n1,2\n', { header: true }).errors.map((e) => e.code)).toStrictEqual([
      'UndetectableDelimiter',
      'TooFewFields',
    ]);
  });

  it('a __proto__ column is silently dropped from rows without polluting prototypes', () => {
    const result = parse('__proto__,constructor,prototype\nx,y,z', { header: true });
    expect(result.meta.fields).toStrictEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.keys(result.data[0] as object)).toStrictEqual(['constructor', 'prototype']);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('dynamicTyping: true skips columns named like Boolean.prototype members', () => {
    const result = parse('constructor,toString,valueOf,b\n1,2,3,4', {
      header: true,
      dynamicTyping: true,
    });
    expect(result.data).toStrictEqual([{ constructor: '1', toString: '2', valueOf: '3', b: 4 }]);
  });
});

describe('R06 dynamicTyping', () => {
  const typed = (value: string): unknown =>
    (parse(`"${value}"`, { dynamicTyping: true, delimiter: '|' }).data as unknown[][])[0]?.[0];

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['1', 1],
    ['1.5', 1.5],
    ['007', 7],
    [' 5 ', 5],
    ['1e3', 1000],
    ['.5', 0.5],
    ['5.', 5],
    ['-.5', -0.5],
    ['9007199254740991', 9007199254740991],
    ['', null],
  ])('converts %j', (input, expected) => {
    expect(typed(input)).toStrictEqual(expected);
  });

  it('converts "-0" to negative zero', () => {
    expect(Object.is(typed('-0'), -0)).toBe(true);
  });

  it.each([
    'True',
    '+5',
    '9007199254740992',
    '-9007199254740992',
    '1e400',
    'NaN',
    'Infinity',
    '0x10',
    '1_000',
    'null',
    '2020-01-02',
  ])('keeps %j as a string', (input) => {
    expect(typed(input)).toBe(input);
  });

  it('converts ISO date-times with a zone to Date', () => {
    expect(typed('2020-01-02T03:04:05.123+03:00')).toStrictEqual(
      new Date('2020-01-02T00:04:05.123Z'),
    );
    expect(typed('2020-01-02T03:04Z')).toStrictEqual(new Date('2020-01-02T03:04:00.000Z'));
  });

  it('field map is keyed by header name or column index', () => {
    expect(parse('a,b\n1,2', { header: true, dynamicTyping: { b: true } }).data).toStrictEqual([
      { a: '1', b: 2 },
    ]);
    expect(parse('1,2', { dynamicTyping: { 1: true } }).data).toStrictEqual([['1', 2]]);
  });

  it('function is called once per field and receives the name or index', () => {
    const calls: unknown[] = [];
    const result = parse('a,b\n1,2\n3,4', {
      header: true,
      dynamicTyping: (field) => {
        calls.push(field);
        return field === 'a';
      },
    });
    expect(calls).toStrictEqual(['a', 'b']);
    expect(result.data).toStrictEqual([
      { a: 1, b: '2' },
      { a: 3, b: '4' },
    ]);
  });

  it('does not type the header row', () => {
    expect(parse('1,2\n3,4', { header: true, dynamicTyping: true }).meta.fields).toStrictEqual([
      '1',
      '2',
    ]);
  });

  it('replaces a function in the caller config with a cache object', () => {
    const config: Papa.ParseConfig<unknown> = { dynamicTyping: () => true };
    parse('1,2', config);
    expect(typeof config.dynamicTyping).toBe('object');
    expect(Object.keys(config)).toStrictEqual([
      'dynamicTyping',
      'dynamicTypingFunction',
      'transform',
    ]);
  });
});

describe('R07 transform', () => {
  it('is called row-major with (value, column index) before typing', () => {
    const calls: unknown[] = [];
    const result = parse('a,b\n1,2', {
      transform: (value, field) => {
        calls.push([value, field]);
        return `${value}!`;
      },
    });
    expect(calls).toStrictEqual([
      ['a', 0],
      ['b', 1],
      ['1', 0],
      ['2', 1],
    ]);
    expect(result.data).toStrictEqual([
      ['a!', 'b!'],
      ['1!', '2!'],
    ]);
    expect(parse('1,2', { dynamicTyping: true, transform: (v) => `${v}0` }).data).toStrictEqual([
      [10, 20],
    ]);
  });

  it('with headers receives the field name, __parsed_extra for extras, and skips the header row', () => {
    const calls: unknown[] = [];
    parse('a,b\n1,2,3', {
      header: true,
      transform: (value, field) => {
        calls.push([value, field]);
        return value;
      },
    });
    expect(calls).toStrictEqual([
      ['1', 'a'],
      ['2', 'b'],
      ['3', '__parsed_extra'],
    ]);
  });

  it('a thrown error propagates out of parse', () => {
    expect(() =>
      parse('a,b', {
        transform: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow('boom');
  });

  it('non-string return values are kept as is', () => {
    expect(parse('a,b', { transform: () => 5 }).data).toStrictEqual([[5, 5]]);
  });
});

describe('R08 comments and skipEmptyLines', () => {
  it('skips comment lines in fast and quoted paths', () => {
    expect(parse('#c\na,b\n#d\nc,d', { comments: '#' }).data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parse('#c\n"a",b\n#d', { comments: '#' }).data).toStrictEqual([['a', 'b']]);
    // @ts-expect-error -- the reference accepts comments: true as '#'
    expect(parse('#c\na,b', { comments: true }).data).toStrictEqual([['a', 'b']]);
    expect(parse('//c\na,b', { comments: '//' }).data).toStrictEqual([['a', 'b']]);
  });

  it('comment markers inside quotes or after the line start are data', () => {
    expect(parse('"#x",b\n#c', { comments: '#' }).data).toStrictEqual([['#x', 'b']]);
    expect(parse('a,#b\n #c', { comments: '#', delimiter: ',' }).data).toStrictEqual([
      ['a', '#b'],
      [' #c'],
    ]);
  });

  it('a comment marker equal to the delimiter throws', () => {
    expect(() => parse('a,b', { comments: ',' })).toThrow('Comment character same as delimiter');
  });

  it('skipEmptyLines: true removes only rows with one empty field', () => {
    expect(
      parse('a\n\n \n,\nb\n""\n', { skipEmptyLines: true, delimiter: ',' }).data,
    ).toStrictEqual([['a'], [' '], ['', ''], ['b']]);
  });

  it('skipEmptyLines: "greedy" also removes whitespace-only rows', () => {
    expect(
      parse('a\n\n \n,\n \t, \n" "\nb\n', { skipEmptyLines: 'greedy', delimiter: ',' }).data,
    ).toStrictEqual([['a'], ['b']]);
  });
});

describe('R09 preview and skipFirstNLines', () => {
  it('preview limits rows and sets truncated', () => {
    expect(parse('a\nb\nc\nd', { preview: 2, delimiter: ',' })).toStrictEqual({
      data: [['a'], ['b']],
      errors: [],
      meta: meta({ truncated: true, cursor: 6 }),
    });
    expect(parse('a\nb\nc\nd', { preview: 4, delimiter: ',' }).meta.truncated).toBe(false);
  });

  it('preview does not count the header row', () => {
    expect(parse('h\na\nb\nc', { header: true, preview: 2, delimiter: ',' }).data).toStrictEqual([
      { h: 'a' },
      { h: 'b' },
    ]);
  });

  it('preview counts comment lines in the fast path but not in the quoted path', () => {
    const config = { comments: '#', preview: 2, delimiter: ',' };
    expect(parse('#x\n#y\na\nb\nc', config).data).toStrictEqual([['a']]);
    expect(parse('#x\n#y\n"a"\nb\nc', config).data).toStrictEqual([['a'], ['b']]);
  });

  it('preview counts blank lines before skipEmptyLines removes them', () => {
    expect(
      parse('a\n\nb\nc', { preview: 2, skipEmptyLines: true, delimiter: ',' }).data,
    ).toStrictEqual([['a']]);
  });

  it('skipFirstNLines drops raw lines before parsing, including before the header', () => {
    expect(parse('x\na,b\n1,2', { skipFirstNLines: 1 }).data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parse('x\ny\na,b\n1,2', { skipFirstNLines: 2, header: true }).data).toStrictEqual([
      { a: '1', b: '2' },
    ]);
  });

  it('skipFirstNLines is not quote-aware and splits a quoted multiline field', () => {
    expect(parse('"x\ny",z\na,b', { skipFirstNLines: 1 }).data).toStrictEqual([
      ['y"', 'z'],
      ['a', 'b'],
    ]);
  });

  it('meta.cursor is relative to the input after skipped lines', () => {
    expect(parse('xxxx\na,b', { skipFirstNLines: 1 }).meta.cursor).toBe(3);
  });
});

describe('R10 fastMode', () => {
  it('auto mode switches on the presence of any quote character', () => {
    expect(parse('a,b\nc,"d,e"').data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd,e'],
    ]);
  });

  it('fastMode: true keeps quotes as literal characters', () => {
    expect(parse('a,"b,c"', { fastMode: true }).data).toStrictEqual([['a', '"b', 'c"']]);
  });

  it('fastMode: false gives the same rows for unquoted input', () => {
    expect(parse('a,b\nc,d', { fastMode: false })).toStrictEqual(parse('a,b\nc,d'));
  });
});

describe('R12 unparse inputs', () => {
  it('arrays of arrays, objects and {fields, data}', () => {
    expect(
      Papa.unparse([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe('a,b\r\n1,2');
    expect(
      Papa.unparse([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]),
    ).toBe('a,b\r\n1,2\r\n3,4');
    expect(Papa.unparse({ fields: ['x', 'y'], data: [[1, 2]] })).toBe('x,y\r\n1,2');
    expect(Papa.unparse({ fields: ['b'], data: [{ a: 1, b: 2 }] })).toBe('b\r\n2');
    expect(Papa.unparse([])).toBe('');
  });

  it('object columns come from the first object only', () => {
    expect(Papa.unparse([{ a: 1 }, { a: 2, b: 3 }])).toBe('a\r\n1\r\n2');
    expect(Papa.unparse([{ a: 1, b: 2 }, { b: 3 }])).toBe('a,b\r\n1,2\r\n,3');
  });

  it('serializes non-string values', () => {
    expect(
      Papa.unparse([
        [null, undefined, true, 1.5, -0, NaN, new Date(0), new Date(NaN), { x: 1 }, [1, 2]],
      ]),
    ).toBe(',,true,1.5,0,NaN,1970-01-01T00:00:00.000Z,,[object Object],"1,2"');
  });

  it('quotes delimiters, quotes, line breaks, BOM and edge spaces', () => {
    expect(Papa.unparse([['a,b', 'c"d', 'e\nf', ' g', 'h ', 'i\rj', '﻿k']])).toBe(
      '"a,b","c""d","e\nf"," g","h ","i\rj","﻿k"',
    );
  });

  it('mutates the {data, fields} input object', () => {
    const input = { data: [1, 2] };
    // @ts-expect-error -- probing {data} without fields, which the reference accepts
    Papa.unparse(input);
    expect(input).toStrictEqual({ data: [[1, 2]], fields: [] });
  });

  it('throws on unrecognized input', () => {
    // @ts-expect-error -- probing the reference with an invalid input type
    expect(() => Papa.unparse(5)).toThrow('Unable to serialize unrecognized input');
  });
});

describe('R13 unparse options', () => {
  it('quotes: boolean, per-column array and function', () => {
    expect(Papa.unparse([['a', 1]], { quotes: true })).toBe('"a","1"');
    expect(Papa.unparse([['a', 'b']], { quotes: [false, true] })).toBe('a,"b"');
    expect(Papa.unparse([['a', 'b']], { quotes: (_value, col) => col === 0 })).toBe('"a",b');
  });

  it('quoteChar, escapeChar and delimiter', () => {
    expect(Papa.unparse([['a,b']], { quoteChar: "'" })).toBe("'a,b'");
    expect(Papa.unparse([['a"b']], { escapeChar: '\\' })).toBe('"a\\"b"');
    expect(Papa.unparse([['a', 'b']], { delimiter: ';' })).toBe('a;b');
    expect(Papa.unparse([['a', 'b']], { delimiter: '::' })).toBe('a::b');
    expect(Papa.unparse([['a', 'b']], { delimiter: '\n' })).toBe('a,b');
  });

  it('header, newline and columns', () => {
    expect(Papa.unparse([{ a: 1 }], { header: false })).toBe('1');
    expect(Papa.unparse([['a'], ['b']], { newline: '\n' })).toBe('a\nb');
    expect(Papa.unparse([{ a: 1, b: 2, c: 3 }], { columns: ['c', 'a'] })).toBe('c,a\r\n3,1');
    expect(() => Papa.unparse([{ a: 1 }], { columns: [] })).toThrow('Option columns is empty');
  });

  it('skipEmptyLines', () => {
    expect(Papa.unparse([['a'], [''], [], ['b']], { skipEmptyLines: true })).toBe('a\r\nb');
    expect(Papa.unparse([['a'], [' ', ''], ['b']], { skipEmptyLines: 'greedy' })).toBe('a\r\nb');
    expect(Papa.unparse([{ a: 1 }, {}, { a: 2 }], { skipEmptyLines: true })).toBe('a\r\n1\r\n2');
  });

  it('escapeFormulae prefixes risky strings but not numbers', () => {
    expect(
      Papa.unparse([['=1+1', '+1', '-1', '@x', '\tx', '\rx', -1, 'a=b']], { escapeFormulae: true }),
    ).toBe('"\'=1+1","\'+1","\'-1","\'@x","\'\tx","\'\rx",-1,a=b');
    expect(Papa.unparse([['!x', '=y']], { escapeFormulae: /^!/ })).toBe('"\'!x",=y');
  });

  it('escapeFormulae does not prefix a risky string that contains a line break', () => {
    expect(Papa.unparse([['=1\n2', '=HYPERLINK("x")\n']], { escapeFormulae: true })).toBe(
      '"=1\n2","=HYPERLINK(""x"")\n"',
    );
  });
});
