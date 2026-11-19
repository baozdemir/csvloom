import { inferSchema, initParser } from 'udsv';
import type { Parser } from 'udsv';
import type { Adapter, Dialect, RecordRow, Row } from '../lanes.ts';

// uDSV needs a schema per input. The dialect is passed explicitly, so
// inferSchema only reads the header row and column names. Schema inference and
// parser setup run inside every timed call, as they would for a caller.
const options = (dialect: Dialect) => ({
  col: dialect.delimiter,
  row: dialect.newline,
  encl: dialect.quote,
});

export default {
  udsv: {
    package: 'udsv',
    B1: (csv, dialect) =>
      initParser(inferSchema(csv, { ...options(dialect), header: () => [] })).stringArrs<Row>(csv),
    B2: (csv, dialect) => initParser(inferSchema(csv, options(dialect))).stringObjs<RecordRow>(csv),
    S1: async (chunks, dialect, onRecord) => {
      // inferSchema needs the whole header line, so text is buffered until the
      // first line break before the parser is created.
      const decoder = new TextDecoder();
      let parser: Parser | undefined;
      let pending = '';
      const onData = (record: RecordRow) => {
        onRecord(record);
      };
      const feed = (text: string) => {
        if (!parser) {
          pending += text;
          if (!pending.includes(dialect.newline)) return;
          parser = initParser(inferSchema(pending, options(dialect)));
          text = pending;
          pending = '';
        }
        parser.chunk(text, parser.stringObjs, onData);
      };
      for await (const chunk of chunks) feed(decoder.decode(chunk, { stream: true }));
      feed(decoder.decode());
      if (!parser && pending) {
        parser = initParser(inferSchema(pending, options(dialect)));
        parser.chunk(pending, parser.stringObjs, onData);
      }
      parser?.end();
    },
  },
} satisfies Record<string, Adapter>;
