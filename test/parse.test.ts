import Papa from 'papaparse';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { UnsupportedFeatureError } from '../src/options.ts';
import papaEntry from '../src/papa.ts';
import { parse } from '../src/parse.ts';
import type { HeaderRow, ParseConfig, ParseError } from '../src/types.ts';
import { difference, papaConfig } from './differential.ts';

// Direct tests for parse (src/parse.ts). Expected values are written out by hand; agreement with
// Papa Parse 5.7.1 is checked separately in test/compatibility.test.ts. Tests marked (R) take
// their values from Papa Parse's source and also assert them for the live reference.

const LF = { delimiter: ',', newline: '\n' } as const satisfies ParseConfig;
const rows = (
  input: string,
  config: Omit<ParseConfig, 'header' | 'dynamicTyping' | 'transform'> = LF,
) => parse(input, config).data;
const withReference = (input: string, config: ParseConfig) => [
  parse(input, config),
  Papa.parse<unknown>(input, papaConfig(config)),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('records and fields', () => {
  it.each([
    ['empty input', '', []],
    ['one field', 'a', [['a']]],
    ['empty fields', 'a,,c', [['a', '', 'c']]],
    ['trailing delimiter', 'a,b,', [['a', 'b', '']]],
    ['only a delimiter', ',', [['', '']]],
    ['final record without a line break', 'a\nb', [['a'], ['b']]],
    ['a final line break adds one [""] record (D2-e)', 'a,b\n', [['a', 'b'], ['']]],
    ['blank lines stay records', 'a\n\n\nb', [['a'], [''], [''], ['b']]],
    ['only a line break', '\n', [[''], ['']]],
    ['whitespace is data', ' a ,\tb\t', [[' a ', '\tb\t']]],
  ])('%s', (_name, input, expected) => {
    expect(rows(input)).toStrictEqual(expected);
  });

  it.each([',', ';', '\t'] as const)('splits on the explicit delimiter %j only', (delimiter) => {
    const others = [',', ';', '\t'].filter((d) => d !== delimiter).join('');
    const input = `a${delimiter}b${others}c\n1${delimiter}2`;
    expect(rows(input, { delimiter, newline: '\n' })).toStrictEqual([
      ['a', `b${others}c`],
      ['1', '2'],
    ]);
  });

  it.each([
    ['\n', 'a,b\nc,d\r\ne\rf'],
    ['\r\n', 'a,b\r\nc,d\ne\rf'],
    ['\r', 'a,b\rc,d\ne\r\nf'],
  ] as const)(
    'ends records only at the explicit newline %j; other line breaks are data',
    (newline, input) => {
      const result = rows(input, { delimiter: ',', newline });
      expect(result.flat().join('')).toBe(input.replaceAll(newline, '').replaceAll(',', ''));
      expect(result).toHaveLength(input.split(newline).length);
    },
  );

  it('handles the same records under LF, CRLF and CR', () => {
    for (const newline of ['\n', '\r\n', '\r'] as const) {
      const input = ['h1,h2', 'a,"b', 'c"', '', 'd,'].join(newline);
      expect(rows(input, { delimiter: ',', newline })).toStrictEqual([
        ['h1', 'h2'],
        ['a', `b${newline}c`],
        [''],
        ['d', ''],
      ]);
    }
  });
});

describe('quoted fields', () => {
  it.each([
    ['embedded delimiter', 'a,"b,c"', [['a', 'b,c']]],
    ['doubled quotes', '"a""b",""""', [['a"b', '"']]],
    ['empty quoted field', '"",""', [['', '']]],
    ['embedded LF', '"a\nb",c', [['a\nb', 'c']]],
    ['embedded CRLF and CR', '"a\r\nb\rc"', [['a\r\nb\rc']]],
    ['quoted field before a line break', '"a"\n"b"', [['a'], ['b']]],
    ['quoted field at the end of input', 'x,"a"', [['x', 'a']]],
    ['unquoted fields around a quoted one', 'a,"b,c",d,e', [['a', 'b,c', 'd', 'e']]],
    ['delimiter at the end of input after a quoted field', '"a",b,', [['a', 'b', '']]],
    ['quoted fields inside unquoted runs', 'a,b,"c",d,"e",f', [['a', 'b', 'c', 'd', 'e', 'f']]],
    ['a quote inside an unquoted run', 'a,b"c,d,"e",f', [['a', 'b"c', 'd', 'e', 'f']]],
    ['quoted blank record is kept', 'a\n""\nb', [['a'], [''], ['b']]],
    ['a quote inside an unquoted field is data', 'a"b,c"', [['a"b', 'c"']]],
    ['long field', `"${'x,"" '.repeat(5000)}"`, [['x," '.repeat(5000)]]],
  ])('%s', (_name, input, expected) => {
    const result = parse(input, LF);
    expect(result.data).toStrictEqual(expected);
    expect(result.errors).toStrictEqual([]);
  });

  // The field that starts at the end of the input, after a quote was passed.
  it.each([
    ['after a line break', '"a",b\n', [['a', 'b'], ['']]],
    ['after a delimiter', '"a",b,', [['a', 'b', '']]],
    ['after a quoted field and a line break', 'x\n"a"\n', [['x'], ['a'], ['']]],
    ['after a quote inside an unquoted field', 'a"b\n', [['a"b'], ['']]],
  ])('an empty last field %s', (_name, input, expected) => {
    for (let i = 0; i < 3; i++) {
      const result = parse(input, LF);
      expect(result.data).toStrictEqual(expected);
      expect(result.errors).toStrictEqual([]);
    }
  });

  it('drops whitespace between a closing quote and the delimiter or line break', () => {
    expect(rows('"a"  ,"b"\t\n"c" ')).toStrictEqual([['a', 'b'], ['c" ']]);
  });
});

describe('malformed quoting', () => {
  it('keeps the unterminated rest of the input as one raw field with MissingQuotes', () => {
    const result = parse('a,b\nc,"d""e\nf,g', LF);
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd""e\nf,g'],
    ]);
    expect(result.errors).toStrictEqual([
      {
        type: 'Quotes',
        code: 'MissingQuotes',
        message: 'Quoted field unterminated',
        row: 1,
        index: 7,
      },
    ]);
  });

  it('reports text after a closing quote as InvalidQuotes and keeps the field open', () => {
    const result = parse('"a"b,c\nd,"e"', LF);
    expect(result.data).toStrictEqual([['a"b,c\nd,"e']]);
    expect(result.errors).toStrictEqual([
      {
        type: 'Quotes',
        code: 'InvalidQuotes',
        message: 'Trailing quote on quoted field is malformed',
        row: 0,
        index: 1,
      },
      {
        type: 'Quotes',
        code: 'InvalidQuotes',
        message: 'Trailing quote on quoted field is malformed',
        row: 0,
        index: 1,
      },
    ]);
  });

  it('keeps doubled quotes raw in an unterminated field, before and after an invalid quote', () => {
    const result = parse('"a""b"c""d', LF);
    expect(result.data).toStrictEqual([['a""b"c""d']]);
    expect(result.errors).toMatchObject([
      { code: 'InvalidQuotes', row: 0, index: 1 },
      { code: 'MissingQuotes', row: 0, index: 1 },
    ]);
  });

  it('counts the header record in quote-error rows (D2-f)', () => {
    const result = parse('h\n"x', { ...LF, header: true });
    expect(result.errors).toMatchObject([{ code: 'MissingQuotes', row: 1, index: 3 }]);
  });

  // A quadratic scan would need far longer than the timeout at this size.
  it('takes linear time on long runs of malformed quotes', { timeout: 5000 }, () => {
    const n = 400_000;
    for (const input of ['"a' + '"b'.repeat(n), '"a' + '"b'.repeat(n) + ' '.repeat(n) + ',']) {
      const result = parse(input, LF);
      expect(result.data).toStrictEqual([[input.slice(1)]]);
      expect(result.errors.filter((e) => e.code === 'InvalidQuotes')).toHaveLength(n);
      expect(result.errors.at(-1)).toMatchObject({ code: 'MissingQuotes', row: 0, index: 1 });
    }
  });

  it('treats exactly the characters String.prototype.trim removes as whitespace after a quote', () => {
    for (let code = 0; code <= 0xffff; code++) {
      const char = String.fromCharCode(code);
      expect([code, /^\s$/.test(char)]).toStrictEqual([code, char.trim() === '']);
    }
    expect(rows('"a"\u00a0\u3000,b')).toStrictEqual([['a', 'b']]);
  }, 60_000);
});

describe('dialect options', () => {
  const invalidQuotes = (index: number) => ({
    type: 'Quotes',
    code: 'InvalidQuotes',
    message: 'Trailing quote on quoted field is malformed',
    row: 0,
    index,
  });

  it('opens quoted fields with quoteChar', () => {
    expect(parse("a,'b,c'", { ...LF, quoteChar: "'" }).data).toStrictEqual([['a', 'b,c']]);
  });

  it('keeps a quote after escapeChar as data', () => {
    expect(parse('a,"b\\"c",d', { ...LF, escapeChar: '\\' }).data).toStrictEqual([
      ['a', 'b"c', 'd'],
    ]);
  });

  it('keeps doubled quotes raw and malformed when escapeChar differs from quoteChar', () => {
    const result = parse('a,"b""c",d', { ...LF, escapeChar: '\\' });
    expect(result.data).toStrictEqual([['a', 'b""c', 'd']]);
    expect(result.errors).toStrictEqual([invalidQuotes(3)]);
  });

  it('(R) gives an escaped escape character no special meaning', () => {
    for (const result of withReference('"a\\\\",b', { ...LF, escapeChar: '\\' })) {
      expect(result.data).toStrictEqual([['a\\\\",b']]);
      expect(result.errors).toStrictEqual([
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 0,
          index: 1,
        },
      ]);
    }
  });

  it('(R) closes a quote at the end of the input before checking escapeChar', () => {
    for (const result of withReference('"a\\"', { ...LF, escapeChar: '\\' })) {
      expect(result.data).toStrictEqual([['a\\']]);
    }
  });

  it.each([
    [
      'a::"b::c"\n1::2',
      [
        ['a', 'b::c'],
        ['1', '2'],
      ],
    ],
    ['a:::b', [['a', ':b']]],
    ['"a"  ::b', [['a', 'b']]],
  ])('(R) splits on a multi-character delimiter: %j', (input, expected) => {
    for (const result of withReference(input, { delimiter: '::', newline: '\n' })) {
      expect(result.data).toStrictEqual(expected);
    }
  });

  it.each(['|', '\x1e'])('splits on the delimiter %j', (d) => {
    expect(rows(`a${d}"b${d}c"${d}d,e\n1${d}2`, { delimiter: d, newline: '\n' })).toStrictEqual([
      ['a', `b${d}c`, 'd,e'],
      ['1', '2'],
    ]);
  });
});

describe('comments and empty lines', () => {
  it.each([
    [
      '#c\na,b\n#d\nc,d',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['#c\n"a",b\n#d', [['a', 'b']]],
    ['"#x",b\n#c', [['#x', 'b']]],
    ['a,#b\n #c', [['a', '#b'], [' #c']]],
  ])('skips a comment line only at a record start outside quotes: %j', (input, expected) => {
    expect(rows(input, { ...LF, comments: '#' })).toStrictEqual(expected);
  });

  it('reads comments: true as "#" and matches a multi-character marker', () => {
    const input = '#x\n//y\na';
    expect(rows(input, { ...LF, comments: true })).toStrictEqual([['//y'], ['a']]);
    expect(rows(input, { ...LF, comments: '//' })).toStrictEqual([['#x'], ['a']]);
  });

  it('(R) ends the parse at a final comment line, with the cursor after the last record', () => {
    for (const result of withReference('a\n#c', { ...LF, comments: '#' })) {
      expect(result.data).toStrictEqual([['a']]);
      expect(result.meta.cursor).toBe(2);
    }
  });

  it('removes records that are one empty field with skipEmptyLines: true', () => {
    expect(rows('a\n\n \n,\nb\n""\n', { ...LF, skipEmptyLines: true })).toStrictEqual([
      ['a'],
      [' '],
      ['', ''],
      ['b'],
    ]);
  });

  it("also removes records of whitespace and empty fields with skipEmptyLines: 'greedy'", () => {
    expect(rows('a\n\n \n,\n \t, \n" "\nb\n', { ...LF, skipEmptyLines: 'greedy' })).toStrictEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('(R) counts a removed empty record in quote-error rows', () => {
    for (const result of withReference('a\n\n"b', { ...LF, skipEmptyLines: true })) {
      expect(result.data).toStrictEqual([['a'], ['b']]);
      expect(result.errors).toStrictEqual([
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 2,
          index: 4,
        },
      ]);
    }
  });

  it('rejects a comment marker equal to the delimiter', () => {
    expect(() => parse('a,b', { ...LF, comments: ',' })).toThrow(
      'Comment character same as delimiter',
    );
  });

  it('(R) compares comments with the delimiter before true becomes "#"', () => {
    const [engine, reference] = withReference('a#b\n#c\nd', {
      delimiter: '#',
      newline: '\n',
      comments: true,
    });
    expect(engine).toStrictEqual(reference);
    expect(engine?.data).toStrictEqual([['a', 'b'], ['d']]);
  });

  it('(R) opens a quoted field where the comment marker starts with the quote character', () => {
    for (const result of withReference("x\n'c,d'\ny", { ...LF, quoteChar: "'", comments: "'" })) {
      expect(result.data).toStrictEqual([['x'], ['c,d'], ['y']]);
    }
  });

  it('(R) takes the fields from the first record left after record 0 is removed', () => {
    for (const result of withReference('\na,a\n1,2', {
      ...LF,
      header: true,
      skipEmptyLines: true,
    })) {
      expect(result).toStrictEqual({
        data: [{ a: '2' }],
        errors: [],
        meta: {
          delimiter: ',',
          linebreak: '\n',
          aborted: false,
          truncated: false,
          cursor: 8,
          renamedHeaders: null,
          fields: ['a', 'a'],
        },
      });
    }
  });

  it("(R) takes the fields after a whitespace record 0 with skipEmptyLines: 'greedy'", () => {
    const config = { ...LF, header: true, skipEmptyLines: 'greedy' } as const;
    for (const result of withReference(' \na,b\n1,2', config)) {
      expect(result.meta.fields).toStrictEqual(['a', 'b']);
      expect(result.data).toStrictEqual([{ a: '1', b: '2' }]);
    }
  });

  it('rejects comments and skipEmptyLines values outside their types', () => {
    const calls: Array<[string, () => unknown]> = [
      // @ts-expect-error -- not a boolean or a string
      ['comments', () => parse('a', { ...LF, comments: 5 })],
      // @ts-expect-error -- not a boolean or a string
      ['comments', () => parse('a', { ...LF, comments: null })],
      // Papa.BAD_DELIMITERS, which Papa reads as no comments.
      ['comments', () => parse('a', { ...LF, comments: '"' })],
      ['comments', () => parse('a', { ...LF, comments: '﻿' })],
      // P3-c: a marker containing a line break.
      ['comments', () => parse('a', { ...LF, comments: '#\n' })],
      // @ts-expect-error -- not a boolean or 'greedy'
      ['skipEmptyLines', () => parse('a', { ...LF, skipEmptyLines: 'yes' })],
    ];
    for (const [option, call] of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${option}"`);
    }
  });
});

describe('preview, skipFirstNLines and fastMode', () => {
  it('stops after preview records and reports truncated', () => {
    expect(parse('a\nb\nc\nd', { ...LF, preview: 2 })).toStrictEqual({
      data: [['a'], ['b']],
      errors: [],
      meta: {
        delimiter: ',',
        linebreak: '\n',
        aborted: false,
        truncated: true,
        cursor: 6,
        renamedHeaders: null,
      },
    });
    expect(parse('a\nb\nc\nd', { ...LF, preview: 4 }).meta.truncated).toBe(false);
  });

  it('does not count the header record in preview', () => {
    expect(parse('h\na\nb\nc', { ...LF, header: true, preview: 2 }).data).toStrictEqual([
      { h: 'a' },
      { h: 'b' },
    ]);
  });

  it.each([
    ['#x\n#y\na\nb\nc', { comments: '#' }, [['a']]],
    ['#x\n#y\n"a"\nb\nc', { comments: '#' }, [['a'], ['b']]],
    ['a\n\nb\nc', { skipEmptyLines: true }, [['a']]],
  ] as const)(
    'counts comment lines in preview only without quotes, and blank lines before skipEmptyLines (D2-g): %j',
    (input, options, expected) => {
      expect(rows(input, { ...LF, ...options, preview: 2 })).toStrictEqual(expected);
    },
  );

  it('skips raw lines before parsing, not quote-aware, and rebases the cursor (D2-h)', () => {
    const skip1 = { ...LF, skipFirstNLines: 1 };
    expect(rows('x\na,b\n1,2', skip1)).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parse('x\ny\na,b\n1,2', { ...LF, header: true, skipFirstNLines: 2 }).data).toStrictEqual(
      [{ a: '1', b: '2' }],
    );
    expect(rows('"x\ny",z\na,b', skip1)).toStrictEqual([
      ['y"', 'z'],
      ['a', 'b'],
    ]);
    expect(parse('xxxx\na,b', skip1).meta.cursor).toBe(3);
  });

  it.each([
    ['a\nb\nc', true, 5],
    ['"a"\nb\nc', true, 6],
    ['a\nb', false, 3],
    ['"a"\nb\n', true, 6],
    ['a\nb\n', true, 4],
  ] as const)(
    '(R) counts preview by lines without quotes and by records ending in a line break with them: %j',
    (input, truncated, cursor) => {
      for (const result of withReference(input, { ...LF, preview: 2 })) {
        expect(result.data).toStrictEqual([['a'], ['b']]);
        expect(result.meta.truncated).toBe(truncated);
        expect(result.meta.cursor).toBe(cursor);
      }
    },
  );

  it('keeps quotes literal with fastMode: true; fastMode: false changes nothing on unquoted input', () => {
    expect(rows('a,"b,c"', { ...LF, fastMode: true })).toStrictEqual([['a', '"b', 'c"']]);
    expect(parse('a,b\nc,d', { ...LF, fastMode: false })).toStrictEqual(parse('a,b\nc,d', LF));
  });

  it('(R) lets a quote after 100,000 lines decide how preview counts comment lines', () => {
    const head = '#c\n#d\na\nb\n' + 'x\n'.repeat(100_000);
    const config = { ...LF, comments: '#', preview: 2 };
    for (const result of withReference(head + '"q"', config)) {
      expect(result.data).toStrictEqual([['a'], ['b']]);
      expect(result.meta.truncated).toBe(true);
      expect(result.meta.cursor).toBe(10);
    }
    for (const result of withReference(head, config)) {
      expect(result.data).toStrictEqual([['a']]);
      expect(result.meta.truncated).toBe(true);
      expect(result.meta.cursor).toBe(8);
    }
  });

  it('rejects preview, skipFirstNLines and fastMode values outside their types', () => {
    const calls: Array<[string, () => unknown]> = [
      // P3-b: Papa's two paths disagree on a negative preview.
      ['preview', () => parse('a', { ...LF, preview: -1 })],
      ['preview', () => parse('a', { ...LF, preview: 1.5 })],
      // @ts-expect-error -- not a number
      ['preview', () => parse('a', { ...LF, preview: '2' })],
      ['skipFirstNLines', () => parse('a', { ...LF, skipFirstNLines: -1 })],
      // @ts-expect-error -- not a boolean
      ['fastMode', () => parse('a', { ...LF, fastMode: 'yes' })],
    ];
    for (const [option, call] of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${option}"`);
    }
  });

  it('(R) a preview reached before comment lines that run to the end is not truncated', () => {
    // Papa's split path reads the comment line, then finds no more lines.
    for (const result of withReference('a\n#c', { ...LF, comments: '#', preview: 1 })) {
      expect(result.data).toStrictEqual([['a']]);
      expect(result.meta.truncated).toBe(false);
      expect(result.meta.cursor).toBe(2);
    }
  });
});

describe('newline and delimiter detection', () => {
  const UNDETECTABLE = {
    type: 'Delimiter',
    code: 'UndetectableDelimiter',
    message: "Unable to auto-detect delimiting character; defaulted to ','",
  } as const;
  const meta = (overrides: object = {}) => ({
    delimiter: ',',
    linebreak: '\n',
    aborted: false,
    truncated: false,
    cursor: 0,
    renamedHeaders: null,
    ...overrides,
  });
  const recorder = (result: string) => {
    const calls: string[] = [];
    const delimiter = (text: string) => {
      calls.push(text);
      return result;
    };
    return { calls, delimiter };
  };

  it('reports UndetectableDelimiter for empty input and when a final line break defeats detection', () => {
    expect(parse('', {})).toStrictEqual({ data: [], errors: [UNDETECTABLE], meta: meta() });
    expect(parse('a,b\n1,2\n', {})).toStrictEqual({
      data: [['a', 'b'], ['1', '2'], ['']],
      errors: [UNDETECTABLE],
      meta: meta({ cursor: 8 }),
    });
  });

  it.each([
    ['a;b;c\n1;2;3', ';'],
    ['a\tb\n1\t2', '\t'],
    ['a|b\n1|2', '|'],
  ])('detects the delimiter of %j', (input, delimiter) => {
    const result = parse(input, {});
    expect(result.data).toStrictEqual(input.split('\n').map((line) => line.split(delimiter)));
    expect(result.errors).toStrictEqual([]);
    expect(result.meta.delimiter).toBe(delimiter);
  });

  it("reads '' as automatic for delimiter and newline", () => {
    expect(parse('a;b\n1;2', { delimiter: '' }).meta.delimiter).toBe(';');
    expect(parse('a;b\r\n1;2', { newline: '' }).meta).toStrictEqual(
      meta({ delimiter: ';', linebreak: '\r\n', cursor: 8 }),
    );
  });

  it('falls back to "," with UndetectableDelimiter on single-column input', () => {
    expect(parse('abc\ndef', {})).toStrictEqual({
      data: [['abc'], ['def']],
      errors: [UNDETECTABLE],
      meta: meta({ cursor: 7 }),
    });
  });

  it('calls a function delimiter once with the text and reports its result', () => {
    const { calls, delimiter } = recorder(';');
    const result = parse('a;b\n1;2', { delimiter });
    expect(calls).toStrictEqual(['a;b\n1;2']);
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(result.meta.delimiter).toBe(';');
  });

  it('(R) breaks ties by the higher average field count, then by list order, and ignores quoted text', () => {
    for (const [input, delimiter] of [
      ['a,b;c\nd,e;f', ','],
      ['a,b|c|d\ne,f|g|h', '|'],
      ['"a;x",b\n"c;y",d', ','],
    ] as const) {
      for (const result of withReference(input, {})) expect(result.meta.delimiter).toBe(delimiter);
    }
  });

  it('guesses only from delimitersToGuess', () => {
    expect(parse('a~b\nc~d', { delimitersToGuess: ['|', '~'] }).meta.delimiter).toBe('~');
    expect(parse('a,b\nc,d', { delimitersToGuess: ['|', '~'] }).errors).toStrictEqual([
      UNDETECTABLE,
    ]);
  });

  it.each([
    ['a,b\r\nc,d', '\r\n'],
    ['a,b\rc,d', '\r'],
    ['a,b\nc,d', '\n'],
  ])('detects the line break of %j', (input, linebreak) => {
    const result = parse(input, {});
    expect(result.meta.linebreak).toBe(linebreak);
    expect(result.data).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('(R) keeps the other line break inside unquoted fields when endings are mixed', () => {
    for (const result of withReference('a\r\nb\nc\r\nd', {})) {
      expect(result).toStrictEqual({
        data: [['a'], ['b\nc'], ['d']],
        errors: [UNDETECTABLE],
        meta: meta({ linebreak: '\r\n', cursor: 9 }),
      });
    }
    for (const result of withReference('"x\ny",b\r\nc,d', {})) {
      expect(result.meta.linebreak).toBe('\r\n');
    }
  });

  it('(R) calls the function delimiter with the text after the BOM and skipFirstNLines', () => {
    const engine = recorder(';');
    const reference = recorder(';');
    const input = '\ufeffx\na;b';
    expect(parse(input, { skipFirstNLines: 1, delimiter: engine.delimiter }).data).toStrictEqual([
      ['a', 'b'],
    ]);
    Papa.parse(input, { skipFirstNLines: 1, delimiter: reference.delimiter });
    expect(engine.calls).toStrictEqual(['a;b']);
    expect(reference.calls).toStrictEqual(['a;b']);
  });

  it('(R) guesses the newline for skipFirstNLines before the skip and again after it', () => {
    for (const result of withReference('x\na;b\r\n1;2', { skipFirstNLines: 1 })) {
      expect(result).toStrictEqual({
        data: [
          ['a', 'b'],
          ['1', '2'],
        ],
        errors: [],
        meta: meta({ delimiter: ';', linebreak: '\r\n', cursor: 8 }),
      });
    }
    for (const result of withReference('x\ra;b\r1;2', { skipFirstNLines: 1 })) {
      expect(result.data).toStrictEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
      expect(result.meta.linebreak).toBe('\r');
    }
  });

  it('(R) scans each candidate as Papa does: comment lines count for preview 10 without a quote', () => {
    const input = '#c\n'.repeat(9) + 'a;b\nc;d\n' + 'x,y,z\n'.repeat(8);
    for (const result of withReference(input, { comments: '#' })) {
      expect(result.meta.delimiter).toBe(';');
    }
    for (const result of withReference(input + '"q"', { comments: '#' })) {
      expect(result.meta.delimiter).toBe(',');
    }
  });

  it('rejects a function result outside the delimiter rules (D2-k, P3-a, P3-c)', () => {
    for (const result of ['"', '', '\ufeff', '\n', ',\n']) {
      const call = () => parse('a,b', { delimiter: () => result });
      expect(call).toThrow(TypeError);
      expect(call).toThrow('"delimiter"');
    }
    // @ts-expect-error -- the function returns a number
    const call = () => parse('a,b', { delimiter: () => 5 });
    expect(call).toThrow(TypeError);
    expect(call).toThrow('"delimiter"');
  });

  it('(R) throws when comments equal a detection candidate, even on comma data', () => {
    for (const comments of [';', '|', '\t']) {
      expect(() => parse('a,b\n1,2', { comments })).toThrow('Comment character same as delimiter');
      expect(() => Papa.parse('a,b\n1,2', { comments })).toThrow(
        'Comment character same as delimiter',
      );
    }
    for (const config of [{ comments: ';', delimiter: ',' }, { comments: true }]) {
      for (const result of withReference('a,b\n1,2', config)) {
        expect(result.data).toStrictEqual([
          ['a', 'b'],
          ['1', '2'],
        ]);
      }
    }
  });

  it('(R) compares comments as given with the fallback delimiter and a function result', () => {
    const fallback = { comments: ',', delimitersToGuess: ['|'] };
    expect(() => parse('abc', fallback)).toThrow('Comment character same as delimiter');
    expect(() => Papa.parse('abc', { ...fallback })).toThrow('Comment character same as delimiter');
    for (const result of withReference('a|b', fallback)) expect(result.meta.delimiter).toBe('|');
    const call = () => parse('a;b', { comments: ';', delimiter: () => ';' });
    expect(call).toThrow('Comment character same as delimiter');
    // true is not '#' until after the comparison.
    const hash = { comments: true, delimitersToGuess: ['#'] };
    for (const result of withReference('a#b\n1#2', hash)) expect(result.meta.delimiter).toBe('#');
  });

  it('(R) guesses the newline from the first 1,048,576 UTF-16 units', () => {
    for (const result of withReference('a\n'.repeat(524_288) + 'b\r\nc\r\n', {})) {
      expect(result.meta.linebreak).toBe('\n');
      expect(result.errors).toStrictEqual([UNDETECTABLE]);
    }
    // The closing quote is beyond the sample, so the CRLF inside the field counts.
    const input = '"x\r\ny' + 'z'.repeat(1_048_576) + '"\nq\n';
    const [engine, reference] = withReference(input, {});
    expect(engine?.meta.linebreak).toBe('\r\n');
    expect(engine?.errors).toStrictEqual([
      {
        type: 'Quotes',
        code: 'InvalidQuotes',
        message: 'Trailing quote on quoted field is malformed',
        row: 0,
        index: 1,
      },
      {
        type: 'Quotes',
        code: 'MissingQuotes',
        message: 'Quoted field unterminated',
        row: 0,
        index: 1,
      },
      UNDETECTABLE,
    ]);
    expect(engine).toStrictEqual(reference);
  });

  it('(R) puts UndetectableDelimiter after quote errors and before field-count errors', () => {
    for (const result of withReference('a\n1,2\n"x', { header: true })) {
      expect(result.errors).toStrictEqual([
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 2,
          index: 7,
        },
        UNDETECTABLE,
        {
          type: 'FieldMismatch',
          code: 'TooManyFields',
          message: 'Too many fields: expected 1 fields but parsed 2',
          row: 0,
        },
      ]);
    }
  });

  it('rejects delimitersToGuess values outside the delimiter rules (D2-k, P3-a)', () => {
    const calls = [
      // P3-a: an empty candidate, on which Papa's search never advances.
      () => parse('a', { delimitersToGuess: [''] }),
      () => parse('a', { delimitersToGuess: ['"'] }),
      () => parse('a', { delimitersToGuess: [';\n'] }),
      // @ts-expect-error -- not an array
      () => parse('a', { delimitersToGuess: ',' }),
      // @ts-expect-error -- not a string
      () => parse('a', { delimitersToGuess: [5] }),
      // @ts-expect-error -- null is not an array
      () => parse('a', { delimitersToGuess: null }),
    ];
    for (const call of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow('"delimitersToGuess"');
    }
  });
});

describe('byte order mark', () => {
  it('removes exactly one leading U+FEFF and keeps every other one', () => {
    const result = parse('\ufeff\ufeffa,\ufeffb\nc\ufeff', LF);
    expect(result.data).toStrictEqual([['\ufeffa', '\ufeffb'], ['c\ufeff']]);
    expect(result.meta.cursor).toBe(8);
  });

  it('removes one U+FEFF from the start of every header cell', () => {
    expect(parse('\ufeffa,\ufeffb\n1,2', { ...LF, header: true }).meta.fields).toStrictEqual([
      'a',
      'b',
    ]);
  });
});

describe('header records', () => {
  const H = { ...LF, header: true } as const;

  it('keys each later record by the header fields', () => {
    const result = parse('a,b\n1,2\n3,4', H);
    expect(result.data).toStrictEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(result.meta.fields).toStrictEqual(['a', 'b']);
    expect(result.errors).toStrictEqual([]);
  });

  it('leaves missing fields absent and collects extra fields, reporting both', () => {
    const result = parse('a,b\n1\n2,3,4,5\n6,7', H);
    expect(result.data).toStrictEqual([
      { a: '1' },
      { a: '2', b: '3', __parsed_extra: ['4', '5'] },
      { a: '6', b: '7' },
    ]);
    expect(result.errors).toStrictEqual([
      {
        type: 'FieldMismatch',
        code: 'TooFewFields',
        message: 'Too few fields: expected 2 fields but parsed 1',
        row: 0,
      },
      {
        type: 'FieldMismatch',
        code: 'TooManyFields',
        message: 'Too many fields: expected 2 fields but parsed 4',
        row: 1,
      },
    ]);
  });

  it('reports every quote error before every field-count error, each with its own row count', () => {
    const result = parse('a,b\n1\n"x"y",2,3\n"open', H);
    expect(result.data).toStrictEqual([
      { a: '1' },
      { a: 'x"y', b: '2', __parsed_extra: ['3'] },
      { a: 'open' },
    ]);
    expect(result.errors).toMatchObject([
      { code: 'InvalidQuotes', row: 2, index: 7 },
      { code: 'MissingQuotes', row: 3, index: 17 },
      { code: 'TooFewFields', row: 0 },
      { code: 'TooManyFields', row: 1 },
      { code: 'TooFewFields', row: 2 },
    ]);
  });

  it('gives a header-only input no records, and an empty input no fields', () => {
    expect(parse('a,b', H)).toMatchObject({ data: [], errors: [], meta: { fields: ['a', 'b'] } });
    expect(parse('', H)).toMatchObject({ data: [], errors: [], meta: { fields: [] } });
  });

  it('keeps the final-line-break record, which then has too few fields (D2-e)', () => {
    const result = parse('a,b\n1,2\n', H);
    expect(result.data).toStrictEqual([{ a: '1', b: '2' }, { a: '' }]);
    expect(result.errors).toMatchObject([{ code: 'TooFewFields', row: 1 }]);
  });

  it('renames duplicate headers and reports the renames without logging (D2-b)', () => {
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const result = parse('a,a,a_1,a,b\n1,2,3,4,5', H);
    expect(result.meta.fields).toStrictEqual(['a', 'a_2', 'a_1', 'a_3', 'b']);
    expect(result.meta.renamedHeaders).toStrictEqual({ a_2: 'a', a_3: 'a' });
    expect(result.data).toStrictEqual([{ a: '1', a_2: '2', a_1: '3', a_3: '4', b: '5' }]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('renames many duplicates in linear time', { timeout: 5000 }, () => {
    const k = 50_000;
    const taken = Array.from({ length: k }, (_, i) => `a_${String(i + 1)}`);
    const header = ['a', ...taken, ...Array<string>(k).fill('a')];
    const { fields = [] } = parse(`${header.join(',')}\n1`, H).meta;
    expect(fields.slice(k + 1, k + 4)).toStrictEqual([
      `a_${String(k + 1)}`,
      `a_${String(k + 2)}`,
      `a_${String(k + 3)}`,
    ]);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('stores prototype-named headers as own data properties (D2-c)', () => {
    const [record = {}] = parse('__proto__,constructor,prototype\nx,y,z', H).data;
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.keys(record)).toStrictEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')).toStrictEqual({
      value: 'x',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(record.constructor).toBe('y');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('enumerates integer-like keys first, as every ordinary object does', () => {
    const result = parse('10,2\na,b', H);
    expect(result.meta.fields).toStrictEqual(['10', '2']);
    expect(Object.keys(result.data[0] ?? {})).toStrictEqual(['2', '10']);
  });

  it('builds full, short and long records the same way at every width, as Papa does', () => {
    for (const width of [3, 1001]) {
      const names = Array.from({ length: width }, (_, i) => `c${String(i)}`);
      const full = names.map((_, i) => String(i)).join(',');
      const input = `${names.join(',')}\n${full}\n0,1\n${full},x,y`;
      const [engine, reference] = withReference(input, H);
      expect(engine).toStrictEqual(reference);
      expect(engine?.data.map((record) => Object.keys(record as object).length)).toStrictEqual([
        width,
        2,
        width + 1,
      ]);
    }
  });

  it('assigns a header name that Object.prototype holds as an accessor, as Papa does', () => {
    const set: unknown[] = [];
    Object.defineProperty(Object.prototype, 'zzAccessor', {
      configurable: true,
      get: () => 'inherited',
      set: (value: unknown) => set.push(value),
    });
    try {
      const [engine, reference] = withReference('zzAccessor,b\n1,2', H);
      expect(engine).toStrictEqual(reference);
      const [record = {}] = engine?.data ?? [];
      expect(Object.hasOwn(record as object, 'zzAccessor')).toBe(false);
      expect(set).toStrictEqual(['1', '1']);
    } finally {
      delete (Object.prototype as Record<string, unknown>).zzAccessor;
    }
  });
});

describe('header processing (transformHeader, U+FEFF, renaming)', () => {
  const H = { ...LF, header: true } as const;
  type Transform = (header: string, index: number) => string;
  // Each library gets its own recording transformHeader, so each call list is its own.
  const recordCalls = (input: string, config: ParseConfig, fn: Transform = (h) => h) =>
    [
      (c: ParseConfig) => parse(input, c),
      (c: ParseConfig) => Papa.parse<unknown>(input, papaConfig(c)),
    ].map((run) => {
      const calls: Array<[string, number]> = [];
      const transformHeader: Transform = (header, index) => {
        calls.push([header, index]);
        return fn(header, index);
      };
      return { result: run({ ...config, transformHeader }), calls };
    });

  it('applies transformHeader with (header, index) and renames the collisions it creates', () => {
    const indexed = parse(' a , b \n1,2', {
      ...H,
      transformHeader: (h, i) => h.trim() + String(i),
    });
    expect(indexed.meta.fields).toStrictEqual(['a0', 'b1']);
    expect(indexed.data).toStrictEqual([{ a0: '1', b1: '2' }]);
    const lower = parse('A,a\n1,2', { ...H, transformHeader: (h) => h.toLowerCase() });
    expect(lower.meta.fields).toStrictEqual(['a', 'a_1']);
    expect(lower.meta.renamedHeaders).toStrictEqual({ a_1: 'a' });
    expect(lower.data).toStrictEqual([{ a: '1', a_1: '2' }]);
  });

  it('(R) removes one leading U+FEFF from each header cell, before transformHeader', () => {
    for (const result of withReference('a,\ufeffb\n1,2', H)) {
      expect(result.meta.fields).toStrictEqual(['a', 'b']);
      expect(result.data).toStrictEqual([{ a: '1', b: '2' }]);
    }
    for (const { calls } of recordCalls('a,\ufeffb\n1,2', H)) {
      expect(calls).toStrictEqual([
        ['a', 0],
        ['b', 1],
      ]);
    }
    // Only one per header cell; data cells keep theirs.
    for (const result of withReference('a,\ufeff\ufeffb\n\ufeff1,2', H)) {
      expect(result.meta.fields).toStrictEqual(['a', '\ufeffb']);
      expect(result.data).toStrictEqual([{ a: '\ufeff1', '\ufeffb': '2' }]);
    }
  });

  it('(R) starts the used names with the raw cells, before U+FEFF removal and transformHeader', () => {
    const lower = { ...H, transformHeader: (h: string) => h.toLowerCase() };
    for (const result of withReference('x,x,X_1\n1,2,3', lower)) {
      expect(result.meta.fields).toStrictEqual(['x', 'x_1', 'x_1']);
      expect(result.meta.renamedHeaders).toStrictEqual({ x_1: 'x' });
      expect(result.data).toStrictEqual([{ x: '1', x_1: '3' }]);
    }
    for (const result of withReference('a,a,\ufeffa_1\n1,2,3', H)) {
      expect(result.meta.fields).toStrictEqual(['a', 'a_1', 'a_1']);
      expect(result.meta.renamedHeaders).toStrictEqual({ a_1: 'a' });
    }
  });

  it('(R) never calls transformHeader without header', () => {
    for (const { result, calls } of recordCalls('a,b\n1,2', LF)) {
      expect(calls).toStrictEqual([]);
      expect(result.data).toStrictEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    }
  });

  it('(R) transforms record 0 before skipEmptyLines removes it, and not the next one', () => {
    for (const { result, calls } of recordCalls('\na,a\n1,2', { ...H, skipEmptyLines: true })) {
      expect(calls).toStrictEqual([['', 0]]);
      expect(result.meta.fields).toStrictEqual(['a', 'a']);
      expect(result.data).toStrictEqual([{ a: '2' }]);
    }
  });

  it('rejects a transformHeader that is not a function or does not return a string', () => {
    const calls = [
      // @ts-expect-error -- not a function
      () => parse('a', { ...H, transformHeader: 'x' }),
      // @ts-expect-error -- not a function
      () => parse('a', { ...H, transformHeader: null }),
      // Checked without header too, as every option is.
      // @ts-expect-error -- not a function
      () => parse('a', { ...LF, transformHeader: 5 }),
      // Papa uses any returned value as the name; the main entry needs a string.
      // @ts-expect-error -- returns a number
      () => parse('a', { ...H, transformHeader: () => 1 }),
    ];
    for (const call of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow('"transformHeader"');
    }
  });
});

describe('dynamicTyping', () => {
  const H = { ...LF, header: true } as const;
  type Typing = (field: string | number) => boolean;
  // Both libraries on one quoted field with delimiter '|', as R06 in
  // test/papa-reference.test.ts reads it.
  const field = (value: string) =>
    withReference(`"${value}"`, { delimiter: '|', dynamicTyping: true }).map(
      (result) => (result.data as unknown[][])[0]?.[0],
    );
  // Each library gets its own recording dynamicTyping function.
  const recordCalls = (input: string, config: ParseConfig, fn: Typing) =>
    [
      (c: ParseConfig) => parse(input, c),
      (c: ParseConfig) => Papa.parse<unknown>(input, papaConfig(c)),
    ].map((run) => {
      const calls: Array<string | number> = [];
      const dynamicTyping: Typing = (name) => {
        calls.push(name);
        return fn(name);
      };
      return { result: run({ ...config, dynamicTyping }), calls };
    });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['FALSE', false],
    ['1', 1],
    ['1.5', 1.5],
    ['007', 7],
    [' 5 ', 5],
    ['1e3', 1000],
    ['.5', 0.5],
    ['5.', 5],
    ['-.5', -0.5],
    ['9007199254740991', 9007199254740991],
    ['-9007199254740991', -9007199254740991],
    ['', null],
  ])('(R) converts %j (R06)', (input, expected) => {
    expect(field(input)).toStrictEqual([expected, expected]);
  });

  it.each([
    'True',
    'fALSE',
    'true ',
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
    '2020-01-02T03:04:60Z',
  ])('(R) keeps %j as a string (R06)', (input) => {
    expect(field(input)).toStrictEqual([input, input]);
  });

  it('(R) converts "-0" to negative zero (R06)', () => {
    for (const value of field('-0')) expect(Object.is(value, -0)).toBe(true);
  });

  it('(R) converts ISO date-times with a zone to Date (R06)', () => {
    for (const [input, iso] of [
      ['2020-01-02T03:04:05.123+03:00', '2020-01-02T00:04:05.123Z'],
      ['2020-01-02T03:04:05-05:30', '2020-01-02T08:34:05.000Z'],
      ['2020-01-02T03:04Z', '2020-01-02T03:04:00.000Z'],
    ] as const) {
      for (const value of field(input)) {
        expect(value).toBeInstanceOf(Date);
        expect((value as Date).toISOString()).toBe(iso);
      }
    }
  });

  it('(R) typing edge values: whitespace, U+FEFF, underflow, rounding, ".e", non-ASCII digits, ISO-shaped invalid dates', () => {
    expect(field(' 5')).toStrictEqual([5, 5]);
    expect(field('\ufeff5')).toStrictEqual([5, 5]);
    expect(field('1 ')).toStrictEqual([1, 1]);
    expect(field('\u00a05\u00a0')).toStrictEqual([5, 5]);
    expect(field('5\u2028')).toStrictEqual([5, 5]);
    for (const value of field('1e-400')) expect(Object.is(value, 0)).toBe(true);
    for (const value of field('-1e-400')) expect(Object.is(value, -0)).toBe(true);
    // parseFloat rounds it to 2^53, which is outside the bounds.
    expect(field('9007199254740991.5')).toStrictEqual(['9007199254740991.5', '9007199254740991.5']);
    expect(field('1.e2')).toStrictEqual([100, 100]);
    expect(field('\u0661')).toStrictEqual(['\u0661', '\u0661']);
    for (const value of field('2020-19-39T29:59Z')) {
      expect(value).toBeInstanceOf(Date);
      expect((value as Date).getTime()).toBeNaN();
    }
  });

  it('(R) reads a map by header name, or by column index without header (R06)', () => {
    for (const result of withReference('a,b\n1,2', { ...H, dynamicTyping: { b: true } })) {
      expect(result.data).toStrictEqual([{ a: '1', b: 2 }]);
    }
    for (const result of withReference('1,2', { ...LF, dynamicTyping: { 1: true } })) {
      expect(result.data).toStrictEqual([['1', 2]]);
    }
    // A key set to false, a missing name, and an index with header convert nothing.
    const none = { a: false, c: true, 1: true };
    for (const result of withReference('a,b\n1,2', { ...H, dynamicTyping: none })) {
      expect(result.data).toStrictEqual([{ a: '1', b: '2' }]);
    }
  });

  it('(R) calls the function once per field with the header name, or the index without header (R06)', () => {
    for (const { result, calls } of recordCalls('a,b\n1,2\n3,4', H, (f) => f === 'a')) {
      expect(calls).toStrictEqual(['a', 'b']);
      expect(result.data).toStrictEqual([
        { a: 1, b: '2' },
        { a: 3, b: '4' },
      ]);
    }
    for (const { result, calls } of recordCalls('1,2\n3,4', LF, (f) => f === 0)) {
      expect(calls).toStrictEqual([0, 1]);
      expect(result.data).toStrictEqual([
        [1, '2'],
        [3, '4'],
      ]);
    }
  });

  it('(R) asks the function again after it returns undefined, and converts only on true', () => {
    // @ts-expect-error -- returns undefined, which Papa does not cache
    const undecided: Typing = () => undefined;
    // @ts-expect-error -- returns a number, which is kept and does not convert
    const one: Typing = () => 1;
    for (const { result, calls } of recordCalls('a,b\n1,2\n3,4', H, undecided)) {
      expect(calls).toStrictEqual(['a', 'b', 'a', 'b']);
      expect(result.data).toStrictEqual([
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ]);
    }
    for (const { result, calls } of recordCalls('a,b\n1,2\n3,4', H, one)) {
      expect(calls).toStrictEqual(['a', 'b']);
      expect(result.data).toStrictEqual([
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ]);
    }
  });

  it('(R) calls the function with the names after transformHeader and renaming', () => {
    const config = { ...H, transformHeader: (h: string) => h.toLowerCase() };
    for (const { result, calls } of recordCalls('A,a\n1,2', config, (f) => f === 'a')) {
      expect(calls).toStrictEqual(['a', 'a_1']);
      expect(result.data).toStrictEqual([{ a: 1, a_1: '2' }]);
    }
  });

  it('(R) does not type the header row', () => {
    for (const result of withReference('1,2\n3,4', { ...H, dynamicTyping: true })) {
      expect(result.meta.fields).toStrictEqual(['1', '2']);
      expect(result.data).toStrictEqual([{ 1: 3, 2: 4 }]);
    }
  });

  it('(R) types __parsed_extra values under the name __parsed_extra', () => {
    for (const result of withReference('a\n1,2', { ...H, dynamicTyping: true })) {
      expect(result.data).toStrictEqual([{ a: 1, __parsed_extra: [2] }]);
    }
    const extra = { ...H, dynamicTyping: { __parsed_extra: true } };
    for (const result of withReference('a,b\n1,2,3,', extra)) {
      expect(result.data).toStrictEqual([{ a: '1', b: '2', __parsed_extra: [3, null] }]);
    }
  });

  it('(R) removes empty records before typing', () => {
    for (const result of withReference('1\n\n2', {
      ...LF,
      dynamicTyping: true,
      skipEmptyLines: true,
    })) {
      expect(result.data).toStrictEqual([[1], [2]]);
    }
    const greedy = { ...H, dynamicTyping: true, skipEmptyLines: 'greedy' } as const;
    for (const result of withReference('a\n \n1', greedy)) {
      expect(result.data).toStrictEqual([{ a: 1 }]);
    }
  });

  it('rejects a dynamicTyping that is not a boolean, a plain object of booleans or a function', () => {
    const calls = [
      // @ts-expect-error -- null is not an option value
      () => parse('a', { ...LF, dynamicTyping: null }),
      // @ts-expect-error -- a string
      () => parse('a', { ...LF, dynamicTyping: 'yes' }),
      // @ts-expect-error -- a number
      () => parse('a', { ...LF, dynamicTyping: 1 }),
      // @ts-expect-error -- an array
      () => parse('a', { ...LF, dynamicTyping: [true] }),
      // @ts-expect-error -- a map value that is not a boolean
      () => parse('a', { ...LF, dynamicTyping: { 0: 1 } }),
      // @ts-expect-error -- not a plain object
      () => parse('a', { ...LF, dynamicTyping: new Map([[0, true]]) }),
    ];
    for (const call of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow('"dynamicTyping"');
    }
    expect(parse('1', { ...LF, dynamicTyping: false }).data).toStrictEqual([['1']]);
    const bare: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
    bare[0] = true;
    expect(parse('1', { ...LF, dynamicTyping: bare }).data).toStrictEqual([[1]]);
  });
});

describe('transform', () => {
  const H = { ...LF, header: true } as const;
  type Transform = (value: string, field: string | number) => unknown;
  const LIBRARIES = [
    (input: string, config: ParseConfig) => parse(input, config),
    (input: string, config: ParseConfig) => Papa.parse<unknown>(input, papaConfig(config)),
  ];
  // Each library gets its own recording transform.
  const recordTransform = (input: string, config: ParseConfig, fn: Transform = (v) => v) =>
    LIBRARIES.map((run) => {
      const calls: unknown[][] = [];
      const transform: Transform = (value, field) => {
        calls.push([value, field]);
        return fn(value, field);
      };
      return { result: run(input, { ...config, transform }), calls };
    });
  const thrownBy = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  // The one field of input 'a' after transform returned value, with dynamicTyping.
  const typedAs = (value: unknown) =>
    recordTransform('a', { ...LF, dynamicTyping: true }, () => value).map(
      ({ result }) => (result.data as unknown[][])[0]?.[0],
    );

  it('(R) is called row-major with the value and the column index (R07)', () => {
    for (const { result, calls } of recordTransform('a,b\n1,2', LF, (v) => `${v}!`)) {
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
    }
  });

  it('(R) with header gets the header name or __parsed_extra and skips the header record (R07)', () => {
    for (const { result, calls } of recordTransform('a,b\n1,2,3', H)) {
      expect(calls).toStrictEqual([
        ['1', 'a'],
        ['2', 'b'],
        ['3', '__parsed_extra'],
      ]);
      expect(result.data).toStrictEqual([{ a: '1', b: '2', __parsed_extra: ['3'] }]);
    }
  });

  it('(R) gets renamed duplicate names, and no call for a missing field', () => {
    const named = (v: string, f: string | number) => `${String(f)}:${v}`;
    for (const { result, calls } of recordTransform('a,a,a_1\n1,2,3\n4', H, named)) {
      expect(calls).toStrictEqual([
        ['1', 'a'],
        ['2', 'a_2'],
        ['3', 'a_1'],
        ['4', 'a'],
      ]);
      expect(result.data).toStrictEqual([{ a: 'a:1', a_2: 'a_2:2', a_1: 'a_1:3' }, { a: 'a:4' }]);
    }
  });

  it('(R) keeps what it returns (R07)', () => {
    for (const { result } of recordTransform('a,b', LF, () => 5)) {
      expect(result.data).toStrictEqual([[5, 5]]);
    }
  });

  it('(R) runs before dynamicTyping (R07)', () => {
    const typed = { ...LF, dynamicTyping: true } as const;
    for (const { result } of recordTransform('1,2', typed, (v) => `${v}0`)) {
      expect(result.data).toStrictEqual([[10, 20]]);
    }
  });

  it('(R) propagates the object it throws, and the next parse equals a fresh one (R07)', () => {
    for (const run of LIBRARIES) {
      const fresh = run('a,b\n1,2', H);
      const boom = new Error('boom');
      const fail = () => {
        throw boom;
      };
      expect(thrownBy(() => run('a,b', { ...LF, transform: fail }))).toBe(boom);
      // On the second record, with header: the first record was transformed.
      const calls: unknown[][] = [];
      const second = (value: string, field: string | number) => {
        calls.push([value, field]);
        if (value === '2') throw boom;
        return value;
      };
      expect(thrownBy(() => run('a\n1\n2\n3', { ...H, transform: second }))).toBe(boom);
      expect(calls).toStrictEqual([
        ['1', 'a'],
        ['2', 'a'],
      ]);
      expect(run('a,b\n1,2', H)).toStrictEqual(fresh);
    }
  });

  it('(R) comes after the delimiter function and transformHeader, each field before its dynamicTyping call', () => {
    for (const run of LIBRARIES) {
      const log: unknown[][] = [];
      const rec =
        <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
        (...args: A): R => {
          log.push([name, ...args]);
          return fn(...args);
        };
      run('a;b\n1;2\n3;4', {
        header: true,
        delimiter: rec('delimiter', () => ';'),
        transformHeader: rec('transformHeader', (h: string) => h),
        transform: rec('transform', (v: string) => v),
        dynamicTyping: rec('dynamicTyping', () => false),
      });
      expect(log).toStrictEqual([
        ['delimiter', 'a;b\n1;2\n3;4'],
        ['transformHeader', 'a', 0],
        ['transformHeader', 'b', 1],
        ['transform', '1', 'a'],
        ['dynamicTyping', 'a'],
        ['transform', '2', 'b'],
        ['dynamicTyping', 'b'],
        ['transform', '3', 'a'],
        ['transform', '4', 'b'],
      ]);
    }
  });

  it('(R) non-string results with dynamicTyping', () => {
    const typed = { ...LF, dynamicTyping: true } as const;
    for (const { result } of recordTransform('-0,1e400,abc', typed, (v) => Number(v))) {
      expect(result.data).toStrictEqual([[0, Infinity, NaN]]);
      expect(Object.is((result.data as unknown[][])[0]?.[0], 0)).toBe(true);
    }
    for (const { result } of recordTransform('x, 5 ', typed, (v) => (v === 'x' ? null : v))) {
      expect(result.data).toStrictEqual([[null, 5]]);
    }
  });

  it('(R) dynamicTyping converts a non-string result as given, as Papa does', () => {
    for (const value of typedAs(-0)) expect(Object.is(value, 0)).toBe(true);
    expect(typedAs(null)).toStrictEqual([null, null]);
    expect(typedAs(undefined)).toStrictEqual([undefined, undefined]);
    const date = new Date('2020-01-02T03:04:05Z');
    for (const value of typedAs(date)) expect(value).toBe(date);
    // The patterns read toString; the Date constructor reads valueOf.
    for (const value of typedAs({ toString: () => '2020-01-02T03:04Z', valueOf: () => 0 })) {
      expect(value).toBeInstanceOf(Date);
      expect((value as Date).getTime()).toBe(0);
    }
    // One conversion per test: FLOAT, parseFloat for the bounds, parseFloat for the value.
    for (const run of LIBRARIES) {
      let n = 0;
      const counting = { toString: () => String(++n) };
      const config = { ...LF, dynamicTyping: true, transform: () => counting } as const;
      expect(run('a', config).data).toStrictEqual([[3]]);
    }
    for (const run of LIBRARIES) {
      const symbol = { ...LF, dynamicTyping: true, transform: () => Symbol('s') } as const;
      const error = thrownBy(() => run('a', symbol));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe('Cannot convert a Symbol value to a string');
      // Untyped, it is kept.
      const kept = run('a', { ...LF, transform: () => Symbol.for('s') }).data;
      expect(kept).toStrictEqual([[Symbol.for('s')]]);
    }
  });

  it('(R) never sees a record skipEmptyLines removes, and cannot change which are removed', () => {
    const skip = { ...LF, skipEmptyLines: true } as const;
    for (const { result, calls } of recordTransform('a\n\nb', skip, (v) => v || 'filled')) {
      expect(calls).toStrictEqual([
        ['a', 0],
        ['b', 0],
      ]);
      expect(result.data).toStrictEqual([['a'], ['b']]);
    }
    for (const { result } of recordTransform('1\n2', skip, () => '')) {
      expect(result.data).toStrictEqual([[''], ['']]);
    }
  });

  it('can start another parse without disturbing either', () => {
    const inner = { delimiter: ';', newline: '\n', dynamicTyping: true } as const;
    const fresh = parse('x;y\n3;4', inner);
    const seen: unknown[] = [];
    const outer = parse('a,b\n1,2', {
      ...H,
      transform: (value) => {
        seen.push(parse('x;y\n3;4', inner));
        return value;
      },
    });
    expect(outer).toStrictEqual(parse('a,b\n1,2', H));
    expect(seen).toStrictEqual([fresh, fresh]);
  });

  it('rejects a transform that is not a function, checked after dynamicTyping', () => {
    const calls = [
      // @ts-expect-error -- null is not an option value
      () => parse('a', { ...LF, transform: null }),
      // @ts-expect-error -- a string
      () => parse('a', { ...LF, transform: 'x' }),
      // @ts-expect-error -- a number
      () => parse('a', { ...LF, transform: 1 }),
    ];
    for (const call of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow('Parse option "transform" must be a function');
    }
    // @ts-expect-error -- two invalid values
    const both = () => parse('a', { ...LF, dynamicTyping: 'yes', transform: null });
    expect(both).toThrow('"dynamicTyping"');
  });

  it('types the rows as unknown', () => {
    const config: ParseConfig = LF;
    expectTypeOf(parse('a', { ...LF, transform: (v) => v.length }).data).toEqualTypeOf<
      unknown[][]
    >();
    expectTypeOf(parse('a', { ...H, transform: (v) => v }).data).toEqualTypeOf<
      HeaderRow<unknown>[]
    >();
    expectTypeOf(
      parse('a', { ...LF, dynamicTyping: true, transform: (v) => v }).data,
    ).toEqualTypeOf<unknown[][]>();
    expectTypeOf(parse('a', config).data).toEqualTypeOf<Array<unknown[] | HeaderRow<unknown>>>();
  });
});

describe('result metadata and isolation', () => {
  it('reports the dialect, cursor and no renames', () => {
    expect(parse('a;b\r\nc', { delimiter: ';', newline: '\r\n' }).meta).toStrictEqual({
      delimiter: ';',
      linebreak: '\r\n',
      aborted: false,
      truncated: false,
      cursor: 6,
      renamedHeaders: null,
    });
  });

  it('does not write into the caller config (D2-a)', () => {
    const config = Object.freeze({ delimiter: ',', newline: '\n', header: true } as const);
    expect(() => parse('a\n1', config)).not.toThrow();
    expect(config).toStrictEqual({ delimiter: ',', newline: '\n', header: true });
  });

  it('keeps no state between parses', () => {
    const first = parse('"a\nb",c\n"x', LF);
    parse('z', { delimiter: ';', newline: '\r', header: true });
    expect(parse('"a\nb",c\n"x', LF)).toStrictEqual(first);
  });
});

describe('result contract', () => {
  const H = { ...LF, header: true } as const;
  const META_KEYS = ['aborted', 'cursor', 'delimiter', 'linebreak', 'renamedHeaders', 'truncated'];
  const WITH_FIELDS = [
    'aborted',
    'cursor',
    'delimiter',
    'fields',
    'linebreak',
    'renamedHeaders',
    'truncated',
  ];
  // default, header, preview, comments and auto (undefined: no config).
  const CONFIGS: Array<ParseConfig | undefined> = [
    LF,
    H,
    { ...LF, preview: 1 },
    { ...H, preview: 1 },
    { ...LF, comments: '#' },
    { ...H, comments: '#' },
    {},
    { header: true },
    undefined,
  ];
  const INPUTS = ['a,b\n#c\n1,2', '', '"a\n1'];
  const results = (input: string, config: ParseConfig | undefined) =>
    config === undefined
      ? [parse(input), Papa.parse<unknown>(input)]
      : withReference(input, config);

  it('(R) has exactly six meta keys, plus fields exactly when a header is used', () => {
    for (const config of CONFIGS) {
      for (const input of INPUTS) {
        for (const { meta } of results(input, config)) {
          expect(Object.keys(meta).sort()).toStrictEqual(config?.header ? WITH_FIELDS : META_KEYS);
        }
      }
    }
  });

  it('(R) reports aborted: false in every result (no step or abort in the alpha)', () => {
    const configs: Array<ParseConfig | undefined> = [
      ...CONFIGS,
      { ...H, skipEmptyLines: 'greedy', skipFirstNLines: 1, fastMode: true },
      { delimitersToGuess: ['|'], quoteChar: "'", escapeChar: '\\' },
      { ...H, delimiter: () => ',', transformHeader: (h) => h, dynamicTyping: true },
      { ...LF, transform: (v) => v, preview: 2, fastMode: false },
    ];
    for (const config of configs) {
      for (const input of [...INPUTS, 'a\n"b', 'a,b\n1\n2,3,4']) {
        for (const { meta } of results(input, config)) expect(meta.aborted).toBe(false);
      }
    }
  });

  it('(R) gives each error type its exact keys', () => {
    const KEYS: Record<ParseError['type'], string[]> = {
      Quotes: ['type', 'code', 'message', 'row', 'index'],
      Delimiter: ['type', 'code', 'message'],
      FieldMismatch: ['type', 'code', 'message', 'row'],
    };
    const inputs: Array<[string, ParseConfig]> = [
      ['a\n"b', LF],
      ['"a"b,c', LF],
      ['a\nb', {}],
      ['a,b\n1', H],
      ['a\n1,2', H],
    ];
    const codes = new Set<string>();
    for (const [input, config] of inputs) {
      for (const { errors } of withReference(input, config)) {
        for (const error of errors) {
          codes.add(error.code);
          expect(Object.keys(error)).toStrictEqual(KEYS[error.type]);
        }
      }
    }
    expect([...codes].sort()).toStrictEqual([
      'InvalidQuotes',
      'MissingQuotes',
      'TooFewFields',
      'TooManyFields',
      'UndetectableDelimiter',
    ]);
  });

  it('(R) counts the cursor in UTF-16 units after the BOM', () => {
    expect(parse('\ufeff😀,b\n').meta.cursor).toBe(5);
    expect(Papa.parse('\ufeff😀,b\n').meta.cursor).toBe(5);
  });

  it('(R) detects the dialect without a config', () => {
    const detected = {
      data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      errors: [],
      meta: {
        delimiter: ';',
        linebreak: '\r\n',
        aborted: false,
        truncated: false,
        cursor: 8,
        renamedHeaders: null,
      },
    };
    expect(parse('a;b\r\n1;2')).toStrictEqual(detected);
    expect(Papa.parse('a;b\r\n1;2')).toStrictEqual(detected);
    expect(parse('a')).toStrictEqual(Papa.parse('a'));
    expect(parse('a').errors.map((error) => error.code)).toStrictEqual(['UndetectableDelimiter']);
  });
});

describe('config validation (main entry)', () => {
  const unsupported = (call: () => unknown, feature: string) => {
    expect(call).toThrow(Error);
    expect(call).toThrow(
      expect.objectContaining({
        name: 'UnsupportedFeatureError',
        feature,
        message: `"${feature}" is not supported by csvloom`,
      }) as Error,
    );
  };

  it('rejects an unknown key with a TypeError naming it', () => {
    // @ts-expect-error -- misspelled option
    const call = () => parse('a', { delimiter: ',', newline: '\n', delimitr: ',' });
    expect(call).toThrow(TypeError);
    expect(call).toThrow('delimitr');
  });

  it('checks unknown keys before unsupported features', () => {
    // @ts-expect-error -- an unknown key and an excluded option
    const call = () => parse('a', { worker: true, foo: 1 });
    expect(call).toThrow(TypeError);
    expect(call).toThrow('foo');
  });

  it('rejects each active excluded option with UnsupportedFeatureError (D3)', () => {
    const calls: Array<[string, () => unknown]> = [
      // @ts-expect-error -- excluded option
      ['step', () => parse('a', { ...LF, step: () => undefined })],
      // @ts-expect-error -- excluded option
      ['chunk', () => parse('a', { ...LF, chunk: () => undefined })],
      // @ts-expect-error -- excluded option
      ['complete', () => parse('a', { ...LF, complete: () => undefined })],
      // @ts-expect-error -- excluded option
      ['error', () => parse('a', { ...LF, error: () => undefined })],
      // @ts-expect-error -- excluded option
      ['beforeFirstChunk', () => parse('a', { ...LF, beforeFirstChunk: () => undefined })],
      // @ts-expect-error -- excluded option
      ['worker', () => parse('a', { ...LF, worker: true })],
      // @ts-expect-error -- excluded option
      ['download', () => parse('a', { ...LF, download: true })],
      // @ts-expect-error -- excluded option
      ['chunkSize', () => parse('a', { ...LF, chunkSize: 1024 })],
      // @ts-expect-error -- excluded option
      ['encoding', () => parse('a', { ...LF, encoding: 'utf-8' })],
      // @ts-expect-error -- excluded option
      ['downloadRequestHeaders', () => parse('a', { ...LF, downloadRequestHeaders: {} })],
      // @ts-expect-error -- excluded option
      ['downloadRequestBody', () => parse('a', { ...LF, downloadRequestBody: '' })],
      // @ts-expect-error -- excluded option
      ['downloadTimeout', () => parse('a', { ...LF, downloadTimeout: 5000 })],
      // @ts-expect-error -- excluded option
      ['withCredentials', () => parse('a', { ...LF, withCredentials: true })],
    ];
    for (const [feature, call] of calls) unsupported(call, feature);
  });

  it('accepts the inactive values of the excluded options (D3)', () => {
    // A config that is not an object literal may carry keys its type does not list.
    const config = {
      ...LF,
      worker: false,
      download: false,
      encoding: '',
      step: undefined,
      withCredentials: false,
    };
    expect(parse('a', config).data).toStrictEqual([['a']]);
  });

  it('accepts only string input', () => {
    // @ts-expect-error -- not a string
    const number = () => parse(123);
    // @ts-expect-error -- not a string
    const nothing = () => parse(null);
    expect(number).toThrow(TypeError);
    expect(number).toThrow('number');
    expect(nothing).toThrow(TypeError);
    expect(nothing).toThrow('null');
    // @ts-expect-error -- Papa.NODE_STREAM_INPUT
    unsupported(() => parse(1), 'NODE_STREAM_INPUT');
    // @ts-expect-error -- not a string
    unsupported(() => parse({}), 'non-string input');
    // @ts-expect-error -- not a string
    unsupported(() => parse(new Blob(['a'])), 'non-string input');
  });

  it('rejects a config that is not a plain object', () => {
    const calls = [
      // @ts-expect-error -- not a config object
      () => parse('a', null),
      // @ts-expect-error -- not a config object
      () => parse('a', []),
      // @ts-expect-error -- not a config object
      () => parse('a', 'x'),
    ];
    for (const call of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow('plain object');
    }
  });

  it('rejects a value outside the option type with a TypeError naming the option', () => {
    const calls: Array<[string, () => unknown]> = [
      // D2-k: the quote character
      ['delimiter', () => parse('a', { ...LF, delimiter: '"' })],
      // @ts-expect-error -- not a newline
      ['newline', () => parse('a', { ...LF, newline: 'x' })],
      // @ts-expect-error -- not a boolean
      ['header', () => parse('a', { ...LF, header: 'yes' })],
    ];
    for (const [option, call] of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${option}"`);
    }
  });

  it('rejects null for every known key, naming it', () => {
    const keys = [
      'delimiter',
      'newline',
      'quoteChar',
      'escapeChar',
      'header',
      'comments',
      'skipEmptyLines',
      'preview',
      'skipFirstNLines',
      'fastMode',
      'delimitersToGuess',
      'transformHeader',
      'dynamicTyping',
      'transform',
      'worker',
      'download',
      'step',
      'chunk',
      'complete',
      'error',
      'beforeFirstChunk',
      'chunkSize',
      'encoding',
      'downloadRequestHeaders',
      'downloadRequestBody',
      'withCredentials',
      'downloadTimeout',
    ];
    // The D3 table reads any value of these as a request.
    const requests = [
      'downloadRequestHeaders',
      'downloadRequestBody',
      'withCredentials',
      'downloadTimeout',
    ];
    for (const key of keys) {
      const config: Record<string, unknown> = { [key]: null };
      const call = () => parse('a;b\n1;2', config);
      if (requests.includes(key)) unsupported(call, key);
      else {
        expect(call).toThrow(TypeError);
        expect(call).toThrow(`"${key}"`);
      }
    }
  });

  it('rejects a quoteChar other than one UTF-16 unit, an empty candidate and a multi-line delimiter', () => {
    const calls: Array<[string, () => unknown]> = [
      ['quoteChar', () => parse('a', { ...LF, quoteChar: '' })],
      ['quoteChar', () => parse('a', { ...LF, quoteChar: "''" })],
      // @ts-expect-error -- not a string
      ['quoteChar', () => parse('a', { ...LF, quoteChar: 5 })],
      // P3-a: '' is automatic as the delimiter but never a delimiter itself.
      ['delimitersToGuess', () => parse('a', { ...LF, delimitersToGuess: [''] })],
      // P3-c: a delimiter containing a line break.
      ['delimiter', () => parse('a', { ...LF, delimiter: ',\n' })],
    ];
    for (const [option, call] of calls) {
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${option}"`);
    }
  });
});

describe('csvloom/papa entry', () => {
  // The /papa entry takes any config at run time, as Papa does.
  const papaParse = (input: unknown, config?: unknown) =>
    papaEntry.parse(input as string, config as Parameters<typeof papaEntry.parse>[1]);
  /** (R) Both libraries, each with its own copy of config, give the same result. */
  const same = (input: string, config: () => unknown) => {
    const ours = papaParse(input, config());
    const papa = Papa.parse<unknown>(input, config() as Papa.ParseConfig<unknown>);
    expect(difference(ours, papa)).toBeNull();
    return ours;
  };
  /** (R) Both libraries throw message. */
  const bothThrow = (input: unknown, config: () => unknown, message: string) => {
    expect(() => papaParse(input, config())).toThrow(message);
    expect(() => Papa.parse(input as string, config() as Papa.ParseConfig<unknown>)).toThrow(
      message,
    );
  };

  it("default export: frozen, exactly seven members, Papa's constants", () => {
    expect(Object.isFrozen(papaEntry)).toBe(true);
    expect(Object.keys(papaEntry).sort()).toStrictEqual([
      'BAD_DELIMITERS',
      'BYTE_ORDER_MARK',
      'RECORD_SEP',
      'UNIT_SEP',
      'UnsupportedFeatureError',
      'parse',
      'unparse',
    ]);
    expect(papaEntry.RECORD_SEP).toBe(Papa.RECORD_SEP);
    expect(papaEntry.UNIT_SEP).toBe(Papa.UNIT_SEP);
    expect(papaEntry.BYTE_ORDER_MARK).toBe(Papa.BYTE_ORDER_MARK);
    expect(papaEntry.BAD_DELIMITERS).toStrictEqual(Papa.BAD_DELIMITERS);
    expect(Object.isFrozen(papaEntry.BAD_DELIMITERS)).toBe(true);
    expect(papaEntry.UnsupportedFeatureError).toBe(UnsupportedFeatureError);
  });

  it("rejects Papa's other inputs: NODE_STREAM_INPUT and objects (D3), other values as Papa", () => {
    expect(() => papaParse(1)).toThrow(
      expect.objectContaining({
        name: 'UnsupportedFeatureError',
        feature: 'NODE_STREAM_INPUT',
      }) as Error,
    );
    expect(() => papaParse({})).toThrow(
      expect.objectContaining({
        name: 'UnsupportedFeatureError',
        feature: 'non-string input',
      }) as Error,
    );
    for (const input of [null, undefined]) {
      bothThrow(
        input,
        () => undefined,
        `Cannot read properties of ${String(input)} (reading 'readable')`,
      );
    }
    for (const input of [123, true]) {
      bothThrow(input, () => undefined, "Cannot read properties of null (reading 'stream')");
    }
  });

  it('(R) coercions: header 1, skipFirstNLines "1", preview "2", delimiter 5', () => {
    const input = 'a,b\n1,2\n3,4';
    expect(same(input, () => ({ header: 1 })).data).toStrictEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(same(input, () => ({ skipFirstNLines: '1' })).data).toStrictEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    const preview = same(input, () => ({ preview: '2' }));
    expect(preview.data).toStrictEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(preview.meta.truncated).toBe(true);
    const five = same(input, () => ({ delimiter: 5 }));
    expect(five.meta.delimiter).toBe(',');
    expect(five.errors).toStrictEqual([]);
  });

  it('(R) null and falsy values mean detect, the default or false (papaparse.js 1022, 1026, 1366)', () => {
    const result = same('a;b\r\n1;2', () => ({
      delimiter: null,
      newline: null,
      header: null,
      quoteChar: null,
      comments: null,
      preview: null,
      skipFirstNLines: null,
      dynamicTyping: null,
      transform: null,
      transformHeader: null,
      delimitersToGuess: null,
      skipEmptyLines: null,
      fastMode: null,
    }));
    expect(result.meta).toMatchObject({ delimiter: ';', linebreak: '\r\n' });
    expect(same('a,b', () => ({ delimiter: 0, newline: '', preview: NaN })).data).toStrictEqual([
      ['a', 'b'],
    ]);
    // A falsy config is {}.
    for (const config of [null, 0, '']) same('a;b', () => config);
  });

  it("(R) a primitive config throws Papa's TypeError (papaparse.js 110, strict mode)", () => {
    bothThrow('a', () => 'x', "Cannot create property 'dynamicTyping' on string 'x'");
    bothThrow('a', () => 5, "Cannot create property 'dynamicTyping' on number '5'");
  });

  it('(R) newline: an invalid value parses with "\\n" but skipFirstNLines splits at it (436-443)', () => {
    const result = same('axb,c\n1,2', () => ({ newline: 'x', skipFirstNLines: 1 }));
    expect(result.data).toStrictEqual([
      ['b', 'c'],
      ['1', '2'],
    ]);
    expect(result.meta.linebreak).toBe('\n');
    // A copied object's string form, and [] splitting at '' (one unit dropped).
    same('a[object Object]b,c', () => ({ newline: /x/, skipFirstNLines: 1 }));
    expect(same('a,b\n1,2', () => ({ newline: [], skipFirstNLines: 1 })).data).toStrictEqual([
      ['', 'b'],
      ['1', '2'],
    ]);
  });

  it('(R) quoteChar and escapeChar other than strings throw where Papa builds its RegExp', () => {
    // Detection uses quoteChar || '"'; the full path escapes both.
    bothThrow('a,b', () => ({ quoteChar: 5 }), 'string.replace is not a function');
    expect(same('a,b', () => ({ quoteChar: 5, newline: '\n' })).data).toStrictEqual([['a', 'b']]);
    bothThrow('5,b', () => ({ quoteChar: 5, newline: '\n' }), 'string.replace is not a function');
    same('5,"b"', () => ({ quoteChar: 5, newline: '\n', fastMode: true }));
    same('a,"b"', () => ({ quoteChar: 0 }));
    bothThrow(
      '"a",b',
      () => ({ escapeChar: null }),
      "Cannot read properties of null (reading 'replace')",
    );
    same('a,b', () => ({ escapeChar: null }));
  });

  it('(R) comments, skipEmptyLines and fastMode are read as Papa reads them', () => {
    // Upstream "Bad comments value specified": comments 5 is no comments.
    expect(same('a,b\n5c\nd,e', () => ({ comments: 5 })).data).toStrictEqual([
      ['a', 'b'],
      ['5c'],
      ['d', 'e'],
    ]);
    same('a\n#b\n"c"', () => ({ comments: '\n' }));
    bothThrow(
      'a,b',
      () => ({ comments: ',', delimiter: '"' }),
      'Comment character same as delimiter',
    );
    expect(same('a\n\n \nb', () => ({ skipEmptyLines: 'x' })).data).toStrictEqual([
      ['a'],
      [' '],
      ['b'],
    ]);
    expect(same('"a,b",c', () => ({ fastMode: 0 })).data).toStrictEqual([['a,b', 'c']]);
    expect(same('"a,b",c', () => ({ fastMode: 1 })).data).toStrictEqual([['"a', 'b"', 'c']]);
  });

  it('(R) preview: numeric strings, plus one with a header; non-numeric is no limit', () => {
    const input = 'a,b\n1,2\n3,4';
    expect(same(input, () => ({ preview: ' 1 ', header: true })).data).toStrictEqual([
      { a: '1', b: '2' },
    ]);
    expect(same(input, () => ({ preview: 'abc' })).meta.truncated).toBe(false);
    expect(same(input, () => ({ preview: Infinity })).meta.truncated).toBe(false);
    // '0' with a header is one record: the header alone.
    expect(same(input, () => ({ preview: '0', header: true })).data).toStrictEqual([]);
    // P3-b: Papa's two paths disagree on these.
    for (const preview of ['0', [], 1.5, -1]) {
      expect(() => papaParse(input, { preview })).toThrow('"preview"');
    }
  });

  it('(R) delimitersToGuess: falsy means the defaults; a string is read by index; a falsy entry never wins', () => {
    expect(same('a;b\n1;2', () => ({ delimitersToGuess: 0 })).meta.delimiter).toBe(';');
    expect(same('a;b\n1;2', () => ({ delimitersToGuess: ',;' })).meta.delimiter).toBe(';');
    expect(same('a,b\n1,2', () => ({ delimitersToGuess: [0] })).errors).toMatchObject([
      { code: 'UndetectableDelimiter' },
    ]);
    expect(same('a,b\n1,2', () => ({ delimitersToGuess: [5] })).errors).toStrictEqual([]);
    same('a,b', () => ({ delimitersToGuess: {} }));
  });

  it('(R) a transformHeader result that is not a string is the name (papaparse.js 1690-1715)', () => {
    const numbers = same('a,b\n1,2', () => ({
      header: true,
      transformHeader: (_h: string, i: number) => i,
    }));
    expect(numbers.meta.fields).toStrictEqual([0, 1]);
    expect(numbers.data).toStrictEqual([{ 0: '1', 1: '2' }]);
    // Counted by property key, so 0 and '0' are repeats; renamed as strings.
    const renamed = same('a,b,c\n1,2,3', () => ({
      header: true,
      transformHeader: (_h: string, i: number) => (i === 2 ? '0' : 0),
    }));
    expect(renamed.meta.fields).toStrictEqual([0, '0_1', '0_2']);
    expect(renamed.meta.renamedHeaders).toStrictEqual({ '0_1': 0, '0_2': '0' });
    // skipEmptyLines reads a name by its length: [] is empty, undefined throws.
    same('a\n1\n2', () => ({ header: true, skipEmptyLines: true, transformHeader: () => [] }));
    bothThrow(
      'a\n1',
      () => ({ header: true, skipEmptyLines: true, transformHeader: () => undefined }),
      "Cannot read properties of undefined (reading 'length')",
    );
  });

  it('(R) dynamicTyping: a map types the fields whose own value is true; arrays are maps (1192)', () => {
    expect(same('a,b\n1,2', () => ({ dynamicTyping: [true] })).data).toStrictEqual([
      ['a', 'b'],
      [1, '2'],
    ]);
    expect(
      same('a,b\n1,2', () => ({ header: true, dynamicTyping: { a: 1, b: true } })).data,
    ).toStrictEqual([{ a: '1', b: 2 }]);
    expect(same('1,2', () => ({ dynamicTyping: 'abc' })).data).toStrictEqual([['1', '2']]);
  });

  it('(R) a transform, transformHeader or delimiter that is not a function is ignored or coerced', () => {
    expect(
      same('a,b\n1,2', () => ({ header: true, transform: 'x', transformHeader: 5 })).data,
    ).toStrictEqual([{ a: '1', b: '2' }]);
    expect(same('a;b', () => ({ delimiter: () => 5 })).data).toStrictEqual([['a;b']]);
    expect(same('a;b', () => ({ delimiter: () => '"' })).meta.delimiter).toBe(',');
  });

  it("(R) inherited enumerable config keys count, as in Papa's copy (papaparse.js 1860-1868)", () => {
    expect(same('a;b', () => Object.create({ delimiter: ';' }) as object).data).toStrictEqual([
      ['a', 'b'],
    ]);
  });

  it("keeps the main entry's D3 checks (UnsupportedFeatureError, TypeError otherwise)", () => {
    expect(() => papaParse('a', { worker: true })).toThrow(
      expect.objectContaining({ name: 'UnsupportedFeatureError', feature: 'worker' }) as Error,
    );
    // Papa ignores worker: 1 in Node; both entries reject it (D3 as in the main entry).
    expect(() => papaParse('a', { worker: 1 })).toThrow(TypeError);
    expect(papaParse('a', { worker: false, encoding: '', unknownKey: 1 }).data).toStrictEqual([
      ['a'],
    ]);
  });

  it('(R) a function config is read by its own keys, as Papa reads it (papaparse.js 101-112)', () => {
    const config = () => Object.assign(() => undefined, { delimiter: ';' });
    expect(same('a;b', config).data).toStrictEqual([['a', 'b']]);
  });

  it('(R) a Symbol from transformHeader is the field name', () => {
    const name = Symbol('h');
    const result = same('a\n1', () => ({ header: true, transformHeader: () => name }));
    expect(result.meta.fields).toStrictEqual([name]);
    expect(result.data).toStrictEqual([{ [name]: '1' }]);
  });
});

describe('error messages (D2-l)', () => {
  const caught = (call: () => unknown): unknown => {
    try {
      call();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const expectTypeError = (call: () => unknown, message: string) => {
    const error = caught(call);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(message);
  };
  const BOM = '"\\ufeff"';
  const DELIMITER = `a non-empty string other than '"' and ${BOM}`;
  const LINE_BREAKS = 'free of "\\r" and "\\n"';
  // Every message the main entry's parse creates that is not Papa's, in full:
  // each names the option or the input kind.
  const MAIN: ReadonlyArray<readonly [string, unknown, unknown, string]> = [
    ['input null', null, undefined, 'Expected a string input, got null'],
    ['input undefined', undefined, undefined, 'Expected a string input, got undefined'],
    ['input true', true, undefined, 'Expected a string input, got boolean'],
    ['config []', 'a', [], 'Parse config must be a plain object'],
    ['an unknown key', 'a', { delimitr: ',' }, 'Unknown parse option "delimitr"'],
    ["delimiter '\"'", 'a', { delimiter: '"' }, `Parse option "delimiter" must be ${DELIMITER}`],
    [
      "a delimiter function returning '\"'",
      'a',
      { delimiter: () => '"' },
      `Parse option "delimiter" must be ${DELIMITER}`,
    ],
    [
      "newline 'x'",
      'a',
      { newline: 'x' },
      'Parse option "newline" must be "\\n", "\\r\\n", "\\r" or \'\'',
    ],
    [
      "quoteChar ''",
      'a',
      { quoteChar: '' },
      'Parse option "quoteChar" must be one UTF-16 code unit',
    ],
    ['escapeChar 5', 'a', { escapeChar: 5 }, 'Parse option "escapeChar" must be a string'],
    ["header 'yes'", 'a', { header: 'yes' }, 'Parse option "header" must be a boolean'],
    [
      'comments 5',
      'a',
      { comments: 5 },
      `Parse option "comments" must be a boolean or a string other than '"' and ${BOM}`,
    ],
    [
      "skipEmptyLines 'yes'",
      'a',
      { skipEmptyLines: 'yes' },
      'Parse option "skipEmptyLines" must be a boolean or "greedy"',
    ],
    [
      'preview -1',
      'a',
      { preview: -1 },
      'Parse option "preview" must be a non-negative safe integer',
    ],
    [
      'skipFirstNLines 1.5',
      'a',
      { skipFirstNLines: 1.5 },
      'Parse option "skipFirstNLines" must be a non-negative safe integer',
    ],
    ["fastMode 'yes'", 'a', { fastMode: 'yes' }, 'Parse option "fastMode" must be a boolean'],
    [
      "delimitersToGuess 'x'",
      'a',
      { delimitersToGuess: 'x' },
      'Parse option "delimitersToGuess" must be an array',
    ],
    [
      "delimitersToGuess ['\"']",
      'a',
      { delimitersToGuess: ['"'] },
      `Parse option "delimitersToGuess" must be ${DELIMITER}`,
    ],
    [
      'transformHeader 5',
      'a',
      { transformHeader: 5 },
      'Parse option "transformHeader" must be a function',
    ],
    [
      'a transformHeader result 5',
      'a',
      { header: true, transformHeader: () => 5 },
      'Parse option "transformHeader" must return a string',
    ],
    [
      "dynamicTyping 'yes'",
      'a',
      { dynamicTyping: 'yes' },
      'Parse option "dynamicTyping" must be a boolean, a plain object of booleans or a function',
    ],
    ['transform 5', 'a', { transform: 5 }, 'Parse option "transform" must be a function'],
  ];
  it.each(MAIN)('main entry: %s', (_label, input, config, message) => {
    expectTypeError(() => parse(input as string, config as ParseConfig), message);
  });

  // The D3, P3-a and P3-c messages, the same in both entries.
  const BOTH: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['worker 1 (D3)', { worker: 1 }, 'Parse option "worker" must be false'],
    ['encoding 5 (D3)', { encoding: 5 }, 'Parse option "encoding" must be ""'],
    ["chunkSize 'x' (D3)", { chunkSize: 'x' }, 'Parse option "chunkSize" must be omitted'],
    [
      "a delimiter function returning '' (P3-a)",
      { delimiter: () => '' },
      `Parse option "delimiter" must be ${DELIMITER}`,
    ],
    [
      "delimitersToGuess [''] (P3-a)",
      { delimitersToGuess: [''] },
      `Parse option "delimitersToGuess" must be ${DELIMITER}`,
    ],
    [
      'a delimiter with a line break (P3-c)',
      { delimiter: ',\n' },
      `Parse option "delimiter" must be ${LINE_BREAKS}`,
    ],
    [
      'comments with a line break (P3-c)',
      { comments: '#\n' },
      `Parse option "comments" must be ${LINE_BREAKS}`,
    ],
  ];
  it.each(BOTH)('both entries: %s', (_label, config, message) => {
    expectTypeError(() => parse('a', config as ParseConfig), message);
    expectTypeError(() => papaEntry.parse('a', config), message);
  });

  it('csvloom/papa: a preview Papa cannot count (P3-b)', () => {
    expectTypeError(
      () => papaEntry.parse('a', { preview: -1 }),
      'Parse option "preview" must be a whole number of records, positive without header (or not numeric)',
    );
  });

  it('both entries: UnsupportedFeatureError names the feature', () => {
    for (const run of [parse, papaEntry.parse] as Array<
      (input: unknown, config?: unknown) => unknown
    >) {
      const cases: Array<[unknown, unknown, string]> = [
        ['a', { worker: true }, 'worker'],
        [1, undefined, 'NODE_STREAM_INPUT'],
        [{}, undefined, 'non-string input'],
      ];
      for (const [input, config, feature] of cases) {
        const error = caught(() => run(input, config));
        expect(error).toBeInstanceOf(UnsupportedFeatureError);
        expect((error as Error).message).toBe(`"${feature}" is not supported by csvloom`);
      }
    }
  });
});
