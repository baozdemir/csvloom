import { Readable } from 'node:stream';
import { parse, parseString } from '@fast-csv/parse';
import type { Adapter, Dialect, RecordRow, Row } from '../lanes.ts';

// fast-csv has no line-ending option; it accepts \n, \r\n and \r.
const options = (dialect: Dialect, headers: boolean) => ({
  delimiter: dialect.delimiter,
  quote: dialect.quote,
  escape: dialect.quote,
  headers,
});

function collect<T>(csv: string, dialect: Dialect, headers: boolean): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    parseString(csv, options(dialect, headers))
      .on('data', (row: T) => rows.push(row))
      .on('error', reject)
      .on('end', () => {
        resolve(rows);
      });
  });
}

export default {
  'fast-csv': {
    package: '@fast-csv/parse',
    B1: (csv, dialect) => collect<Row>(csv, dialect, false),
    B2: (csv, dialect) => collect<RecordRow>(csv, dialect, true),
    S1: (chunks, dialect, onRecord) =>
      new Promise((resolve, reject) => {
        const parser = parse(options(dialect, true));
        parser.on('data', onRecord).on('error', reject).on('end', resolve);
        Readable.from(chunks, { objectMode: false }).on('error', reject).pipe(parser);
      }),
  },
} satisfies Record<string, Adapter>;
