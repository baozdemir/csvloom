import { writeToString } from '@fast-csv/format';
import type { Adapter, RecordRow, Row } from '../lanes.ts';

// Writer only (W1). writeToString is a streaming formatter drained into one string:
// the rows go through a CsvFormatterStream into a Writable that collects Buffers,
// then Buffer.concat and toString, all inside the timed call.
export default {
  'fast-csv-format': {
    package: '@fast-csv/format',
    W1: (data, header, dialect) =>
      writeToString(data as (Row | RecordRow)[], {
        delimiter: dialect.delimiter,
        rowDelimiter: dialect.newline,
        quote: dialect.quote,
        escape: dialect.quote,
        headers: header === null ? false : (header as string[]),
      }),
  },
} satisfies Record<string, Adapter>;
