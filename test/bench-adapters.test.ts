import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAdapter } from '../bench/adapters/index.ts';
import {
  dropLineEndRecord,
  skipLeadingBomBytes,
  stripLeadingBom,
  type Dialect,
} from '../bench/lanes.ts';
import { collect } from '../bench/worker.ts';
import { EDGES, edgeMatrix, outcome } from './adapter-edges.ts';

// The expected behavior of every adapter on each lane-contract
// edge. A change in any library or adapter shows up as a diff here.
const expected = JSON.parse(
  readFileSync(new URL('./fixtures/adapter-edge-matrix.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, Record<string, string>>>;

describe('adapter edge matrix', () => {
  it('matches the expected matrix for every adapter, lane and edge', async () => {
    expect(await edgeMatrix()).toStrictEqual(expected);
  }, 60_000);

  // Papa is the reference and the only adapter whose output the harness
  // normalizes in all three lanes; it must satisfy every edge exactly.
  it.each(['B1', 'B2', 'S1'])('papaparse %s passes every edge at every S1 chunk size', (lane) => {
    for (const edge of EDGES) expect(expected.papaparse?.[lane]?.[edge.id]).toBe('PASS');
  });

  // The candidate is not in manifest.implementations (the v1 manifest defers its S1 lane).
  it.each(['B1', 'B2'] as const)('the csv-engine candidate passes every %s edge', async (lane) => {
    for (const edge of EDGES) expect(await outcome('csv-engine', lane, edge, 0)).toBe('PASS');
  });

  it('csv-simple-parser normalization keeps genuine final records (B2 all PASS)', () => {
    for (const edge of EDGES) expect(expected['csv-simple-parser']?.B2?.[edge.id]).toBe('PASS');
  });
});

describe('example: Papa B2 and S1 agree on an interior blank record', () => {
  const dialect: Dialect = { delimiter: ',', quote: '"', newline: '\n' };
  const csv = 'name,value\na,1\n\nb,2\n';
  const input = { csv, dialect, sha256: '', header: null, rows: null };

  it('both lanes keep the blank record', async () => {
    const papa = await loadAdapter('papaparse');
    const b2 = await collect(papa, 'B2', input, 4);
    const s1 = await collect(papa, 'S1', input, 4);
    expect(b2).toStrictEqual([{ name: 'a', value: '1' }, { name: '' }, { name: 'b', value: '2' }]);
    expect(s1).toStrictEqual(b2);
  });
});

describe('example: csv-parse relax_quotes', () => {
  const dialect: Dialect = { delimiter: ',', quote: '"', newline: '\n' };
  const input = { csv: 'a,b\nx"y,z', dialect, sha256: '', header: null, rows: null };

  it('is strict by default and matches Papa with relax_quotes: true', async () => {
    const csvParse = await loadAdapter('csv-parse');
    await expect(collect(csvParse, 'B1', input, 0)).rejects.toThrow(/Invalid Opening Quote/);
    const relaxed = await collect(csvParse, 'B1', input, 0, { relax_quotes: true });
    expect(relaxed).toStrictEqual(await collect(await loadAdapter('papaparse'), 'B1', input, 0));
  });
});

describe('dropLineEndRecord', () => {
  const lf: Dialect = { delimiter: ',', quote: '"', newline: '\n' };

  it('drops only the artifact of the final line break', () => {
    expect(dropLineEndRecord([['a', 'b'], ['']], 'a,b\n', lf)).toStrictEqual([['a', 'b']]);
    expect(dropLineEndRecord([['h'], [''], ['']], 'h\n\n', lf)).toStrictEqual([['h'], ['']]);
    expect(dropLineEndRecord([{ a: '1' }, { a: '' }], 'a\n1\n', lf)).toStrictEqual([{ a: '1' }]);
  });

  it('keeps a real all-empty record and input without a final line break', () => {
    expect(
      dropLineEndRecord(
        [
          ['a', 'b'],
          ['', ''],
        ],
        'a,b\n,\n',
        lf,
      ),
    ).toStrictEqual([
      ['a', 'b'],
      ['', ''],
    ]);
    expect(dropLineEndRecord([['a'], ['']], 'a\n', { ...lf, newline: '\r\n' })).toHaveLength(2);
    expect(dropLineEndRecord([['a'], ['']], 'a\n""', lf)).toHaveLength(2);
  });
});

describe('lane BOM policy helpers', () => {
  it('stripLeadingBom removes exactly one leading U+FEFF and nothing else', () => {
    expect(stripLeadingBom('\ufeffa,b')).toBe('a,b');
    expect(stripLeadingBom('\ufeff\ufeffa')).toBe('\ufeffa');
    expect(stripLeadingBom('a,\ufeffb')).toBe('a,\ufeffb');
    expect(stripLeadingBom(' a')).toBe(' a');
    expect(stripLeadingBom('')).toBe('');
  });

  async function bytesAfter(chunks: number[][]): Promise<number[]> {
    // eslint-disable-next-line @typescript-eslint/require-await -- an in-memory async source has nothing to await
    async function* source() {
      for (const c of chunks) yield Uint8Array.from(c);
    }
    const out: number[] = [];
    for await (const chunk of skipLeadingBomBytes(source())) out.push(...chunk);
    return out;
  }

  it('skipLeadingBomBytes drops one EF BB BF prefix, also when split across chunks', async () => {
    expect(await bytesAfter([[0xef, 0xbb, 0xbf, 0x61]])).toStrictEqual([0x61]);
    expect(await bytesAfter([[0xef], [0xbb], [0xbf], [0x61]])).toStrictEqual([0x61]);
    expect(await bytesAfter([[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]])).toStrictEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });

  it('skipLeadingBomBytes keeps input that only starts like a BOM, or has none', async () => {
    expect(await bytesAfter([[0xef, 0xbb], [0x61]])).toStrictEqual([0xef, 0xbb, 0x61]);
    expect(await bytesAfter([[0x61, 0xef, 0xbb, 0xbf]])).toStrictEqual([0x61, 0xef, 0xbb, 0xbf]);
    expect(await bytesAfter([[0xef, 0xbb]])).toStrictEqual([0xef, 0xbb]);
    expect(await bytesAfter([])).toStrictEqual([]);
  });
});
