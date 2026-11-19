import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import type { Adapter, AdapterOptions, Dialect, RecordRow } from '../lanes.ts';

// bom: true is csv-parse's native handling of a leading BOM (lane BOM policy).
// relax_quotes (quotes inside unquoted fields are data) is chosen per case in the
// manifest; it defaults to false, csv-parse's strict default.
const options = (dialect: Dialect, extra: AdapterOptions) => ({
  delimiter: dialect.delimiter,
  quote: dialect.quote,
  record_delimiter: dialect.newline,
  bom: true,
  relax_quotes: extra.relax_quotes === true,
});

export default {
  'csv-parse': {
    package: 'csv-parse',
    B1: (csv, dialect, extra) => parseSync(csv, options(dialect, extra)),
    B2: (csv, dialect, extra) =>
      parseSync<RecordRow>(csv, { ...options(dialect, extra), columns: true }),
    S1: (chunks, dialect, onRecord, extra) =>
      new Promise((resolve, reject) => {
        const parser = parse({ ...options(dialect, extra), columns: true });
        parser.on('data', onRecord).on('error', reject).on('end', resolve);
        Readable.from(chunks, { objectMode: false }).on('error', reject).pipe(parser);
      }),
  },
} satisfies Record<string, Adapter>;
