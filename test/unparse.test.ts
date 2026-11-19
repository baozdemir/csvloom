import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as chai from 'chai';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import papaEntry from '../src/papa.ts';
import { parse } from '../src/parse.ts';
import type { UnparseConfig, UnparseInput } from '../src/types.ts';
import { unparse } from '../src/unparse.ts';
import { mulberry32 } from '../bench/fixtures.ts';
import { PLAIN_NUMBER } from '../src/options.ts';
import {
  D4A_FORMULA,
  fuzzUnparse,
  SIGNED_NUMBERS,
  unparseArrays,
  unparseObjects,
  unparseValue,
} from './differential.ts';
import { UNPARSE_FIXTURES } from './fixtures/groups.ts';

// Direct tests for the main entry's unparse. Expected values are
// written out by hand; tests marked (R) also assert them for the live
// reference, Papa Parse 5.7.1, which gets its own copy of the input because it
// writes into {data} inputs.

const papa = (input: unknown, config?: UnparseConfig) =>
  Papa.unparse(structuredClone(input) as unknown[][], config as Papa.UnparseConfig);
/** (R) Both libraries give expected. */
const both = (input: unknown, config: UnparseConfig | undefined, expected: string) => {
  expect(unparse(input as UnparseInput, config)).toBe(expected);
  expect(papa(input, config)).toBe(expected);
};
/** fn, recording the arguments of each call in `calls`. */
const rec = <A extends unknown[], R>(fn: (...args: A) => R) => {
  const calls: A[] = [];
  return Object.assign(
    (...args: A) => {
      calls.push(args);
      return fn(...args);
    },
    { calls },
  );
};

describe('R12 unparse inputs', () => {
  it('(R) arrays of arrays, objects and {fields, data}', () => {
    both(
      [
        ['a', 'b'],
        ['1', '2'],
      ],
      undefined,
      'a,b\r\n1,2',
    );
    both(
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      undefined,
      'a,b\r\n1,2\r\n3,4',
    );
    both({ fields: ['x', 'y'], data: [[1, 2]] }, undefined, 'x,y\r\n1,2');
    both({ fields: ['b'], data: [{ a: 1, b: 2 }] }, undefined, 'b\r\n2');
    both([], undefined, '');
  });

  it('(R) object columns come from the first object only (D2-j)', () => {
    both([{ a: 1 }, { a: 2, b: 3 }], undefined, 'a\r\n1\r\n2');
    both([{ a: 1, b: 2 }, { b: 3 }], undefined, 'a,b\r\n1,2\r\n,3');
  });

  it('(R) serializes non-string values', () => {
    const row = [null, undefined, true, 1.5, -0, NaN, new Date(0), new Date(NaN), { x: 1 }, [1, 2]];
    both([row], undefined, ',,true,1.5,0,NaN,1970-01-01T00:00:00.000Z,,[object Object],"1,2"');
  });

  it('(R) quotes delimiters, quotes, line breaks, BOM and edge spaces', () => {
    both(
      [['a,b', 'c"d', 'e\nf', ' g', 'h ', 'i\rj', '\ufeffk']],
      undefined,
      '"a,b","c""d","e\nf"," g","h ","i\rj","\ufeffk"',
    );
  });

  it('(R) {data} inputs: a JSON string, primitives as one record, meta.fields, no data', () => {
    both({ fields: ['a', 'b'], data: '[[1,2],[3,4]]' }, undefined, 'a,b\r\n1,2\r\n3,4');
    both({ data: [1, 2, 3] }, undefined, '1,2,3');
    both({ data: [{ a: 1, b: 2 }], meta: { fields: ['b'] } }, undefined, 'b\r\n2');
    both({ fields: ['a', 'b'] }, undefined, 'a,b');
    both({ data: [[1, 2]] }, undefined, '1,2');
    both('[["a","b"],[1,null]]', undefined, 'a,b\r\n1,');
  });

  it('does not modify the input (D2-a)', () => {
    const inputs = [
      { data: [1, 2] },
      { fields: ['a'], data: '[[1]]' },
      { data: [{ a: 1 }], meta: { fields: ['a'] } },
      { data: [] },
    ];
    for (const input of inputs) {
      const before = structuredClone(input);
      unparse(input);
      expect(input).toStrictEqual(before);
    }
  });

  it('(R) throws on unrecognized input', () => {
    // @ts-expect-error -- an input outside UnparseInput
    expect(() => unparse(5)).toThrow('Unable to serialize unrecognized input');
    // @ts-expect-error -- an input outside UnparseInput
    expect(() => Papa.unparse(5)).toThrow('Unable to serialize unrecognized input');
    for (const input of [['a', 'b'], '"x"']) {
      expect(() => unparse(input as UnparseInput)).toThrow(
        'Unable to serialize unrecognized input',
      );
      expect(() => papa(input)).toThrow('Unable to serialize unrecognized input');
    }
    // The main entry names undefined as the input kind instead (D2-l).
    expect(() => papa(undefined)).toThrow('Unable to serialize unrecognized input');
  });
});

describe('R13 unparse options', () => {
  it('(R) quotes: boolean, per-column array and function', () => {
    both([['a', 1]], { quotes: true }, '"a","1"');
    both([['a', 'b']], { quotes: [false, true] }, 'a,"b"');
    both([['a', 'b']], { quotes: (_value, col) => col === 0 }, '"a",b');
  });

  it('(R) quoteChar, escapeChar and delimiter', () => {
    both([['a,b']], { quoteChar: "'" }, "'a,b'");
    both([['a"b']], { escapeChar: '\\' }, '"a\\"b"');
    both([['a', 'b']], { delimiter: ';' }, 'a;b');
    both([['a', 'b']], { delimiter: '::' }, 'a::b');
  });

  it('a delimiter with "\\n" throws a TypeError, where Papa uses "," (D2-k)', () => {
    expect(() => unparse([['a', 'b']], { delimiter: '\n' })).toThrow(TypeError);
    expect(Papa.unparse([['a', 'b']], { delimiter: '\n' })).toBe('a,b');
  });

  it('(R) header, newline and columns', () => {
    both([{ a: 1 }], { header: false }, '1');
    both([['a'], ['b']], { newline: '\n' }, 'a\nb');
    both([{ a: 1, b: 2, c: 3 }], { columns: ['c', 'a'] }, 'c,a\r\n3,1');
    // Papa Parse 5.7.1: an empty array with columns writes their header.
    both([], { columns: ['c', 'a'] }, 'c,a');
    both('[]', { columns: ['c', 'a'] }, 'c,a');
    both([], { columns: ['c', 'a'], header: false }, '');
    expect(papaEntry.unparse([], { columns: ['c', 'a'] })).toBe('c,a');
    expect(() => unparse([{ a: 1 }], { columns: [] })).toThrow('Option columns is empty');
    expect(() => Papa.unparse([{ a: 1 }], { columns: [] })).toThrow('Option columns is empty');
  });

  it('(R) skipEmptyLines', () => {
    both([['a'], [''], [], ['b']], { skipEmptyLines: true }, 'a\r\nb');
    both([['a'], [' ', ''], ['b']], { skipEmptyLines: 'greedy' }, 'a\r\nb');
    both([{ a: 1 }, {}, { a: 2 }], { skipEmptyLines: true }, 'a\r\n1\r\n2');
    both(
      {
        fields: ['a', 'b'],
        data: [
          ['1', '2'],
          [' ', ''],
        ],
      },
      { skipEmptyLines: 'greedy' },
      'a,b\r\n1,2\r\n',
    );
    // The line break before left-out last records stays.
    both([['a'], [''], []], { skipEmptyLines: true }, 'a\r\n');
    // Papa Parse 5.7.1: a record that holds only null or undefined is empty.
    for (const [input, expected] of [
      [[[null]], ''],
      [[[1], [undefined]], '1\r\n'],
      [[[null], ['a'], [undefined], ['b']], 'a\r\nb'],
    ] as const) {
      both(input, { skipEmptyLines: true }, expected);
      expect(papaEntry.unparse(input, { skipEmptyLines: true })).toBe(expected);
    }
  });

  it('(R) escapeFormulae prefixes risky strings but not numbers', () => {
    const input = [['=1+1', '+1', '-1', '@x', '\tx', '\rx', -1, 'a=b']];
    // Main entry (D4-a): the plain numbers '+1' and '-1' are left alone.
    expect(unparse(input, { escapeFormulae: true })).toBe(
      '"\'=1+1",+1,-1,"\'@x","\'\tx","\'\rx",-1,a=b',
    );
    // csvloom/papa and the reference.
    const papaRow = '"\'=1+1","\'+1","\'-1","\'@x","\'\tx","\'\rx",-1,a=b';
    expect(papaEntry.unparse(input, { escapeFormulae: true })).toBe(papaRow);
    expect(papa(input, { escapeFormulae: true })).toBe(papaRow);
    both([['!x', '=y']], { escapeFormulae: /^!/ }, '"\'!x",=y');
  });

  it('escapeFormulae: true prefixes a risky string that contains a line break (D2-i)', () => {
    const input = [['=1\n2', '=HYPERLINK("x")\n']];
    expect(unparse(input, { escapeFormulae: true })).toBe('"\'=1\n2","\'=HYPERLINK(""x"")\n"');
    expect(papa(input, { escapeFormulae: true })).toBe('"=1\n2","=HYPERLINK(""x"")\n"');
  });

  it('(R) escapeFormulae tests the string form of arrays, objects, wrappers, functions and symbols, as Papa Parse 5.7.1 does', () => {
    const toString = { toString: () => '@SUM(A1)' };
    const fn = Object.assign(() => 0, { toString: () => '=f()' });
    // Input, main entry, csvloom/papa and the reference.
    const cases: Array<[unknown[][], string, string]> = [
      [[[['=1+1']]], '"\'=1+1"', '"\'=1+1"'],
      [[[toString]], '"\'@SUM(A1)"', '"\'@SUM(A1)"'],
      [[[new String('+x')]], '"\'+x"', '"\'+x"'],
      [[[fn]], '"\'=f()"', '"\'=f()"'],
      // A wrapper is an object: its string form is tested; the main rule (D4-a)
      // leaves the plain number '-5' alone.
      [[[new Number(-5)]], '-5', '"\'-5"'],
      // Numbers, bigints and booleans are not.
      [[[-5, true, 5n]], '-5,true,5', '-5,true,5'],
    ];
    for (const [input, engine, papaRow] of cases) {
      expect(unparse(input, { escapeFormulae: true })).toBe(engine);
      expect(papaEntry.unparse(input, { escapeFormulae: true })).toBe(papaRow);
      expect(Papa.unparse(input, { escapeFormulae: true })).toBe(papaRow);
    }
    // A symbol is tested by its string form too.
    const symbol = [[Symbol('x')]];
    const prefixed = '"\'Symbol(x)"';
    expect(unparse(symbol, { escapeFormulae: /^S/ })).toBe(prefixed);
    expect(papaEntry.unparse(symbol, { escapeFormulae: /^S/ })).toBe(prefixed);
    expect(Papa.unparse(symbol, { escapeFormulae: /^S/ })).toBe(prefixed);
    expect(unparse(symbol, { escapeFormulae: true })).toBe('Symbol(x)');
    // (R) With escapeFormulae false both write the string form as is; by default
    // the main entry prefixes it (F6-a) and csvloom/papa does not.
    both([[['=1+1']]], { escapeFormulae: false }, '=1+1');
    expect(unparse([[['=1+1']]])).toBe('"\'=1+1"');
    expect(papaEntry.unparse([[['=1+1']]])).toBe('=1+1');
    expect(Papa.unparse([[['=1+1']]])).toBe('=1+1');
    // The test call on the array's string form advances a g RegExp, in each library.
    const engine = /^=/g;
    const reference = /^=/g;
    unparse([[['=a']]], { escapeFormulae: engine });
    Papa.unparse([[['=a']]], { escapeFormulae: reference });
    expect([engine.lastIndex, reference.lastIndex]).toStrictEqual([1, 1]);
  });

  it('(R) the quotes function is not called for null or a prefixed value', () => {
    const engine = rec(() => false);
    const reference = rec(() => false);
    const input = [['=a', 'b', null]];
    expect(unparse(input, { escapeFormulae: true, quotes: engine })).toBe('"\'=a",b,');
    expect(papa(input, { escapeFormulae: true, quotes: reference })).toBe('"\'=a",b,');
    expect(engine.calls).toStrictEqual([['b', 1]]);
    expect(reference.calls).toStrictEqual([['b', 1]]);
  });

  it('(R) a parse result is unparsed through meta.fields', () => {
    expect(unparse(parse('a,b\n1,2', { header: true }))).toBe('a,b\r\n1,2');
    expect(papa(Papa.parse('a,b\n1,2', { header: true }))).toBe('a,b\r\n1,2');
  });

  it('(R) D2-i/D2-a conflict: g flag', () => {
    // The RegExp is used as given, so its lastIndex moves as in Papa;
    // after '=a' matches, the test on '=b' starts at index 1 and fails.
    const input = [['=a'], ['=b']];
    expect(unparse(input, { escapeFormulae: /^=/g })).toBe('"\'=a"\r\n=b');
    expect(papa(input, { escapeFormulae: /^=/g })).toBe('"\'=a"\r\n=b');
    const engine = /^=/g;
    const reference = /^=/g;
    unparse([['=a']], { escapeFormulae: engine });
    papa([['=a']], { escapeFormulae: reference });
    expect(engine.lastIndex).toBe(1);
    expect(reference.lastIndex).toBe(1);
  });
});

describe('main rule: escapeFormulae true in the main entry (D4-a)', () => {
  const FIRST = ['=', '+', '-', '@', '\t', '\r', '\n', '\uff1d', '\uff0b', '\uff0d', '\uff20'];
  const on = (input: UnparseInput, config: UnparseConfig = {}) =>
    unparse(input, { ...config, escapeFormulae: true });
  const off = (input: UnparseInput) => unparse(input, { escapeFormulae: false });
  const prefixed = (text: string) => on([[text]]) !== off([[text]]);

  it('main rule: every listed first character', () => {
    expect(FIRST).toHaveLength(11);
    for (const text of [...FIRST, ...FIRST.map((first) => `${first}x`)]) {
      const expected = `"'${text}"`;
      expect(on([[text]])).toBe(expected);
      expect(on([[[text]]])).toBe(expected);
      expect(on([[{ toString: () => text }]])).toBe(expected);
      // With an ordinary character in front nothing is prefixed.
      expect(on([[`a${text}`]])).toBe(off([[`a${text}`]]));
      expect(on([[[`a${text}`]]])).toBe(off([[[`a${text}`]]]));
      expect(on([[{ toString: () => `a${text}` }]])).toBe(off([[`a${text}`]]));
    }
  });

  it('main rule: the same verdict as D4-a for every first UTF-16 unit', () => {
    const differing: string[] = [];
    for (let unit = 0; unit <= 0xffff; unit++) {
      const first = String.fromCharCode(unit);
      for (const text of [first, `${first}x`, `${first}1`]) {
        if (prefixed(text) !== D4A_FORMULA.test(text)) differing.push(text);
      }
    }
    expect(differing).toEqual([]);
  });

  it('main rule: plain numbers are left alone', () => {
    expect(PLAIN_NUMBER.source).toBe(String.raw`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`);
    expect(PLAIN_NUMBER.flags).toBe('');
    for (const text of ['-5', '+5', '-1.5', '5.', '.5', '-2e3', '+1E-2']) {
      expect(on([[text]])).toBe(text);
    }
    expect(on([[-5, -5n]])).toBe('-5,-5');
  });

  it('main rule: a number followed by anything else is escaped', () => {
    const texts = ['-', '+', '-5a', '-5 ', '-5\n=1', '+90 555 123 45 67', '-1,5', '-1,234.56'];
    for (const text of [...texts, '-3%', '+5.2%', '--5', '-.', '-e5']) {
      expect(on([[text]])).toBe(`"'${text}"`);
    }
  });

  it('main rule: a 1 MiB hostile value in under 50 ms', () => {
    const half = '1'.repeat(2 ** 19);
    for (const value of [`-${half}${half.slice(2)}x`, `+${half}.${half.slice(3)}e`]) {
      expect(value).toHaveLength(2 ** 20);
      const start = performance.now();
      const csv = on([[value]]);
      const ms = performance.now() - start;
      expect(csv).toBe(`"'${value}"`);
      expect(ms).toBeLessThan(50);
    }
  });

  it('main rule: the same verdict as a simpler number pattern on every string of up to 5 units of "+-.0eEx"', () => {
    // A simpler number pattern, quadratic on long inputs.
    const simpler = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const texts = [''];
    let level = [''];
    for (let length = 1; length <= 5; length++) {
      level = level.flatMap((text) =>
        ['+', '-', '.', '0', 'e', 'E', 'x'].map((unit) => text + unit),
      );
      texts.push(...level);
    }
    expect(texts).toHaveLength(19608);
    const differ = texts.filter(
      (text) => prefixed(text) !== (/^[+-]/.test(text) && !simpler.test(text)),
    );
    expect(differ).toStrictEqual([]);
  });

  it('one cell stays one cell', () => {
    expect(parse(unparse([['x",=1']]), { delimiter: ',' }).data).toStrictEqual([['x",=1']]);
    const value = '=a,"b\r\nc';
    expect(on([[value]])).toBe(`"'=a,""b\r\nc"`);
    expect(parse(on([[value]]), { delimiter: ',' }).data).toStrictEqual([[`'${value}`]]);
  });

  const REWRITTEN: Array<[string, string]> = [
    ['-', `"'-"`],
    ['-abc', `"'-abc"`],
    ['+90 555 123 45 67', `"'+90 555 123 45 67"`],
    ['-3%', `"'-3%"`],
    ['+5.2%', `"'+5.2%"`],
    ['-1,234.56', `"'-1,234.56"`],
    ['-1,5', `"'-1,5"`],
    ['@handle', `"'@handle"`],
    ['=1', `"'=1"`],
    ['\tx', `"'\tx"`],
    ['\nx', `"'\nx"`],
    ['\uff1d1', `"'\uff1d1"`],
  ];

  it('round trip: the strings the main rule rewrites (exact list)', () => {
    for (const [text, csv] of REWRITTEN) {
      expect(on([[text]])).toBe(csv);
      expect(parse(csv, { delimiter: ',' }).data).toStrictEqual([[`'${text}`]]);
    }
    expect(on([{ '@timestamp': '1' }])).toBe(`"'@timestamp"\r\n1`);
    for (const text of ['-5', '+1.5', '-2e3']) {
      expect(on([[text]])).toBe(text);
      expect(parse(on([[text]]), { delimiter: ',' }).data).toStrictEqual([[text]]);
    }
  });

  it('round trip: parse gives v or "\'" + v for every generated string v', () => {
    const random = mulberry32(20261109);
    const generated = Array.from({ length: 20000 }, () => unparseValue(random));
    const texts = [...generated, ...SIGNED_NUMBERS, ...FIRST.map((first) => `${first}x`)].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    expect(texts.length).toBeGreaterThan(5000);
    const differ = texts.filter((text) =>
      [unparse([[text]]), on([[text]])].some(
        (csv) =>
          parse(csv, { delimiter: ',' }).data[0]?.[0] !==
          (D4A_FORMULA.test(text) ? `'${text}` : text),
      ),
    );
    expect(differ).toStrictEqual([]);
  });

  it('main rule: the quotes function and header cells', () => {
    const quotes = rec(() => false);
    expect(on([['-abc', '-5', 'b']], { quotes })).toBe(`"'-abc",-5,b`);
    expect(quotes.calls).toStrictEqual([
      ['-5', 1],
      ['b', 2],
    ]);
    expect(on([{ '=a': '1', '@b': '-5', '-1': '+x' }])).toBe(`"'=a","'@b",-1\r\n1,-5,"'+x"`);
  });

  it('a RegExp is used as given, with no number exemption', () => {
    expect(unparse([['-5']], { escapeFormulae: /^-/ })).toBe(`"'-5"`);
  });

  it('main entry escapes formula-like strings by default', () => {
    expect(unparse([['=1+1', '@x', 'a']])).toBe(`"'=1+1","'@x",a`);
    const input = [['=1+1', '@x', 'a', '-5', '\n=1', '\uff1d1']];
    const csv = `"'=1+1","'@x",a,-5,"'\n=1","'\uff1d1"`;
    expect(unparse(input)).toBe(csv);
    expect(unparse(input, { escapeFormulae: true })).toBe(csv);
    // undefined means omitted in the main entry's config.
    const omitted: Record<string, unknown> = { escapeFormulae: undefined };
    expect(unparse(input, omitted)).toBe(csv);
  });

  it('escapeFormulae: false gives the old output', () => {
    expect(unparse([['=1+1', '@x', 'a']], { escapeFormulae: false })).toBe('=1+1,@x,a');
    const input = [['=1+1', '@x', 'a', '-5', '\n=1', '\uff1d1']];
    expect(unparse(input, { escapeFormulae: false })).toBe('=1+1,@x,a,-5,"\n=1",\uff1d1');
  });

  it('the default equals an explicit true on the seeded unparse inputs', () => {
    const random = mulberry32(20261109);
    for (let k = 0; k < 5000; k++) {
      const input = random() < 0.5 ? unparseArrays(random) : unparseObjects(random);
      expect(unparse(input)).toBe(on(input));
    }
  });

  it('the quotes function is not called for a prefixed value, by default', () => {
    const quotes = rec(() => false);
    expect(unparse([['=a', 'b', '-5']], { quotes })).toBe(`"'=a",b,-5`);
    expect(quotes.calls).toStrictEqual([
      ['b', 1],
      ['-5', 2],
    ]);
  });

  it('header cells are escaped by default', () => {
    expect(unparse([{ '=a': '1', b: '2' }])).toBe(`"'=a",b\r\n1,2`);
    expect(unparse({ fields: ['@id', 'x'], data: [['1', '2']] })).toBe(`"'@id",x\r\n1,2`);
  });

  it('round trip keeps signed numbers', () => {
    const text = 'a,b\n-5,+1.5\n-2e3,-0.5';
    expect(unparse(parse(text, { delimiter: ',' }).data)).toBe('a,b\r\n-5,+1.5\r\n-2e3,-0.5');
    expect(unparse(parse(text, { delimiter: ',', header: true }))).toBe(
      'a,b\r\n-5,+1.5\r\n-2e3,-0.5',
    );
  });

  it('round trip: the strings the default rewrites (exact list)', () => {
    for (const [text, csv] of REWRITTEN) {
      expect(unparse([[text]])).toBe(csv);
      expect(parse(unparse([[text]]), { delimiter: ',' }).data).toStrictEqual([[`'${text}`]]);
    }
    expect(unparse([{ '@timestamp': '1' }])).toBe(`"'@timestamp"\r\n1`);
    for (const text of ['-5', '+1.5', '-2e3']) expect(unparse([[text]])).toBe(text);
  });
});

describe('grouped unparse fixtures', () => {
  it.each(UNPARSE_FIXTURES.map((f) => [f.id, f] as const))('(R) %s', (_name, f) => {
    both(f.input, f.config as UnparseConfig, f.expected);
  });
});

describe('config validation (main entry)', () => {
  const ROW = [['a', 'b']];
  const INVALID: Array<[string, Record<string, unknown>, string]> = [
    ['an unknown key', { quote: true }, 'quote'],
    // Papa joins quoted values without a separator (the main entry rejects it; /papa keeps it).
    ["delimiter ''", { delimiter: '' }, 'delimiter'],
    ['delimiter "\\n"', { delimiter: '\n' }, 'delimiter'],
    ['delimiter ",\\r"', { delimiter: ',\r' }, 'delimiter'],
    ["delimiter '\"'", { delimiter: '"' }, 'delimiter'],
    ['delimiter U+FEFF', { delimiter: '\ufeff' }, 'delimiter'],
    ['delimiter 5', { delimiter: 5 }, 'delimiter'],
    ['quotes "yes"', { quotes: 'yes' }, 'quotes'],
    ['quotes [1, 0]', { quotes: [1, 0] }, 'quotes'],
    ['columns "a"', { columns: 'a' }, 'columns'],
    ['columns [1]', { columns: [1] }, 'columns'],
    ['skipEmptyLines "x"', { skipEmptyLines: 'x' }, 'skipEmptyLines'],
    ['header 1', { header: 1 }, 'header'],
    ['newline 5', { newline: 5 }, 'newline'],
    ['quoteChar 5', { quoteChar: 5 }, 'quoteChar'],
    ['escapeChar 5', { escapeChar: 5 }, 'escapeChar'],
    ['escapeFormulae "x"', { escapeFormulae: 'x' }, 'escapeFormulae'],
    // Papa tests instanceof RegExp and ignores a RegExp from another realm.
    [
      'escapeFormulae from another realm',
      { escapeFormulae: runInNewContext('/^=/') },
      'escapeFormulae',
    ],
    ['bom 1', { bom: 1 }, 'bom'],
    ['sepLine "yes"', { sepLine: 'yes' }, 'sepLine'],
    ['sepLine with delimiter "::"', { sepLine: true, delimiter: '::' }, 'sepLine'],
  ];
  it.each(INVALID)('%s throws a TypeError naming the option', (_name, config, key) => {
    const call = () => unparse(ROW, config);
    expect(call).toThrow(TypeError);
    expect(call).toThrow(`"${key}"`);
  });

  it('null throws a TypeError naming the option, for every option', () => {
    const KEYS = ['quotes', 'quoteChar', 'escapeChar', 'delimiter', 'header', 'newline'];
    for (const key of [...KEYS, 'skipEmptyLines', 'columns', 'escapeFormulae', 'bom', 'sepLine']) {
      const call = () => unparse(ROW, { [key]: null });
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${key}"`);
    }
  });

  it('a config other than a plain object throws a TypeError', () => {
    const configs: unknown[] = [null, 'x', [], new Date(0)];
    for (const config of configs) {
      expect(() => unparse(ROW, config as UnparseConfig)).toThrow(TypeError);
    }
  });

  it('(R) accepts every value Papa reads as given, undefined meaning omitted', () => {
    both([['a,b', 'c"d']], { quoteChar: '' }, 'a,b,c"d');
    both([['a<>b', 'c,d']], { quoteChar: '<>' }, '<>a<><>b<>,<>c,d<>');
    both([['a'], ['b']], { newline: '' }, 'ab');
    both([['a$b']], { quoteChar: '$' }, '$a$b$');
    both([["a'b"]], { quoteChar: "'", escapeChar: '$' }, "'abb'");
    both(ROW, { quotes: [], skipEmptyLines: false, escapeFormulae: false }, 'a,b');
    const omitted: Record<string, unknown> = { quotes: undefined, columns: undefined };
    both(ROW, omitted, 'a,b');
  });
});

describe('error messages (D2-l)', () => {
  const thrownText = (call: () => unknown): string => {
    try {
      return `returned ${JSON.stringify(call())}`;
    } catch (error) {
      return `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
  };
  // Inputs of which Papa reads a property of null or undefined, or calls join
  // on a record without one: the main entry throws a TypeError naming the
  // input part; csvloom/papa throws what Papa throws (V8's text).
  const INPUTS: ReadonlyArray<readonly [string, () => unknown, UnparseConfig | undefined, string]> =
    [
      ['null', () => null, undefined, 'must be an array, an object or a JSON string, got null'],
      [
        'undefined',
        () => undefined,
        undefined,
        'must be an array, an object or a JSON string, got undefined',
      ],
      [
        "JSON 'null'",
        () => 'null',
        undefined,
        'must be an array, an object or a JSON string, got null',
      ],
      ['[null]', () => [null], undefined, 'record 0 must be an array or an object, got null'],
      [
        "[null] with columns ['a']",
        () => [null],
        { columns: ['a'] },
        'record 0 must be an array or an object, got null',
      ],
      [
        '[{a: 1}, undefined]',
        () => [{ a: 1 }, undefined],
        undefined,
        'record 1 must be an array or an object, got undefined',
      ],
      [
        '[[1], null]',
        () => [[1], null],
        undefined,
        'record 1 must be an array or an object, got null',
      ],
      [
        '{data: [null]}',
        () => ({ data: [null] }),
        undefined,
        'record 0 must be an array or an object, got null',
      ],
      [
        "{fields: ['a'], data: [null]}",
        () => ({ fields: ['a'], data: [null] }),
        undefined,
        'record 0 must be an array or an object, got null',
      ],
      [
        '{data: [[1], null]}',
        () => ({ data: [[1], null] }),
        undefined,
        'record 1 must be an array or an object, got null',
      ],
      [
        '{data: {length: 2}}',
        () => ({ data: { length: 2 } }),
        undefined,
        'record 0 must be an array or an object, got undefined',
      ],
      [
        "[[1], 'ab'] with greedy",
        () => [[1], 'ab'],
        { skipEmptyLines: 'greedy' },
        'record 1 must be an array with skipEmptyLines "greedy", got string',
      ],
      [
        '[{}] with greedy',
        () => [{}],
        { skipEmptyLines: 'greedy' },
        'record 0 must be an array with skipEmptyLines "greedy", got object',
      ],
    ];
  it.each(INPUTS)('(R) input %s', (_label, input, config, message) => {
    expect(thrownText(() => unparse(input() as UnparseInput, config))).toBe(
      `TypeError: Unparse input ${message}`,
    );
    const reference = thrownText(() => papa(input(), config));
    expect(reference).toMatch(/^(TypeError|Error): /);
    // Papa's text quotes its own expression data[row].join (D2-l).
    expect(thrownText(() => papaEntry.unparse(input(), config))).toBe(
      reference.replace('data[row].join', 'record.join'),
    );
  });

  it('(R) propagates what JSON.parse and value conversions throw, in both entries as in Papa', () => {
    const cases: ReadonlyArray<readonly [() => unknown, UnparseConfig | undefined, string]> = [
      [() => 'not json', undefined, 'SyntaxError'],
      [() => ({ data: 'not json' }), undefined, 'SyntaxError'],
      [() => ({ fields: 'x', data: [[1]] }), undefined, 'SyntaxError'],
      [() => [[Object.create(null)]], undefined, 'TypeError'],
      [() => [[1, Symbol('s')]], { skipEmptyLines: 'greedy' }, 'TypeError'],
    ];
    for (const [input, config, name] of cases) {
      const reference = thrownText(() =>
        Papa.unparse(input() as unknown[][], config as Papa.UnparseConfig),
      );
      expect(reference.startsWith(`${name}: `)).toBe(true);
      expect(thrownText(() => unparse(input() as UnparseInput, config))).toBe(reference);
      expect(thrownText(() => papaEntry.unparse(input(), config))).toBe(reference);
    }
  });

  const BOM = '"\\ufeff"';
  // Every message the main entry's unparse creates for its config, in full.
  const OPTIONS: ReadonlyArray<readonly [string, unknown, string]> = [
    ['config []', [], 'Unparse config must be a plain object'],
    ['an unknown key', { quote: true }, 'Unknown unparse option "quote"'],
    [
      "delimiter ''",
      { delimiter: '' },
      `Unparse option "delimiter" must be a non-empty string without "\\r", "\\n", '"' and ${BOM}`,
    ],
    [
      "quotes 'yes'",
      { quotes: 'yes' },
      'Unparse option "quotes" must be a boolean, an array of booleans or a function',
    ],
    [
      "skipEmptyLines 'x'",
      { skipEmptyLines: 'x' },
      'Unparse option "skipEmptyLines" must be a boolean or "greedy"',
    ],
    ['newline 5', { newline: 5 }, 'Unparse option "newline" must be a string'],
    ['quoteChar 5', { quoteChar: 5 }, 'Unparse option "quoteChar" must be a string'],
    ['header 1', { header: 1 }, 'Unparse option "header" must be a boolean'],
    ["columns 'a'", { columns: 'a' }, 'Unparse option "columns" must be an array of strings'],
    ['escapeChar 5', { escapeChar: 5 }, 'Unparse option "escapeChar" must be a string'],
    [
      "escapeFormulae 'x'",
      { escapeFormulae: 'x' },
      'Unparse option "escapeFormulae" must be a boolean or a RegExp',
    ],
    ['bom 1', { bom: 1 }, 'Unparse option "bom" must be a boolean'],
    ["sepLine 'yes'", { sepLine: 'yes' }, 'Unparse option "sepLine" must be a boolean'],
    [
      "sepLine with delimiter '::'",
      { sepLine: true, delimiter: '::' },
      'Unparse option "sepLine" needs a delimiter of one UTF-16 code unit',
    ],
  ];
  it.each(OPTIONS)('main entry: %s', (_label, config, message) => {
    expect(thrownText(() => unparse([['a']], config as UnparseConfig))).toBe(
      `TypeError: ${message}`,
    );
  });
});

describe('Papa Parse 5.7.1 upstream unparse inputs', () => {
  interface UpstreamUnparse {
    description: string;
    input: unknown;
    config?: Record<string, unknown>;
    expected: string;
  }
  // As in test/compatibility.test.ts, with this realm's Date, so that the
  // upstream Dates pass Papa's `constructor === Date` test as in its own runs.
  const require = createRequire(import.meta.url);
  const file = require.resolve('./upstream/papaparse-5.7.1/tests/test-cases.js');
  const sandbox: Record<string, unknown> = {
    Date,
    module: { exports: {} },
    require: (id: string) => {
      if (id === 'chai') return chai;
      if (id === '../papaparse.js') return Papa;
      throw new Error(`unexpected require ${id}`);
    },
    describe: Object.assign(() => undefined, { skip: () => undefined }),
    it: Object.assign(() => undefined, { skip: () => undefined }),
  };
  runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  // A copy from this realm, so that arrays made from it compare with toStrictEqual. A RegExp
  // literal of the file is the sandbox's, which Papa's instanceof test ignores: it is made again
  // in this realm, as in Papa's own runs.
  const all = [...(sandbox.UNPARSE_TESTS as UpstreamUnparse[])].map((t) => {
    const pattern = t.config?.escapeFormulae;
    if (Object.prototype.toString.call(pattern) !== '[object RegExp]') return t;
    const { source, flags } = pattern as RegExp;
    return { ...t, config: { ...t.config, escapeFormulae: new RegExp(source, flags) } };
  });
  // A value Papa reads silently that the main entry rejects (D2-k).
  const REJECTED: Readonly<Record<string, string>> = { 'Bad delimiter (\\n)': 'delimiter' };
  const cases = all.filter((t) => !(t.description in REJECTED));
  const rejected = all.filter((t) => t.description in REJECTED);
  // Cases without escapeFormulae whose values the main entry escapes by default (F6-a); with
  // escapeFormulae: false it writes the expected output.
  const ESCAPED_BY_DEFAULT: Readonly<Record<string, string>> = {
    "Don't escape formulae by default":
      'Col1,Col2,Col3\r\n"\'=danger","\'@danger",safe\r\nsafe=safe,"\'+danger","\'-danger, danger"\r\n\'+safe,\'@safe,"safe, safe"',
  };

  it('found the upstream cases', () => {
    expect(all).toHaveLength(64);
    expect(cases).toHaveLength(63);
    expect(rejected.map((t) => t.description)).toStrictEqual(Object.keys(REJECTED));
    expect(
      cases.filter((t) => t.description in ESCAPED_BY_DEFAULT).map((t) => t.description),
    ).toStrictEqual(Object.keys(ESCAPED_BY_DEFAULT));
  });

  it.each(rejected.map((t) => [t.description, t] as const))(
    '%s: rejected by the main entry',
    (name, t) => {
      const call = () => unparse(t.input as UnparseInput, t.config);
      expect(call).toThrow(TypeError);
      expect(call).toThrow(`"${String(REJECTED[name])}"`);
      expect(Papa.unparse(t.input as unknown[][], t.config as Papa.UnparseConfig)).toBe(t.expected);
    },
  );

  it.each(cases.map((t) => [t.description, t] as const))('%s', (name, t) => {
    // csvloom first: Papa writes into {data} inputs.
    const actual = unparse(t.input as UnparseInput, t.config);
    if (name in ESCAPED_BY_DEFAULT) {
      expect(actual).toBe(ESCAPED_BY_DEFAULT[name]);
      expect(unparse(t.input as UnparseInput, { ...t.config, escapeFormulae: false })).toBe(
        t.expected,
      );
    } else {
      expect(actual).toBe(t.expected);
    }
    expect(Papa.unparse(t.input as unknown[][], t.config as Papa.UnparseConfig)).toBe(t.expected);
  });
});

describe('seeded unparse differential', () => {
  const SEED = 20261109;
  const CASES = 5000;

  it.each(['main', 'papa'] as const)(
    `%s entry matches Papa on ${String(CASES)} generated inputs (seed ${String(SEED)})`,
    (entry) => {
      const summary = fuzzUnparse(SEED, CASES, entry);
      expect(summary.failure).toBeNull();
      expect(summary.shapes.arrays + summary.shapes.objects).toBe(CASES);
      expect(Math.min(summary.shapes.arrays, summary.shapes.objects)).toBeGreaterThan(0);
      // Only the main entry rejects delimiter ''.
      if (entry === 'main') expect(summary.rejected).toBeGreaterThan(0);
      else expect(summary.rejected).toBe(0);
    },
  );
});

describe('csvloom/papa unparse', () => {
  const ROW = [['a', 'b"c']];
  // The /papa entry takes any config at run time, as Papa does.
  const ours = (input: unknown, config: unknown) =>
    papaEntry.unparse(input, config as Parameters<typeof papaEntry.unparse>[1]);
  const reference = (input: unknown, config: unknown) =>
    Papa.unparse(structuredClone(input) as unknown[][], config as Papa.UnparseConfig);
  /** (R) Both libraries, each with its own copy of the input, give expected. */
  const same = (input: unknown, config: unknown, expected: string) => {
    expect(ours(structuredClone(input), config)).toBe(expected);
    expect(reference(input, config)).toBe(expected);
  };

  it('(R) a value of another type than Papa tests means the default (papaparse.js 257-298)', () => {
    for (const config of [
      { delimiter: 5 },
      { delimiter: '\n' },
      { delimiter: 'a"b' },
      { quotes: 'yes' },
      { quotes: null },
      { skipEmptyLines: 5 },
      { newline: 5 },
      { quoteChar: 5 },
      { header: 1 },
      { columns: 'a' },
      { escapeFormulae: 1 },
      { escapeFormulae: 'x' },
      { unknownKey: 1 },
    ]) {
      same(ROW, config, 'a,"b""c"');
    }
  });

  it("(R) Papa's readings: truthy array entries, any string skipEmptyLines, escapeChar with +", () => {
    same([['a', 'b']], { quotes: [1, 0] }, '"a",b');
    same([['a'], [''], ['b']], { skipEmptyLines: 'x' }, 'a\r\nb');
    same([['a"b']], { escapeChar: null }, '"anull"b"');
    same([{ 1: 'x', a: 2 }], { columns: [1] }, '1\r\nx');
    same([['a', 'b']], { delimiter: '' }, '"a""b"');
  });

  it('(R) a config that is not an object is ignored; null throws as in Papa', () => {
    for (const config of ['x', 5, true, () => 1]) same(ROW, config, 'a,"b""c"');
    expect(() => ours(ROW, null)).toThrow("Cannot read properties of null (reading 'delimiter')");
    expect(() => reference(ROW, null)).toThrow(
      "Cannot read properties of null (reading 'delimiter')",
    );
    expect(() => ours(ROW, { columns: [] })).toThrow('Option columns is empty');
  });

  it("(R) a RegExp from another realm is ignored, as Papa's instanceof test ignores it", () => {
    same([['=a']], { escapeFormulae: runInNewContext('/^=/') as unknown }, '=a');
  });

  it("escapeFormulae is unchanged in csvloom/papa: off by default, Papa's characters when true", () => {
    expect(ours([['=1']], undefined)).toBe('=1');
    expect(ours([['-5', '\n=1', '\uff1d1']], { escapeFormulae: true })).toBe(
      '"\'-5","\n=1",\uff1d1',
    );
  });

  it('D2-i applies: escapeFormulae true prefixes a risky value with a line break', () => {
    expect(ours([['=1\n2']], { escapeFormulae: true })).toBe('"\'=1\n2"');
    expect(reference([['=1\n2']], { escapeFormulae: true })).toBe('"=1\n2"');
  });
});

describe('one scan per value', () => {
  // A unit of the test's RegExp class is written as its code, so RegExp syntax cannot leak in.
  const UNITS = '][\\^-.*+?$|(){}/ u\t\u00e9\u2028\ud83d'.split('');
  const VALUES = [
    UNITS.join(''),
    ...UNITS,
    ...UNITS.map((unit) => `a${unit}b`),
    ...['', 'plain', ' a', 'a ', '"', 'a\nb', 'a\rb', `a${String.fromCharCode(0xfeff)}`],
    ...[5, null, true, { toString: () => 'a]b' }],
  ];
  // Papa does not write into an array of arrays, so it needs no copy (a function cannot be cloned).
  const reference = (input: unknown[][], config?: UnparseConfig) =>
    Papa.unparse(input, config as Papa.UnparseConfig);

  it('(R) every pair of a one-unit delimiter and quoteChar matches Papa, RegExp syntax characters included', () => {
    for (const delimiter of UNITS) {
      for (const quoteChar of UNITS) {
        const config = { delimiter, quoteChar, escapeFormulae: false };
        const expected = reference([VALUES], config);
        expect(unparse([VALUES], config)).toBe(expected);
        expect(papaEntry.unparse([VALUES], config)).toBe(expected);
      }
    }
  });

  it('(R) a toString that returns no string throws a TypeError, as in Papa', () => {
    const input = [[{ toString: () => 5 }]];
    expect(() => unparse(input as unknown as UnparseInput)).toThrow(TypeError);
    expect(() => papaEntry.unparse(input)).toThrow(TypeError);
    expect(() => reference(input)).toThrow(TypeError);
  });
});

describe('output written in parts', () => {
  it("(R) an output many times FLAT_UNITS long equals Papa's, for rows and for records", () => {
    const rows = Array.from({ length: 30000 }, (_, i) =>
      i % 11 === 5
        ? ['']
        : [String(i), 'a,b', ' x', 'plain text', i % 7 === 0 ? 'q"q' : '', `line\n${String(i)}`],
    );
    const records = rows.map(([id = '', b = '', c = '']) => (id === '' ? {} : { id, b, c }));
    const configs: UnparseConfig[] = [
      {},
      { skipEmptyLines: true },
      { skipEmptyLines: 'greedy' },
      { delimiter: ';', newline: '\n', header: false },
    ];
    for (const config of configs) {
      for (const input of [rows, records]) {
        const expected = Papa.unparse(input as unknown[][], config as Papa.UnparseConfig);
        expect(expected.length).toBeGreaterThan(4 * 65536);
        // Compared outside expect: a difference would print both texts.
        expect(unparse(input, { ...config, escapeFormulae: false }) === expected).toBe(true);
        expect(papaEntry.unparse(input, config) === expected).toBe(true);
      }
    }
  });
});
