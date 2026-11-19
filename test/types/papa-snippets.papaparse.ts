/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the rows of a plain Papa.ParseConfig are `any` */
// Papa Parse code as its TypeScript users write it. This file and its twin beside it differ only
// in the module the next statement imports; test/types.test.ts compares the two texts and what
// they return, and npm run typecheck compiles both.
import Papa, {
  type ParseConfig,
  type ParseError,
  type ParseMeta,
  type ParseResult,
  type UnparseConfig,
} from 'papaparse';

interface Row {
  name: string;
  age: string;
}
const text = 'name,age\nAda,36\nGrace,45';

/** The row type as a type argument. */
function typeArgument(): string[] {
  const result = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  const rows: Row[] = result.data;
  return rows.map((row) => `${row.name} is ${row.age}`);
}

/** The row type from an annotation, and the type names read from the default import. */
function annotations(): Papa.ParseResult<Row> {
  const result: ParseResult<Row> = Papa.parse(text, { header: true });
  return result;
}

/** The row type from the function's return type. */
function returned(csv: string): ParseResult<string[]> {
  return Papa.parse(csv, { delimiter: ',', newline: '\n', download: false, worker: false });
}

/** Configs in variables: one with a row type, one without, whose rows are `any`. */
function configVariables(): unknown[] {
  const typed: ParseConfig<Row> = {
    header: true,
    dynamicTyping: false,
    transformHeader: (header) => header.trim(),
  };
  const rows: Row[] = Papa.parse(text, typed).data;
  const plain: Papa.ParseConfig = { header: true, comments: '#', delimitersToGuess: [',', ';'] };
  const first = Papa.parse(text, plain).data[0];
  return [rows.length, first.name];
}

/** Callbacks with their parameters annotated: with a header, a transform's field is a string. */
function callbacks(): Row[] {
  return Papa.parse<Row>(' name ,age\nAda, 36 ', {
    header: true,
    transformHeader: (header: string, index: number) => (index === 0 ? header.trim() : header),
    transform: (value: string, field: string) => (field === 'age' ? value.trim() : value),
    dynamicTyping: (field: string | number) => field === 'none',
    delimiter: (input: string) => (input.includes(';') ? ';' : ','),
  }).data;
}

/** Errors and meta, read as @types/papaparse declares them. */
function errorsAndMeta(): unknown {
  const { errors, meta } = Papa.parse<Row>('name,age\nAda\n"x', { header: true });
  const lines = errors.map(
    (error: ParseError) =>
      `${error.type}/${error.code}, row ${String(error.row)}, index ${String(error.index)}: ${error.message}`,
  );
  const headers: string[] = meta.fields ?? [];
  const read = (m: ParseMeta) => [m.delimiter, m.linebreak, m.aborted, m.truncated, m.cursor];
  const renamed = Object.keys(meta.renamedHeaders ?? {});
  return { lines, headers, meta: read(meta), renamed };
}

/** Neither a type argument nor an annotation: the rows are unknown until a cast states them. */
function casts(): unknown[] {
  const records = Papa.parse(text, { header: true }).data as Row[];
  const arrays = Papa.parse(text).data as string[][];
  return [records[0]?.name, arrays[0]?.[0]];
}

/** A result built by hand, as a wrapper or a test double builds one. */
function handBuilt(): ParseResult<Row> {
  const error: Papa.ParseError = { type: 'Quotes', code: 'MissingQuotes', message: 'm', row: 0 };
  const meta: Papa.ParseMeta = {
    delimiter: ',',
    linebreak: '\n',
    aborted: false,
    truncated: false,
    cursor: 0,
  };
  return { data: [{ name: 'Ada', age: '36' }], errors: [error], meta };
}

/** unparse and its config. */
function writing(): string[] {
  const config: UnparseConfig = { quotes: true, newline: '\n', columns: ['name', 'age'] };
  const other: Papa.UnparseConfig = { delimiter: ';', header: false };
  const rows = Papa.parse<Row>(text, { header: true }).data;
  return [
    Papa.unparse(rows, config),
    Papa.unparse({ fields: ['a', 'b'], data: [['1', '2']] }, other),
    Papa.unparse([['x', 'y']]),
  ];
}

export const snippets = (): Record<string, unknown> => ({
  typeArgument: typeArgument(),
  annotations: annotations(),
  returned: returned(text),
  configVariables: configVariables(),
  callbacks: callbacks(),
  errorsAndMeta: errorsAndMeta(),
  casts: casts(),
  handBuilt: handBuilt(),
  writing: writing(),
  constants: [Papa.RECORD_SEP, Papa.UNIT_SEP, Papa.BAD_DELIMITERS.length],
});
