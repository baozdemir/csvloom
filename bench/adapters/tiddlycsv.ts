import { parseCSV, writeCSV } from 'tiddlycsv';
import {
  requireCommaQuote,
  requireLf,
  stripLeadingBom,
  UnsupportedDialectError,
  type Adapter,
  type Row,
} from '../lanes.ts';

// tiddlycsv has no options (comma, double quote, and '\n' when writing) and no
// header API; writeCSV writes arrays only. Its streaming API takes text chunks;
// not adapted because S1 is header-keyed.
export default {
  tiddlycsv: {
    package: 'tiddlycsv',
    B1: (csv, dialect) => {
      requireCommaQuote(dialect, 'tiddlycsv');
      return parseCSV(stripLeadingBom(csv)); // no BOM support: lane BOM policy
    },
    W1: (data, header, dialect) => {
      requireCommaQuote(dialect, 'tiddlycsv');
      requireLf(dialect, 'tiddlycsv');
      if (header !== null)
        throw new UnsupportedDialectError('tiddlycsv writeCSV writes arrays only');
      return writeCSV(data as Row[]);
    },
  },
} satisfies Record<string, Adapter>;
