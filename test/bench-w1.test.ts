import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scratchDir } from './scratch.ts';
import { abRunOptions } from '../bench/ab.ts';
import { ADAPTER_IDS, loadAdapter } from '../bench/adapters/index.ts';
import { FAMILIES, generateFixture } from '../bench/fixtures.ts';
import {
  candidateAdapter,
  consumeText,
  type Adapter,
  type CandidateUnparse,
  type Dialect,
  type Lane,
} from '../bench/lanes.ts';
import {
  expectedPairs,
  expectedPairsV2,
  manifestSha256,
  manifestV2Issues,
  readManifest,
  readManifestV2,
  s1Manifest,
  w1Manifest,
  type CaseSpec,
  type Manifest,
  type ManifestV2,
} from '../bench/manifest.ts';
import { renderV2, scoreV2, type JobRecord, type Shard } from '../bench/report.ts';
import { parse } from '../src/parse.ts';
import { unparse } from '../src/unparse.ts';
import {
  bundleArms,
  dryRunCases,
  jsonlCheckpoint,
  projectMs,
  runShardV2,
  runV2,
  type Guards,
  type JobOutcome,
  type SpawnV2,
} from '../bench/run.ts';
import {
  check,
  measureMemory,
  memoryOperation,
  operation,
  time,
  w1Input,
  type Input,
} from '../bench/worker.ts';

// The W1 lane: rows or records to one CSV string. Its cases, implementations and shards are a
// manifest of their own (w1Manifest); every output is read back by Papa Parse before anything is
// timed.

const base = readManifest();
const v2 = readManifestV2();
const w1 = w1Manifest(base, v2);
const V1_SHA = manifestSha256();
const scratch = scratchDir;
// The W1 diagnostic arm: the candidate's bundle, unparse without escapeFormulae.
const ARM = 'csv-engine (default-on)';

describe('the W1 lane and manifest', () => {
  it('the lane type accepts W1, and manifest-v2.json validates with its W1 section', () => {
    const lane: Lane = 'W1';
    expect(lane).toBe('W1');
    expect(manifestV2Issues(v2, base, V1_SHA)).toEqual([]);
  });

  it('has 24 cases: six families, 1 MiB and 32 MiB, rows and records, each a frozen v1 fixture', () => {
    expect(w1.cases).toHaveLength(24);
    const keys = new Set(
      w1.cases.map((c) => `${String(c.family)} ${String(c.targetBytes)} ${String(c.shape)}`),
    );
    expect(keys.size).toBe(24);
    for (const c of w1.cases) {
      expect(c).toMatchObject({ lane: 'W1', class: 'primary', weight: 1 });
      expect(FAMILIES).toContain(c.family);
      expect([1048576, 33554432]).toContain(c.targetBytes);
      const frozen = base.cases.find(
        (b) => b.lane === 'B1' && b.family === c.family && b.targetBytes === c.targetBytes,
      );
      expect(c.fixture).toStrictEqual(frozen?.fixture);
    }
  });

  it('is a manifest of its own: no B1/B2/S1 case, and the B1/B2/S1 manifest has no W1 case', () => {
    expect(base.cases.some((c) => c.lane === 'W1')).toBe(false);
    expect(new Set(w1.cases.map((c) => c.lane))).toEqual(new Set(['W1']));
    expect(w1.campaign.shards.flatMap((s) => s.cases).sort()).toEqual(
      w1.cases.map((c) => c.id).sort(),
    );
    expect(w1.campaign.shards.map((s) => s.id)).not.toContain(v2.measurement.memoryShard);
    // The B1/B2/S1 pairs: the A/A arm on 24 primary cases, nothing of W1.
    const pairs = expectedPairsV2(base, v2, 'campaign');
    expect(pairs.some((p) => p.case.startsWith('W1-'))).toBe(false);
    expect(pairs.filter((p) => p.impl === v2.aa.impl)).toHaveLength(24);
  });

  it('accounts for every implementation on every case, with the reason when it has no W1 function', () => {
    const pairs = expectedPairsV2(w1, v2, 'campaign');
    const impls = [...w1.implementations.map((i) => i.id), w1.candidate, v2.aa.impl, ARM];
    expect(pairs).toHaveLength(24 * impls.length);
    for (const p of pairs) {
      if (p.expect !== 'measure') expect(p.reason).toMatch(/\w/);
    }
    const measured = (impl: string) =>
      pairs.filter((p) => p.impl === impl && p.expect === 'measure').length;
    expect(measured('csv-engine')).toBe(24);
    expect(measured('csv-engine-aa')).toBe(24);
    expect(measured(ARM)).toBe(24);
    expect(measured('papaparse')).toBe(24);
    expect(measured('csv-stringify')).toBe(24);
    expect(measured('fast-csv-format')).toBe(24);
    expect(measured('csv-rex')).toBe(24);
    // No line-ending option: not on quote-heavy, the CRLF family.
    expect(measured('d3-dsv')).toBe(20);
    expect(measured('amigo-labs-csv')).toBe(20);
    // Arrays only, comma, '"' and '\n': the rows cases of the five LF families.
    expect(measured('but-csv')).toBe(10);
    expect(measured('tiddlycsv')).toBe(10);
    // Records only.
    expect(measured('csv-pipe')).toBe(12);
    for (const none of ['papaparse-fastmode', 'csv-parse', 'csv-parser', 'fast-csv', 'udsv']) {
      expect(measured(none)).toBe(0);
    }
    expect(measured('csv-simple-parser') + measured('web-csv-toolbox')).toBe(0);
  });

  it('declares W1 for exactly the implementations whose adapter has a W1 function', async () => {
    for (const spec of w1.implementations) {
      expect(ADAPTER_IDS).toContain(spec.id);
      const adapter = await loadAdapter(spec.id);
      expect([spec.id, typeof adapter.W1 === 'function']).toStrictEqual([
        spec.id,
        spec.lanes.includes('W1'),
      ]);
      expect(w1.competitors[spec.package]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('pins the two writers added for W1 to exact versions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['csv-stringify']).toBe(w1.competitors['csv-stringify']);
    expect(pkg.devDependencies['@fast-csv/format']).toBe(w1.competitors['@fast-csv/format']);
  });

  it('rejects an invalid W1 section with its reason', () => {
    const issues = (change: (m: ManifestV2) => void) => {
      const copy = structuredClone(v2);
      change(copy);
      return manifestV2Issues(copy, base, V1_SHA).join('\n');
    };
    const first = (m: ManifestV2) => m.w1.cases[0] as CaseSpec;
    expect(issues((m) => (first(m).lane = 'B1'))).toMatch(/must be lane W1, class primary/);
    expect(issues((m) => (first(m).weight = 0))).toMatch(/weight 1/);
    expect(issues((m) => delete first(m).shape)).toMatch(/needs shape rows or records/);
    expect(
      issues((m) => (first(m).fixture = { bytes: 1, rows: 1, columns: 1, sha256: 'x' })),
    ).toMatch(/frozen fixture/);
    expect(issues((m) => m.w1.shards[0]?.cases.pop())).toMatch(/exactly one shard/);
    expect(issues((m) => m.w1.cases.pop())).toMatch(/24 distinct case ids/);
    expect(issues((m) => ((m.w1.shards[0] as { id: string }).id = 'M'))).toMatch(/memoryShard/);
    expect(issues((m) => (m.w1.implementations[0] as { lanes: string[] }).lanes.pop())).toMatch(
      /needs either lane W1 or missingLanes\.W1/,
    );
    expect(issues((m) => delete m.w1.competitors.papaparse)).toMatch(/papaparse has no version/);
  });
});

function fixtureInput(family: (typeof FAMILIES)[number], targetBytes = 8 * 1024): Input {
  const f = generateFixture({ family, seed: base.families[family].seed, targetBytes });
  return {
    csv: f.csv,
    dialect: f.dialect,
    sha256: f.sha256,
    header: f.rows[0] ?? null,
    rows: f.rows,
  };
}
const w1Spec = (family: (typeof FAMILIES)[number], shape: 'rows' | 'records'): CaseSpec => ({
  id: `W1-${shape}-${family}-test`,
  lane: 'W1',
  class: 'primary',
  weight: 1,
  family,
  shape,
});
const candidate = candidateAdapter(parse, unparse);
async function prepared(family: (typeof FAMILIES)[number], shape: 'rows' | 'records') {
  const spec = w1Spec(family, shape);
  const input = fixtureInput(family);
  input.w1 = await w1Input(spec, input, base.reference);
  return { spec, input };
}

describe('W1 correctness before timing (read back by Papa Parse)', () => {
  // Every writer on a small fixture of every family, in both shapes: it round-trips,
  // or the adapter itself says UNSUPPORTED exactly where the manifest declares it.
  it.each(FAMILIES)(
    'every W1 writer round-trips %s, or is declared unsupported there',
    async (family) => {
      for (const shape of ['rows', 'records'] as const) {
        const { spec, input } = await prepared(family, shape);
        const declared = w1.cases.find((c) => c.family === family && c.shape === shape);
        for (const id of [...w1.implementations.map((i) => i.id), 'csv-engine']) {
          const pair = expectedPairs(w1, [declared?.id ?? '']).find((p) => p.impl === id);
          // The candidate as the campaign builds it (from dist/ there, from src/ here).
          const adapter = id === 'csv-engine' ? candidate : await loadAdapter(id);
          const result = await check(adapter, spec, input, base);
          const want = pair?.expect === 'measure' ? 'PASS' : 'UNSUPPORTED';
          expect([id, shape, result.status]).toStrictEqual([id, shape, want]);
          if (result.status === 'PASS') {
            expect(result.outputLength).toBe(input.rows?.length);
            expect(result.outputBytes).toBeGreaterThan(input.csv.length / 2);
          }
        }
      }
    },
    60_000,
  );

  // Deliberately wrong: joins fields without quoting. Lives only in this test.
  const naive: Adapter = {
    package: 'naive-join',
    W1: (data, header, dialect) =>
      (header === null ? (data as string[][]) : [])
        .map((row) => row.join(dialect.delimiter))
        .join(dialect.newline),
  };

  it('an output that does not round-trip is FAIL with its first differing cell and byte length', async () => {
    const { spec, input } = await prepared('quote-heavy', 'rows');
    const result = await check(naive, spec, input, base);
    expect(result).toMatchObject({ status: 'FAIL', oracle: 'generator' });
    if (result.status !== 'FAIL') throw new Error('expected FAIL');
    expect(result.outputBytes).toBeGreaterThan(0);
    const cell = result.mismatch as Record<string, unknown>;
    expect(cell).toMatchObject({ row: expect.any(Number) as unknown });
    expect(Object.keys(cell)).toEqual(
      expect.arrayContaining(['reason', 'row', 'column', 'expected', 'actual']),
    );
    // The same writer passes where nothing needs quoting: the gate is per case.
    const simple = await prepared('simple', 'rows');
    expect(await check(naive, simple.spec, simple.input, base)).toMatchObject({ status: 'PASS' });
  });

  it('shortens long cells in a FAIL record (a long-field cell reaches 64 KiB)', async () => {
    const { spec, input } = await prepared('long-field', 'rows');
    const result = await check(naive, spec, input, base);
    expect(result.status).toBe('FAIL');
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it('an adapter without a W1 function is UNSUPPORTED, not FAIL', async () => {
    const { spec, input } = await prepared('simple', 'records');
    const parserOnly = await loadAdapter('udsv');
    expect(parserOnly.W1).toBeUndefined();
    expect(await check(parserOnly, spec, input, base)).toEqual({
      status: 'UNSUPPORTED',
      reason: 'udsv has no W1 function',
    });
  });

  it('refuses an input that differs from the fixture: the input is checked before the writer', async () => {
    const { spec, input } = await prepared('simple', 'rows');
    const rows = (input.w1?.data ?? []) as string[][];
    input.w1 = { data: [...rows.slice(0, -1), ['changed']], header: null };
    await expect(check(await loadAdapter('papaparse'), spec, input, base)).rejects.toThrow(
      /the W1 input differs from the fixture/,
    );
  });

  it('records keep the header as the column order; rows keep the header row first', async () => {
    const records = await prepared('wide', 'records');
    expect(records.input.w1?.header).toStrictEqual(records.input.rows?.[0]);
    expect(records.input.w1?.data).toHaveLength((records.input.rows?.length ?? 0) - 1);
    const rows = await prepared('wide', 'rows');
    expect(rows.input.w1?.header).toBeNull();
    expect(rows.input.w1?.data).toStrictEqual(rows.input.rows);
  });
});

describe('W1 timed and memory operations', () => {
  const m = { ...base.measurement, warmupMs: 5, minWarmupOps: 2, samples: 3, minSampleMs: 1 };

  it('consumes the output string, synchronous writers in a plain loop and drained streams in an awaiting loop', async () => {
    const { input } = await prepared('unicode', 'records');
    const papa = operation(await loadAdapter('papaparse'), 'W1', input, 0);
    const fast = operation(await loadAdapter('fast-csv-format'), 'W1', input, 0);
    expect(await time(papa, m)).toMatchObject({ loop: 'sync' });
    expect(await time(fast, m)).toMatchObject({ loop: 'async' });
    const text = (await loadAdapter('papaparse')).W1?.(
      input.w1?.data ?? [],
      input.w1?.header ?? null,
      input.dialect,
      {},
    ) as string;
    expect(papa()).toBe(consumeText(text));
    expect(consumeText('ab')).toBe(2 + 98);
  });

  it('memory mode keeps the written string alive until the peak has been read', async () => {
    const { input } = await prepared('simple', 'rows');
    const op = memoryOperation(await loadAdapter('csv-stringify'), 'W1', input, 0);
    let retained: readonly unknown[] | null = null;
    const result = await measureMemory(async () => {
      const out = await op();
      retained = out.retained;
      return out;
    });
    expect(retained).toHaveLength(1);
    expect(typeof (retained as unknown as unknown[])[0]).toBe('string');
    expect(result.retainedRecords).toBe(1);
  });

  it('a W1 case without its prepared input is an error, never an empty write', async () => {
    const papa = await loadAdapter('papaparse');
    expect(() => operation(papa, 'W1', fixtureInput('simple'), 0)).toThrow(
      /W1 case without its input/,
    );
  });
});

const guards = (): Guards => ({
  deadlineAt: Date.now() + 120_000,
  rssLimitBytes: 2 * 1024 ** 3,
  rssPollMs: 1000,
  diskFloorBytes: 0,
  tempCapBytes: Infinity,
  freeDiskBytes: () => Infinity,
  tempUsageBytes: () => 0,
  signal: new AbortController().signal,
});
const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** A stand-in worker: checks PASS except for the implementations named, which FAIL. */
function fakeWorker(
  failing: readonly string[] = [],
  opMs = 10,
): { spawn: SpawnV2; argv: string[][] } {
  const argv: string[][] = [];
  const spawn: SpawnV2 = (args, _guards, command, options) => {
    argv.push(args);
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const mode = arg('--mode');
    const impl = arg('--impl') ?? '';
    const record = {
      mode,
      ...(mode === 'check'
        ? failing.includes(impl)
          ? { status: 'FAIL', mismatch: { reason: 'value', row: 3, column: 2 }, outputBytes: 99 }
          : { status: 'PASS', outputBytes: 100 }
        : {}),
      ...(mode === 'time' ? { samplesMs: [opMs, opMs, opMs], inputLoadMs: 1 } : {}),
      process: {
        node: process.version,
        cwd: options.cwd,
        execArgv: args.filter(
          (a, i) => a.startsWith('--') && i < args.findIndex((x) => x.endsWith('worker.ts')),
        ),
        cpusAllowed: command === 'taskset' ? args[1] : null,
        padLength: (options.env.CSV_BENCH_PAD ?? '').length,
        entry: arg('--load') === 'entry' ? arg('--entry') : null,
        entrySha256: arg('--load') === 'entry' ? 'entry-sha' : null,
      },
    };
    const outcome: JobOutcome = { status: 'ok', record, wallMs: 1, peakPolledRssBytes: 1 };
    return Promise.resolve(outcome);
  };
  return { spawn, argv };
}

describe('the runner on the W1 manifest', () => {
  const shard = w1.campaign.shards.find((s) => s.id === 'W1-rows');
  const caseIds = ['W1-rows-simple-1MiB', 'W1-rows-quote-heavy-1MiB'];
  const pairs = expectedPairsV2(w1, v2, 'campaign', caseIds);

  it('times only the pairs that pass; a FAIL is checked once and never timed; declared pairs never spawn', async () => {
    const file = join(scratch('w1-shard'), 'W1-rows.jsonl');
    const { spawn, argv } = fakeWorker(['csv-rex']);
    const status = await runShardV2({
      manifest: w1,
      v2,
      shardId: shard?.id ?? '',
      campaignSeed: 7,
      cases: w1.cases.filter((c) => caseIds.includes(c.id)),
      pairs,
      processes: 2,
      memoryProcesses: 1,
      phase: 'timing',
      copies: ['/copies/c1'],
      ...bundleArms(w1, v2, 'W1', 'dist/index.js', 'twin/index.js', 'entry-sha'),
      identities: { '*': { commit: 'c0ffee', distSha256: 'dist-sha' } },
      harnessCommit: 'ba5e',
      machine: { cpuModel: 'cpu', kernel: 'k' },
      pinCpu: null,
      inputs: Object.fromEntries(caseIds.map((id) => [id, `/fixtures/${id}.csv`])),
      guards: guards(),
      checkpoint: jsonlCheckpoint(file),
      spawnWorker: spawn,
    });
    expect(status).toBe('complete');
    const records = lines(file);
    const of = (type: string, impl: string) =>
      records.filter((r) => r.type === type && r.impl === impl);
    expect(of('check', 'csv-rex').map((r) => r.status)).toEqual(['FAIL', 'FAIL']);
    expect(of('time', 'csv-rex')).toHaveLength(0);
    expect(of('time', 'papaparse')).toHaveLength(2 * 2);
    expect(of('time', 'csv-engine-aa')).toHaveLength(2 * 2);
    // The default-on arm runs beside the candidate on every case, from the same bundle.
    expect(of('check', ARM).map((r) => r.case)).toEqual(caseIds);
    expect(of('time', ARM)).toHaveLength(2 * 2);
    const armJobs = argv.filter((a) => a.includes(ARM));
    expect(armJobs).toHaveLength(2 + 2 * 2);
    expect(armJobs.every((a) => a.includes('/copies/c1/dist/index.js'))).toBe(true);
    // Declared: recorded with the reason, no process.
    expect(records.find((r) => r.impl === 'udsv')).toMatchObject({
      status: 'UNSUPPORTED',
      declared: true,
      reason: expect.stringContaining('no writer') as unknown,
    });
    expect(
      records.find((r) => r.impl === 'd3-dsv' && r.case === 'W1-rows-quote-heavy-1MiB'),
    ).toMatchObject({ status: 'UNSUPPORTED', declared: true });
    expect(argv.some((a) => a.includes('udsv'))).toBe(false);
    // Every job names a W1 case; the candidate arms load the bundle.
    const jobs = argv.filter((a) => a.includes('--case'));
    expect(jobs.every((a) => a[a.indexOf('--case') + 1]?.startsWith('W1-'))).toBe(true);
    expect(jobs.filter((a) => a.includes('csv-engine')).every((a) => a.includes('entry'))).toBe(
      true,
    );
  });

  it('projects W1 rows and records from their own dry measurements, and has 12 dry-run cases', () => {
    const dryCases = dryRunCases(w1, v2);
    expect(dryCases).toHaveLength(12);
    expect(dryRunCases(base, v2)).toHaveLength(18);
    const bytes = w1.cases.find((c) => c.id === 'W1-rows-simple-1MiB')?.fixture?.bytes ?? 0;
    const dry = new Map([
      ['papaparse\0W1-rows\0simple', { bytes, opMs: 10, inputLoadMs: 5, fixedMs: 100 }],
      ['papaparse\0W1-records\0simple', { bytes, opMs: 20, inputLoadMs: 5, fixedMs: 100 }],
    ]);
    const project = (id: string) =>
      projectMs(
        [{ impl: 'papaparse', case: id, expect: 'measure' }],
        w1,
        v2,
        dry,
        0,
        1,
        0,
        'timing',
      );
    expect(project('W1-records-simple-1MiB')).toBeGreaterThan(project('W1-rows-simple-1MiB'));
  });

  it('prints the projection and refuses to start above the budget', async () => {
    const dir = scratch('w1-budget');
    const one = [{ impl: 'papaparse', case: 'W1-rows-simple-1MiB', expect: 'measure' as const }];
    const { spawn } = fakeWorker([], 1000);
    const code = await runV2({
      kind: 'smoke',
      campaignId: 'w1-test',
      shardId: 'smoke',
      seed: 1,
      outFile: join(dir, 'smoke.jsonl'),
      manifest: w1,
      v2,
      cases: w1.cases.filter((c) => c.id === 'W1-rows-simple-1MiB'),
      pairs: one,
      campaignShards: { smoke: one },
      memoryPairs: [],
      phase: 'timing',
      processes: 10,
      memoryProcesses: 0,
      pinning: null,
      budgetMinutes: 0.1,
      dryRunOnly: false,
      copies: [join(dir, 'copy')],
      entries: {},
      entrySha256: {},
      identities: { '*': { commit: 'c', distSha256: 'd' } },
      start: { lane: 'W1' },
      unchanged: () => true,
      spawnWorker: spawn,
      fixtureDir: join(dir, 'fixtures'),
    });
    expect(code).toBe(1);
    const records = lines(join(dir, 'smoke.jsonl'));
    expect(records[0]).toMatchObject({ type: 'start', lane: 'W1' });
    expect(records.find((r) => r.type === 'projection')).toMatchObject({ overBudget: true });
    expect(records.at(-1)).toMatchObject({ type: 'end', status: 'over-budget' });
    expect(records.some((r) => r.type === 'check' || r.type === 'time')).toBe(false);
  });
});

// A small W1 manifest for the report: two cases, a fast competitor, the
// reference, one writer that fails its check, and one without a W1 function.
const tiny: Manifest = {
  ...w1,
  competitors: { ref: '1.0.0', fast: '2.0.0', bad: '3.0.0', none: '4.0.0' },
  reference: 'ref',
  candidate: 'cand',
  implementations: [
    { id: 'ref', package: 'ref', lanes: ['W1'] },
    { id: 'fast', package: 'fast', lanes: ['W1'] },
    { id: 'bad', package: 'bad', lanes: ['W1'] },
    { id: 'none', package: 'none', lanes: [], missingLanes: { W1: 'parser only' } },
  ],
  unsupported: [],
  campaign: {
    ...w1.campaign,
    shards: [
      { id: 'W1-rows', cases: ['W1-rows-a'] },
      { id: 'W1-records', cases: ['W1-records-a'] },
    ],
  },
  cases: [
    { id: 'W1-rows-a', lane: 'W1', class: 'primary', weight: 1, shape: 'rows' },
    { id: 'W1-records-a', lane: 'W1', class: 'primary', weight: 1, shape: 'records' },
  ],
};
const TINY_ARM = 'cand (default-on)';
// The campaigns below are written for 10 rounds; the real process count is pinned in
// bench-v2-run.test.ts.
const tinyV2: ManifestV2 = {
  ...v2,
  measurement: { ...v2.measurement, processes: 10 },
  aa: { impl: 'cand-aa', distDir: 'twin' },
  w1: { ...v2.w1, arms: { [TINY_ARM]: { omitEscapeFormulae: true } } },
};
const HASHES = { manifestSha256: 'm', manifestV2Sha256: 'm2' };
const IDENTITY = {
  harnessCommit: 'c0ffee',
  commit: 'c0ffee',
  distSha256: 'dist-sha',
  node: 'v24.22.1',
  cpuModel: 'cpu',
  kernel: 'k',
  tasksetMask: '2',
  padLength: 1,
  checkoutCopy: 0,
};
const BASE_MS: Record<string, number> = { ref: 20, fast: 8, cand: 10, 'cand-aa': 10 };
// The arm is faster than every competitor on W1-rows-a, and must still never be the fastest competitor.
const msOf = (impl: string, caseId: string) =>
  impl === TINY_ARM ? (caseId === 'W1-rows-a' ? 5 : 12) : (BASE_MS[impl] ?? 10);
const JITTER = [-0.008, 0.004, 0, 0.006, -0.003, 0.009, -0.006, 0.002, -0.001, 0.007];
const SETTINGS = { samples: 3, minSampleMs: 250, warmupMs: 500, minWarmupOps: 3 };

function start(id: string, phase: 'timing' | 'memory', planned: string[], lane: string | null) {
  return {
    type: 'start',
    method: 'v2',
    kind: 'campaign',
    phase,
    ...(lane === null ? {} : { lane }),
    campaignId: 'w1',
    shardId: id,
    seed: 42,
    plannedCases: planned,
    measurement: tinyV2.measurement,
    filters: { cases: null, impls: null, processes: null, memoryProcesses: null },
    runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
    packages: tiny.competitors,
    ...HASHES,
    source: { gitCommit: 'c0ffee', sha256: 'source' },
    candidate: { commit: 'c0ffee', distSha256: 'dist-sha', aaImpl: 'cand-aa' },
    pinning: { cpu: 2, siblings: [2, 6], runnerCpus: [3] },
    environment: { cpu: 'cpu' },
  };
}

function timingShard(id: string, lane: string | null = 'W1'): Shard {
  const caseIds = tiny.campaign.shards.find((s) => s.id === id)?.cases ?? [];
  const records: JobRecord[] = [];
  const seeded = (round: number) => ({ ...IDENTITY, v8Seed: 100 + round });
  for (const caseId of caseIds) {
    records.push({
      type: 'check',
      impl: 'none',
      case: caseId,
      round: 0,
      status: 'UNSUPPORTED',
      declared: true,
      reason: 'parser only',
      identity: IDENTITY,
    });
    records.push({
      type: 'check',
      impl: 'bad',
      case: caseId,
      round: 0,
      status: 'FAIL',
      mismatch: { reason: 'value', row: 7, column: 3, expected: 'a,b', actual: 'a' },
      outputBytes: 1234,
      identity: IDENTITY,
    });
    for (const impl of ['ref', 'fast', 'cand', 'cand-aa', TINY_ARM]) {
      records.push({
        type: 'check',
        impl,
        case: caseId,
        round: 0,
        status: 'PASS',
        outputBytes: 1000,
        identity: IDENTITY,
      });
      for (let round = 1; round <= 10; round++) {
        const t = msOf(impl, caseId) * (1 + (JITTER[round - 1] ?? 0));
        records.push({
          type: 'time',
          impl,
          case: caseId,
          round,
          identity: seeded(round),
          measurement: SETTINGS,
          process: { execArgv: ['--expose-gc', ...v2.measurement.repeatedNodeFlags] },
          samplesMs: [t * 1.01, t, t * 0.99],
        });
      }
    }
  }
  for (let round = 1; round <= 10; round++) {
    records.push({
      type: 'empty',
      impl: '-',
      case: '-',
      round,
      identity: seeded(round),
      rssBytes: 40 * 2 ** 20,
      workerMaxRssBytes: 42 * 2 ** 20,
      peakRssMethod: 'linux-proc-self-status-VmHWM',
    });
  }
  const s = start(id, 'timing', caseIds, lane);
  const end = { type: 'end', status: 'complete', ...HASHES, source: s.source };
  return { file: `${id}.jsonl`, start: s, records, end } as unknown as Shard;
}

function memoryShard(): Shard {
  const primary = tiny.cases.map((c) => c.id);
  const records: JobRecord[] = [];
  for (let round = 1; round <= 5; round++) {
    const identity = { ...IDENTITY, v8Seed: 200 + round };
    for (const caseId of primary) {
      for (const impl of ['ref', 'fast', 'bad', 'cand', 'cand-aa', TINY_ARM]) {
        records.push({
          type: 'memory',
          impl,
          case: caseId,
          round,
          identity,
          peakRssMethod: 'linux-proc-self-status-VmHWM',
          loadedInputPeakRssBytes: 60 * 2 ** 20,
          peakRssBytes: 90 * 2 ** 20,
          rssBeforeParseBytes: 55 * 2 ** 20,
        });
      }
    }
    records.push({
      type: 'empty',
      impl: '-',
      case: '-',
      round,
      identity,
      rssBytes: 40 * 2 ** 20,
      workerMaxRssBytes: 42 * 2 ** 20,
      peakRssMethod: 'linux-proc-self-status-VmHWM',
    });
  }
  const s = start('M', 'memory', primary, 'W1');
  const end = { type: 'end', status: 'complete', ...HASHES, source: s.source };
  return { file: 'M.jsonl', start: s, records, end } as unknown as Shard;
}

describe('the W1 report', () => {
  const campaign = () => [timingShard('W1-rows'), timingShard('W1-records'), memoryShard()];

  it('renders W1 in its own section, losing cases first, with every FAIL and its first differing cell', () => {
    const s = scoreV2(tiny, tinyV2, HASHES, campaign());
    expect(s.issues).toEqual([]);
    const { text, complete } = renderV2(tiny, tinyV2, HASHES, campaign());
    expect(complete).toBe(true);
    expect(text).toMatch(/^# Benchmark report \(method v2, W1\): campaign w1$/m);
    expect(text).toMatch(/^## W1 \(unparse throughput\)$/m);
    expect(text).toMatch(/^## W1 cases \(behind first, then inconclusive, then ahead\)$/m);
    expect(text).toMatch(/^Ahead 0, behind 2, inconclusive 0 of 2 W1 cases\.$/m);
    expect(text).not.toMatch(/## Result|## Primary cases|## Small inputs|Overall against/);
    // The Papa-relative memory limit is a B1/B2 reported check; W1 has no threshold.
    expect(text).not.toMatch(/Reported check|limit 1\.10/);
    expect(text).toMatch(/^## Memory \(single write, input and output held/m);
    expect(text).toMatch(/\| W1-rows-a \| fast \| 0\.8/);
    expect(text).toContain('| impl | status | output bytes | median ms | min | max | processes |');
    expect(text).toContain(
      '| bad | FAIL ({"reason":"value","row":7,"column":3,"expected":"a,b","actual":"a"}) | 1234 |',
    );
    expect(text).toContain('| none | UNSUPPORTED (parser only) | - |');
  });

  it('reports the default-on arm in its own table, costliest case first, never as the fastest competitor or in the counts', () => {
    const s = scoreV2(tiny, tinyV2, HASHES, campaign());
    expect(s.issues).toEqual([]);
    // Faster than every competitor on W1-rows-a, yet the fastest competitor stays `fast`.
    expect(s.cases.map((r) => [r.case, r.competitor])).toEqual([
      ['W1-rows-a', 'fast'],
      ['W1-records-a', 'fast'],
    ]);
    expect(s.w1Arms?.map((r) => [r.case, r.impl, r.ratio?.ratio.toFixed(3)])).toEqual([
      ['W1-rows-a', TINY_ARM, '0.500'],
      ['W1-records-a', TINY_ARM, '1.200'],
    ]);
    const { text } = renderV2(tiny, tinyV2, HASHES, campaign());
    expect(text).toMatch(/^Ahead 0, behind 2, inconclusive 0 of 2 W1 cases\.$/m);
    const heading =
      '## Diagnostic arm cand (default-on) (arm time / cand time: above 1 means the arm is slower)';
    expect(text).toContain(heading);
    expect(text).toContain(
      '| case | cand (default-on) / cand [95%] | cand ms | cand (default-on) ms | cand peak MiB | cand (default-on) peak MiB |',
    );
    const table = text.slice(text.indexOf(heading));
    const records = table.indexOf('| W1-records-a | 1.200 [1.200, 1.200] |');
    const rows = table.indexOf('| W1-rows-a | 0.500 [0.500, 0.500] |');
    expect(records).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(records);
    expect(table).toMatch(
      /^\| W1-rows-a \| 0\.500 \[0\.500, 0\.500\] \| [\d.]+ \| [\d.]+ \| 90\.0 \| 90\.0 \|$/m,
    );
    expect(text).toContain('{"omitEscapeFormulae":true}');
    expect(text).toContain('`escapeFormulae: false`');
  });

  it('the default-on arm must pass its check and be measured: otherwise the W1 campaign is incomplete', () => {
    const failing = campaign();
    const rec = failing[0]?.records.find(
      (r) => r.type === 'check' && r.impl === TINY_ARM && r.case === 'W1-rows-a',
    );
    if (rec) rec.status = 'FAIL';
    expect(scoreV2(tiny, tinyV2, HASHES, failing).issues).toContain(
      `${TINY_ARM} @ W1-rows-a: FAIL`,
    );
    const missing = campaign();
    const [rowsShard] = missing;
    if (rowsShard) rowsShard.records = rowsShard.records.filter((r) => r.impl !== TINY_ARM);
    expect(scoreV2(tiny, tinyV2, HASHES, missing).missingPairs).toContain(
      `${TINY_ARM} @ W1-rows-a: no correctness record`,
    );
  });

  it('never mixes W1 with B1/B2/S1 runs', () => {
    const mixed = [timingShard('W1-rows', null), timingShard('W1-records'), memoryShard()];
    expect(scoreV2(tiny, tinyV2, HASHES, mixed).issues.join('\n')).toMatch(
      /W1-rows\.jsonl \(W1-rows\): a B1\/B2\/S1 run in a W1 report/,
    );
    const asB = { ...tiny, cases: tiny.cases.map((c) => ({ ...c, lane: 'B1' as const })) };
    expect(scoreV2(asB, tinyV2, HASHES, campaign()).issues.join('\n')).toMatch(
      /a W1 run in a B1\/B2\/S1 report/,
    );
  });
});

// The candidate's W1 function passes escapeFormulae: false, whatever the main entry's default is;
// the diagnostic arm csv-engine (default-on) is the same bundle calling unparse without
// escapeFormulae.
describe('the W1 pin and the default-on arm', () => {
  it('the candidate passes escapeFormulae: false; the arm passes no escapeFormulae at all', () => {
    const seen: object[] = [];
    const spy: CandidateUnparse = (data, config) => {
      seen.push(config);
      return unparse(data, config);
    };
    const adapter = candidateAdapter(parse, spy);
    const d: Dialect = { delimiter: ';', quote: "'", newline: '\r\n' };
    const arm = v2.w1.arms[ARM] ?? {};
    const write = (
      ...args: [string[][] | Array<Record<string, string>>, string[] | null, object]
    ) => adapter.W1?.(args[0], args[1], d, args[2] as Record<string, unknown>) as string;
    expect(write([['=1', 'a']], null, {})).toBe('=1;a');
    write([{ x: '1' }], ['x'], {});
    write([['=1', 'a']], null, arm);
    write([{ x: '1' }], ['x'], arm);
    const dialect = { delimiter: ';', newline: '\r\n', quoteChar: "'" };
    expect(seen).toStrictEqual([
      { ...dialect, escapeFormulae: false },
      { ...dialect, columns: ['x'], escapeFormulae: false },
      dialect,
      { ...dialect, columns: ['x'] },
    ]);
  });

  it('manifest-v2.json: one W1 arm, validated like the S1 arms', () => {
    expect(v2.w1.arms).toStrictEqual({ [ARM]: { omitEscapeFormulae: true } });
    const issues = (change: (m: ManifestV2) => void) => {
      const copy = structuredClone(v2);
      change(copy);
      return manifestV2Issues(copy, base, V1_SHA).join('\n');
    };
    for (const taken of ['papaparse', 'csv-engine', 'csv-engine-aa']) {
      expect(issues((m) => (m.w1.arms[taken] = {}))).toMatch(
        new RegExp(`w1: arm ${taken} is already an implementation or the candidate`),
      );
    }
    expect(issues((m) => (m.w1.arms[ARM] = [] as unknown as Record<string, unknown>))).toMatch(
      /w1: arm csv-engine \(default-on\): options must be an object/,
    );
  });

  it('joins the candidate on every W1 case of a campaign, from its bundle; never a calibration, B1/B2 or S1, never a competitor', () => {
    const pairs = expectedPairsV2(w1, v2, 'campaign');
    expect(pairs.filter((p) => p.impl === ARM)).toStrictEqual(
      w1.cases.map((c) => ({ impl: ARM, case: c.id, expect: 'measure' })),
    );
    expect(expectedPairsV2(w1, v2, 'calibration').some((p) => p.impl === ARM)).toBe(false);
    expect(expectedPairsV2(base, v2, 'campaign').some((p) => p.impl === ARM)).toBe(false);
    const s1 = s1Manifest(base, v2);
    expect(expectedPairsV2(s1, v2, 'campaign').some((p) => p.impl === ARM)).toBe(false);
    expect(w1.implementations.map((i) => i.id)).not.toContain(ARM);
    expect(bundleArms(w1, v2, 'W1', 'dist/index.js', 'twin/index.js', 'sha').entries).toStrictEqual(
      { 'csv-engine': 'dist/index.js', 'csv-engine-aa': 'twin/index.js', [ARM]: 'dist/index.js' },
    );
    expect(Object.keys(bundleArms(s1, v2, 'S1', 'd', 't', 's').entries)).not.toContain(ARM);
  });

  it('bench/ab.ts --lane W1 runs arms a and b only (the arm is not in an A/B)', () => {
    const arm = (name: string) => ({
      commit: name,
      distSha256: name,
      dir: name,
      distDir: name,
      entry: fileURLToPath(import.meta.url),
    });
    const options = abRunOptions({
      id: 'w1-ab',
      lane: 'W1',
      manifest: w1,
      v2,
      caseIds: w1.cases.map((c) => c.id),
      targets: ['W1-rows-simple-1MiB'],
      seed: 1,
      processes: 10,
      budgetMinutes: 1,
      dryRunOnly: true,
      pinning: null,
      outFile: 'unused',
      copies: [],
      a: arm('a'),
      b: arm('b'),
    });
    expect(new Set(options.pairs.map((p) => p.impl))).toEqual(new Set(['a', 'b']));
    expect(options.pairs).toHaveLength(48);
    expect(Object.keys(options.entries)).toEqual(['a', 'b']);
  });

  describe('bench/worker.ts from a bundle (check mode, real processes)', () => {
    const ROOT = fileURLToPath(new URL('..', import.meta.url));
    const root = scratch('w1-pin-root');
    cpSync(join(ROOT, 'bench'), join(root, 'bench'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
    // The check reads the output back with Papa Parse, a package.
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'dist', 'index.js'),
      [
        `export { parse } from ${JSON.stringify(join(ROOT, 'src', 'parse.ts'))};`,
        `import { unparse as real } from ${JSON.stringify(join(ROOT, 'src', 'unparse.ts'))};`,
        'export function unparse(data, config) {',
        '  process.stderr.write(`unparse ${JSON.stringify(config)}\\n`);',
        '  return real(data, config);',
        '}',
        '',
      ].join('\n'),
    );
    const worker = (impl: string, caseId: string) => {
      const r = spawnSync(
        process.execPath,
        [
          join(root, 'bench', 'worker.ts'),
          ...['--method', 'v2', '--mode', 'check', '--impl', impl, '--case', caseId],
          ...['--load', 'entry', '--entry', join(root, 'dist', 'index.js')],
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      return {
        record: JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>,
        // Node 22 may also print a warning about type stripping.
        calls: r.stderr.split('\n').filter((line) => line.startsWith('unparse ')),
      };
    };
    const pinned =
      'unparse {"delimiter":",","newline":"\\n","quoteChar":"\\"","escapeFormulae":false}';

    it('the candidate, the A/A arm and A/B arms a and b write with escapeFormulae: false; the arm without it; all PASS', () => {
      for (const impl of ['csv-engine', 'csv-engine-aa', 'a', 'b']) {
        const { record, calls } = worker(impl, 'W1-rows-simple-1MiB');
        expect([impl, record.status, record.options]).toStrictEqual([impl, 'PASS', {}]);
        // The check writes once and its probe (method v2) writes again, all with the pin.
        expect(calls.length).toBeGreaterThan(0);
        expect(new Set(calls)).toEqual(new Set([pinned]));
      }
      const { record, calls } = worker(ARM, 'W1-rows-simple-1MiB');
      expect(record).toMatchObject({
        impl: ARM,
        status: 'PASS',
        options: { omitEscapeFormulae: true },
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls)).toEqual(
        new Set(['unparse {"delimiter":",","newline":"\\n","quoteChar":"\\""}']),
      );
      const records = worker(ARM, 'W1-records-simple-1MiB');
      expect(records.record).toMatchObject({ status: 'PASS' });
      expect(records.calls.length).toBeGreaterThan(0);
      for (const call of records.calls) {
        expect(call).toMatch(
          /^unparse \{"delimiter":",","newline":"\\n","quoteChar":"\\"","columns":\[.*\]\}$/,
        );
      }
    }, 60_000);
  });
});
