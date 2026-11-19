import { format } from 'csv-rex/format';
import parseAll, { parse as createParser } from 'csv-rex/parse';
import type { CsvRexEntry, CsvRexOptions } from 'csv-rex/parse';
import { stripLeadingBom, type Adapter, type Dialect, type RecordRow, type Row } from '../lanes.ts';

// Imported from csv-rex/parse: the package root re-exports it through a
// self-reference while also depending on an older csv-rex@0.4.2.
const options = (dialect: Dialect, header: boolean): CsvRexOptions => ({
  header,
  delimiterChar: dialect.delimiter,
  newlineChar: dialect.newline,
  quoteChar: dialect.quote,
});

export default {
  'csv-rex': {
    package: 'csv-rex',
    // No BOM support in the bulk path (stripLeadingBom inside the timed call); the
    // S1 path decodes with TextDecoder, which drops a leading BOM.
    B1: (csv, dialect) => parseAll(stripLeadingBom(csv), options(dialect, false)) as Row[],
    B2: (csv, dialect) => parseAll(stripLeadingBom(csv), options(dialect, true)) as RecordRow[],
    S1: async (chunks, dialect, onRecord) => {
      const decoder = new TextDecoder();
      const parser = createParser(options(dialect, true));
      const controller = {
        enqueue: (entry: CsvRexEntry) => {
          if (entry.err) throw new Error(`csv-rex ${entry.err.code}: ${entry.err.message}`);
          onRecord(entry.data as RecordRow);
        },
      };
      for await (const chunk of chunks) {
        parser.chunkParse(
          parser.previousChunk() + decoder.decode(chunk, { stream: true }),
          controller,
        );
      }
      parser.chunkParse(parser.previousChunk() + decoder.decode(), controller, true);
    },
    // header false: with arrays, csv-rex would otherwise write an empty first line.
    W1: (data, header, dialect) =>
      format(data, {
        header: header ?? false,
        delimiterChar: dialect.delimiter,
        newlineChar: dialect.newline,
        quoteChar: dialect.quote,
        enableReturn: true,
      }),
  },
} satisfies Record<string, Adapter>;
