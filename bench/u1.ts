// The U1 timing runner: the browser file flow of
// test/browser/page/u1.html in headless Chromium, on Linux only. Each round
// starts a fresh browser whose whole process tree is pinned with taskset to one CPU set and runs
// with the round's V8 seed (method v2); the jobs (arm x file, plus stream-worker a second time as
// the A/A arm) run in the round's random order, each in a fresh browser context. Every run is
// checked against the generator's rows and recorded, failures included.
//
//   TMPDIR=~/chromium-tmp taskset -c <runner cpus> node --max-old-space-size=6144 bench/u1.ts \
//     --campaign <id> --seed <n> --cpus <browser cpus> --chromium <binary> \
//     --ld-library-path <dirs> [--no-sandbox]       (the Chromium binary and its library directories;
//                                            with FONTCONFIG_FILE=<file> where it names one: the
//                                            browser inherits it, and the start record states it)
//   the same with --dry-run                  one round of the same path and the bulk-main attempt,
//                                            to U1-dry-run.jsonl; prints each run's status and the
//                                            projection for all rounds; never a result
//   node bench/u1.ts --report <U1.jsonl>     the three tables per file
//   node bench/u1.ts --smoke [--family unicode --mib 32]   each arm once (default simple, 1 MiB),
//                                            in Playwright's own Chromium; prints no time
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { homedir, release, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type LaunchOptions } from '@playwright/test';
import { tally, type Tally } from '../test/browser/page/u1-tally.ts';
import { generateFixture, type Family } from './fixtures.ts';
import { readManifest, readManifestV2, seedFor } from './manifest.ts';
import { median, pairByRound, pairedBootstrapRatio } from './report.ts';
import {
  BUILD_INPUTS,
  buildCommit,
  parseCpuList,
  roundOrder,
  ROOT,
  v8Seeds,
  verifyDist,
  WORK_V2,
} from './run.ts';

export const ARMS = ['stream-worker', 'stream-main', 'bulk-main', 'papa-worker', 'papa-main'];
const CANDIDATE_ARMS = ['stream-worker', 'stream-main', 'bulk-main'];
const PAPA_ARMS = ['papa-worker', 'papa-main'];
export const AA = 'stream-worker-aa';
const MiB = 1024 * 1024;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

interface FileSpec {
  family: Family;
  targetBytes: number;
  arms: readonly string[];
}

const FILES: FileSpec[] = [
  { family: 'simple', targetBytes: 32 * MiB, arms: ARMS },
  { family: 'unicode', targetBytes: 32 * MiB, arms: ARMS },
  // bulk-main is expected to fail near the string limit: attempted once, after the rounds.
  { family: 'simple', targetBytes: 256 * MiB, arms: ARMS.filter((arm) => arm !== 'bulk-main') },
];

interface Prepared {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  reference: Tally;
  arms: readonly string[];
}

/** What u1.html prints. */
interface PageResult {
  rows?: number;
  sum?: number;
  totalMs?: number;
  firstBatchMs?: number;
  maxGapMs?: number;
  idleMaxGapMs?: number;
  error?: string;
}

export interface RunRecord extends PageResult {
  type: 'run';
  /** 1..rounds; 0 for the bulk-main attempt after the rounds. */
  round: number;
  v8Seed: number;
  file: string;
  /** The arm, or AA for the second stream-worker. */
  label: string;
  /** false: the browser ran with --no-sandbox. */
  sandbox: boolean;
  /** rows and sum equal the generator's. */
  match: boolean;
}

/**
 * Writes the fixture to the bench's cache. The generator's rows are the oracle; the line break that
 * ends the file makes Papa's one-field last record (`{ <first column>: '' }`), which every arm keeps.
 */
function prepare(spec: FileSpec): Prepared {
  const manifest = readManifest();
  const { seed } = manifest.families[spec.family];
  const fixture = generateFixture({ family: spec.family, seed, targetBytes: spec.targetBytes });
  const known = manifest.cases.find(
    (c) => c.family === spec.family && c.targetBytes === spec.targetBytes,
  )?.fixture?.sha256;
  if (known !== undefined && known !== fixture.sha256)
    throw new Error(
      `the ${spec.family} fixture of ${String(spec.targetBytes)} bytes differs from the manifest`,
    );
  const dir = join(ROOT, 'work', 'data', 'fixtures');
  const path = join(dir, `${fixture.sha256}.csv`);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, fixture.csv);
  }
  const reference = { rows: 0, sum: 0 };
  tally(reference, fixture.rows.slice(1));
  tally(reference, [['']]);
  const id = `${spec.family}-${String(spec.targetBytes / MiB)}MiB`;
  return { id, path, bytes: fixture.bytes, sha256: fixture.sha256, reference, arms: spec.arms };
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const url = new URL('../test/browser/server.mjs', import.meta.url).href;
  const { serve } = (await import(url)) as { serve: (port: number) => Promise<Server> };
  const server = await serve(0);
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  // The server bundles each script once; do it before anything is timed.
  for (const script of ['u1.js', 'u1-worker.js']) {
    const response = await fetch(`${baseUrl}/test/browser/page/${script}`);
    if (!response.ok) throw new Error(`${script}: HTTP ${String(response.status)}`);
  }
  return { server, baseUrl };
}

async function runPage(browser: Browser, baseUrl: string, arm: string, file: string) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/test/browser/page/u1.html?arm=${arm}`);
    await page.setInputFiles('#file', file);
    await page.waitForSelector('#out[data-done]', { state: 'attached', timeout: JOB_TIMEOUT_MS });
    return JSON.parse((await page.textContent('#out')) ?? '{}') as PageResult;
  } catch (error) {
    return { error: String(error) } satisfies PageResult;
  } finally {
    await context.close();
  }
}

const matches = (r: PageResult, reference: Tally) =>
  r.error === undefined && r.rows === reference.rows && r.sum === reference.sum;

const git = (...args: string[]) =>
  spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

const playwrightVersion = () =>
  (
    JSON.parse(readFileSync(join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

const allowedCpus = (status: string) => /^Cpus_allowed_list:\s*(\S+)$/m.exec(status)?.[1] ?? '';

/** Cpus_allowed_list of every other process whose command line contains `binary`. */
function affinityOf(binary: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    if (Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(binary))
        found[pid] = allowedCpus(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      // the process ended
    }
  }
  return found;
}

async function campaign(values: Record<string, string | boolean | undefined>): Promise<void> {
  if (process.platform !== 'linux') throw new Error('U1 timing runs on Linux only');
  // Playwright writes each browser's profile there; nothing outside the home directory.
  if (!tmpdir().startsWith(homedir() + sep))
    throw new Error('set TMPDIR to a directory under $HOME');
  const need = (name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`);
    return value;
  };
  const campaignId = need('campaign');
  const seed = Number(need('seed'));
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
  const cpuText = need('cpus');
  const cpus = parseCpuList(cpuText);
  const binary = need('chromium');
  if (!existsSync(binary)) throw new Error(`${binary} does not exist`);
  const libraryPath =
    typeof values['ld-library-path'] === 'string' ? values['ld-library-path'] : '';
  const sandbox = values['no-sandbox'] !== true;

  // The browser's CPUs and their hyperthread siblings are the browser's alone.
  const siblings = cpus.flatMap((cpu) =>
    parseCpuList(
      readFileSync(
        `/sys/devices/system/cpu/cpu${String(cpu)}/topology/thread_siblings_list`,
        'utf8',
      ),
    ),
  );
  const runnerCpus = parseCpuList(allowedCpus(readFileSync('/proc/self/status', 'utf8')));
  if (runnerCpus.some((cpu) => siblings.includes(cpu)))
    throw new Error(`start the runner under taskset on CPUs outside ${siblings.join(',')}`);

  const v2 = readManifestV2();
  const commit = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain') !== '') throw new Error('the working tree differs from HEAD');
  const buildDir = join(WORK_V2, 'build', `u1-${campaignId}`);
  const distSha256 = verifyDist({
    commit,
    distDir: join(ROOT, 'dist'),
    dirtyBuildInputs: () => git('status', '--porcelain', '--', ...BUILD_INPUTS),
    freshBuildSha256: () => buildCommit(commit, buildDir, v2),
  });

  const outDir =
    typeof values.out === 'string' ? values.out : join(ROOT, 'work', 'bench-v2', 'u1', campaignId);
  // A dry run is one round of the campaign's own path; its file is never a campaign's.
  const dryRun = values['dry-run'] === true;
  const outFile = join(outDir, dryRun ? 'U1-dry-run.jsonl' : 'U1.jsonl');
  if (existsSync(outFile)) throw new Error(`${outFile} exists; use another campaign id`);
  mkdirSync(outDir, { recursive: true });
  const write = (record: object) => {
    appendFileSync(outFile, JSON.stringify(record) + '\n');
  };

  // Every browser process inherits the wrapper's affinity and library path.
  const wrapper = join(outDir, 'chromium-pinned.sh');
  const env = libraryPath === '' ? '' : `LD_LIBRARY_PATH='${libraryPath}' `;
  writeFileSync(wrapper, `#!/bin/sh\n${env}exec taskset -c ${cpuText} '${binary}' "$@"\n`);
  chmodSync(wrapper, 0o755);

  const files = FILES.map(prepare);
  const rounds = dryRun ? 1 : v2.measurement.processes;
  const seeds = v8Seeds(v2, seed, 'U1', rounds);
  const startedMs = performance.now();
  const jobs = files.flatMap((f) => [
    ...f.arms.map((arm) => ({ file: f, label: arm, arm })),
    { file: f, label: AA, arm: 'stream-worker' },
  ]);
  const { server, baseUrl } = await startServer();
  const options = (v8Seed: number): LaunchOptions => ({
    executablePath: wrapper,
    chromiumSandbox: sandbox,
    args: [`--js-flags=--random-seed=${String(v8Seed)} --hash-seed=${String(v8Seed)}`],
  });
  let browserVersion = '';
  try {
    for (let round = 1; round <= rounds; round++) {
      const v8Seed = seeds[round] ?? 0;
      const browser = await chromium.launch(options(v8Seed));
      try {
        if (round === 1) {
          browserVersion = browser.version();
          write({
            type: 'start',
            ...(dryRun ? { dryRun } : {}),
            campaign: campaignId,
            seed,
            rounds,
            v8Seeds: seeds.slice(1),
            commit,
            distSha256,
            node: process.version,
            playwright: playwrightVersion(),
            browserVersion,
            binary,
            libraryPath,
            fontconfigFile: process.env.FONTCONFIG_FILE ?? null,
            sandbox,
            args: ['--js-flags=--random-seed=<v8Seed> --hash-seed=<v8Seed>'],
            cpus: cpuText,
            runnerCpus: runnerCpus.join(','),
            cpuModel:
              /^model name\s*:\s*(.*)$/m.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1] ?? '',
            kernel: release(),
            files: files.map(({ id, bytes, sha256, reference }) => ({
              id,
              bytes,
              sha256,
              reference,
            })),
          });
        }
        for (const job of roundOrder(jobs, seed, 'U1', round)) {
          const result = await runPage(browser, baseUrl, job.arm, job.file.path);
          const match = matches(result, job.file.reference);
          if (dryRun)
            console.log(
              `${job.file.id} ${job.label}: ${match ? 'match' : (result.error ?? 'rows or checksum differ')}`,
            );
          write({
            type: 'run',
            round,
            v8Seed,
            file: job.file.id,
            label: job.label,
            sandbox,
            ...result,
            match,
          });
        }
        const affinity = affinityOf(binary);
        write({ type: 'pinning', round, affinity });
        const wanted = cpus.join(',');
        const pids = Object.values(affinity);
        if (pids.length === 0 || pids.some((list) => parseCpuList(list).join(',') !== wanted))
          throw new Error(`round ${String(round)}: a browser process is not on CPUs ${wanted}`);
      } finally {
        await browser.close();
      }
    }
    const roundsMs = performance.now() - startedMs;
    const large = files.find((f) => !f.arms.includes('bulk-main'));
    if (large) {
      const browser = await chromium.launch(options(seeds[0] ?? 0));
      try {
        const result = await runPage(browser, baseUrl, 'bulk-main', large.path);
        const match = matches(result, large.reference);
        write({
          type: 'run',
          round: 0,
          v8Seed: seeds[0],
          file: large.id,
          label: 'bulk-main',
          sandbox,
          ...result,
          match,
        });
      } finally {
        await browser.close();
      }
    }
    write({ type: 'end', status: dryRun ? 'dry-run' : 'complete' });
    if (dryRun) {
      const all = v2.measurement.processes;
      const minutes = (all * roundsMs + (performance.now() - startedMs - roundsMs)) / 60_000;
      console.log(
        `projection: ${minutes.toFixed(1)} minutes for ${String(all)} rounds of ${String(jobs.length)} runs and the bulk-main attempt (from one round on this machine; not a measurement)`,
      );
    }
  } catch (error) {
    write({ type: 'end', status: 'error', error: String(error) });
    throw error;
  } finally {
    server.close();
  }
  console.log(`${outFile}: ${browserVersion}`);
}

const METRICS = [
  ['totalMs', 'Total time (flow start to last batch)'],
  ['firstBatchMs', 'Time to the first batch on the main thread'],
  ['maxGapMs', 'Main-thread delay (largest gap of a 4 ms setTimeout ticker)'],
] as const;

const fmt = (x: number) => x.toFixed(3);

/** The three tables per file, from the records of one campaign. */
export function renderU1(records: readonly Record<string, unknown>[]): string {
  const start = records.find((r) => r.type === 'start');
  if (!start) throw new Error('no start record');
  const seed = Number(start.seed);
  const v2 = readManifestV2();
  const { bootstrapResamples, confidence } = v2.statistics;
  const runs = records.filter((r) => r.type === 'run') as unknown as RunRecord[];
  const files = start.files as { id: string; bytes: number }[];
  const out: string[] = [
    `Chromium ${String(start.browserVersion)} headless on Linux; not a claim about other browsers or about desktop hardware.`,
    '',
    `Campaign ${String(start.campaign)}, seed ${String(seed)}, ${String(start.rounds)} rounds (one browser process each); commit ${String(start.commit)}, dist ${String(start.distSha256)}; Node ${String(start.node)}, Playwright ${String(start.playwright)}.`,
    `Browser ${String(start.binary)}, sandbox ${start.sandbox ? 'on' : 'off (--no-sandbox)'}, arguments ${JSON.stringify(start.args)}, LD_LIBRARY_PATH ${JSON.stringify(start.libraryPath)}; browser pinned to CPUs ${String(start.cpus)}, runner on ${String(start.runnerCpus)}; ${String(start.cpuModel)}, kernel ${String(start.kernel)}.`,
    '',
    'Ratios are Papa time over csv-engine time (above 1: csv-engine is faster), medians over rounds, paired by round, with the 95% bootstrap interval of method v2; ahead or behind only outside the A/A interval of the same file and table; no multiplicity correction. The Papa arms do different internal work (10 MiB FileReader slices, a row array per chunk) and are not the same work as the csv-engine arms.',
  ];
  for (const file of files) {
    const fileRuns = runs.filter((r) => r.file === file.id && r.round > 0);
    out.push('', `## ${file.id} (${String(file.bytes)} bytes)`);
    const failed = fileRuns.filter((r) => !r.match);
    for (const r of failed)
      out.push(
        `FAIL round ${String(r.round)} ${r.label}: ${r.error ?? `rows ${String(r.rows)}, sum ${String(r.sum)} differ from the generator`}`,
      );
    const labels = [...new Set(fileRuns.map((r) => r.label))];
    for (const [metric, title] of METRICS) {
      const byRound = (label: string) =>
        new Map(
          fileRuns
            .filter((r) => r.label === label && r.match)
            .map((r) => [r.round, r[metric] ?? NaN]),
        );
      const compare = (top: string, bottom: string) => {
        const pair = pairByRound(byRound(top), byRound(bottom));
        if (pair.top.length < 2) return null;
        const bootSeed = seedFor(seed, `bootstrap:U1:${file.id}:${metric}:${top}/${bottom}`);
        return {
          ...pairedBootstrapRatio(pair.top, pair.bottom, bootSeed, bootstrapResamples, confidence),
          rounds: pair.top.length,
        };
      };
      const aa = compare(AA, 'stream-worker');
      const rows = CANDIDATE_ARMS.filter((c) => labels.includes(c)).flatMap((c) =>
        PAPA_ARMS.map((p) => ({ name: `${p} / ${c}`, r: compare(p, c) })),
      );
      rows.sort((a, b) => (a.r?.ratio ?? Infinity) - (b.r?.ratio ?? Infinity));
      out.push(
        '',
        `### ${title}`,
        '',
        '| Comparison | Ratio | 95% interval | Rounds | Verdict |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const { name, r } of [...rows, { name: `${AA} / stream-worker (A/A)`, r: aa }]) {
        if (!r) {
          out.push(`| ${name} | n/a | n/a | <2 | no data |`);
          continue;
        }
        const verdict =
          aa === null || name.endsWith('(A/A)')
            ? '-'
            : r.lo > aa.hi
              ? 'csv-engine ahead'
              : r.hi < aa.lo
                ? 'csv-engine behind'
                : 'inconclusive';
        out.push(
          `| ${name} | ${fmt(r.ratio)} | ${fmt(r.lo)}-${fmt(r.hi)} | ${String(r.rounds)} | ${verdict} |`,
        );
      }
      out.push(
        '',
        '| Arm | Median ms | Min ms | Max ms | Valid runs |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const label of labels) {
        const xs = [...byRound(label).values()];
        if (xs.length === 0) out.push(`| ${label} | n/a | n/a | n/a | 0 |`);
        else
          out.push(
            `| ${label} | ${fmt(median(xs))} | ${fmt(Math.min(...xs))} | ${fmt(Math.max(...xs))} | ${String(xs.length)} |`,
          );
      }
      if (metric === 'maxGapMs') {
        const idle = fileRuns.flatMap((r) =>
          r.idleMaxGapMs === undefined ? [] : [r.idleMaxGapMs],
        );
        if (idle.length > 0)
          out.push(
            '',
            `Idle-page baseline (largest gap over one idle second, every run): median ${fmt(median(idle))} ms.`,
          );
      }
    }
  }
  for (const r of runs.filter((x) => x.round === 0))
    out.push(
      '',
      `${r.label} on ${r.file}, one attempt after the rounds: ${r.error ?? (r.match ? 'completed, rows and checksum match' : 'completed, rows or checksum differ')}.`,
    );
  const end = records.at(-1);
  if (end?.type !== 'end' || end.status !== 'complete')
    out.push('', 'INCOMPLETE: the campaign did not end complete.');
  return out.join('\n') + '\n';
}

/** Drives the page once per arm in Playwright's own Chromium; prints rows and checksum, never a time. */
async function smoke(family: Family, mib: number): Promise<void> {
  const file = prepare({ family, targetBytes: mib * MiB, arms: ARMS });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    for (const arm of ARMS) {
      const result = await runPage(browser, baseUrl, arm, file.path);
      const { rows, sum, error } = result;
      const match = matches(result, file.reference);
      console.log(
        JSON.stringify({ arm, file: file.id, rows, sum, reference: file.reference, match, error }),
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      campaign: { type: 'string' },
      seed: { type: 'string' },
      cpus: { type: 'string' },
      chromium: { type: 'string' },
      'ld-library-path': { type: 'string' },
      'no-sandbox': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      out: { type: 'string' },
      report: { type: 'string' },
      smoke: { type: 'boolean' },
      family: { type: 'string', default: 'simple' },
      mib: { type: 'string', default: '1' },
    },
  });
  if (values.report !== undefined) {
    const lines = readFileSync(values.report, 'utf8').split('\n').filter(Boolean);
    process.stdout.write(
      renderU1(lines.map((line) => JSON.parse(line) as Record<string, unknown>)),
    );
  } else if (values.smoke) {
    await smoke(values.family as Family, Number(values.mib));
  } else {
    await campaign(values);
  }
}
