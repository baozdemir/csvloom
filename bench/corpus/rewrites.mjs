// Formula escaping on real files: per corpus, how many
// cells and header cells the main entry's unparse would prefix with "'", by first character and by
// shape, with 20 real examples per shape. Three arms, each decided by the built dist/index.js
// (a cell counts when its one-cell output differs from the output with escapeFormulae off):
//   first character alone  escapeFormulae: FIRST_CHARACTER, a RegExp, used as given (no exemption);
//   as specified           escapeFormulae: true (the built rule, with its plain-number exemption);
//   variant W              as specified, and also not prefixed when W_NUMBER matches (not built).
// Corpora, each reported on its own: the three external datasets of bench/manifest.json (SHA-256
// checked) and the clean files of Pollock's polluted_files/clean (fetch-pollock.mjs --verify).
// Prints Markdown. Usage: node bench/corpus/rewrites.mjs  (after npm run build)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { parse, unparse } from '../../dist/index.js';

const FIRST_CHARACTER = /^[=+\-@\t\r\n\uff1d\uff0b\uff0d\uff20]/;
// Variant W's pattern: a wider plain-number exemption (thousands separators, decimal comma, %).
const W_NUMBER = /^[+-]?(?:\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d+)(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?$/;
const EXAMPLES = 20;
const FIRSTS = [
  ['=', '='],
  ['+', '+'],
  ['-', '-'],
  ['@', '@'],
  ['tab', '\t'],
  ['CR', '\r'],
  ['LF', '\n'],
  ['full-width ＝', '\uff1d'],
  ['full-width ＋', '\uff0b'],
  ['full-width －', '\uff0d'],
  ['full-width ＠', '\uff20'],
];
// An ordered partition of the cells the first character alone would prefix: the first match wins.
const SHAPES = [
  ['header cell starting with @ (@timestamp, @id)', (cell, header) => header && cell[0] === '@'],
  [
    'signed plain number, left alone by the exemption (-5, +1.5, -2e3)',
    (_c, _h, arms) => !arms.specified,
  ],
  ['a lone - or +, or a run of them', (cell) => /^[-+]+$/.test(cell)],
  ['signed percentage (-3%, +5.2%)', (cell) => /^[-+]\d[\d.,]*\s?%$/.test(cell)],
  [
    'signed number with digit grouping (-1,234.56)',
    (cell) => /^[-+]\d{1,3}(?:[,.\u00a0 ]\d{3})+(?:[.,]\d+)?$/.test(cell),
  ],
  ['signed number with a decimal comma (-1,5)', (cell) => /^[-+]\d+,\d+$/.test(cell)],
  [
    'phone-like: + then digits and separators (+90 555 123 45 67)',
    (cell) => /^\+\d[\d \-()./]*$/.test(cell),
  ],
  ['@handle (@ then letters, digits, _ or .)', (cell) => /^@[\w.]+$/.test(cell)],
  ['starts with =', (cell) => cell[0] === '='],
  ['starts with a tab, CR or LF', (cell) => /^[\t\r\n]/.test(cell)],
  ['starts with a full-width ＝ ＋ － ＠', (cell) => /^[\uff1d\uff0b\uff0d\uff20]/.test(cell)],
  ['text that starts with - or + (bullet-like)', (cell) => /^[-+]/.test(cell)],
  ['everything else', () => true],
];

const say = (text = '') => process.stdout.write(`${text}\n`);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const percent = (part, whole) => (whole === 0 ? '0' : ((100 * part) / whole).toPrecision(3));
const show = (cell) => JSON.stringify(cell.length > 60 ? `${cell.slice(0, 60)}…` : cell);

const verified = execFileSync(process.execPath, ['bench/corpus/fetch-pollock.mjs', '--verify'], {
  encoding: 'utf8',
}).trim();
const pollock = JSON.parse(readFileSync('bench/corpus/pollock.json', 'utf8'));
const pollockRoot = `work/data/external/pollock/${pollock.commit}`;
const manifest = JSON.parse(readFileSync('bench/manifest.json', 'utf8'));
const external = (id) => manifest.cases.find((entry) => entry.id === id).external;

const CORPORA = [
  ['B1-ext-nga-text-entries', true],
  ['B1-ext-geonames-cities1000', false],
  ['B1-ext-tate-artwork', true],
].map(([id, header]) => {
  const { path, sha256: pinned, dialect, source, license } = external(id);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== pinned)
    throw new Error(`${path}: SHA-256 differs from bench/manifest.json`);
  return {
    label: path,
    about: [
      `source: ${source}`,
      `licence: ${license}`,
      `SHA-256 ${pinned}: matches bench/manifest.json`,
    ],
    config: { delimiter: dialect.delimiter, newline: dialect.newline, quoteChar: dialect.quote },
    header: header ? 'record 1' : 'none (the file has no header record)',
    files: [{ name: path, text: decoder.decode(bytes), header }],
  };
});
const clean = `${pollockRoot}/polluted_files/clean`;
CORPORA.push({
  label: `Pollock polluted_files/clean (${pollock.commit.slice(0, 8)})`,
  about: [
    `source: ${pollock.repository} at ${pollock.commit}, polluted_files/clean/`,
    `licence: ${pollock.licence}`,
    `fetch-pollock.mjs --verify: ${verified}`,
    'every file is a variant of one designed source table (source.csv), so the same values repeat across files: read the distinct-value counts',
  ],
  config: { delimiter: ',', newline: '\n', quoteChar: '"' },
  header: 'record 1 of each file (as evaluate.py reads them)',
  files: readdirSync(clean)
    .sort()
    .map((name) => ({
      name: `polluted_files/clean/${name}`,
      text: decoder.decode(readFileSync(`${clean}/${name}`)),
      header: true,
    })),
});

const tally = () => ({ cells: 0, files: new Set(), values: new Set() });
const arms = ['first', 'specified', 'w'];
const armTally = () => Object.fromEntries(arms.map((arm) => [arm, tally()]));
const add = (entry, file, cell) => {
  entry.cells++;
  entry.files.add(file);
  entry.values.add(cell);
};

say('# Formula escaping: the cells the main rule would rewrite');
say();
say(
  `Run ${new Date().toISOString()}, csvloom ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}, Node ${process.version}, dist/index.js SHA-256 ${sha256(readFileSync('dist/index.js'))}.`,
);
say();
say(
  'Arms, each decided by the built `unparse` on the one cell (prefixed when its output differs from the output with `escapeFormulae: false`):',
);
say(
  `- **first character alone**: \`escapeFormulae: ${FIRST_CHARACTER}\` (a RegExp is used as given, with no exemption): what the eleven first characters would catch without the number exemption.`,
);
say(
  '- **as specified**: `escapeFormulae: true`, the built rule (its first characters and its plain-number exemption).',
);
say(
  `- **variant W** (not built): as specified, and also left alone when the whole cell matches \`${W_NUMBER}\`, so W's exemption is the specified one or W's pattern.`,
);

for (const corpus of CORPORA) {
  const totals = { cells: 0, header: 0, errors: 0, filesWithErrors: 0 };
  const byArm = armTally();
  const headerByArm = armTally();
  const byFirst = new Map(FIRSTS.map(([label]) => [label, armTally()]));
  const byShape = new Map(SHAPES.map(([label]) => [label, { ...armTally(), examples: new Map() }]));
  const exemptNotW = tally();
  for (const file of corpus.files) {
    const result = parse(file.text, corpus.config);
    if (result.errors.length > 0) {
      totals.errors += result.errors.length;
      totals.filesWithErrors++;
    }
    const rows = result.data;
    const last = rows.at(-1);
    if (last?.length === 1 && last[0] === '') rows.pop();
    rows.forEach((row, r) => {
      const header = file.header && r === 0;
      row.forEach((cell, c) => {
        totals.cells++;
        if (header) totals.header++;
        const plain = unparse([[cell]], { escapeFormulae: false });
        if (unparse([[cell]], { escapeFormulae: FIRST_CHARACTER }) === plain) return;
        const prefixed = {
          first: true,
          specified: unparse([[cell]], { escapeFormulae: true }) !== plain,
        };
        prefixed.w = prefixed.specified && !W_NUMBER.test(cell);
        if (!prefixed.specified && !W_NUMBER.test(cell)) add(exemptNotW, file.name, cell);
        const first = FIRSTS.find(([, unit]) => cell[0] === unit)?.[0];
        if (first === undefined)
          throw new Error(`${file.name}: no first-character row for ${show(cell)}`);
        const shape = SHAPES.find(([, test]) => test(cell, header, prefixed))[0];
        const examples = byShape.get(shape).examples;
        if (examples.size < EXAMPLES && !examples.has(cell)) {
          examples.set(cell, `${file.name}, record ${r + 1}, field ${c + 1}`);
        }
        for (const arm of arms) {
          if (!prefixed[arm]) continue;
          add(byArm[arm], file.name, cell);
          if (header) add(headerByArm[arm], file.name, cell);
          add(byFirst.get(first)[arm], file.name, cell);
          add(byShape.get(shape)[arm], file.name, cell);
        }
      });
    });
  }
  for (const rows of [byFirst, byShape]) {
    for (const arm of arms) {
      const sum = [...rows.values()].reduce((total, row) => total + row[arm].cells, 0);
      if (sum !== byArm[arm].cells)
        throw new Error(`${corpus.label}: rows of ${arm} sum to ${sum}`);
    }
  }

  say();
  say(`## ${corpus.label}`);
  say();
  for (const line of corpus.about) say(`- ${line}`);
  say(
    `- parsed with \`${JSON.stringify(corpus.config)}\`, a final record \`['']\` (the line break at the end) dropped; header cells: ${corpus.header}`,
  );
  say(
    `- parse errors: ${totals.errors} in ${totals.filesWithErrors} of ${corpus.files.length} files`,
  );
  say();
  say('| | first character alone | as specified | variant W |');
  say('| --- | ---: | ---: | ---: |');
  say(`| files | ${corpus.files.length} | | |`);
  say(`| cells (header cells included) | ${totals.cells} | | |`);
  say(`| header cells | ${totals.header} | | |`);
  const row = (label, pick) => say(`| ${label} | ${arms.map((arm) => pick(arm)).join(' | ')} |`);
  row('cells rewritten', (arm) => byArm[arm].cells);
  row('share of all cells, %', (arm) => percent(byArm[arm].cells, totals.cells));
  row('distinct values rewritten', (arm) => byArm[arm].values.size);
  row('files with at least one rewrite', (arm) => byArm[arm].files.size);
  row('header cells rewritten', (arm) => headerByArm[arm].cells);
  say();
  say(
    `The number exemption leaves alone ${byArm.first.cells - byArm.specified.cells} cells (${byArm.first.values.size - byArm.specified.values.size} distinct values) that the first character alone would rewrite; variant W would leave alone ${byArm.specified.cells - byArm.w.cells} more (${byArm.specified.values.size - byArm.w.values.size} distinct). Cells the specified exemption leaves alone that W's pattern alone would not: ${exemptNotW.cells} (${[...exemptNotW.values].slice(0, 10).map(show).join(', ') || 'none'}).`,
  );
  say();
  say('By first character (cells; distinct values in brackets):');
  say();
  say(
    '| first character | first character alone | as specified | variant W | share of all cells, as specified, % | files, as specified |',
  );
  say('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [label, entry] of byFirst) {
    say(
      `| ${label} | ${arms.map((arm) => `${entry[arm].cells} (${entry[arm].values.size})`).join(' | ')} | ${percent(entry.specified.cells, totals.cells)} | ${entry.specified.files.size} |`,
    );
  }
  say();
  say(
    'By shape (an ordered partition: a cell is counted in the first shape it matches; cells; distinct values in brackets):',
  );
  say();
  say(
    '| shape | first character alone | as specified | variant W | share of all cells, as specified, % | files, as specified |',
  );
  say('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [label, entry] of byShape) {
    say(
      `| ${label} | ${arms.map((arm) => `${entry[arm].cells} (${entry[arm].values.size})`).join(' | ')} | ${percent(entry.specified.cells, totals.cells)} | ${entry.specified.files.size} |`,
    );
  }
  say();
  say(
    `Examples: up to ${EXAMPLES} distinct values per shape, in file order, each with where it first occurs (record and field numbers are 1-based). "W keeps it" means variant W would not rewrite it.`,
  );
  for (const [label, entry] of byShape) {
    if (entry.examples.size === 0) continue;
    say();
    say(`- ${label}:`);
    for (const [cell, where] of entry.examples) {
      say(
        `  - ${show(cell)} (${where})${entry.specified.values.has(cell) && !entry.w.values.has(cell) ? ', W keeps it' : ''}`,
      );
    }
  }
  const rest = byShape.get('everything else').first.values;
  if (rest.size > EXAMPLES && rest.size < 200) {
    say();
    say(`- everything else, all ${rest.size} distinct values: ${[...rest].map(show).join(', ')}`);
  }
}
