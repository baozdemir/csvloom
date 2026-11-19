import { loadAdapter } from '../bench/adapters/index.ts';
import {
  firstMismatch,
  UnsupportedDialectError,
  type Dialect,
  type Lane,
  type RecordRow,
  type Row,
} from '../bench/lanes.ts';
import { readManifest } from '../bench/manifest.ts';
import { collect, type Input } from '../bench/worker.ts';

// Edge inputs for the lane contracts, run against the real library adapters.
// Expected output follows the contract in bench/lanes.ts: the final line break
// creates no record; every other record, including blank lines, is preserved; a
// short B2 record has only the fields it contains.

const LF: Dialect = { delimiter: ',', quote: '"', newline: '\n' };
const CRLF: Dialect = { ...LF, newline: '\r\n' };

export interface Edge {
  id: string;
  csv: string;
  dialect: Dialect;
  b1: Row[];
  b2: RecordRow[];
}

export const EDGES: Edge[] = [
  {
    id: 'single-column',
    csv: 'h\na\nb\n',
    dialect: LF,
    b1: [['h'], ['a'], ['b']],
    b2: [{ h: 'a' }, { h: 'b' }],
  },
  {
    id: 'single-column-empty-last',
    csv: 'h\na\n\n',
    dialect: LF,
    b1: [['h'], ['a'], ['']],
    b2: [{ h: 'a' }, { h: '' }],
  },
  {
    id: 'multiple-final-line-breaks',
    csv: 'a,b\n1,2\n\n\n',
    dialect: LF,
    b1: [['a', 'b'], ['1', '2'], [''], ['']],
    b2: [{ a: '1', b: '2' }, { a: '' }, { a: '' }],
  },
  {
    id: 'quoted-empty-last',
    csv: 'h\na\n""\n',
    dialect: LF,
    b1: [['h'], ['a'], ['']],
    b2: [{ h: 'a' }, { h: '' }],
  },
  {
    id: 'all-empty-last',
    csv: 'a,b\n1,2\n,\n',
    dialect: LF,
    b1: [
      ['a', 'b'],
      ['1', '2'],
      ['', ''],
    ],
    b2: [
      { a: '1', b: '2' },
      { a: '', b: '' },
    ],
  },
  {
    id: 'no-final-line-break',
    csv: 'a,b\n1,2',
    dialect: LF,
    b1: [
      ['a', 'b'],
      ['1', '2'],
    ],
    b2: [{ a: '1', b: '2' }],
  },
  {
    id: 'crlf',
    csv: 'a,b\r\n1,2\r\n',
    dialect: CRLF,
    b1: [
      ['a', 'b'],
      ['1', '2'],
    ],
    b2: [{ a: '1', b: '2' }],
  },
  {
    id: 'crlf-empty-last',
    csv: 'a\r\nx\r\n\r\n',
    dialect: CRLF,
    b1: [['a'], ['x'], ['']],
    b2: [{ a: 'x' }, { a: '' }],
  },
  {
    id: 'interior-blank',
    csv: 'name,value\na,1\n\nb,2\n',
    dialect: LF,
    b1: [['name', 'value'], ['a', '1'], [''], ['b', '2']],
    b2: [{ name: 'a', value: '1' }, { name: '' }, { name: 'b', value: '2' }],
  },
  {
    id: 'unicode',
    csv: 'h,é\nçğ😀,👩🏽‍💻\n',
    dialect: LF,
    b1: [
      ['h', 'é'],
      ['çğ😀', '👩🏽‍💻'],
    ],
    b2: [{ h: 'çğ😀', é: '👩🏽‍💻' }],
  },
  // One leading UTF-8 BOM is an encoding marker, not data; any other U+FEFF and leading spaces are data.
  {
    id: 'leading-bom',
    csv: '\ufeffh,v\na,1\n',
    dialect: LF,
    b1: [
      ['h', 'v'],
      ['a', '1'],
    ],
    b2: [{ h: 'a', v: '1' }],
  },
  // A U+FEFF anywhere else is data, and so is leading whitespace.
  {
    id: 'embedded-feff',
    csv: 'h,v\na,\ufeff1\n',
    dialect: LF,
    b1: [
      ['h', 'v'],
      ['a', '\ufeff1'],
    ],
    b2: [{ h: 'a', v: '\ufeff1' }],
  },
  {
    id: 'leading-space',
    csv: ' h,v\na,1\n',
    dialect: LF,
    b1: [
      [' h', 'v'],
      ['a', '1'],
    ],
    b2: [{ ' h': 'a', v: '1' }],
  },
  {
    id: 'crlf-inside-quotes',
    csv: 'a,b\n"x\r\ny",z\n',
    dialect: LF,
    b1: [
      ['a', 'b'],
      ['x\r\ny', 'z'],
    ],
    b2: [{ a: 'x\r\ny', b: 'z' }],
  },
];

export const S1_CHUNK_SIZES = [1, 2, 3, 7, 65536];

const input = (edge: Edge): Input => ({
  csv: edge.csv,
  dialect: edge.dialect,
  sha256: '',
  header: null,
  rows: null,
});

export async function outcome(
  impl: string,
  lane: Lane,
  edge: Edge,
  chunk: number,
): Promise<string> {
  const expected = lane === 'B1' ? edge.b1 : edge.b2;
  try {
    const actual = await collect(await loadAdapter(impl), lane, input(edge), chunk);
    const mismatch = firstMismatch(actual, expected, lane);
    return mismatch ? `${mismatch.reason}@${String(mismatch.index)}` : 'PASS';
  } catch (error) {
    return error instanceof UnsupportedDialectError ? 'UNSUPPORTED' : 'throws';
  }
}

/** implementation -> lane -> edge -> result ("PASS", "<reason>@<index>", ...). */
export async function edgeMatrix(): Promise<
  Record<string, Record<string, Record<string, string>>>
> {
  const matrix: Record<string, Record<string, Record<string, string>>> = {};
  for (const spec of readManifest().implementations) {
    for (const lane of spec.lanes) {
      const row: Record<string, string> = {};
      for (const edge of EDGES) {
        if (lane !== 'S1') row[edge.id] = await outcome(spec.id, lane, edge, 0);
        else {
          const results: string[] = [];
          for (const size of S1_CHUNK_SIZES) results.push(await outcome(spec.id, lane, edge, size));
          const failing = S1_CHUNK_SIZES.filter((_, i) => results[i] !== 'PASS');
          row[edge.id] =
            failing.length === 0
              ? 'PASS'
              : `${String(results.find((r) => r !== 'PASS'))} at chunk ${failing.join('/')}`;
        }
      }
      (matrix[spec.id] ??= {})[lane] = row;
    }
  }
  return matrix;
}
