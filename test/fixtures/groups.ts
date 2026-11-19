import type Papa from 'papaparse';

// Small correctness fixtures, in groups. Each expected value is what
// csvloom/papa returns: Papa Parse 5.7.1 behavior unless an
// exception applies (those live in test/papa-deviations.test.ts).
// Streaming-only items (UTF-8 and CRLF split across chunks) are covered by the
// S1 edge matrix in test/adapter-edges.ts; surrogate splits across string
// chunks, interleaved incremental parsers and abort are covered by the
// csvloom/stream tests.

export type Group =
  | 'basic'
  | 'quoting'
  | 'line-endings'
  | 'unicode'
  | 'headers'
  | 'conversion'
  | 'delimiters'
  | 'comments-whitespace'
  | 'limits'
  | 'reentrancy'
  | 'errors';

export interface ParseFixture {
  id: string;
  group: Group;
  input: string;
  config: Papa.ParseConfig<unknown>;
  /** The runner adds a transform that calls the same parser on another input. */
  reentrant?: true;
  expected:
    | { data: unknown[]; errors?: Array<Partial<Papa.ParseError>>; meta?: Partial<Papa.ParseMeta> }
    | { throws: string | RegExp };
}

export interface UnparseFixture {
  id: string;
  input: unknown;
  config?: Papa.UnparseConfig;
  expected: string;
}

const C = { delimiter: ',' } as const;
const longField = 'x,"y" '.repeat(2000);
const wide = Array.from({ length: 10_000 }, (_, i) => `c${String(i)}`);

export const PARSE_FIXTURES: ParseFixture[] = [
  // basic
  { id: 'empty-string', group: 'basic', input: '', config: C, expected: { data: [], errors: [] } },
  { id: 'one-field', group: 'basic', input: 'a', config: C, expected: { data: [['a']] } },
  {
    id: 'empty-field',
    group: 'basic',
    input: 'a,,c',
    config: C,
    expected: { data: [['a', '', 'c']] },
  },
  {
    id: 'trailing-delimiter',
    group: 'basic',
    input: 'a,b,',
    config: C,
    expected: { data: [['a', 'b', '']] },
  },
  {
    id: 'trailing-newline',
    group: 'basic',
    input: 'a,b\n',
    config: C,
    expected: { data: [['a', 'b'], ['']] },
  },
  {
    id: 'final-row-without-newline',
    group: 'basic',
    input: 'a\nb',
    config: C,
    expected: { data: [['a'], ['b']] },
  },

  // quoting
  {
    id: 'embedded-delimiter',
    group: 'quoting',
    input: 'a,"b,c"',
    config: C,
    expected: { data: [['a', 'b,c']] },
  },
  {
    id: 'doubled-quote',
    group: 'quoting',
    input: '"a""b"',
    config: C,
    expected: { data: [['a"b']] },
  },
  {
    id: 'multiline-field',
    group: 'quoting',
    input: '"a\nb",c',
    config: C,
    expected: { data: [['a\nb', 'c']] },
  },
  {
    id: 'long-quoted-field',
    group: 'quoting',
    input: `"${longField.replaceAll('"', '""')}",end`,
    config: C,
    expected: { data: [[longField, 'end']] },
  },
  {
    id: 'missing-closing-quote',
    group: 'quoting',
    input: 'a,"b',
    config: C,
    expected: {
      data: [['a', 'b']],
      errors: [
        {
          type: 'Quotes',
          code: 'MissingQuotes',
          message: 'Quoted field unterminated',
          row: 0,
          index: 3,
        },
      ],
    },
  },

  // line endings
  {
    id: 'lf',
    group: 'line-endings',
    input: 'a\nb',
    config: C,
    expected: { data: [['a'], ['b']], meta: { linebreak: '\n' } },
  },
  {
    id: 'crlf',
    group: 'line-endings',
    input: 'a\r\nb',
    config: C,
    expected: { data: [['a'], ['b']], meta: { linebreak: '\r\n' } },
  },
  {
    id: 'cr',
    group: 'line-endings',
    input: 'a\rb',
    config: C,
    expected: { data: [['a'], ['b']], meta: { linebreak: '\r' } },
  },
  {
    id: 'crlf-inside-quotes-lf-records',
    group: 'line-endings',
    input: '"a\r\nb"\nc',
    config: { ...C, newline: '\n' },
    expected: { data: [['a\r\nb'], ['c']] },
  },

  // unicode (no normalization: code points are preserved as written)
  {
    id: 'turkish',
    group: 'unicode',
    input: 'İ,ı\nŞ,ğ',
    config: C,
    expected: {
      data: [
        ['İ', 'ı'],
        ['Ş', 'ğ'],
      ],
    },
  },
  {
    id: 'cjk',
    group: 'unicode',
    input: '名前,東京\n서울,ソウル',
    config: C,
    expected: {
      data: [
        ['名前', '東京'],
        ['서울', 'ソウル'],
      ],
    },
  },
  {
    id: 'emoji-zwj-flag',
    group: 'unicode',
    input: '👩🏽‍💻,🇹🇷',
    config: C,
    expected: { data: [['👩🏽‍💻', '🇹🇷']] },
  },
  {
    id: 'combining-marks',
    group: 'unicode',
    input: 'é,ñ',
    config: C,
    expected: { data: [['é', 'ñ']] },
  },
  {
    id: 'bom-before-header',
    group: 'unicode',
    input: '﻿a,b\n1,2',
    config: { ...C, header: true },
    expected: { data: [{ a: '1', b: '2' }], meta: { fields: ['a', 'b'] } },
  },

  // headers
  {
    id: 'empty-header',
    group: 'headers',
    input: ',b\n1,2',
    config: { ...C, header: true },
    expected: { data: [{ '': '1', b: '2' }] },
  },
  {
    id: 'duplicate-headers',
    group: 'headers',
    input: 'a,a\n1,2',
    config: { ...C, header: true },
    expected: {
      data: [{ a: '1', a_1: '2' }],
      meta: { fields: ['a', 'a_1'], renamedHeaders: { a_1: 'a' } },
    },
  },
  {
    id: 'collision-after-transform',
    group: 'headers',
    input: 'A,a\n1,2',
    config: { ...C, header: true, transformHeader: (h) => h.toLowerCase() },
    expected: { data: [{ a: '1', a_1: '2' }], meta: { fields: ['a', 'a_1'] } },
  },
  {
    id: 'extra-and-missing-fields',
    group: 'headers',
    input: 'a,b\n1,2,3\n4',
    config: { ...C, header: true },
    expected: {
      data: [{ a: '1', b: '2', __parsed_extra: ['3'] }, { a: '4' }],
      errors: [
        { code: 'TooManyFields', row: 0 },
        { code: 'TooFewFields', row: 1 },
      ],
    },
  },
  {
    id: 'constructor-prototype-headers',
    group: 'headers',
    input: 'constructor,prototype\nx,y',
    config: { ...C, header: true },
    expected: { data: [{ constructor: 'x', prototype: 'y' }] },
  },
  {
    // meta.fields keeps header order; the row object enumerates integer-like keys first.
    id: 'integer-like-headers',
    group: 'headers',
    input: '10,2\na,b',
    config: { ...C, header: true },
    expected: { data: [{ 10: 'a', 2: 'b' }], meta: { fields: ['10', '2'] } },
  },

  // conversion
  {
    id: 'typing-rules',
    group: 'conversion',
    input: '007| 5 |TRUE|1e3|9007199254740991|9007199254740992|2020-01-02|2020-01-02T03:04:05Z|',
    config: { delimiter: '|', dynamicTyping: true },
    expected: {
      data: [
        [
          7,
          5,
          true,
          1000,
          9007199254740991,
          '9007199254740992',
          '2020-01-02',
          new Date('2020-01-02T03:04:05Z'),
          null,
        ],
      ],
    },
  },
  {
    id: 'typing-edge-values',
    group: 'conversion',
    // Whitespace and U+FEFF around digits,
    // underflow, rounding to 2^53, '1.e2', a non-ASCII digit. (The ISO-shaped
    // invalid date is in test/parse.test.ts: Node 22's isDeepStrictEqual finds
    // two invalid Dates unequal.)
    input: '1 | 5|\ufeff5|\u00a05|1e-400|-1e-400|9007199254740991.5|1.e2|\u0661',
    config: { delimiter: '|', dynamicTyping: true },
    expected: {
      data: [[1, 5, 5, 5, 0, -0, '9007199254740991.5', 100, '\u0661']],
    },
  },
  {
    id: 'typing-map-after-transform-header',
    group: 'conversion',
    input: 'A,B\n1,2,3\n4,5',
    config: {
      ...C,
      header: true,
      transformHeader: (h) => h.toLowerCase(),
      dynamicTyping: { a: true, __parsed_extra: true },
    },
    expected: {
      data: [
        { a: 1, b: '2', __parsed_extra: [3] },
        { a: 4, b: '5' },
      ],
      errors: [{ code: 'TooManyFields', row: 0 }],
    },
  },
  {
    id: 'transform-before-typing',
    group: 'conversion',
    input: '1,2',
    config: { ...C, dynamicTyping: true, transform: (v: string) => `${v}0` },
    expected: { data: [[10, 20]] },
  },
  {
    id: 'transform-fields-with-header',
    group: 'conversion',
    // A renamed duplicate and the extra fields reach transform by name.
    input: 'a,a\n1,2,3',
    config: {
      ...C,
      header: true,
      transform: (v: string, f: string | number) => `${String(f)}:${v}`,
    },
    expected: {
      data: [{ a: 'a:1', a_1: 'a_1:2', __parsed_extra: ['__parsed_extra:3'] }],
      errors: [{ code: 'TooManyFields', row: 0 }],
    },
  },

  // delimiters
  {
    id: 'explicit-semicolon',
    group: 'delimiters',
    input: 'a;b',
    config: { delimiter: ';' },
    expected: { data: [['a', 'b']] },
  },
  {
    id: 'multi-character',
    group: 'delimiters',
    input: 'a::b',
    config: { delimiter: '::' },
    expected: { data: [['a', 'b']] },
  },
  {
    id: 'function-delimiter',
    group: 'delimiters',
    input: 'a|b',
    config: { delimiter: () => '|' },
    expected: { data: [['a', 'b']], meta: { delimiter: '|' } },
  },
  {
    id: 'auto-tab',
    group: 'delimiters',
    input: 'a\tb\n1\t2',
    config: {},
    expected: {
      data: [
        ['a', 'b'],
        ['1', '2'],
      ],
      meta: { delimiter: '\t' },
    },
  },
  {
    id: 'delimiter-inside-quotes',
    group: 'delimiters',
    input: '"a;b";c',
    config: { delimiter: ';' },
    expected: { data: [['a;b', 'c']] },
  },

  // comments and whitespace
  {
    id: 'comment-line',
    group: 'comments-whitespace',
    input: '#x\na,b',
    config: { ...C, comments: '#' },
    expected: { data: [['a', 'b']] },
  },
  {
    id: 'comment-marker-in-quotes',
    group: 'comments-whitespace',
    input: '"#x",b',
    config: { ...C, comments: '#' },
    expected: { data: [['#x', 'b']] },
  },
  {
    id: 'whitespace-only-fields',
    group: 'comments-whitespace',
    input: ' , \n\t',
    config: C,
    expected: { data: [[' ', ' '], ['\t']] },
  },
  {
    id: 'greedy-skip',
    group: 'comments-whitespace',
    input: 'a\n \t\n,\nb',
    config: { ...C, skipEmptyLines: 'greedy' },
    expected: { data: [['a'], ['b']] },
  },

  // limits
  {
    id: 'preview',
    group: 'limits',
    input: 'a\nb\nc',
    config: { ...C, preview: 1 },
    expected: { data: [['a']], meta: { truncated: true } },
  },
  {
    id: 'skip-first-lines',
    group: 'limits',
    input: 'x\na,b',
    config: { ...C, skipFirstNLines: 1 },
    expected: { data: [['a', 'b']] },
  },
  {
    id: 'large-unquoted-field',
    group: 'limits',
    input: `${'y'.repeat(1 << 20)},z`,
    config: C,
    expected: { data: [['y'.repeat(1 << 20), 'z']] },
  },
  {
    id: 'very-wide-row',
    group: 'limits',
    input: wide.join(','),
    config: C,
    expected: { data: [wide] },
  },
  {
    id: 'consecutive-blank-lines',
    group: 'limits',
    input: 'a\n\n\n\nb',
    config: C,
    expected: { data: [['a'], [''], [''], [''], ['b']] },
  },

  // reentrancy: a callback that starts another parse does not disturb the outer one
  {
    id: 'parse-inside-transform',
    group: 'reentrancy',
    input: 'a,b\nc,d',
    config: C,
    reentrant: true,
    expected: {
      data: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    },
  },

  // errors
  {
    id: 'comment-equals-delimiter',
    group: 'errors',
    input: 'a,b',
    config: { ...C, comments: ',' },
    expected: { throws: 'Comment character same as delimiter' },
  },
  {
    id: 'transform-throws',
    group: 'errors',
    input: 'a',
    config: {
      ...C,
      transform: () => {
        throw new Error('boom');
      },
    },
    expected: { throws: 'boom' },
  },
];

export const UNPARSE_FIXTURES: UnparseFixture[] = [
  {
    id: 'date-null-undefined',
    input: [[new Date(0), null, undefined, new Date(Number.NaN)]],
    expected: '1970-01-01T00:00:00.000Z,,,',
  },
  // '"' stays in Papa's BAD_DELIMITERS even when quoteChar is "'", so a"b is quoted too.
  {
    id: 'custom-quote-and-escape',
    input: [['a"b', 'c,d']],
    config: { quoteChar: "'", escapeChar: '\\' },
    expected: "'a\"b','c,d'",
  },
  { id: 'forced-quotes', input: [['a', 1]], config: { quotes: true }, expected: '"a","1"' },
  {
    id: 'header-order-from-columns',
    input: [{ a: 1, b: 2 }],
    config: { columns: ['b', 'a'] },
    expected: 'b,a\r\n2,1',
  },
  {
    id: 'escape-formulae-simple',
    input: [['=1+1', 'a']],
    config: { escapeFormulae: true },
    expected: '"\'=1+1",a',
  },
];
