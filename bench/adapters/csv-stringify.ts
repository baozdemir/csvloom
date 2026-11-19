import { stringify } from 'csv-stringify/sync';
import type { Adapter } from '../lanes.ts';

// Writer only (W1), its sync entry. header: true writes the column names, which
// the default (false) does not; eof (default true) ends the text with a line break.
export default {
  'csv-stringify': {
    package: 'csv-stringify',
    W1: (data, header, dialect) =>
      stringify(data as unknown[], {
        delimiter: dialect.delimiter,
        quote: dialect.quote,
        record_delimiter: dialect.newline,
        ...(header && { header: true, columns: header }),
      }),
  },
} satisfies Record<string, Adapter>;
