import { build, parse } from 'but-csv';
import {
  requireCommaQuote,
  requireLf,
  stripLeadingBom,
  UnsupportedDialectError,
  type Adapter,
  type Row,
} from '../lanes.ts';

// but-csv has no options (comma, double quote, and '\n' when writing) and no
// header or streaming API; build writes arrays only.
export default {
  'but-csv': {
    package: 'but-csv',
    B1: (csv, dialect) => {
      requireCommaQuote(dialect, 'but-csv');
      return parse(stripLeadingBom(csv)); // no BOM support: lane BOM policy
    },
    W1: (data, header, dialect) => {
      requireCommaQuote(dialect, 'but-csv');
      requireLf(dialect, 'but-csv');
      if (header !== null) throw new UnsupportedDialectError('but-csv build writes arrays only');
      return build(data as Row[]);
    },
  },
} satisfies Record<string, Adapter>;
