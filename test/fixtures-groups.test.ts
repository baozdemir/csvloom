import Papa from 'papaparse';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../bench/fixtures.ts';
import { parse } from '../src/index.ts';
import { parseStream } from '../src/stream.ts';
import type { ParseConfig } from '../src/types.ts';
import { PARSE_FIXTURES, UNPARSE_FIXTURES, type ParseFixture } from './fixtures/groups.ts';
import { byteSplits, checkStream, collect, splits } from './stream-split.ts';

// Runs the grouped fixtures of test/fixtures/groups.ts against the pinned
// reference. The same data drives csvloom's differential tests.

afterEach(() => {
  vi.restoreAllMocks();
});

function configFor(f: ParseFixture): Papa.ParseConfig<unknown> {
  if (!f.reentrant) return f.config;
  return {
    ...f.config,
    transform: (value: string) => {
      expect(Papa.parse('x,y', { delimiter: ',' }).data).toStrictEqual([['x', 'y']]);
      return value;
    },
  };
}

describe('grouped parse fixtures against Papa Parse 5.7.1', () => {
  it.each(PARSE_FIXTURES.map((f) => [`${f.group} / ${f.id}`, f] as const))('%s', (_name, f) => {
    // Duplicate-header console.warn is an exception (test/papa-deviations.test.ts).
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { expected } = f;
    if ('throws' in expected) {
      expect(() => Papa.parse(f.input, configFor(f))).toThrow(expected.throws);
      return;
    }
    const result = Papa.parse<unknown>(f.input, configFor(f));
    expect(result.data).toStrictEqual(expected.data);
    if (expected.errors) expect(result.errors).toMatchObject(expected.errors);
    if (expected.meta) expect(result.meta).toMatchObject(expected.meta);
  });

  it('keeps meta.fields in header order while row objects enumerate integer-like keys first', () => {
    const result = Papa.parse<Record<string, string>>('10,2\na,b', {
      header: true,
      delimiter: ',',
    });
    expect(result.meta.fields).toStrictEqual(['10', '2']);
    expect(Object.keys(result.data[0] ?? {})).toStrictEqual(['2', '10']);
  });
});

describe('grouped unparse fixtures against Papa Parse 5.7.1', () => {
  it.each(UNPARSE_FIXTURES.map((f) => [f.id, f] as const))('%s', (_name, f) => {
    expect(Papa.unparse(f.input as unknown[][], f.config)).toBe(f.expected);
  });
});

// The grouped rows that only a stream has (chunk boundaries, interleaved
// parsers), through parseStream.

const BOM = String.fromCharCode(0xfeff);
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * `text` as string chunks at every split and as its UTF-8 bytes at every byte split, through every
 * source kind with batchSize 1: bulk's result (rules a-d, callback calls), whose rows are `rows`.
 */
async function streamsAs(text: string, config: ParseConfig, rows: unknown[]) {
  const random = mulberry32(20261120);
  const bytes = encode(text);
  const runs = [[text], ...splits(text, random, 5), [bytes], ...byteSplits(bytes, random, 5)];
  const check = await checkStream(text, config, 1, runs);
  expect(check.failure).toBeNull();
  expect(check.throwing).toBe(false);
  const { batches } = await collect([text], config);
  expect(batches.flatMap((batch) => batch.data)).toStrictEqual(rows);
}

describe('grouped rows through parseStream, at every string and byte split', () => {
  it('CRLF split across chunks, with the newline detected and given', async () => {
    const rows = [['a', 'b'], ['c', 'd'], ['']];
    await streamsAs('a,b\r\nc,d\r\n', {}, rows);
    await streamsAs('a,b\r\nc,d\r\n', { delimiter: ',', newline: '\r\n' }, rows);
  });

  it('UTF-8 split across byte chunks, the BOM included', async () => {
    await streamsAs('é,😀\n€,ğ', {}, [
      ['é', '😀'],
      ['€', 'ğ'],
    ]);
    await streamsAs(`${BOM}é,b`, {}, [['é', 'b']]);
  });

  it('a surrogate pair split across string chunks', async () => {
    expect('😀'.length).toBe(2);
    await streamsAs('😀,a\nb,😀', {}, [
      ['😀', 'a'],
      ['b', '😀'],
    ]);
  });

  it('a doubled quote, an escape pair and a "::" delimiter split', async () => {
    await streamsAs('"a""b",c\n"d"""', {}, [['a"b', 'c'], ['d"']]);
    await streamsAs('"a\\"b",c', { escapeChar: '\\' }, [['a"b', 'c']]);
    await streamsAs('a::b\nc:d::e', { delimiter: '::' }, [
      ['a', 'b'],
      ['c:d', 'e'],
    ]);
  });

  it('the end of the input right after a quote, a "\\r" and a delimiter', async () => {
    await streamsAs('a,"b"', {}, [['a', 'b']]);
    await streamsAs('a,b\r', {}, [['a', 'b'], ['']]);
    await streamsAs('a,b\r', { delimiter: ',', newline: '\r\n' }, [['a', 'b\r']]);
    await streamsAs('a,b,', {}, [['a', 'b', '']]);
  });

  it('reentrancy: a transform that runs another parse gets its own result', async () => {
    const inner: unknown[] = [];
    const transform = (value: string) => {
      inner.push(parse('x;y', { delimiter: ';' }).data);
      return value;
    };
    await streamsAs('a,b\nc,d', { transform }, [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every((data) => JSON.stringify(data) === '[["x","y"]]')).toBe(true);
  });

  it('reentrancy: two parseStream iterations advanced alternately each give their own result', async () => {
    const left = 'a,b\nc,d\ne,f\n';
    const right = '1;2;3\r\n4;5;6\r\n7;8;9';
    const one = parseStream(['a,b\nc', ',d\ne,f\n'], { batchSize: 1 });
    const two = parseStream([encode(right).subarray(0, 7), encode(right).subarray(7)], {
      batchSize: 1,
      header: true,
    });
    const got: [unknown[], unknown[]] = [[], []];
    for (let ended = 0; ended < 2;) {
      // Both next() calls are pending at once, then each result goes to its own list.
      const steps = await Promise.all([one.next(), two.next()]);
      ended = 0;
      steps.forEach((step, i) => {
        if (step.done) ended++;
        else got[i]?.push(...step.value.data);
      });
    }
    expect(got).toStrictEqual([parse(left).data, parse(right, { header: true }).data]);
    expect(got[1]).toStrictEqual([
      { '1': '4', '2': '5', '3': '6' },
      { '1': '7', '2': '8', '3': '9' },
    ]);
  });

  it('a __proto__ header cannot change a prototype', async () => {
    const text = '__proto__,b\n1,2\n3,4';
    const config = { header: true, transform: () => ({ polluted: true }) };
    const bytes = encode(text);
    const random = mulberry32(20261121);
    for (const chunks of [
      [text],
      ...splits(text, random, 5),
      [bytes],
      ...byteSplits(bytes, random, 5),
    ]) {
      const { batches, thrown } = await collect(chunks as Iterable<string>, config);
      const rows = batches.flatMap((batch) => batch.data);
      expect(thrown).toBeUndefined();
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
        expect(Object.hasOwn(row as object, '__proto__')).toBe(true);
      }
    }
    await streamsAs(text, config, parse(text, config).data);
  });
});
