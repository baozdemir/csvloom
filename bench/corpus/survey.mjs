// Dialect accuracy on the pinned Pollock checkout, for parse's guess (no delimiter given) or
// for detect, both from the built dist/index.js. The survey/ annotations are not used (no licence
// per file), so the ground truth is polluted_files/parameters:
// all its files derive from one designed source file, so the share measures robustness to
// pollution, not variety of real dialects. A file is right when delimiter, quotechar and
// escapechar all equal the parameters'. One mapping for both detectors: an escape that is the
// quote doubled is written as escapechar `"`, as the parameters write it (parse's guess always
// has quote `"` and that escape). Header and preamble are scored for detect only: its header guess
// against header_lines > 0, its preambleLines against preamble_lines.
// Halves: the parity of the first byte of SHA-256 of "polluted_files/csv/<name>", even for
// tuning, odd held out. With --half only that half's files are read, so a tuning run computes
// nothing on the held-out half. --sample <units> (detect only) gives detect each text cut as its
// own sample is cut, at that many units; a size above detect's 65,536 is accepted only when no
// file read is longer than 65,536 units, where the result is that of 65,536 by construction.
// Prints Markdown. Usage: node bench/corpus/survey.mjs [--detector guess|smart] [--half even|odd] [--sample <units>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs, TextDecoder } from 'node:util';
import { detect, parse } from '../../dist/index.js';

const DETECT_UNITS = 65_536;
const { values: args } = parseArgs({
  options: {
    detector: { type: 'string', default: 'guess' },
    half: { type: 'string' },
    sample: { type: 'string' },
  },
});
const smart = args.detector === 'smart';
const sample = args.sample === undefined ? DETECT_UNITS : Number(args.sample);
if (
  !['guess', 'smart'].includes(args.detector) ||
  ![undefined, 'even', 'odd'].includes(args.half) ||
  !Number.isSafeInteger(sample) ||
  sample < 1 ||
  (args.sample !== undefined && !smart)
) {
  throw new Error(
    'usage: survey.mjs [--detector guess|smart] [--half even|odd] [--sample <units>]',
  );
}

execFileSync(process.execPath, ['bench/corpus/fetch-pollock.mjs', '--verify'], {
  stdio: 'inherit',
});
const { commit } = JSON.parse(readFileSync('bench/corpus/pollock.json', 'utf8'));
const root = `work/data/external/pollock/${commit}`;
const KEYS = ['delimiter', 'quotechar', 'escapechar'];
const SCORED = smart ? [...KEYS, 'header', 'preamble'] : KEYS;

/** The text cut as detect cuts its sample, at `units`. */
const cut = (text, units) => {
  if (text.length <= units) return text;
  const at = Math.max(text.lastIndexOf('\n', units - 1), text.lastIndexOf('\r', units - 1));
  return text.slice(0, at === -1 ? units : at + 1);
};

let longest = 0;
const files = readdirSync(`${root}/polluted_files/csv`)
  .filter((name) => name.endsWith('csv'))
  .sort()
  .map((name) => {
    const path = `polluted_files/csv/${name}`;
    return {
      name,
      path,
      half: createHash('sha256').update(path).digest()[0] % 2 === 0 ? 'even' : 'odd',
    };
  })
  .filter((file) => args.half === undefined || file.half === args.half)
  .map(({ name, path, half }) => {
    const parameters = JSON.parse(
      readFileSync(`${root}/polluted_files/parameters/${name}_parameters.json`, 'utf8'),
    );
    const text = new TextDecoder().decode(readFileSync(`${root}/${path}`));
    longest = Math.max(longest, text.length);
    const annotated = Object.fromEntries(KEYS.map((key) => [key, parameters[key]]));
    let guessed;
    let undetectable = false;
    const right = {};
    if (smart) {
      const found = detect(sample < DETECT_UNITS ? cut(text, sample) : text);
      guessed = {
        delimiter: found.delimiter,
        quotechar: found.quoteChar,
        escapechar: found.escapeChar === found.quoteChar ? '"' : found.escapeChar,
      };
      right.header = found.header === parameters.header_lines > 0;
      right.preamble = found.preambleLines === parameters.preamble_lines;
    } else {
      const result = parse(text);
      guessed = { delimiter: result.meta.delimiter, quotechar: '"', escapechar: '"' };
      undetectable = result.errors.some((error) => error.code === 'UndetectableDelimiter');
    }
    for (const key of KEYS) right[key] = annotated[key] === guessed[key];
    right.all = KEYS.every((key) => right[key]);
    return { path, half, annotated, guessed, right, undetectable };
  });
if (sample > DETECT_UNITS && longest > DETECT_UNITS) {
  throw new Error(`--sample ${sample}: a file has ${longest} units, more than detect reads`);
}

const say = (text) => process.stdout.write(`${text}\n`);
const show = (dialect) => KEYS.map((key) => JSON.stringify(dialect[key])).join(' ');
const share = (group, key) => {
  const right = group.filter((file) => file.right[key]).length;
  return `${right} (${((100 * right) / group.length).toFixed(2)}%)`;
};
const head = execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=40'], {
  encoding: 'utf8',
}).trim();
const detector = smart ? `detect (sample ${sample} units)` : "today's guess";
say(`# Dialect accuracy of ${detector} on polluted_files/parameters\n`);
say(`Corpus: Pollock ${commit} (bench/corpus/pollock.json). csvloom: ${head}, dist/index.js.`);
say('Ground truth: polluted_files/parameters, not survey annotations (survey/ is not used);');
say('every file derives from one designed source file.');
say(`Files read: ${files.length} (${args.half ?? 'both halves'}); longest ${longest} units.`);
if (smart && sample > DETECT_UNITS) {
  say(`No file is longer than ${DETECT_UNITS} units: this is the result of ${DETECT_UNITS}.`);
}
if (!smart) say("Header and preamble: not scored, today's parse guesses neither.");
say('');
const titles = {
  delimiter: 'delimiter right',
  quotechar: 'quote right',
  escapechar: 'escape right',
  header: 'header guess right',
  preamble: 'preamble lines right',
};
say(
  `| half | files | delimiter, quote and escape right | ${SCORED.map((key) => titles[key]).join(' | ')} |`,
);
say(`| --- | --- | --- | ${SCORED.map(() => '---').join(' | ')} |`);
for (const [label, group] of [
  ['even (tuning)', files.filter((file) => file.half === 'even')],
  ['odd (held out)', files.filter((file) => file.half === 'odd')],
  ['all', args.half === undefined ? files : []],
]) {
  if (group.length === 0) continue;
  const cells = ['all', ...SCORED].map((key) => share(group, key));
  say(`| ${label} | ${group.length} | ${cells.join(' | ')} |`);
}
if (!smart) {
  const undetectable = files.filter((file) => file.undetectable);
  say(`\nUndetectableDelimiter reported (the parse then used ","): ${undetectable.length} files.`);
  for (const file of undetectable) say(`- ${file.path}`);
}
const wrong = files.filter((file) => !file.right.all);
say(
  `\n## Wrong files (${wrong.length}); dialects as JSON strings: delimiter quotechar escapechar\n`,
);
say('| half | path | annotated | guessed |');
say('| --- | --- | --- | --- |');
for (const file of wrong) {
  say(`| ${file.half} | ${file.path} | ${show(file.annotated)} | ${show(file.guessed)} |`);
}
if (smart) {
  for (const key of ['header', 'preamble']) {
    const missed = files.filter((file) => !file.right[key]);
    say(`\n## Wrong ${titles[key].replace(' right', '')} (${missed.length})\n`);
    for (const file of missed) say(`- ${file.half} ${file.path}`);
  }
}
