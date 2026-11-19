import Papa from 'papaparse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import papa from '../src/papa.ts';
import { parse } from '../src/parse.ts';
import type { ParseConfig, UnparseInput } from '../src/types.ts';
import { unparse } from '../src/unparse.ts';

// Named golden tests for the compatibility exceptions (D2-a..l, D3 and P3-a..c in
// docs/compatibility.md). Each test states both sides: what the pinned reference does, and what
// csvloom must do instead. The general differential comparator is not loosened for these cases.

// The parts of a result these tests read; both libraries' results fit it.
interface Result {
  data: unknown[];
  meta: { fields?: unknown[] | undefined; renamedHeaders?: Record<string, unknown> | null };
}
type ParseFn = (input: string, config?: object) => Result;
type UnparseFn = (input: unknown, config?: Record<string, unknown>) => string;
interface Subject {
  role: 'reference' | 'engine';
  parse: ParseFn;
  unparse: UnparseFn;
}

const reference: Subject = {
  role: 'reference',
  parse: (input, config) => Papa.parse<unknown>(input, config),
  unparse: (input, config) => Papa.unparse(input as unknown[][], config),
};
// Configs pass through unchecked by the compiler: rejecting invalid ones at run
// time is part of what these tests check.
const enginePapa: Subject = {
  role: 'engine',
  parse: (input, config) => papa.parse(input, config),
  unparse: (input, config) => papa.unparse(input, config),
};
const engineMain: Subject = {
  role: 'engine',
  parse: (input, config) => parse(input, config as ParseConfig),
  unparse: (input, config) => unparse(input as UnparseInput, config),
};

afterEach(() => {
  vi.restoreAllMocks();
});

const SUBJECTS = [
  ['papaparse 5.7.1 (reference)', reference],
  ['csvloom/papa', enginePapa],
  ['csvloom main entry', engineMain],
] as const;

describe.each(SUBJECTS)('%s', (_name, s) => {
  const isReference = s.role === 'reference';

  it('D2-a: parse does not write into the caller config', () => {
    const config = { dynamicTyping: () => true };
    s.parse('1,2', config);
    if (isReference)
      expect(Object.keys(config)).toStrictEqual([
        'dynamicTyping',
        'dynamicTypingFunction',
        'transform',
      ]);
    else expect(Object.keys(config)).toStrictEqual(['dynamicTyping']);
  });

  it('D2-a: unparse does not modify a {data} input', () => {
    const input = { data: [1, 2] };
    expect(s.unparse(input)).toBe('1,2');
    if (isReference) expect(input).toStrictEqual({ data: [[1, 2]], fields: [] });
    else expect(input).toStrictEqual({ data: [1, 2] });
  });

  it('D2-b: duplicate headers are renamed without console output', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = s.parse('a,a\n1,2', { header: true, delimiter: ',' });
    expect(result.meta.fields).toStrictEqual(['a', 'a_1']);
    expect(result.meta.renamedHeaders).toStrictEqual({ a_1: 'a' });
    expect(warn).toHaveBeenCalledTimes(isReference ? 1 : 0);
  });

  it('D2-c: a __proto__ column is kept as an own data property without touching prototypes', () => {
    const result = s.parse('__proto__,b\nx,2', { header: true, delimiter: ',' });
    const row = result.data[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('x');
    if (isReference) expect(Object.keys(row)).toStrictEqual(['b']);
    else {
      expect(Object.keys(row)).toStrictEqual(['__proto__', 'b']);
      expect(Object.getOwnPropertyDescriptor(row, '__proto__')).toMatchObject({
        value: 'x',
        enumerable: true,
        writable: true,
      });
    }
  });

  it('D2-d: dynamicTyping converts columns named like Object/Boolean prototype members', () => {
    const result = s.parse('constructor,toString,valueOf,b\n1,2,3,4', {
      header: true,
      delimiter: ',',
      dynamicTyping: true,
    });
    expect(result.data).toStrictEqual([
      isReference
        ? { constructor: '1', toString: '2', valueOf: '3', b: 4 }
        : { constructor: 1, toString: 2, valueOf: 3, b: 4 },
    ]);
  });

  it('D2-d: the dynamicTyping function is called for columns named like prototype members', () => {
    const calls: unknown[] = [];
    const result = s.parse('constructor,b\n1,2', {
      header: true,
      delimiter: ',',
      newline: '\n',
      dynamicTyping: (field: string | number) => {
        calls.push(field);
        return field === 'constructor';
      },
    });
    // Papa's cache object already has a constructor member.
    expect(calls).toStrictEqual(isReference ? ['b'] : ['constructor', 'b']);
    expect(result.data).toStrictEqual([
      isReference ? { constructor: '1', b: '2' } : { constructor: 1, b: '2' },
    ]);
  });

  it('D2-i: escapeFormulae: true also prefixes risky values that contain a line break', () => {
    const out = s.unparse([['=1\n2', '+x\r', '@a\nb', 'safe']], { escapeFormulae: true });
    if (isReference) expect(out).toBe('"=1\n2","+x\r","@a\nb",safe');
    else expect(out).toBe('"\'=1\n2","\'+x\r","\'@a\nb",safe');
  });

  it('escapeFormulae: true prefixes arrays and objects whose string form is risky, as Papa Parse 5.7.1 does', () => {
    const out = s.unparse([[['=1+1'], new String('+x'), { toString: () => '@x' }, -5]], {
      escapeFormulae: true,
    });
    expect(out).toBe('"\'=1+1","\'+x","\'@x",-5');
  });

  it('D2-i: an explicit escapeFormulae RegExp keeps its own semantics', () => {
    // No s flag: "." does not match the line break, so "$" cannot match before it.
    expect(s.unparse([['=1\n2', '!ok']], { escapeFormulae: /^[=!].*$/ })).toBe('"=1\n2","\'!ok"');
  });
});

describe.each([['csvloom main entry', engineMain]] as const)('%s only', (_name, s) => {
  it('D2-k: invalid delimiter, newline or quoteChar values throw TypeError', () => {
    expect(() => s.parse('a,b', { delimiter: '"' })).toThrow(TypeError);
    expect(() => s.parse('a,b', { newline: 'x' })).toThrow(TypeError);
    expect(() => s.parse('a,b', { quoteChar: "''" })).toThrow(TypeError);
    // Omitted and auto-detected values stay valid.
    expect(() => s.parse('a,b', { delimiter: '' })).not.toThrow();
  });

  it('D3: unknown option keys are rejected', () => {
    expect(() => s.parse('a', { delimitr: ',' })).toThrow(TypeError);
  });
});

describe.each([
  ['csvloom/papa', enginePapa],
  ['csvloom main entry', engineMain],
] as const)('%s: unsupported features (D3)', (_name, s) => {
  it('active excluded features throw UnsupportedFeatureError', () => {
    for (const config of [
      { step: () => undefined },
      { worker: true },
      { download: true },
      { chunkSize: 1024 },
    ]) {
      expect(() => s.parse('a', config)).toThrow(
        expect.objectContaining({ name: 'UnsupportedFeatureError' }) as Error,
      );
    }
  });

  it('documented inactive defaults are accepted', () => {
    expect(() =>
      s.parse('a', { worker: false, download: false, encoding: '', step: undefined }),
    ).not.toThrow();
  });
});

describe.each([['csvloom/papa', enginePapa]] as const)('%s only', (_name, s) => {
  it('D3: unknown option keys are ignored, as in Papa', () => {
    expect(s.parse('a', { delimitr: ',' }).data).toStrictEqual([['a']]);
  });

  it('(R) D2-k: invalid delimiter, newline and quoteChar values fall back as in Papa', () => {
    for (const subject of [s, reference]) {
      expect(subject.parse('a,b', { delimiter: '"' })).toMatchObject({
        data: [['a', 'b']],
        errors: [],
        meta: { delimiter: ',' },
      });
      expect(subject.parse('a,b\nc,d', { newline: 'x' })).toMatchObject({
        data: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        meta: { linebreak: '\n' },
      });
      // The R04 probe values (test/papa-reference.test.ts).
      expect(subject.parse('a,"b,c"', { quoteChar: '' }).data).toStrictEqual([['a', '"b', 'c"']]);
      expect(subject.parse("a,''b,c''", { quoteChar: "''" }).data).toStrictEqual([
        ['a', "''b", "c''"],
      ]);
    }
  });

  it('(R) D2-k: unparse reads an invalid delimiter as "," and accepts "", as Papa does', () => {
    for (const subject of [s, reference]) {
      expect(subject.unparse([['a', 'b']], { delimiter: '\n' })).toBe('a,b');
      expect(subject.unparse([['a', 'b']], { delimiter: 5 })).toBe('a,b');
      expect(subject.unparse([['a', 'b']], { delimiter: '' })).toBe('"a""b"');
    }
  });
});

// P3-a, P3-b and P3-c: Papa never returns, or its fast path (taken when the text has no quote
// character) and full path disagree; both entries throw a TypeError naming the option.
describe.each([
  ['csvloom/papa', enginePapa],
  ['csvloom main entry', engineMain],
] as const)('%s: P3 exceptions', (_name, s) => {
  const rejects = (call: () => unknown, option: string) => {
    expect(call).toThrow(TypeError);
    expect(call).toThrow(`"${option}"`);
  };

  it('P3-a: an empty delimiter from a function or delimitersToGuess throws (Papa loops forever on text with a quote, papaparse.js 1588-1596; not executed)', () => {
    rejects(() => s.parse('a,"b"', { delimiter: () => '' }), 'delimiter');
    rejects(() => s.parse('a,"b"', { delimitersToGuess: [''] }), 'delimitersToGuess');
  });

  it('(R) P3-b: a negative preview throws (Papa: [] on its fast path, one record on its full path)', () => {
    rejects(() => s.parse('a\nb\nc', { preview: -1 }), 'preview');
    expect(Papa.parse('a\nb\nc', { preview: -1 }).data).toStrictEqual([]);
    expect(Papa.parse('a\nb\n"c"', { preview: -1 }).data).toStrictEqual([['a']]);
  });

  it("(R) P3-c: a delimiter or comment marker containing a line break throws (Papa's two paths differ)", () => {
    rejects(() => s.parse('a,\nb', { delimiter: ',\n' }), 'delimiter');
    rejects(() => s.parse('a,\nb', { delimiter: () => ',\n' }), 'delimiter');
    rejects(() => s.parse('#\na', { comments: '#\n' }), 'comments');
    expect(Papa.parse('a,\nb', { delimiter: ',\n', newline: '\n' }).data).toStrictEqual([
      ['a,'],
      ['b'],
    ]);
    expect(Papa.parse('a,\nb,"c"', { delimiter: ',\n', newline: '\n' }).data).toStrictEqual([
      ['a', '\n'],
      ['b,"c"'],
    ]);
  });
});
