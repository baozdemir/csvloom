import { Readable } from 'node:stream';
import csvParser from 'csv-parser';
import {
  skipLeadingBomBytes,
  stripLeadingBom,
  type Adapter,
  type Dialect,
  type RecordRow,
} from '../lanes.ts';

// csv-parser only emits objects (index-keyed when headers: false), so B1 is unsupported.
// Its newline option is a single character; the default accepts both \n and \r\n.
// No BOM support: the lane BOM policy is applied inside the timed call (string
// and byte-stream forms).
const options = (dialect: Dialect) => ({
  separator: dialect.delimiter,
  quote: dialect.quote,
  escape: dialect.quote,
});

export default {
  'csv-parser': {
    package: 'csv-parser',
    B2: (csv, dialect) =>
      new Promise<RecordRow[]>((resolve, reject) => {
        const records: RecordRow[] = [];
        csvParser(options(dialect))
          .on('data', (record: RecordRow) => records.push(record))
          .on('error', reject)
          .on('end', () => {
            resolve(records);
          })
          .end(stripLeadingBom(csv));
      }),
    S1: (chunks, dialect, onRecord) =>
      new Promise((resolve, reject) => {
        const parser = csvParser(options(dialect));
        parser.on('data', onRecord).on('error', reject).on('end', resolve);
        Readable.from(skipLeadingBomBytes(chunks), { objectMode: false })
          .on('error', reject)
          .pipe(parser);
      }),
  },
} satisfies Record<string, Adapter>;
