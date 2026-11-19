import { createCsvParser, parse, stringify } from 'csv-pipe';
import { UnsupportedDialectError, type Adapter, type Dialect, type RecordRow } from '../lanes.ts';

// skipEmptyLines defaults to true in csv-pipe; disabled to match the lane contract.
const options = (dialect: Dialect) => ({
  separator: dialect.delimiter,
  quote: dialect.quote,
  skipEmptyLines: false,
});

export default {
  'csv-pipe': {
    package: 'csv-pipe',
    B1: (csv, dialect) => parse(csv, { ...options(dialect), header: false }),
    B2: (csv, dialect) => parse<RecordRow>(csv, options(dialect)),
    S1: async (chunks, dialect, onRecord) => {
      for await (const record of createCsvParser<RecordRow>(options(dialect)).stream(chunks)) {
        onRecord(record);
      }
    },
    // stringify encodes records keyed by column name (CsvRecord); arrays are not a documented input.
    W1: (data, header, dialect) => {
      if (header === null)
        throw new UnsupportedDialectError('csv-pipe stringify writes objects only');
      return stringify(data as RecordRow[], {
        columns: header,
        separator: dialect.delimiter,
        quote: dialect.quote,
        newline: dialect.newline,
      });
    },
  },
} satisfies Record<string, Adapter>;
