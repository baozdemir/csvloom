import { Readable } from 'node:stream';
import Papa from 'papaparse';
import {
  dropLineEndRecord,
  type Adapter,
  type Dialect,
  type RecordRow,
  type Row,
} from '../lanes.ts';

const config = (dialect: Dialect, fastMode?: boolean) => ({
  delimiter: dialect.delimiter,
  newline: dialect.newline,
  quoteChar: dialect.quote,
  ...(fastMode === undefined ? {} : { fastMode }),
});

function variant(fastMode?: boolean): Adapter {
  return {
    package: 'papaparse',
    B1: (csv, dialect) =>
      dropLineEndRecord(Papa.parse<Row>(csv, config(dialect, fastMode)).data, csv, dialect),
    B2: (csv, dialect) =>
      dropLineEndRecord(
        Papa.parse<RecordRow>(csv, { ...config(dialect, fastMode), header: true }).data,
        csv,
        dialect,
      ),
    // Papa's string path emits an extra record for the final line break (removed
    // above); its stream path does not, so S1 needs no final-record handling
    // (see the edge matrix in test/fixtures/adapter-edge-matrix.json).
    S1: (chunks, dialect, onRecord) =>
      new Promise((resolve, reject) => {
        // setEncoding decodes UTF-8 across chunk boundaries; Papa's own
        // Buffer.toString per chunk would split multi-byte characters.
        const source = Readable.from(chunks, { objectMode: false }).setEncoding('utf8');
        source.on('error', reject);
        Papa.parse<RecordRow>(source, {
          ...config(dialect, fastMode),
          header: true,
          chunk: (results) => {
            for (const record of results.data) onRecord(record);
          },
          complete: () => {
            resolve();
          },
          error: reject,
        });
      }),
    // fastMode is a parse option; Papa.unparse is measured once, as papaparse.
    ...(fastMode === undefined && {
      W1: (
        data: readonly Row[] | readonly RecordRow[],
        header: readonly string[] | null,
        d: Dialect,
      ) =>
        Papa.unparse(data as unknown[], {
          delimiter: d.delimiter,
          newline: d.newline,
          quoteChar: d.quote,
          ...(header && { columns: header as string[] }),
        }),
    }),
  };
}

export default {
  papaparse: variant(),
  'papaparse-fastmode': variant(true),
} satisfies Record<string, Adapter>;
