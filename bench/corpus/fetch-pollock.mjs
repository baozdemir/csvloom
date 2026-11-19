// Fetches the Pollock benchmark (Vitagliano et al., PVLDB 16, 2023) at the pinned commit into
// work/data/external/pollock/<commit>/ (git-ignored: nothing of the corpus is committed) and pins
// it: SHA256SUMS there lists every polluted file and evaluator file, and bench/corpus/pollock.json
// holds the SHA-256 of that list. A second run, or --verify, recomputes the sums and the git state
// and exits non-zero on any difference. survey/ and survey_sample/ are never checked out: their
// files carry no licence per file. Usage: node bench/corpus/fetch-pollock.mjs [--verify]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const REPOSITORY = 'https://github.com/HPI-Information-Systems/Pollock';
const COMMIT = 'bd2a646f4cf55d2bd4e76df511c9c9f675ae7bcc';
const DIR = `work/data/external/pollock/${COMMIT}`;
const MANIFEST = 'bench/corpus/pollock.json';
// Checked out: the top-level files (evaluate.py among them), the evaluator's modules, the polluted
// files, every system's published per-file scores, and the per-file outputs of the two systems
// the harness check scores again.
const SPARSE = [
  '/*',
  '!/*/',
  '/pollock/',
  '/sut/',
  '/polluted_files/',
  '/results/*.csv',
  '/results/*/polluted_files/*.csv',
  '/results/pandas/polluted_files/loading/',
  '/results/pycsv/polluted_files/loading/',
];
// Pinned by SHA-256 (everything else checked out is pinned by git's own hashes: see `status`).
const PINNED = [
  'LICENSE',
  'evaluate.py',
  'pollock',
  'pollock_weights.json',
  'polluted_files',
  'requirements.txt',
  'sut/utils.py',
];

const git = (...args) => execFileSync('git', ['-C', DIR, ...args], { encoding: 'utf8' });
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const filesUnder = (path) =>
  statSync(`${DIR}/${path}`).isDirectory()
    ? readdirSync(`${DIR}/${path}`)
        .filter((name) => name !== '__pycache__')
        .flatMap((name) => filesUnder(`${path}/${name}`))
    : [path];

if (!existsSync(DIR)) {
  if (process.argv.includes('--verify')) throw new Error(`${DIR} does not exist`);
  mkdirSync(DIR, { recursive: true });
  git('init', '-q');
  git('remote', 'add', 'origin', `${REPOSITORY}.git`);
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', COMMIT);
  git('sparse-checkout', 'set', '--no-cone', ...SPARSE);
  git('checkout', '-q', '--detach', COMMIT);
}

const problems = [];
const head = git('rev-parse', 'HEAD').trim();
if (head !== COMMIT) problems.push(`HEAD is ${head}, not ${COMMIT}`);
const status = git('status', '--porcelain', '--untracked-files=no');
if (status !== '') problems.push(`tracked files changed:\n${status}`);

const paths = PINNED.flatMap(filesUnder).sort();
const sums = paths.map((path) => `${sha256(readFileSync(`${DIR}/${path}`))}  ${path}\n`).join('');
if (!existsSync(`${DIR}/SHA256SUMS`)) writeFileSync(`${DIR}/SHA256SUMS`, sums);
const stored = new Set(readFileSync(`${DIR}/SHA256SUMS`, 'utf8').split('\n'));
const changed = sums.split('\n').filter((line) => !stored.has(line));
if (changed.length > 0) problems.push(`differs from ${DIR}/SHA256SUMS:\n${changed.join('\n')}`);

const manifest = `${JSON.stringify(
  {
    repository: REPOSITORY,
    commit: COMMIT,
    licence:
      'MIT (LICENSE at the commit); only polluted_files/ and the evaluator are used, survey/ and survey_sample/ are not (no licence per file)',
    files: paths.length,
    sha256OfSums: sha256(sums),
  },
  null,
  2,
)}\n`;
if (!existsSync(MANIFEST)) writeFileSync(MANIFEST, manifest);
if (readFileSync(MANIFEST, 'utf8') !== manifest) {
  problems.push(`${MANIFEST} differs from the files:\n${manifest}`);
}

if (problems.length > 0) {
  process.stderr.write(`Pollock corpus check FAILED\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Pollock ${COMMIT}: ${paths.length} files, sums ${sha256(sums)}: OK\n`);
