import parse from 'csv-simple-parser';
import {
  dropLineEndRecord,
  stripLeadingBom,
  type Adapter,
  type RecordRow,
  type Row,
} from '../lanes.ts';

// No BOM support (stripLeadingBom inside the timed call). No line-ending option (detected from the input), no option to skip the
// record it emits for the final line break, and no streaming API.
export default {
  'csv-simple-parser': {
    package: 'csv-simple-parser',
    B1: (csv, dialect) =>
      dropLineEndRecord(
        parse(stripLeadingBom(csv), {
          delimiter: dialect.delimiter,
          quote: dialect.quote,
        }) as Row[],
        csv,
        dialect,
      ),
    B2: (csv, dialect) =>
      dropLineEndRecord(
        parse(stripLeadingBom(csv), {
          delimiter: dialect.delimiter,
          quote: dialect.quote,
          header: true,
        }) as RecordRow[],
        csv,
        dialect,
      ),
  },
} satisfies Record<string, Adapter>;
