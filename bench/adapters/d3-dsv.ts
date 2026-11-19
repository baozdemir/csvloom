import { dsvFormat } from 'd3-dsv';
import {
  requireLf,
  stripLeadingBom,
  UnsupportedDialectError,
  type Adapter,
  type Dialect,
  type RecordRow,
  type Row,
} from '../lanes.ts';

const format = (dialect: Dialect) => {
  if (dialect.quote !== '"') throw new UnsupportedDialectError("d3-dsv always uses '\"'");
  return dsvFormat(dialect.delimiter);
};

// d3-dsv has no streaming API (S1 unsupported) and no quote or line-ending
// options: it always uses '"', accepts \n and \r\n, and writes \n.
export default {
  'd3-dsv': {
    package: 'd3-dsv',
    // No BOM support: the lane BOM policy is applied inside the timed call.
    B1: (csv, dialect) => format(dialect).parseRows(stripLeadingBom(csv)),
    B2: (csv, dialect) => format(dialect).parse(stripLeadingBom(csv)),
    W1: (data, header, dialect) => {
      requireLf(dialect, 'd3-dsv');
      return header === null
        ? format(dialect).formatRows(data as Row[])
        : format(dialect).format(data as RecordRow[], header);
    },
  },
} satisfies Record<string, Adapter>;
