import { isDeepStrictEqual } from 'node:util';

// Lane contracts (see docs/benchmarks.md):
// B1  in-memory string -> every record as string[] (header row included)
// B2  in-memory string -> one object per data record keyed by the header row; a
//     record shorter than the header has only the fields it contains
// S1  UTF-8 byte chunks -> B2 records delivered incrementally, none retained
// W1  rows (B1 shape) or records (B2 shape, with the header as column order) ->
//     one CSV string in the dialect, which Papa Parse must read back cell for cell
// In every parsing lane the line break that ends the input does not create a
// record. Every other record is preserved, including blank lines. Exactly one
// leading UTF-8 BOM (U+FEFF after decoding) is an encoding marker, not data; a
// U+FEFF anywhere else, and leading whitespace, are data.

export type Lane = 'B1' | 'B2' | 'S1' | 'W1';

export interface Dialect {
  delimiter: string;
  quote: string;
  newline: '\n' | '\r\n';
}

export type Row = string[];
export type RecordRow = Record<string, string>;

/** Library options recorded per case in the manifest (for example csv-parse relax_quotes). */
export type AdapterOptions = Readonly<Record<string, unknown>>;

export interface Adapter {
  /** npm package whose installed version is reported with results */
  package: string;
  B1?: (csv: string, dialect: Dialect, options: AdapterOptions) => Row[] | Promise<Row[]>;
  B2?: (
    csv: string,
    dialect: Dialect,
    options: AdapterOptions,
  ) => RecordRow[] | Promise<RecordRow[]>;
  /** Calls onRecord for each data record, in order. */
  S1?: (
    chunks: AsyncIterable<Uint8Array>,
    dialect: Dialect,
    onRecord: (record: RecordRow) => void,
    options: AdapterOptions,
  ) => Promise<void>;
  /** Rows (string[][], header row first) or records (with `header` as the column order) to one CSV string in the dialect. */
  W1?: (
    data: readonly Row[] | readonly RecordRow[],
    header: readonly string[] | null,
    dialect: Dialect,
    options: AdapterOptions,
  ) => string | Promise<string>;
}

/** Thrown by adapters whose library cannot be configured for a dialect (or, in W1, an input shape). */
export class UnsupportedDialectError extends Error {}

/** W1 for libraries that always write '\n' between records. */
export function requireLf(dialect: Dialect, library: string): void {
  if (dialect.newline !== '\n') {
    throw new UnsupportedDialectError(`${library} always writes '\\n' between records`);
  }
}

/** For libraries hard-wired to comma and double quote. */
export function requireCommaQuote(dialect: Dialect, library: string): void {
  if (dialect.delimiter !== ',' || dialect.quote !== '"') {
    throw new UnsupportedDialectError(`${library} only supports ',' and '"'`);
  }
}

/**
 * BOM normalization for libraries without BOM support, applied inside the timed
 * operation: removes exactly one leading U+FEFF. O(1) when there is none.
 */
export function stripLeadingBom(csv: string): string {
  return csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
}

const BOM_BYTES = [0xef, 0xbb, 0xbf];

/** Byte-stream counterpart of stripLeadingBom; handles a BOM split across chunks. */
export async function* skipLeadingBomBytes(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const matched: number[] = [];
  let decided = false;
  for await (const chunk of chunks) {
    if (decided) {
      yield chunk;
      continue;
    }
    let i = 0;
    while (i < chunk.length && matched.length < 3 && chunk[i] === BOM_BYTES[matched.length]) {
      matched.push(chunk[i] ?? 0);
      i++;
    }
    if (matched.length === 3) {
      decided = true;
      if (i < chunk.length) yield chunk.subarray(i);
    } else if (i < chunk.length) {
      decided = true;
      if (matched.length > 0) yield Uint8Array.from(matched);
      yield chunk.subarray(i);
    }
  }
  if (!decided && matched.length > 0) yield Uint8Array.from(matched);
}

// Timed paths fully consume output with the same cheap walk for every adapter,
// so lazily built results cannot skip work.
export function consumeRows(rows: readonly Row[]): number {
  let total = 0;
  for (const row of rows) {
    for (const field of row) total += field.length;
  }
  return total;
}

export function consumeRecord(record: RecordRow, header: readonly string[]): number {
  let total = 0;
  for (const key of header) total += record[key]?.length ?? -1;
  return total;
}

export function consumeRecords(records: readonly RecordRow[], header: readonly string[]): number {
  let total = 0;
  for (const record of records) total += consumeRecord(record, header);
  return total;
}

// W1 output must be one fully built string. A string built with += is a rope
// in V8 until a character is read from it; reading the last code unit flattens
// it (one copy), so a rope cannot leave that copy outside the timed region. A
// string built with join is already flat and costs nothing more here.
export function consumeText(text: string): number {
  return text.length + text.charCodeAt(text.length - 1);
}

// The extra record some parsers emit for the final line break: [''] (padded with
// undefined by some), or a record whose only value is ''.
const isLineEndArtifact = (fields: readonly unknown[]) =>
  fields[0] === '' && fields.every((field, i) => i === 0 || field === undefined);

/**
 * For parsers that always emit one extra record for the line break that ends the
 * input. Removes only that final record, in O(1), and only when the input ends
 * with the dialect's line break; a genuine blank record before it is kept.
 */
export function dropLineEndRecord<T extends Row | RecordRow>(
  rows: T[],
  csv: string,
  dialect: Dialect,
): T[] {
  const last = rows.at(-1);
  if (
    last &&
    csv.endsWith(dialect.newline) &&
    isLineEndArtifact(Array.isArray(last) ? last : Object.values(last))
  ) {
    rows.pop();
  }
  return rows;
}

/** B2 view of B1 rows: a short record keeps only the fields it has. */
export function toRecords(rows: readonly Row[]): RecordRow[] {
  const [header = [], ...data] = rows;
  return data.map((row) =>
    Object.fromEntries(row.map((value, i) => [header[i] ?? String(i), value])),
  );
}

/** Null when the row has the shape its lane requires. */
export function shapeError(lane: Lane, row: unknown): string | null {
  if (lane === 'B1') {
    if (!Array.isArray(row)) return 'B1 row is not an array';
    for (let i = 0; i < row.length; i++) {
      if (typeof row[i] !== 'string') return `B1 row field ${String(i)} is not a string`;
    }
    return null;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return `${lane} record is not an object`;
  }
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string') return `${lane} record field ${key} is not a string`;
  }
  return null;
}

export interface Mismatch {
  index: number;
  reason: 'length' | 'shape' | 'value';
  expected: unknown;
  actual: unknown;
}

// Records are compared by own enumerable keys and values only: key order and
// prototype (plain vs null-prototype objects) are not part of the lane contract.
const normalize = (row: unknown) =>
  row !== null && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row;

/** Full output equality: equal length, lane-valid shapes, and strictly equal rows. */
export function firstMismatch(
  actual: readonly unknown[],
  expected: readonly unknown[],
  lane?: Lane,
): Mismatch | null {
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
    const shape = lane ? shapeError(lane, actual[i]) : null;
    if (shape) return { index: i, reason: 'shape', expected: expected[i], actual: shape };
    if (!isDeepStrictEqual(normalize(actual[i]), normalize(expected[i]))) {
      return { index: i, reason: 'value', expected: expected[i], actual: actual[i] };
    }
  }
  if (actual.length !== expected.length) {
    const index = Math.min(actual.length, expected.length);
    return { index, reason: 'length', expected: expected.length, actual: actual.length };
  }
  return null;
}

/** The part of csvloom's `parse` the candidate adapter uses, from source or from a built bundle. */
export type CandidateParse = (
  csv: string,
  config: { delimiter: string; newline: Dialect['newline']; quoteChar: string; header?: boolean },
) => { data: unknown[] };

/** The part of csvloom/stream's `parseStream` the candidate's S1 function uses. */
export type CandidateParseStream = (
  source: AsyncIterable<Uint8Array>,
  config: {
    delimiter: string;
    newline: Dialect['newline'];
    quoteChar: string;
    header: true;
    batchSize: number;
    maxRecordLength?: number;
  },
) => AsyncIterable<{ data: unknown[] }>;

/** The candidate's S1 batch size unless the case's options set `batchSize`. */
export const S1_BATCH_SIZE = 1024;

/** The S1 arm that collects the chunks and parses them in bulk. */
export const BULK_IMPL = 'csv-engine-bulk';

/** The source's last two bytes as it passes; read once it has ended. */
function watchEnd(chunks: AsyncIterable<Uint8Array>) {
  const end = { last: -1, beforeLast: -1 };
  async function* pass() {
    for await (const chunk of chunks) {
      const n = chunk.length;
      if (n > 0) {
        end.beforeLast = n > 1 ? (chunk[n - 2] ?? -1) : end.last;
        end.last = chunk[n - 1] ?? -1;
      }
      yield chunk;
    }
  }
  return {
    chunks: pass(),
    endsWith: (newline: Dialect['newline']) =>
      end.last === 0x0a && (newline === '\n' || end.beforeLast === 0x0d),
  };
}

/** The part of csvloom's main-entry `unparse` the candidate's W1 function uses. */
export type CandidateUnparse = (
  data: readonly unknown[],
  config: {
    delimiter: string;
    newline: Dialect['newline'];
    quoteChar: string;
    columns?: readonly string[];
    escapeFormulae?: false;
  },
) => string;

/**
 * The candidate's adapter around a given `parse` (and `unparse` for W1, `parseStream`
 * for S1): method v1
 * passes the TypeScript source's `parse`, method v2 the `parse` and `unparse`
 * exported by a built `dist/index.js` (W1 runs on method v2 only). The parser removes one leading BOM itself, and like Papa it
 * returns a [''] record for the line break that ends the input, which the lane
 * contract drops in O(1) (interior blank records stay). W1 passes the dialect, for
 * records `columns`, and `escapeFormulae: false` (the same work as the
 * other writers whatever the entry's default is), nothing else; the adapter option
 * `omitEscapeFormulae` (the diagnostic arm of manifest-v2 `w1.arms`) leaves that key
 * out, so the entry's default applies. S1 iterates parseStream's batches with `header: true`,
 * the case's `batchSize` (else S1_BATCH_SIZE) and `maxRecordLength` (else none), and
 * drops the record a final line break gives, exactly as B2 does: one record is held
 * back until the source has ended, since the last batch may hold no row.
 */
export function candidateAdapter(
  parse: CandidateParse,
  unparse?: CandidateUnparse,
  parseStream?: CandidateParseStream,
): Adapter {
  const config = ({ delimiter, newline, quote }: Dialect) => ({
    delimiter,
    newline,
    quoteChar: quote,
  });
  return {
    package: 'csv-engine',
    B1: (csv, dialect) =>
      dropLineEndRecord(parse(csv, config(dialect)).data as Row[], csv, dialect),
    B2: (csv, dialect) =>
      dropLineEndRecord(
        // Values are strings unless a record has more fields than the header
        // (__parsed_extra); the lane check rejects that shape.
        parse(csv, { ...config(dialect), header: true }).data as RecordRow[],
        csv,
        dialect,
      ),
    ...(unparse && {
      W1: (
        data: readonly Row[] | readonly RecordRow[],
        header: readonly string[] | null,
        d: Dialect,
        options: AdapterOptions,
      ) =>
        unparse(data, {
          ...config(d),
          ...(header === null ? {} : { columns: header }),
          ...(options.omitEscapeFormulae === true ? {} : { escapeFormulae: false as const }),
        }),
    }),
    ...(parseStream && {
      S1: async (
        chunks: AsyncIterable<Uint8Array>,
        dialect: Dialect,
        onRecord: (record: RecordRow) => void,
        options: AdapterOptions,
      ) => {
        const source = watchEnd(chunks);
        const { batchSize = S1_BATCH_SIZE, maxRecordLength } = options as {
          batchSize?: number;
          maxRecordLength?: number;
        };
        let held: RecordRow | undefined;
        for await (const batch of parseStream(source.chunks, {
          ...config(dialect),
          header: true,
          batchSize,
          ...(maxRecordLength === undefined ? {} : { maxRecordLength }),
        })) {
          for (const record of batch.data as RecordRow[]) {
            if (held !== undefined) onRecord(held);
            held = record;
          }
        }
        if (
          held !== undefined &&
          !(source.endsWith(dialect.newline) && isLineEndArtifact(Object.values(held)))
        )
          onRecord(held);
      },
    }),
  };
}

/**
 * The bulk equivalent of the candidate's S1 work (arm `csv-engine-bulk`): the chunks are
 * collected into one byte array, decoded by one fatal `TextDecoder.decode` that keeps a
 * BOM (as the stream's decoder does; `parse` removes one), and parsed by the candidate's
 * B2 function; each record then goes to onRecord.
 */
export function bulkAdapter(parse: CandidateParse): Adapter {
  const b2 = candidateAdapter(parse).B2 as (csv: string, dialect: Dialect) => RecordRow[];
  return {
    package: 'csv-engine',
    S1: async (chunks, dialect, onRecord) => {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of chunks) {
        parts.push(chunk);
        size += chunk.length;
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      const csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      for (const record of b2(csv, dialect)) onRecord(record);
    },
  };
}
