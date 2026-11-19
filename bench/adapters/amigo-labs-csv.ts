import { parse, parseWithHeaders, stringify, stringifyObjects } from '@amigo-labs/csv';
import { requireLf, type Adapter, type Dialect, type RecordRow, type Row } from '../lanes.ts';

// Native (napi-rs) parser and writer. It takes a Buffer and byte-valued options, so
// the UTF-8 encode of the input is part of every timed parse. No streaming API.
// The writer has no line-ending option and writes '\n' after every record.
const options = (dialect: Dialect) => ({
  delimiter: dialect.delimiter.charCodeAt(0),
  quoteChar: dialect.quote.charCodeAt(0),
});

export default {
  'amigo-labs-csv': {
    package: '@amigo-labs/csv',
    B1: (csv, dialect) => parse(Buffer.from(csv), { ...options(dialect), hasHeaders: false }),
    B2: (csv, dialect) => parseWithHeaders(Buffer.from(csv), options(dialect)),
    W1: (data, header, dialect) => {
      requireLf(dialect, '@amigo-labs/csv');
      return header === null
        ? stringify(data as Row[], options(dialect))
        : stringifyObjects(data as RecordRow[], header as string[], options(dialect));
    },
  },
} satisfies Record<string, Adapter>;
