// Plain JS: web-csv-toolbox 0.15.0 ships declarations with extensionless
// relative re-exports that TypeScript's NodeNext resolution rejects (TS2307),
// while the runtime "node" export condition loads fine.
//
// High-level async API only. B1 (array output keeping the header row) exists in
// lower-level factories whose header semantics were not verified.
import { Readable } from 'node:stream';
import { parse } from 'web-csv-toolbox';
import { stripLeadingBom } from '../lanes.ts';

const options = (dialect) => ({ delimiter: dialect.delimiter, quotation: dialect.quote });

export default {
  'web-csv-toolbox': {
    package: 'web-csv-toolbox',
    B2: async (csv, dialect) => {
      const records = [];
      // String input keeps a leading BOM; the lane BOM policy is applied here, inside
      // the timed call. The byte-stream path (S1) already drops it.
      for await (const record of parse(stripLeadingBom(csv), options(dialect)))
        records.push(record);
      return records;
    },
    S1: async (chunks, dialect, onRecord) => {
      const body = Readable.toWeb(Readable.from(chunks, { objectMode: false }));
      for await (const record of parse(body, options(dialect))) onRecord(record);
    },
  },
};
