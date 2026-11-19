// Pollock harness, the system under test: parses every file of polluted_files/csv/ with the built
// dist/index.js as one arm configures it and writes the rows where upstream's evaluate.py reads
// them, results/csv-engine-<arm>/polluted_files/loading/<file>_converted.csv in the pinned checkout
// (the file layout evaluate.py reads). Prints, per file, the config, the rows and
// cells written and a SHA-256 of the cells, so that what Python's csv reader reads back can be
// compared. Usage: node bench/corpus/sut.mjs <arm>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { parse, parseDetailed } from '../../dist/index.js';

// Per arm: the function called and its config from one file's parameters. Every arm takes header
// from the parameters, so the arms differ only in how the dialect is found.
const ARMS = {
  // The default parse (delimiter and newline guessed, `"` quotes).
  guess: [parse, (parameters) => ({ header: parameters.header_lines > 0 })],
  // The parameters as options: an empty delimiter,
  // quotechar or escapechar is read as upstream's sut/utils.py reads it; row_delimiter is passed
  // only when it is "\n" or "\r", because the 2,287 files that say "\r\n" hold lone "\n" only.
  params: [
    parse,
    (parameters) => ({
      delimiter: parameters.delimiter || ',',
      quoteChar: parameters.quotechar || '"',
      escapeChar: parameters.escapechar || '"',
      ...(['\n', '\r'].includes(parameters.row_delimiter) && {
        newline: parameters.row_delimiter,
      }),
      header: parameters.header_lines > 0,
      skipFirstNLines: parameters.preamble_lines,
    }),
  ],
  detect: [parseDetailed, (parameters) => ({ header: parameters.header_lines > 0, detect: true })],
  'detect-repair': [
    parseDetailed,
    (parameters) => ({ header: parameters.header_lines > 0, detect: true, repair: true }),
  ],
};

// Python's csv.writer with its defaults, as upstream's systems write and evaluate.py reads: a field
// holding a comma, a quote or a line break is quoted, and a row of one empty field is written as ""
// (an empty line would be read back as a row with no field).
const field = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const line = (row) => (row.length === 1 && row[0] === '' ? '""' : row.map(field).join(','));

// header: true gives records keyed by meta.fields; each is written back as the values it holds, in
// field order, then its extra fields: nothing is padded or dropped.
const rowsOf = (result) =>
  result.meta.fields === undefined
    ? result.data
    : [
        result.meta.fields,
        ...result.data.map((record) => [
          ...result.meta.fields
            .filter((name) => Object.hasOwn(record, name))
            .map((name) => record[name]),
          ...(record.__parsed_extra ?? []),
        ]),
      ];

// What detect found and what repair changed, so a file's score can be explained from this output.
const found = ({ meta, repairCounts }) =>
  meta.detected === undefined
    ? '-'
    : JSON.stringify({
        ...Object.fromEntries(
          ['delimiter', 'newline', 'quoteChar', 'escapeChar', 'preambleLines', 'columns'].map(
            (key) => [key, meta.detected[key]],
          ),
        ),
        ...(repairCounts && { repairCounts }),
      });

const arm = process.argv[2];
const [run, configOf] = ARMS[arm] ?? [];
if (configOf === undefined) {
  throw new Error(`usage: node bench/corpus/sut.mjs <${Object.keys(ARMS).join('|')}>`);
}
execFileSync(process.execPath, ['bench/corpus/fetch-pollock.mjs', '--verify'], {
  stdio: 'inherit',
});
const { commit } = JSON.parse(readFileSync('bench/corpus/pollock.json', 'utf8'));
const root = `work/data/external/pollock/${commit}`;
const out = `${root}/results/csv-engine-${arm}/polluted_files/loading`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const say = (text) => process.stdout.write(`${text}\n`);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const names = readdirSync(`${root}/polluted_files/csv`)
  .filter((name) => name.endsWith('csv'))
  .sort();
const failures = [];
say(`arm ${arm}: ${run.name}(text, config), config = ${configOf.toString()}`);
say(
  'file\tconfig\trows\tcells\tsha256 of the rows (fields joined by U+001F, rows by U+001E)\tdetected',
);
for (const name of names) {
  const parameters = JSON.parse(
    readFileSync(`${root}/polluted_files/parameters/${name}_parameters.json`, 'utf8'),
  );
  const target = `${out}/${name}_converted.csv`;
  let text;
  try {
    if (!['ascii', 'utf-8'].includes(parameters.encoding)) {
      throw new Error(`encoding ${parameters.encoding} is not decoded`);
    }
    text = decoder.decode(readFileSync(`${root}/polluted_files/csv/${name}`));
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    writeFileSync(target, `Application Error\n${error.message}\n`);
    continue;
  }
  const config = configOf(parameters);
  const result = run(text, config);
  const rows = rowsOf(result);
  writeFileSync(target, rows.map((row) => `${line(row)}\r\n`).join(''));
  const cells = rows.reduce((sum, row) => sum + row.length, 0);
  const digest = sha256(rows.map((row) => row.join('\u001f')).join('\u001e'));
  say(`${name}\t${JSON.stringify(config)}\t${rows.length}\t${cells}\t${digest}\t${found(result)}`);
}
say(`files: ${names.length}, written as Application Error: ${failures.length}`);
for (const failure of failures) say(`  ${failure}`);
