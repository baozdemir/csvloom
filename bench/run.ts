import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomInt } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { ADAPTER_IDS } from './adapters/index.ts';
import { generateFixture, mulberry32 } from './fixtures.ts';
import {
  armsOf,
  expectedColdImpls,
  expectedPairs,
  expectedPairsV2,
  MANIFEST_V2_PATH,
  manifestSha256,
  readManifest,
  readMethod,
  pairNodeFlags,
  pairTimingFlags,
  seedFor,
  laneManifest,
  scoredCases,
  type CaseSpec,
  type ExpectedPair,
  type KindV2,
  type Manifest,
  type ManifestV2,
} from './manifest.ts';

// Runs one shard of a benchmark campaign (or a diagnostic smoke run), one worker
// process at a time, with a shard deadline, a child-RSS budget, a free-disk
// floor and a temporary-disk cap. Every job result is appended to a JSONL
// checkpoint as soon as it finishes; an end record states why the shard stopped.
// Scoring and campaign validation live in report.ts. `--method v2` (second half of
// this file) keeps the same guards and checkpoints and changes how many processes
// run, in which order, from where, on which CPU, and what each record states.

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const WORKER_FLAGS = ['--expose-gc'];
const MiB = 1024 ** 2;

export interface Guards {
  /** Epoch milliseconds after which no job may run. */
  deadlineAt: number;
  rssLimitBytes: number;
  rssPollMs: number;
  diskFloorBytes: number;
  tempCapBytes: number;
  freeDiskBytes: () => number;
  tempUsageBytes: () => number;
  signal: AbortSignal;
}

export type StopReason = 'deadline' | 'disk-floor' | 'temp-cap' | 'cancelled';

/** The first guard that forbids starting another job, if any. */
export function guardBreach(guards: Guards, now = Date.now()): StopReason | null {
  if (guards.signal.aborted) return 'cancelled';
  if (now >= guards.deadlineAt) return 'deadline';
  if (guards.freeDiskBytes() < guards.diskFloorBytes) return 'disk-floor';
  if (guards.tempUsageBytes() > guards.tempCapBytes) return 'temp-cap';
  return null;
}

export type JobOutcome =
  | { status: 'ok'; record: Record<string, unknown>; wallMs: number; peakPolledRssBytes: number }
  | {
      status: 'error' | 'timeout' | 'memory-limit' | 'cancelled';
      detail: string;
      wallMs: number;
      peakPolledRssBytes: number;
    };

const execFileAsync = promisify(execFile);

async function rssBytes(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim()) * 1024;
  } catch {
    return 0; // the process already exited
  }
}

/** A result line is a few KiB; more stdout than this is a protocol failure. */
export const MAX_WORKER_STDOUT_BYTES = 4 * 1024 * 1024;

type Settled =
  | { status: 'ok'; record: Record<string, unknown> }
  | { status: 'error' | 'timeout' | 'memory-limit' | 'cancelled'; detail: string };

/**
 * Runs `<command> <argv>` (Node by default) and returns its last stdout line as
 * a JSON object. Every failure, including spawn errors, a missing or invalid
 * result line and stdout overflow, settles as a structured outcome exactly once.
 * The child is killed when the shard deadline passes, its RSS (polled every
 * rssPollMs) exceeds the budget, its stdout overflows, or the shard is cancelled.
 */
export function runJob(
  argv: readonly string[],
  guards: Guards,
  command = process.execPath,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<JobOutcome> {
  const start = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let peak = 0;
    let stopped: 'timeout' | 'memory-limit' | 'cancelled' | 'overflow' | null = null;
    const child = spawn(command, argv, {
      cwd: options.cwd ?? ROOT,
      ...(options.env ? { env: options.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = (why: NonNullable<typeof stopped>) => {
      stopped ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => {
        stop('timeout');
      },
      Math.max(0, guards.deadlineAt - Date.now()),
    );
    const onAbort = () => {
      stop('cancelled');
    };
    guards.signal.addEventListener('abort', onAbort);
    const poll = setInterval(() => {
      if (child.pid === undefined) return;
      void rssBytes(child.pid).then((rss) => {
        peak = Math.max(peak, rss);
        if (rss > guards.rssLimitBytes) stop('memory-limit');
      });
    }, guards.rssPollMs);
    const settle = (outcome: Settled) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      guards.signal.removeEventListener('abort', onAbort);
      resolve({ ...outcome, wallMs: performance.now() - start, peakPolledRssBytes: peak });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_WORKER_STDOUT_BYTES) stop('overflow');
      else stdout += chunk;
    });
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.on('error', (error) => {
      settle({ status: 'error', detail: `spawn failed: ${error.message}` });
    });
    child.on('close', (code) => {
      if (stopped === 'overflow') {
        settle({
          status: 'error',
          detail: `protocol: worker stdout exceeded ${String(MAX_WORKER_STDOUT_BYTES)} bytes`,
        });
        return;
      }
      if (stopped) {
        settle({ status: stopped, detail: stderr });
        return;
      }
      if (code !== 0) {
        settle({ status: 'error', detail: stderr || `exit code ${String(code)}` });
        return;
      }
      const line = stdout.trim().split('\n').pop();
      if (!line) {
        settle({ status: 'error', detail: 'protocol: worker printed no result line' });
        return;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        settle({
          status: 'error',
          detail: `protocol: invalid JSON result line (${String(error)})`,
        });
        return;
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        settle({ status: 'error', detail: 'protocol: result line is not a JSON object' });
        return;
      }
      settle({ status: 'ok', record: record as Record<string, unknown> });
    });
  });
}

function git(args: string[]): string {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
}

const SOURCE_PATHS = ['bench', 'src', 'package.json', 'package-lock.json'];

/** Hash of every tracked or untracked (not ignored) file that can change results. */
export function sourceIdentity() {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', ...SOURCE_PATHS])
    .split('\n')
    .filter((p) => p && existsSync(join(ROOT, p)))
    .sort();
  const hash = createHash('sha256');
  for (const p of paths)
    hash
      .update(p)
      .update('\0')
      .update(readFileSync(join(ROOT, p)))
      .update('\0');
  return {
    gitCommit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--', ...SOURCE_PATHS]) !== '',
    files: paths.length,
    sha256: hash.digest('hex'),
  };
}

/**
 * Bytes of the files under `dir`, counted as `du` counts them. A symbolic link is not followed
 * (each A/B build directory links the harness's node_modules, which a recursive readdir would walk
 * once per build), and a file with several hard links in the tree counts once (the checkout
 * copies hard-link node_modules).
 */
export function directoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  const seen = new Set<string>();
  let total = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const { dev, ino, size } = statSync(path);
        const key = `${String(dev)}:${String(ino)}`;
        if (!seen.has(key)) {
          seen.add(key);
          total += size;
        }
      }
    }
  };
  walk(dir);
  return total;
}

function freeDiskBytes(): number {
  const s = statfsSync(ROOT);
  return s.bavail * s.bsize;
}

const darwin = (command: string, args: string[]) =>
  process.platform === 'darwin'
    ? spawnSync(command, args, { encoding: 'utf8' }).stdout.trim()
    : null;

/**
 * Lines of a Linux /proc file that match the pattern. Null means unknown: not on
 * Linux, unreadable, or no matching line; never a zero.
 */
function linuxLines(path: string, pattern: RegExp): string[] | null {
  if (process.platform !== 'linux') return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((line) => pattern.test(line));
  return lines.length > 0 ? lines : null;
}

// Power, swap, memory pressure and cumulative paging counters; compare start and
// end snapshots to see contention during a run. macOS reads pmset, sysctl,
// memory_pressure and vm_stat. Linux reads /proc; power stays null there (a VM has
// none to report), and cpuTimes is the aggregate /proc/stat line, whose eighth
// value is cumulative steal time.
function machineState() {
  return {
    at: new Date().toISOString(),
    loadavg: loadavg(),
    power: darwin('pmset', ['-g', 'batt']),
    swap:
      darwin('sysctl', ['vm.swapusage']) ??
      linuxLines('/proc/meminfo', /^Swap(Total|Free):/)?.join('; ') ??
      null,
    memoryPressure:
      darwin('memory_pressure', [])?.split('\n').at(-1) ??
      linuxLines('/proc/pressure/memory', /\S/)?.join('; ') ??
      null,
    cpuPressure: linuxLines('/proc/pressure/cpu', /\S/)?.join('; ') ?? null,
    cpuTimes: linuxLines('/proc/stat', /^cpu /)?.[0] ?? null,
    paging:
      darwin('vm_stat', [])
        ?.split('\n')
        .filter((line) => /^(Pageins|Pageouts|Swapins|Swapouts)/.test(line)) ??
      linuxLines('/proc/vmstat', /^(pgpgin|pgpgout|pswpin|pswpout|pgmajfault) /),
    freeDiskBytes: freeDiskBytes(),
  };
}

/**
 * The installed version of every package of the manifest. A package the method installs under
 * another name (manifest-pub.json `installedAs`) is read there: that directory is what a
 * checkout copy holds under the package's own name (prepareCopies).
 */
export function installedVersions(
  manifest: Manifest,
  installedAs: Record<string, string> = {},
  root: string = ROOT,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(manifest.competitors).map((pkg) => {
      const file = join(root, 'node_modules', installedAs[pkg] ?? pkg, 'package.json');
      return [pkg, (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version];
    }),
  );
}

/**
 * Workers import a package by its own name from their checkout copy, so that is where the
 * manifest's versions must be: throws for a copy that holds another version of any package.
 * The start record states the same versions and the report requires them.
 */
export function verifyCopyPackages(manifest: Manifest, copies: readonly string[]): void {
  for (const copy of copies) {
    const installed = installedVersions(manifest, {}, copy);
    const other = Object.keys(manifest.competitors).filter(
      (pkg) => installed[pkg] !== manifest.competitors[pkg],
    );
    if (other.length > 0)
      throw new Error(
        `${copy} holds ${other.map((p) => `${p} ${String(installed[p])} (manifest: ${String(manifest.competitors[p])})`).join(', ')}; run npm ci`,
      );
  }
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export type Checkpoint = (record: Record<string, unknown>) => void;

export function jsonlCheckpoint(file: string): Checkpoint {
  return (record) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  };
}

/** Writes the terminal record; reports failure instead of pretending the evidence exists. */
export function writeEnd(
  checkpoint: Checkpoint,
  record: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  try {
    checkpoint({ ...record, type: 'end' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export interface ShardContext {
  manifest: Manifest;
  cases: CaseSpec[];
  /** Pairs to account for in this shard, measured ones and declared-unsupported ones. */
  pairs: ExpectedPair[];
  timingArgs: string[];
  repetitions: number;
  memory: boolean;
  coldStart: boolean;
  fixtureDir: string;
  guards: Guards;
  checkpoint: Checkpoint;
  /** Replaceable in tests. */
  spawnWorker?: (argv: string[], guards: Guards) => Promise<JobOutcome>;
}

export type EndStatus = 'complete' | StopReason | 'memory-limit';

/**
 * Case-based shard: correctness checks, then timing repetitions (order shuffled
 * per repetition), then memory, then optional cold start. Only pairs that passed
 * their check are timed; every other status is recorded with its reason.
 */
export async function runShard(ctx: ShardContext): Promise<EndStatus> {
  const { manifest, guards, checkpoint } = ctx;
  const spawnWorker = ctx.spawnWorker ?? runJob;
  const caseById = new Map(ctx.cases.map((c) => [c.id, c]));
  const worker = (impl: string, c: CaseSpec, mode: string, extra: string[] = []) => [
    ...WORKER_FLAGS,
    WORKER,
    '--impl',
    impl,
    '--case',
    c.id,
    '--mode',
    mode,
    ...extra,
  ];

  // Runs one job and checkpoints it; returns a stop status when the shard must end.
  const run = async (
    type: string,
    impl: string,
    c: CaseSpec,
    argv: string[],
    extra: Record<string, unknown> = {},
  ): Promise<{ stop: EndStatus } | { record: Record<string, unknown> | null }> => {
    const breach = guardBreach(guards);
    if (breach) return { stop: breach };
    let outcome: JobOutcome;
    try {
      outcome = await spawnWorker(argv, guards);
    } catch (error) {
      outcome = {
        status: 'error',
        detail: `orchestration: ${String(error)}`,
        wallMs: 0,
        peakPolledRssBytes: 0,
      };
    }
    const base = {
      ...extra,
      impl,
      case: c.id,
      wallMs: outcome.wallMs,
      peakPolledRssBytes: outcome.peakPolledRssBytes,
    };
    if (outcome.status === 'ok') {
      checkpoint({ ...outcome.record, ...base, type });
      return { record: outcome.record };
    }
    checkpoint({
      ...base,
      type,
      status: 'BLOCKED',
      blocked: outcome.status,
      detail: outcome.detail.slice(-1000),
    });
    if (outcome.status === 'error') return { record: null };
    return { stop: outcome.status === 'timeout' ? 'deadline' : outcome.status };
  };

  const passed: ExpectedPair[] = [];
  for (const pair of ctx.pairs) {
    const c = caseById.get(pair.case);
    if (!c) continue;
    if (pair.expect === 'deferred') {
      checkpoint({
        type: 'check',
        impl: pair.impl,
        case: pair.case,
        status: 'DEFERRED',
        reason: pair.reason,
      });
      continue;
    }
    if (pair.expect === 'unsupported') {
      checkpoint({
        type: 'check',
        impl: pair.impl,
        case: pair.case,
        status: 'UNSUPPORTED',
        declared: true,
        reason: pair.reason,
      });
      continue;
    }
    if (!ADAPTER_IDS.includes(pair.impl)) {
      checkpoint({
        type: 'check',
        impl: pair.impl,
        case: pair.case,
        status: 'UNAVAILABLE',
        reason: 'no adapter in bench/adapters',
      });
      continue;
    }
    const r = await run('check', pair.impl, c, worker(pair.impl, c, 'check'));
    if ('stop' in r) return r.stop;
    if (r.record?.status === 'PASS') passed.push(pair);
  }

  for (let rep = 1; rep <= ctx.repetitions; rep++) {
    for (const pair of shuffle(passed, manifest.measurement.orderSeed + rep)) {
      const c = caseById.get(pair.case);
      if (!c) continue;
      const r = await run('time', pair.impl, c, worker(pair.impl, c, 'time', ctx.timingArgs), {
        rep,
      });
      if ('stop' in r) return r.stop;
    }
  }

  if (ctx.memory) {
    for (const c of ctx.cases) {
      const impls = passed.filter((p) => p.case === c.id).map((p) => p.impl);
      if (impls.length === 0) continue;
      let inputArgs: string[] = [];
      if (!c.external && c.family && c.targetBytes) {
        const { seed } = manifest.families[c.family];
        const fixture = generateFixture({ family: c.family, seed, targetBytes: c.targetBytes });
        const file = join(ctx.fixtureDir, `${fixture.sha256}.csv`);
        if (!existsSync(file)) {
          if (guards.tempUsageBytes() + fixture.bytes > guards.tempCapBytes) return 'temp-cap';
          if (guards.freeDiskBytes() - fixture.bytes < guards.diskFloorBytes) return 'disk-floor';
          mkdirSync(ctx.fixtureDir, { recursive: true });
          writeFileSync(file, fixture.csv);
        }
        inputArgs = ['--input-file', file];
      }
      for (const impl of impls) {
        const r = await run('memory', impl, c, worker(impl, c, 'memory', inputArgs));
        if ('stop' in r) return r.stop;
      }
    }
  }

  const coldCase = manifest.cases.find((c) => c.id === manifest.campaign.coldStartCase);
  if (ctx.coldStart && coldCase) {
    for (const impl of expectedColdImpls(manifest)) {
      if (!ADAPTER_IDS.includes(impl)) {
        checkpoint({
          type: 'cold',
          impl,
          case: coldCase.id,
          status: 'UNAVAILABLE',
          reason: 'no adapter in bench/adapters',
        });
        continue;
      }
      const argv = [WORKER, '--impl', impl, '--case', coldCase.id, '--mode', 'cold'];
      const r = await run('cold', impl, coldCase, argv);
      if ('stop' in r) return r.stop;
    }
  }
  return 'complete';
}

async function main() {
  const { values } = parseArgs({
    options: {
      campaign: { type: 'string' },
      shard: { type: 'string' },
      smoke: { type: 'boolean', default: false },
      cases: { type: 'string' },
      impls: { type: 'string' },
      reps: { type: 'string' },
      'deadline-min': { type: 'string' },
      'no-memory': { type: 'boolean', default: false },
      out: { type: 'string' },
      method: { type: 'string', default: 'v1' },
    },
  });
  const manifest = readManifest();
  const smoke = values.smoke;
  const shardSpec = manifest.campaign.shards.find((s) => s.id === values.shard);
  if (!smoke) {
    if (!values.campaign || !shardSpec)
      throw new Error('campaign runs need --campaign <id> and a manifest --shard');
    if (values.cases || values.impls || values.reps || values['no-memory']) {
      throw new Error('campaign shards cannot be filtered');
    }
    if (process.version !== `v${manifest.runtime.node}`) {
      throw new Error(
        `campaign runs require Node ${manifest.runtime.node}; this is ${process.version}`,
      );
    }
    // v1's workers import the root's packages, so they must be the manifest's.
    verifyCopyPackages(manifest, [ROOT]);
  }
  const smallCases = manifest.cases.filter((c) => (c.fixture?.bytes ?? Infinity) <= 64 * 1024);
  const caseIds = smoke
    ? (values.cases?.split(',') ?? smallCases.map((c) => c.id))
    : (shardSpec?.cases ?? []);
  const cases = manifest.cases.filter((c) => caseIds.includes(c.id));
  const implFilter = values.impls?.split(',');
  const pairs = expectedPairs(manifest, caseIds).filter(
    (p) => !implFilter || implFilter.includes(p.impl),
  );

  const deadlineMin = Number(values['deadline-min'] ?? manifest.campaign.maxShardMinutes);
  if (!smoke && deadlineMin > manifest.campaign.maxShardMinutes) {
    throw new Error('shard deadline above the manifest maximum');
  }

  const campaignId = values.campaign ?? `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const shardId = smoke ? 'smoke' : (shardSpec?.id ?? '');
  const outFile = values.out ?? join(ROOT, 'work', 'bench-results', campaignId, `${shardId}.jsonl`);
  if (existsSync(outFile))
    throw new Error(`${outFile} exists; a shard is never appended to or rerun in place`);
  mkdirSync(join(outFile, '..'), { recursive: true });

  const { limits } = manifest;
  const tempCapBytes =
    freeDiskBytes() >= limits.expandCapAtFreeBytes
      ? limits.tempCapExpandedBytes
      : limits.tempCapBytes;
  const workDir = join(ROOT, 'work');
  let tempUsage = directoryBytes(workDir);
  let lastTempScan = Date.now();
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      controller.abort();
    });
  }
  const guards: Guards = {
    deadlineAt: Date.now() + deadlineMin * 60_000,
    rssLimitBytes: limits.rssLimitBytes,
    rssPollMs: limits.rssPollMs,
    diskFloorBytes: limits.diskFloorBytes,
    tempCapBytes,
    freeDiskBytes,
    tempUsageBytes: () => {
      if (Date.now() - lastTempScan > 30_000) {
        tempUsage = directoryBytes(workDir);
        lastTempScan = Date.now();
      }
      return tempUsage;
    },
    signal: controller.signal,
  };

  const checkpoint = jsonlCheckpoint(outFile);
  const source = sourceIdentity();
  checkpoint({
    type: 'start',
    kind: smoke ? 'smoke' : 'campaign',
    campaignId,
    shardId,
    plannedCases: caseIds,
    filters: {
      cases: values.cases ?? null,
      impls: values.impls ?? null,
      reps: values.reps ?? null,
      noMemory: values['no-memory'],
    },
    runtime: { node: process.version, execPath: process.execPath, workerFlags: WORKER_FLAGS },
    packages: installedVersions(manifest),
    manifestSha256: manifestSha256(),
    fixtures: Object.fromEntries(
      cases.map((c) => [c.id, c.fixture?.sha256 ?? c.external?.sha256 ?? null]),
    ),
    source,
    limits: { ...limits, tempCapBytes, deadlineMinutes: deadlineMin },
    tempUsageBytesAtStart: tempUsage,
    machine: machineState(),
    environment: {
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
      osRelease: release(),
    },
  });

  // An unexpected orchestration error still ends the shard with a terminal record.
  let status: string;
  let error: string | undefined;
  try {
    status = await runShard({
      manifest,
      cases,
      pairs,
      timingArgs: smoke ? ['--samples', '3', '--min-sample-ms', '50', '--warmup-ms', '100'] : [],
      repetitions: Number(values.reps ?? (smoke ? 2 : manifest.measurement.repetitions)),
      memory: !values['no-memory'],
      coldStart: smoke || shardSpec?.id === manifest.campaign.coldStartShard,
      fixtureDir: join(workDir, 'data', 'fixtures'),
      guards,
      checkpoint,
    });
  } catch (caught) {
    status = 'orchestration-error';
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  }
  const sourceAtEnd = sourceIdentity();
  const changed =
    sourceAtEnd.sha256 !== source.sha256 || sourceAtEnd.gitCommit !== source.gitCommit;
  const endStatus = changed && status === 'complete' ? 'source-changed' : status;
  const end = writeEnd(checkpoint, {
    status: endStatus,
    ...(error === undefined ? {} : { error }),
    sourceChanged: changed,
    source: sourceAtEnd,
    manifestSha256: manifestSha256(),
    tempUsageBytes: directoryBytes(workDir),
    machine: machineState(),
  });
  if (!end.ok) {
    process.stderr.write(
      `${shardId}: ${endStatus}; FAILED to write the end record to ${outFile} (${end.error}). This checkpoint is incomplete.\n`,
    );
    process.exitCode = 2;
    return;
  }
  const workMiB = (directoryBytes(workDir) / MiB).toFixed(0);
  process.stderr.write(`${shardId}: ${endStatus} -> ${outFile} (${workMiB} MiB in work/)\n`);
  if (error) process.stderr.write(`${error}\n`);
  process.stdout.write(`${outFile}\n`);
  if (endStatus !== 'complete') process.exitCode = 1;
}

// Method v2 (docs/benchmarks.md, "Timing"; settings in bench/manifest-v2.json)

/** The order of one round: a new permutation named by the campaign seed, the shard and the round. */
export function roundOrder<T>(
  jobs: readonly T[],
  campaignSeed: number,
  shardId: string,
  round: number,
): T[] {
  return shuffle(jobs, seedFor(campaignSeed, `order:${shardId}:${String(round)}`));
}

/**
 * The V8 seed of each round of a run, index 0 (checks and dry processes) to
 * `rounds`: derived from the campaign seed, the shard and the round, inside the
 * manifest's range and distinct within the run (a repeat moves on to the next free
 * value). Every process of a round gets the same seed, so the arms of a round share
 * whatever the seed decides (hash layout, Math.random) and the report can pair them.
 */
export function v8Seeds(
  v2: ManifestV2,
  campaignSeed: number,
  shardId: string,
  rounds: number,
): number[] {
  const { min, max } = v2.seeds;
  const span = max - min + 1;
  const used = new Set<number>();
  return Array.from({ length: rounds + 1 }, (_, round) => {
    let seed = min + (seedFor(campaignSeed, `v8:${shardId}:${String(round)}`) % span);
    while (used.has(seed)) seed = min + ((seed - min + 1) % span);
    used.add(seed);
    return seed;
  });
}

/** The randomised setup of one process: its checkout copy and the length of its padding variable. */
export function setupFor(
  v2: ManifestV2,
  copies: number,
  campaignSeed: number,
  label: string,
): { checkoutCopy: number; padLength: number } {
  const random = mulberry32(seedFor(campaignSeed, `setup:${label}`));
  return {
    checkoutCopy: Math.floor(random() * copies),
    padLength: Math.floor(random() * (v2.setup.padMaxLength + 1)),
  };
}

/** SHA-256 over every file of a directory (relative path and bytes, sorted by path); null when missing or empty. */
export function treeSha256(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
  if (files.length === 0) return null;
  const hash = createHash('sha256');
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(dir, file)))
      .update('\0');
  return hash.digest('hex');
}

/** Everything the bundle is built from; a change to any of these makes an existing dist/ stale. */
export const BUILD_INPUTS = [
  'src',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
];

const fileSha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Exports a commit's build inputs into `dir` and builds its bundle there, with the
 * repository's installed tools. Returns the tree hash of the built directory.
 */
export function buildCommit(
  commit: string,
  dir: string,
  v2: ManifestV2,
  repo: string = ROOT,
): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', commit, ...BUILD_INPUTS], {
    cwd: repo,
    maxBuffer: 1024 ** 3,
  });
  if (archive.status !== 0)
    throw new Error(`git archive ${commit} failed: ${archive.stderr.toString()}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed in ${dir}: ${untar.stderr.toString()}`);
  // The build tools resolve through this link; the bundle itself imports no package.
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  const [command = '', ...args] = v2.candidate.buildCommand;
  const build = spawnSync(command === 'node' ? process.execPath : command, args, {
    cwd: dir,
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`build of ${commit} failed in ${dir}: ${build.stderr || build.stdout}`);
  const sha = treeSha256(join(dir, v2.candidate.distDir));
  if (sha === null) throw new Error(`build of ${commit} produced no ${v2.candidate.distDir}/`);
  return sha;
}

export interface DistCheck {
  commit: string;
  /** The bundle directory to measure. */
  distDir: string;
  /** `git status --porcelain` over the build inputs; empty when they equal the commit. */
  dirtyBuildInputs: () => string;
  /** Tree hash of a bundle built now from the commit alone. */
  freshBuildSha256: () => string;
}

/**
 * The bundle must be the one the measured commit builds: present, built from
 * unmodified inputs, and byte-identical to a fresh build of that commit. Returns
 * its tree hash; throws (the campaign does not start) otherwise.
 */
export function verifyDist(check: DistCheck): string {
  const actual = treeSha256(check.distDir);
  if (actual === null)
    throw new Error(`${check.distDir} is missing or empty: build it at commit ${check.commit}`);
  const dirty = check.dirtyBuildInputs();
  if (dirty !== '') {
    throw new Error(
      `build inputs differ from commit ${check.commit}, so no bundle can match it:\n${dirty}`,
    );
  }
  const fresh = check.freshBuildSha256();
  if (fresh !== actual) {
    throw new Error(
      `${check.distDir} is stale: its SHA-256 ${actual} is not that of a fresh build of ${check.commit} (${fresh}); rebuild it`,
    );
  }
  return actual;
}

// Hard links give every copy its own paths (Node resolves a symlink to its target,
// which would collapse the copies into one location) without copying the bytes.
// Symbolic links (node_modules/.bin) are not needed by a worker and are skipped.
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) linkTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) linkSync(join(from, entry.name), join(to, entry.name));
  }
}

/**
 * Creates the checkout copies of manifest-v2 `setup.copies` under `base`: the
 * harness, package.json, the installed packages and the verified bundle twice (the
 * candidate's directory and the A/A arm's). Returns their absolute paths with
 * symlinks resolved; throws if a copy does not hold the verified bytes.
 */
export function prepareCopies(
  root: string,
  base: string,
  v2: ManifestV2,
  distSha256: string,
  /** The verified bundle directory; by default the root's own. */
  distSource: string = join(root, v2.candidate.distDir),
  /** Packages a copy holds from another installed directory (manifest-pub.json `installedAs`). */
  installedAs: Record<string, string> = {},
): string[] {
  rmSync(base, { recursive: true, force: true });
  const benchSha = treeSha256(join(root, 'bench'));
  return v2.setup.copies.map((rel) => {
    const copy = join(base, rel);
    mkdirSync(copy, { recursive: true });
    cpSync(join(root, 'bench'), join(copy, 'bench'), { recursive: true });
    cpSync(join(root, 'package.json'), join(copy, 'package.json'));
    linkTree(join(root, 'node_modules'), join(copy, 'node_modules'));
    // The adapters import a package by its own name, so the version the method names goes there.
    for (const [pkg, dir] of Object.entries(installedAs)) {
      rmSync(join(copy, 'node_modules', pkg), { recursive: true, force: true });
      linkTree(join(root, 'node_modules', dir), join(copy, 'node_modules', pkg));
    }
    for (const dir of [v2.candidate.distDir, v2.aa.distDir]) {
      cpSync(distSource, join(copy, dir), { recursive: true });
      if (treeSha256(join(copy, dir)) !== distSha256)
        throw new Error(`${join(copy, dir)} does not hold the verified bundle`);
    }
    if (treeSha256(join(copy, 'bench')) !== benchSha)
      throw new Error(`${join(copy, 'bench')} differs from the harness`);
    return realpathSync(copy);
  });
}

/** "0-2,5" -> [0, 1, 2, 5]. */
export function parseCpuList(text: string): number[] {
  return text
    .trim()
    .split(',')
    .filter(Boolean)
    .flatMap((part) => {
      const [from, to = from] = part.split('-').map(Number);
      if (from === undefined || to === undefined || !(from <= to))
        throw new Error(`invalid CPU list ${JSON.stringify(text)}`);
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    });
}

export interface PinDeps {
  /** Runs a command to completion (spawnSync). */
  run: (
    command: string,
    args: string[],
  ) => { status: number | null; error?: Error; stderr: string };
  /** Hardware threads of the CPU's core, itself included. */
  siblings: (cpu: number) => number[];
  /** CPUs the runner itself may run on. */
  runnerCpus: () => number[];
}

const realPinDeps: PinDeps = {
  run: (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
  },
  siblings: (cpu) =>
    parseCpuList(
      readFileSync(
        `/sys/devices/system/cpu/cpu${String(cpu)}/topology/thread_siblings_list`,
        'utf8',
      ),
    ),
  runnerCpus: () =>
    parseCpuList(
      /^Cpus_allowed_list:\s*(\S+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? '',
    ),
};

export interface Pinning {
  cpu: number;
  siblings: number[];
  runnerCpus: number[];
}

/**
 * Pinning was requested: prove before the first job that `taskset` can pin a
 * process to the CPU and that the runner cannot run on that CPU or on its
 * hyperthread sibling. Throws otherwise; there is no unpinned fallback.
 */
export function verifyPinning(cpu: number, deps: PinDeps = realPinDeps): Pinning {
  const refuse = (why: string) =>
    new Error(`pinning to CPU ${String(cpu)} was requested but ${why}; refusing to run unpinned`);
  if (!Number.isSafeInteger(cpu) || cpu < 0) throw refuse('that is not a CPU number');
  const probe = deps.run('taskset', ['-c', String(cpu), process.execPath, '-e', '']);
  if (probe.error) throw refuse(`taskset is unavailable (${probe.error.message})`);
  if (probe.status !== 0)
    throw refuse(`taskset failed (exit ${String(probe.status)}: ${probe.stderr.trim()})`);
  const siblings = deps.siblings(cpu);
  const runnerCpus = deps.runnerCpus();
  const shared = runnerCpus.filter((c) => c === cpu || siblings.includes(c));
  if (runnerCpus.length === 0 || shared.length > 0) {
    throw refuse(
      `the runner may run on CPU(s) ${shared.join(',') || '(unknown)'}, the worker CPU or its hyperthread sibling (core threads ${siblings.join(',')}); start the runner under taskset on another core`,
    );
  }
  return { cpu, siblings, runnerCpus };
}

export type SpawnV2 = (
  argv: string[],
  guards: Guards,
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<JobOutcome>;

export type EndStatusV2 = EndStatus | 'pinning-lost' | 'setup-mismatch';

export interface ShardV2Context {
  manifest: Manifest;
  v2: ManifestV2;
  shardId: string;
  campaignSeed: number;
  cases: CaseSpec[];
  pairs: ExpectedPair[];
  /** Rounds; every passing pair gets one fresh timing process per round. */
  processes: number;
  /** Rounds of the memory phase: one memory process per scored pair (scoredCases) in each. */
  memoryProcesses: number;
  /** Timing and memory never share a run: a memory process disturbs the timings after it. */
  phase: 'timing' | 'memory';
  /** Checkout copies (absolute, symlinks resolved) with the harness, the packages and the bundles. */
  copies: string[];
  /** Arms loaded from a built bundle: the entry file, relative to the checkout copy or absolute. */
  entries: Record<string, string>;
  /** SHA-256 of the entry file each bundle arm must report having imported. */
  entrySha256: Record<string, string>;
  /** Commit and bundle hash stated on every record of an arm; '*' covers the arms not named. */
  identities: Record<string, { commit: string; distSha256: string }>;
  /** Commit of the harness (this checkout); the arms' commits are in `identities`. */
  harnessCommit: string;
  machine: { cpuModel: string; kernel: string };
  pinCpu: number | null;
  /** Cached input file per case id (fixture cache or external dataset). */
  inputs: Record<string, string>;
  guards: Guards;
  checkpoint: Checkpoint;
  /** Replaceable in tests. */
  spawnWorker?: SpawnV2;
}

type JobResult = { stop: EndStatusV2 } | { record: Record<string, unknown> | null };

/**
 * The identity every v2 job record states. A pair that is recorded without a
 * process (declared unsupported, deferred, no adapter) has no pad or checkout copy.
 */
function identityOf(
  ctx: ShardV2Context,
  impl: string,
  setup: {
    v8Seed: number | null;
    padLength: number | null;
    checkoutCopy: number | null;
    checkoutPath: string | null;
  },
) {
  const id = ctx.identities[impl] ?? ctx.identities['*'];
  return {
    harnessCommit: ctx.harnessCommit,
    commit: id?.commit ?? null,
    distSha256: id?.distSha256 ?? null,
    node: process.version,
    cpuModel: ctx.machine.cpuModel,
    kernel: ctx.machine.kernel,
    tasksetMask: ctx.pinCpu === null ? null : String(ctx.pinCpu),
    ...setup,
  };
}

/**
 * Runs and checkpoints one v2 worker process: a seeded choice of checkout copy and
 * padding length, the optional pin, the identity on the record, and a comparison
 * of what the worker reports (directory, padding, CPU mask, Node, imported bundle)
 * with what was requested. A difference ends the shard; it is never measured over.
 */
function jobRunner(ctx: ShardV2Context) {
  const { v2, guards, checkpoint } = ctx;
  const spawnWorker = ctx.spawnWorker ?? runJob;
  return async (
    type: string,
    mode: 'check' | 'time' | 'memory' | 'empty',
    impl: string,
    c: CaseSpec | null,
    round: number,
    extra: readonly string[] = [],
    /** Node flags of this process beyond the runner's own (manifest v2 measurement.repeatedNodeFlags). */
    nodeFlags: readonly string[] = [],
  ): Promise<JobResult> => {
    const breach = guardBreach(guards);
    if (breach) return { stop: breach };
    const label = [ctx.shardId, String(round), type, impl, c?.id ?? ''].join(':');
    const { checkoutCopy, padLength } = setupFor(v2, ctx.copies.length, ctx.campaignSeed, label);
    const copy = ctx.copies[checkoutCopy] ?? '';
    const bundle = ctx.entries[impl];
    // Every worker gets the same argument shape; only bundle arms import the entry.
    const entry = resolve(copy, bundle ?? join(v2.candidate.distDir, v2.candidate.entry));
    const input = c ? ctx.inputs[c.id] : undefined;
    // One V8 seed per round, the same for every process of the round; then the pair's own flags.
    const v8Seed = v8Seeds(v2, ctx.campaignSeed, ctx.shardId, round)[round] ?? v2.seeds.min;
    const processFlags = [
      ...v2.seeds.flags.map((flag) => `${flag}=${String(v8Seed)}`),
      ...nodeFlags,
    ];
    const nodeArgv = [
      ...WORKER_FLAGS,
      ...processFlags,
      join(copy, 'bench', 'worker.ts'),
      ...['--method', 'v2', '--mode', mode],
      ...(c
        ? [
            ...['--impl', impl, '--case', c.id],
            ...['--load', bundle === undefined ? 'adapter' : 'entry', '--entry', entry],
            // A check of a synthetic case regenerates it: the generator's rows are the oracle.
            ...(input !== undefined && (mode !== 'check' || c.external)
              ? ['--input-file', input]
              : []),
            ...extra,
          ]
        : []),
    ];
    const pinned = ctx.pinCpu !== null;
    const mask = pinned ? String(ctx.pinCpu) : null;
    const argv = pinned ? ['-c', mask ?? '', process.execPath, ...nodeArgv] : nodeArgv;
    const env = { ...process.env, [v2.setup.padEnv]: 'x'.repeat(padLength) };
    let outcome: JobOutcome;
    try {
      outcome = await spawnWorker(argv, guards, pinned ? 'taskset' : process.execPath, {
        cwd: copy,
        env,
      });
    } catch (error) {
      outcome = {
        status: 'error',
        detail: `orchestration: ${String(error)}`,
        wallMs: 0,
        peakPolledRssBytes: 0,
      };
    }
    const base = {
      type,
      impl,
      case: c?.id ?? '-',
      round,
      identity: identityOf(ctx, impl, { v8Seed, padLength, checkoutCopy, checkoutPath: copy }),
      wallMs: outcome.wallMs,
      peakPolledRssBytes: outcome.peakPolledRssBytes,
    };
    if (outcome.status !== 'ok') {
      checkpoint({
        ...base,
        status: 'BLOCKED',
        blocked: outcome.status,
        detail: outcome.detail.slice(-1000),
      });
      if (outcome.status === 'error') return { record: null };
      return { stop: outcome.status === 'timeout' ? 'deadline' : outcome.status };
    }
    const seen = (outcome.record.process ?? {}) as Record<string, unknown>;
    const differs = (field: string, wanted: unknown) =>
      seen[field] === wanted
        ? null
        : `${field} is ${JSON.stringify(seen[field])}, requested ${JSON.stringify(wanted)}`;
    const pinLost = pinned ? differs('cpusAllowed', mask) : null;
    const execArgv = Array.isArray(seen.execArgv) ? (seen.execArgv as unknown[]) : [];
    const flagsLost = processFlags.every((flag) => execArgv.includes(flag))
      ? null
      : `execArgv is ${JSON.stringify(seen.execArgv)}, requested ${processFlags.join(' ')}`;
    const mismatch =
      pinLost ??
      flagsLost ??
      differs('cwd', copy) ??
      differs('padLength', padLength) ??
      differs('node', process.version) ??
      (c && bundle !== undefined
        ? (differs('entry', entry) ?? differs('entrySha256', ctx.entrySha256[impl]))
        : null);
    if (mismatch !== null) {
      checkpoint({
        ...outcome.record,
        ...base,
        status: 'BLOCKED',
        blocked: pinLost === null ? 'setup-mismatch' : 'pinning-lost',
        detail: mismatch,
      });
      return { stop: pinLost === null ? 'setup-mismatch' : 'pinning-lost' };
    }
    checkpoint({ ...outcome.record, ...base });
    return { record: outcome.record };
  };
}

/**
 * One v2 run. Timing phase (a shard): one correctness check per pair, then
 * `processes` rounds of one fresh timing process per passing pair and one
 * empty-process baseline. Memory phase (its own run, after every timing shard):
 * `memoryProcesses` rounds of one memory process per scored pair and one
 * empty-process baseline, without checks; the report uses the memory of the pairs
 * that passed in the timing shards. Every round is in a new random order. The two
 * kinds of process never share a run: in a calibration whose rounds also held memory
 * processes, those rounds ran 3-25% slower in both arms.
 */
export async function runShardV2(ctx: ShardV2Context): Promise<EndStatusV2> {
  const { manifest, v2, checkpoint } = ctx;
  const job = jobRunner(ctx);
  const caseById = new Map(ctx.cases.map((c) => [c.id, c]));
  const empty = { impl: '-', c: null, mode: 'empty' as const };
  const rounds = async (
    count: number,
    jobs: ReadonlyArray<{
      impl: string;
      c: CaseSpec | null;
      mode: 'time' | 'memory' | 'empty';
      extra?: readonly string[];
      nodeFlags?: readonly string[];
    }>,
  ): Promise<EndStatusV2> => {
    for (let round = 1; round <= count; round++) {
      for (const j of roundOrder(jobs, ctx.campaignSeed, ctx.shardId, round)) {
        const r = await job(j.mode, j.mode, j.impl, j.c, round, j.extra, j.nodeFlags);
        if ('stop' in r) return r.stop;
      }
    }
    return 'complete';
  };
  if (ctx.phase === 'memory') {
    const primary = new Set(scoredCases(manifest).map((c) => c.id));
    const memory = ctx.pairs.flatMap((pair) => {
      const c = caseById.get(pair.case);
      const runnable =
        c !== undefined &&
        primary.has(c.id) &&
        pair.expect === 'measure' &&
        (ctx.entries[pair.impl] !== undefined || ADAPTER_IDS.includes(pair.impl));
      return runnable ? [{ impl: pair.impl, c, mode: 'memory' as const }] : [];
    });
    return rounds(ctx.memoryProcesses, [...memory, empty]);
  }
  const passed: Array<{ impl: string; c: CaseSpec }> = [];
  const opMs = new Map<string, number>();
  for (const pair of ctx.pairs) {
    const c = caseById.get(pair.case);
    if (!c) continue;
    const skip = (status: string, extra: Record<string, unknown>) => {
      checkpoint({
        type: 'check',
        impl: pair.impl,
        case: pair.case,
        round: 0,
        identity: identityOf(ctx, pair.impl, {
          v8Seed: null,
          padLength: null,
          checkoutCopy: null,
          checkoutPath: null,
        }),
        status,
        ...extra,
      });
    };
    if (pair.expect === 'deferred') skip('DEFERRED', { reason: pair.reason });
    else if (pair.expect === 'unsupported')
      skip('UNSUPPORTED', { declared: true, reason: pair.reason });
    else if (ctx.entries[pair.impl] === undefined && !ADAPTER_IDS.includes(pair.impl))
      skip('UNAVAILABLE', { reason: 'no adapter in bench/adapters' });
    else {
      const r = await job('check', 'check', pair.impl, c, 0);
      if ('stop' in r) return r.stop;
      if (r.record?.status === 'PASS') {
        passed.push({ impl: pair.impl, c });
        if (typeof r.record.opMs === 'number') opMs.set(`${pair.impl}|${c.id}`, r.record.opMs);
      }
    }
  }
  // One operations-per-sample count per pair, from its check; arms that run the same code (the
  // candidate and its A/A copy, the two arms of an A/B) take the first arm's count.
  const leader = (impl: string) =>
    impl === v2.aa.impl ? manifest.candidate : impl === 'b' && ctx.entries.a ? 'a' : impl;
  // One parse on a collected heap or repeated parsing, by the pair's probe (manifest v2); a pair
  // that repeats also gets the manifest's Node flags, which a worker must report back (execArgv).
  const timed = passed.map((p) => {
    const ms = opMs.get(`${leader(p.impl)}|${p.c.id}`) ?? opMs.get(`${p.impl}|${p.c.id}`);
    const extra = ms === undefined ? [] : pairTimingFlags(ms, v2.measurement);
    const nodeFlags = ms === undefined ? [] : pairNodeFlags(ms, v2.measurement);
    return { ...p, mode: 'time' as const, extra, nodeFlags };
  });
  return rounds(ctx.processes, [...timed, empty]);
}

/** What the dry processes of one implementation on one dry-run case measured. */
export interface DryMeasure {
  bytes: number;
  /** Median sample of the short dry timing process. */
  opMs: number;
  inputLoadMs: number;
  /** Process time outside input loading and the timing loop (startup, imports, exit). */
  fixedMs: number;
  /** Wall time of the dry correctness check, where one ran (the check family of the lane). */
  checkMs?: number;
}

type LoopSettings = Pick<
  ManifestV2['measurement'],
  'samples' | 'minSampleMs' | 'warmupMs' | 'minWarmupOps'
>;

/** Duration of the worker's timing loop for a given operation time: first call, warm-up, samples. */
export function loopMs(opMs: number, m: LoopSettings): number {
  const warmupOps = Math.max(m.minWarmupOps - 1, Math.ceil(m.warmupMs / opMs));
  const opsPerSample = Math.max(1, Math.ceil(m.minSampleMs / opMs));
  return opMs * (1 + warmupOps + m.samples * opsPerSample);
}

const caseBytes = (c: CaseSpec) => c.fixture?.bytes ?? c.external?.bytes ?? 0;
/** The lane as the projection keys it: W1 rows and records are measured apart. */
const laneKey = (c: CaseSpec) => (c.shape ? `${c.lane}-${c.shape}` : c.lane);
const dryKey = (impl: string, c: CaseSpec) => `${impl}\0${laneKey(c)}\0${c.family ?? ''}`;

/** The dry-run cases: one synthetic case per lane and family, at the manifest's dry-run size. */
export function dryRunCases(manifest: Manifest, v2: ManifestV2): CaseSpec[] {
  return manifest.cases.filter(
    (c) => c.family !== undefined && c.fixture && c.targetBytes === v2.budget.dryRun.targetBytes,
  );
}

/**
 * Projected wall time of a set of pairs in one phase (the timing shards: check and
 * timing processes; the memory phase: memory processes of the primary pairs), in
 * milliseconds. An estimate: each
 * implementation ran one short timing process per lane and family on the dry-run
 * case, and its operation, input-load and check times are scaled linearly by input
 * bytes within that lane and family. A pair without a measurement of its own
 * (an external dataset, or an implementation the dry run could not time) takes the
 * costliest measurement per byte of its implementation in the lane, else of the lane.
 */
export function projectMs(
  pairs: readonly ExpectedPair[],
  manifest: Manifest,
  v2: ManifestV2,
  dry: ReadonlyMap<string, DryMeasure>,
  emptyMs: number,
  processes: number,
  memoryProcesses: number,
  phase: 'timing' | 'memory',
): number {
  const caseById = new Map(manifest.cases.map((c) => [c.id, c]));
  const scored = new Set(scoredCases(manifest).map((c) => c.id));
  const costliest = (lane: string, impl?: string) =>
    [...dry]
      .filter(([k]) => {
        const [i, l] = k.split('\0');
        return l === lane && (impl === undefined || i === impl);
      })
      .map(([, d]) => d)
      .reduce<DryMeasure | undefined>(
        (a, b) => (a && a.opMs / a.bytes >= b.opMs / b.bytes ? a : b),
        undefined,
      );
  let total = (phase === 'memory' ? memoryProcesses : processes) * emptyMs;
  for (const pair of pairs) {
    const c = caseById.get(pair.case);
    if (!c || pair.expect !== 'measure') continue;
    const impl = pair.impl === v2.aa.impl ? manifest.candidate : pair.impl;
    const d = dry.get(dryKey(impl, c)) ?? costliest(laneKey(c), impl) ?? costliest(laneKey(c));
    if (!d) continue;
    const ratio = caseBytes(c) / d.bytes;
    const load = d.inputLoadMs * ratio;
    const op = d.opMs * ratio;
    const checked = dry.get(`${impl}\0${laneKey(c)}\0${v2.budget.dryRun.checkFamily}`);
    const check =
      checked?.checkMs === undefined
        ? d.fixedMs + load + 3 * op
        : d.fixedMs +
          (Math.max(0, checked.checkMs - checked.fixedMs) * caseBytes(c)) / checked.bytes;
    const time = d.fixedMs + load + loopMs(op, v2.measurement);
    const memory = d.fixedMs + load + op;
    if (phase === 'timing') total += check + processes * time;
    else if (scored.has(c.id)) total += memoryProcesses * memory;
  }
  return total;
}

const medianOf = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
};

/**
 * The dry run behind the projection: one empty process, then for every
 * implementation one short timing process on the dry-run case of each lane and
 * family the pairs use, and one correctness check per lane (on the check family).
 */
async function dryRun(
  ctx: ShardV2Context,
  pairs: readonly ExpectedPair[],
): Promise<{ stop: EndStatusV2 } | { dry: Map<string, DryMeasure>; emptyMs: number }> {
  const { manifest, v2 } = ctx;
  const job = jobRunner(ctx);
  const caseById = new Map(manifest.cases.map((c) => [c.id, c]));
  const settings = { ...v2.measurement, ...v2.budget.dryRun };
  const args = [
    ...['--samples', String(settings.samples)],
    ...['--min-sample-ms', String(settings.minSampleMs)],
    ...['--warmup-ms', String(settings.warmupMs)],
  ];
  const dry = new Map<string, DryMeasure>();
  const started = performance.now();
  const e = await job('dry-empty', 'empty', '-', null, 0);
  if ('stop' in e) return e;
  const emptyMs = performance.now() - started;
  // Implementations per lane and family that the pairs measure (the A/A arm is the candidate again).
  const wanted = new Set<string>();
  for (const p of pairs) {
    const c = caseById.get(p.case);
    if (c && p.expect === 'measure' && p.impl !== v2.aa.impl) wanted.add(dryKey(p.impl, c));
  }
  for (const c of dryRunCases(manifest, v2)) {
    const impls = [...new Set(pairs.map((p) => p.impl))].filter((impl) =>
      wanted.has(dryKey(impl, c)),
    );
    for (const impl of impls) {
      const runnable =
        ctx.inputs[c.id] !== undefined &&
        (ctx.entries[impl] !== undefined ||
          expectedPairs(manifest, [c.id]).some((p) => p.impl === impl && p.expect === 'measure'));
      if (!runnable) continue;
      let checkMs: number | undefined;
      if (c.family === v2.budget.dryRun.checkFamily) {
        const t = performance.now();
        const check = await job('dry-check', 'check', impl, c, 0);
        if ('stop' in check) return check;
        if (check.record?.status === 'PASS') checkMs = performance.now() - t;
      }
      const t = performance.now();
      const time = await job('dry-time', 'time', impl, c, 0, args);
      if ('stop' in time) return time;
      const wallMs = performance.now() - t;
      const samples = time.record?.samplesMs;
      if (!Array.isArray(samples) || samples.length === 0) continue;
      const opMs = medianOf(samples as number[]);
      const inputLoadMs = Number(time.record?.inputLoadMs ?? 0);
      dry.set(dryKey(impl, c), {
        bytes: caseBytes(c),
        opMs,
        inputLoadMs,
        fixedMs: Math.max(0, wallMs - inputLoadMs - loopMs(opMs, settings)),
        ...(checkMs === undefined ? {} : { checkMs }),
      });
    }
  }
  return { dry, emptyMs };
}

/** Writes any missing synthetic fixture to the cache and returns the input file of every case. */
function ensureInputs(
  manifest: Manifest,
  cases: readonly CaseSpec[],
  fixtureDir: string,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const c of cases) {
    if (c.external) {
      const file = join(ROOT, c.external.path);
      if (!existsSync(file))
        throw new Error(`case ${c.id}: external dataset ${c.external.path} is missing`);
      inputs[c.id] = file;
    } else if (c.family && c.targetBytes && c.fixture) {
      const file = join(fixtureDir, `${c.fixture.sha256}.csv`);
      if (!existsSync(file)) {
        const { seed } = manifest.families[c.family];
        const fixture = generateFixture({ family: c.family, seed, targetBytes: c.targetBytes });
        if (fixture.sha256 !== c.fixture.sha256)
          throw new Error(`case ${c.id}: generated fixture differs from the manifest`);
        mkdirSync(fixtureDir, { recursive: true });
        writeFileSync(file, fixture.csv);
      }
      inputs[c.id] = file;
    }
  }
  return inputs;
}

export interface RunV2Options {
  kind: KindV2;
  campaignId: string;
  shardId: string;
  seed: number;
  outFile: string;
  manifest: Manifest;
  v2: ManifestV2;
  cases: CaseSpec[];
  pairs: ExpectedPair[];
  /** Every shard of the campaign with its pairs (this run's included), for the projection. */
  campaignShards: Record<string, ExpectedPair[]>;
  /** Pairs of the campaign's memory phase, for the projection; empty when there is none. */
  memoryPairs: ExpectedPair[];
  phase: 'timing' | 'memory';
  processes: number;
  memoryProcesses: number;
  pinning: Pinning | null;
  budgetMinutes: number;
  dryRunOnly: boolean;
  copies: string[];
  entries: Record<string, string>;
  entrySha256: Record<string, string>;
  identities: Record<string, { commit: string; distSha256: string }>;
  /** Kind-specific fields of the start record (filters, arms, bundle identity). */
  start: Record<string, unknown>;
  /** Still true at the end, or the run ends `source-changed` (for example the bundle hash). */
  unchanged: () => boolean;
  /** Replaceable in tests. */
  spawnWorker?: SpawnV2;
  fixtureDir?: string;
  /** The file whose hash the records state as `manifestV2Sha256` (Method.path); manifest-v2.json by default. */
  manifestV2Path?: string;
  /** Method.installedAs: where the start record reads a package's installed version. */
  installedAs?: Record<string, string>;
}

/**
 * One v2 run: start record, dry run and projection, the budget refusal, the
 * rounds, and the end record. Returns the process exit code: 0 only for a
 * complete run (or a requested dry run).
 */
export async function runV2(o: RunV2Options): Promise<number> {
  const { manifest, v2 } = o;
  if (existsSync(o.outFile))
    throw new Error(`${o.outFile} exists; a shard is never appended to or rerun in place`);
  mkdirSync(dirname(o.outFile), { recursive: true });
  const workDir = join(ROOT, 'work');
  const campaignPairs = [...Object.values(o.campaignShards).flat(), ...o.memoryPairs];
  const lanes = new Set(
    manifest.cases.filter((c) => campaignPairs.some((p) => p.case === c.id)).map((c) => c.lane),
  );
  const dryCases = dryRunCases(manifest, v2).filter((c) => lanes.has(c.lane));
  const inputs = ensureInputs(
    manifest,
    manifest.cases.filter((c) => o.cases.includes(c) || dryCases.includes(c)),
    o.fixtureDir ?? join(workDir, 'data', 'fixtures'),
  );
  let tempUsage = directoryBytes(workDir);
  let lastTempScan = Date.now();
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      controller.abort();
    });
  }
  const startedAt = Date.now();
  const guards: Guards = {
    deadlineAt: startedAt + o.budgetMinutes * 60_000,
    rssLimitBytes: v2.limits.rssLimitBytes,
    rssPollMs: v2.limits.rssPollMs,
    diskFloorBytes: v2.limits.diskFloorBytes,
    tempCapBytes: v2.limits.tempCapBytes,
    freeDiskBytes,
    tempUsageBytes: () => {
      if (Date.now() - lastTempScan > 30_000) {
        tempUsage = directoryBytes(workDir);
        lastTempScan = Date.now();
      }
      return tempUsage;
    },
    signal: controller.signal,
  };
  const watched = o.pinning ? [o.pinning.cpu, ...o.pinning.siblings] : [];
  const machine = () => ({
    ...machineState(),
    // Per-CPU times of the worker's core: the sibling's line shows whether it stayed idle.
    coreCpuTimes:
      watched.length > 0
        ? linuxLines('/proc/stat', new RegExp(`^cpu(${[...new Set(watched)].join('|')}) `))
        : null,
  });
  const checkpoint = jsonlCheckpoint(o.outFile);
  const source = sourceIdentity();
  const manifestV2Path = o.manifestV2Path ?? MANIFEST_V2_PATH;
  const manifestV2Sha256 = fileSha256(manifestV2Path);
  checkpoint({
    type: 'start',
    method: 'v2',
    kind: o.kind,
    phase: o.phase,
    campaignId: o.campaignId,
    shardId: o.shardId,
    seed: o.seed,
    plannedCases: o.cases.map((c) => c.id),
    measurement: { ...v2.measurement, processes: o.processes, memoryProcesses: o.memoryProcesses },
    runtime: { node: process.version, execPath: process.execPath, workerFlags: WORKER_FLAGS },
    packages: installedVersions(manifest, o.installedAs),
    manifestSha256: manifestSha256(),
    manifestV2Sha256,
    fixtures: Object.fromEntries(
      o.cases.map((c) => [c.id, c.fixture?.sha256 ?? c.external?.sha256 ?? null]),
    ),
    source,
    nodeEnvironment: Object.fromEntries(NODE_ENVIRONMENT.map((name) => [name, null])),
    // Index = round (0: checks and dry processes); every process of a round ran with this seed.
    v8Seeds: {
      flags: v2.seeds.flags,
      byRound: v8Seeds(v2, o.seed, o.shardId, Math.max(o.processes, o.memoryProcesses)),
    },
    pinning: o.pinning,
    copies: o.copies,
    limits: { ...v2.limits, budgetMinutes: o.budgetMinutes },
    machine: machine(),
    environment: {
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
      osRelease: release(),
    },
    ...o.start,
  });
  const ctx: ShardV2Context = {
    manifest,
    v2,
    shardId: o.shardId,
    campaignSeed: o.seed,
    cases: o.cases,
    pairs: o.pairs,
    processes: o.processes,
    memoryProcesses: o.memoryProcesses,
    phase: o.phase,
    copies: o.copies,
    entries: o.entries,
    entrySha256: o.entrySha256,
    identities: o.identities,
    harnessCommit: source.gitCommit,
    machine: { cpuModel: cpus()[0]?.model ?? 'unknown', kernel: release() },
    pinCpu: o.pinning?.cpu ?? null,
    inputs,
    guards,
    checkpoint,
    ...(o.spawnWorker ? { spawnWorker: o.spawnWorker } : {}),
  };

  let status: string;
  let error: string | undefined;
  let projectedMinutes: number | null = null;
  try {
    const measured = await dryRun(ctx, campaignPairs);
    if ('stop' in measured) status = measured.stop;
    else {
      const minutes = (pairs: readonly ExpectedPair[], phase: 'timing' | 'memory') =>
        projectMs(
          pairs,
          manifest,
          v2,
          measured.dry,
          measured.emptyMs,
          o.processes,
          o.memoryProcesses,
          phase,
        ) / 60_000;
      // Every run of the campaign repeats this dry run, so each carries its duration.
      const dryRunMinutes = (Date.now() - startedAt) / 60_000;
      const perShard = Object.fromEntries(
        Object.entries(o.campaignShards).map(([id, pairs]) => [
          id,
          dryRunMinutes + minutes(pairs, 'timing'),
        ]),
      );
      const timingMinutes = Object.values(perShard).reduce((a, b) => a + b, 0);
      const memoryPhaseMinutes =
        o.memoryPairs.length > 0 ? dryRunMinutes + minutes(o.memoryPairs, 'memory') : 0;
      const campaignMinutes = timingMinutes + memoryPhaseMinutes;
      projectedMinutes = dryRunMinutes + minutes(o.pairs, o.phase);
      const overBudget = campaignMinutes > o.budgetMinutes;
      checkpoint({
        type: 'projection',
        basis:
          'estimate: per implementation, one short timing process on the dry-run case of each lane and family and one check per lane, scaled linearly by input bytes; includes the dry run of every run',
        dryRunMinutes,
        dryMeasures: Object.fromEntries(
          [...measured.dry].map(([k, d]) => [k.replaceAll('\0', ' '), d]),
        ),
        thisRunMinutes: projectedMinutes,
        perShardMinutes: perShard,
        timingMinutes,
        memoryPhaseMinutes,
        campaignMinutes,
        budgetMinutes: o.budgetMinutes,
        overBudget,
      });
      const shards = Object.entries(perShard)
        .map(([id, m]) => `${id} ${m.toFixed(1)}`)
        .join(', ');
      process.stderr.write(
        `projected (estimate): this run (${o.phase}) ${projectedMinutes.toFixed(1)} min; campaign ${campaignMinutes.toFixed(1)} min = timing ${timingMinutes.toFixed(1)} min (${shards}) + memory phase ${memoryPhaseMinutes.toFixed(1)} min; budget ${String(o.budgetMinutes)} min\n`,
      );
      if (overBudget) {
        process.stderr.write('refusing to start: the projection is above the budget\n');
        status = 'over-budget';
      } else if (o.dryRunOnly) status = 'dry-run';
      else status = await runShardV2(ctx);
    }
  } catch (caught) {
    status = 'orchestration-error';
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  }
  const sourceAtEnd = sourceIdentity();
  const changed =
    sourceAtEnd.sha256 !== source.sha256 ||
    sourceAtEnd.gitCommit !== source.gitCommit ||
    fileSha256(manifestV2Path) !== manifestV2Sha256 ||
    !o.unchanged();
  const endStatus = changed && status === 'complete' ? 'source-changed' : status;
  const end = writeEnd(checkpoint, {
    status: endStatus,
    ...(error === undefined ? {} : { error }),
    sourceChanged: changed,
    source: sourceAtEnd,
    manifestSha256: manifestSha256(),
    manifestV2Sha256,
    projectedMinutes,
    elapsedMinutes: (Date.now() - startedAt) / 60_000,
    tempUsageBytes: directoryBytes(workDir),
    machine: machine(),
  });
  if (!end.ok) {
    process.stderr.write(
      `${o.shardId}: ${endStatus}; FAILED to write the end record to ${o.outFile} (${end.error}). This checkpoint is incomplete.\n`,
    );
    return 2;
  }
  process.stderr.write(`${o.shardId}: ${endStatus} -> ${o.outFile}\n`);
  if (error) process.stderr.write(`${error}\n`);
  process.stdout.write(`${o.outFile}\n`);
  return endStatus === 'complete' || endStatus === 'dry-run' ? 0 : 1;
}

/**
 * Variables that change how every Node process of a run starts: NODE_OPTIONS adds
 * flags to the runner and to each worker, NODE_COMPILE_CACHE makes later workers
 * start from code an earlier one compiled. A v2 run refuses to start with either
 * set, so the start record can state both as unset instead of describing them.
 */
export const NODE_ENVIRONMENT = ['NODE_OPTIONS', 'NODE_COMPILE_CACHE'] as const;

export function refuseNodeEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const set = NODE_ENVIRONMENT.filter((name) => env[name] !== undefined && env[name] !== '');
  if (set.length > 0)
    throw new Error(`unset ${set.join(' and ')} before a v2 run: it would change every process`);
}

/** The full commit a revision names in the repository. */
export function commitOf(rev: string, repo: string = ROOT): string {
  const r = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${rev} is not a commit here: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** `--pin-cpu`, or the refusal when the kind requires pinning. */
export function requestedPinning(
  v2: ManifestV2,
  kind: KindV2,
  pinCpu: string | undefined,
  deps?: PinDeps,
): Pinning | null {
  if (pinCpu === undefined) {
    if (v2.placement.requiredFor.includes(kind))
      throw new Error(`a ${kind} run must be pinned: pass --pin-cpu <cpu>`);
    return null;
  }
  return verifyPinning(Number(pinCpu), deps);
}

export const WORK_V2 = join(ROOT, 'work', 'bench-v2');

/**
 * The processes that import the bundle: the candidate and its A/A copy (from the twin
 * directory), and in an S1 or W1 run the arms of manifest-v2 `s1.arms` or `w1.arms`,
 * which import the candidate's own entry and differ only in their adapter options.
 */
export function bundleArms(
  manifest: Manifest,
  v2: ManifestV2,
  lane: string | undefined,
  entry: string,
  aaEntry: string,
  sha256: string,
): { entries: Record<string, string>; entrySha256: Record<string, string> } {
  const arms = Object.keys(armsOf(v2, lane));
  const entries: Record<string, string> = {
    [manifest.candidate]: entry,
    [v2.aa.impl]: aaEntry,
    ...Object.fromEntries(arms.map((arm) => [arm, entry])),
  };
  return {
    entries,
    entrySha256: Object.fromEntries(Object.keys(entries).map((impl) => [impl, sha256])),
  };
}

async function mainV2() {
  const { values } = parseArgs({
    options: {
      method: { type: 'string' },
      campaign: { type: 'string' },
      shard: { type: 'string' },
      kind: { type: 'string', default: 'campaign' },
      seed: { type: 'string' },
      'pin-cpu': { type: 'string' },
      'candidate-commit': { type: 'string' },
      phase: { type: 'string', default: 'timing' },
      budget: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      smoke: { type: 'boolean', default: false },
      cases: { type: 'string' },
      impls: { type: 'string' },
      processes: { type: 'string' },
      'memory-processes': { type: 'string' },
      out: { type: 'string' },
      lane: { type: 'string' },
    },
  });
  refuseNodeEnvironment();
  // v2, or pub: v2 with the values of bench/manifest-pub.json (Node, papaparse, no Node flags).
  const method = readMethod(values.method ?? 'v2');
  const { v2 } = method;
  if (values.lane !== undefined && values.lane !== 'W1' && values.lane !== 'S1')
    throw new Error(
      `unknown --lane ${values.lane} (S1 or W1; without it the B1/B2/S1 manifest runs)`,
    );
  // W1 and S1 are manifests of their own (cases, implementations, shards), each with the
  // candidate's arms (manifest-v2 s1.arms, w1.arms), which load the same bundle.
  const manifest = laneManifest(values.lane, method.manifest, v2);
  const kind = values.smoke ? 'smoke' : values.kind;
  if (kind !== 'campaign' && kind !== 'calibration' && kind !== 'smoke')
    throw new Error(
      `unknown --kind ${kind} (campaign, calibration; --smoke; A/B runs use bench/ab.ts)`,
    );
  const { phase } = values;
  if (phase !== 'timing' && phase !== 'memory')
    throw new Error(`unknown --phase ${phase} (timing or memory)`);
  if (phase === 'memory' && kind === 'calibration')
    throw new Error('a calibration has no memory phase');
  if (phase === 'memory' && values.shard !== undefined)
    throw new Error('the memory phase is one run of its own: do not pass --shard');
  const shardSpec = manifest.campaign.shards.find((s) => s.id === values.shard);
  const filtered = values.cases ?? values.impls ?? values.processes ?? values['memory-processes'];
  if (kind !== 'smoke') {
    if (!values.campaign || (!shardSpec && phase === 'timing') || values.seed === undefined)
      throw new Error(
        'v2 runs need --campaign <id>, the campaign --seed, and a manifest --shard or --phase memory',
      );
    if (filtered !== undefined) throw new Error('campaign shards cannot be filtered');
    if (process.version !== `v${manifest.runtime.node}`)
      throw new Error(
        `--method ${method.name} runs require Node ${manifest.runtime.node}; this is ${process.version}`,
      );
  } else if (!values.cases) throw new Error('a v2 smoke run needs --cases <id,...>');
  const seed = values.seed === undefined ? randomInt(2 ** 32) : Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 2 ** 32)
    throw new Error('--seed must be an integer in [0, 2^32)');
  const budgetMinutes = Number(values.budget ?? v2.budget.defaultMinutes);
  if (!(budgetMinutes > 0)) throw new Error('--budget must be a positive number of minutes');

  const pairsOf = (caseIds: readonly string[]) =>
    expectedPairsV2(manifest, v2, kind === 'calibration' ? 'calibration' : 'campaign', caseIds);
  const implFilter = values.impls?.split(',');
  const primaryIds = scoredCases(manifest).map((c) => c.id);
  // The memory phase of a campaign covers every scored pair, after all timing shards.
  const memoryPairs = kind === 'campaign' ? pairsOf(primaryIds) : [];
  const caseIds =
    kind === 'smoke'
      ? (values.cases ?? '').split(',')
      : phase === 'memory'
        ? primaryIds
        : (shardSpec?.cases ?? []);
  const pairs = pairsOf(caseIds).filter((p) => !implFilter || implFilter.includes(p.impl));
  const planned = new Set(pairs.map((p) => p.case));
  const cases = manifest.cases.filter((c) => planned.has(c.id));
  const campaignId = values.campaign ?? `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const shardId =
    kind === 'smoke'
      ? 'smoke'
      : phase === 'memory'
        ? v2.measurement.memoryShard
        : (shardSpec?.id ?? '');
  const outFile = values.out ?? join(WORK_V2, 'results', campaignId, `${shardId}.jsonl`);
  if (existsSync(outFile))
    throw new Error(`${outFile} exists; a shard is never appended to or rerun in place`);

  const source = sourceIdentity();
  if (kind !== 'smoke' && source.dirty)
    throw new Error('the working tree differs from the commit; commit or discard the changes');
  const pinning = requestedPinning(v2, kind, values['pin-cpu']);
  // The candidate is HEAD's dist/ (verified against a fresh build of HEAD), or with
  // --candidate-commit the bundle of that commit, built here from its archive alone.
  const buildDir = join(WORK_V2, 'build', `${campaignId}-${shardId}`);
  const candidateCommit =
    values['candidate-commit'] === undefined
      ? source.gitCommit
      : commitOf(values['candidate-commit']);
  let distDir = join(ROOT, v2.candidate.distDir);
  let distSha256: string;
  if (values['candidate-commit'] === undefined) {
    distSha256 = verifyDist({
      commit: source.gitCommit,
      distDir,
      dirtyBuildInputs: () => git(['status', '--porcelain', '--', ...BUILD_INPUTS]),
      freshBuildSha256: () => buildCommit(source.gitCommit, buildDir, v2),
    });
    rmSync(buildDir, { recursive: true, force: true });
  } else {
    distSha256 = buildCommit(candidateCommit, buildDir, v2);
    distDir = join(buildDir, v2.candidate.distDir);
  }
  const copiesBase = join(WORK_V2, 'copies', campaignId, shardId);
  const copies = prepareCopies(ROOT, copiesBase, v2, distSha256, distDir, method.installedAs);
  const entry = join(v2.candidate.distDir, v2.candidate.entry);
  const aaEntry = join(v2.aa.distDir, v2.candidate.entry);
  const entryFileSha256 = fileSha256(join(distDir, v2.candidate.entry));
  try {
    // Refused before anything is timed: the report rejects packages that are not the manifest's.
    if (kind !== 'smoke') verifyCopyPackages(manifest, copies);
    process.exitCode = await runV2({
      kind,
      campaignId,
      shardId,
      seed,
      outFile,
      manifest,
      v2,
      cases,
      pairs,
      campaignShards:
        kind === 'smoke'
          ? phase === 'timing'
            ? { smoke: pairs }
            : {}
          : Object.fromEntries(manifest.campaign.shards.map((s) => [s.id, pairsOf(s.cases)])),
      memoryPairs: kind === 'smoke' ? (phase === 'memory' ? pairs : []) : memoryPairs,
      phase,
      processes: Number(values.processes ?? v2.measurement.processes),
      memoryProcesses: Number(values['memory-processes'] ?? v2.measurement.memoryProcesses),
      pinning,
      budgetMinutes,
      dryRunOnly: values['dry-run'],
      copies,
      ...bundleArms(manifest, v2, values.lane, entry, aaEntry, entryFileSha256),
      identities: { '*': { commit: candidateCommit, distSha256 } },
      start: {
        ...(values.lane === undefined ? {} : { lane: values.lane }),
        filters: {
          cases: values.cases ?? null,
          impls: values.impls ?? null,
          processes: values.processes ?? null,
          memoryProcesses: values['memory-processes'] ?? null,
        },
        candidate: {
          commit: candidateCommit,
          harnessCommit: source.gitCommit,
          distSha256,
          entrySha256: entryFileSha256,
          buildCommand: v2.candidate.buildCommand,
          aaImpl: v2.aa.impl,
        },
      },
      unchanged: () => treeSha256(distDir) === distSha256,
      manifestV2Path: method.path,
      installedAs: method.installedAs,
    });
  } finally {
    rmSync(copiesBase, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { method: { type: 'string' } }, strict: false });
  if (values.method === undefined || values.method === 'v1') await main();
  else if (values.method === 'v2' || values.method === 'pub') await mainV2();
  else throw new Error(`unknown --method ${String(values.method)} (v1, v2 or pub)`);
}
