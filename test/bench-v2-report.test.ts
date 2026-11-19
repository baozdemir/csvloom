import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scratchDir } from './scratch.ts';
import {
  manifestSha256,
  readManifest,
  readManifestV2,
  readMethod,
  type Manifest,
  type ManifestPub,
  type ManifestV2,
} from '../bench/manifest.ts';
import {
  bootstrapRatio,
  CALIBRATION_FAILED,
  exitCodeV2,
  holm,
  pairByRound,
  pairedBootstrapRatio,
  parseShard,
  renderAb,
  renderV2,
  scoreAb,
  scoreV2,
  type JobRecord,
  type Shard,
} from '../bench/report.ts';

// Method v2 report: bootstrap intervals on process medians, Holm, the
// ahead/behind/inconclusive rule against the A/A band, the overall geometric
// mean, memory, completeness, determinism, and the A/B keep rule.

const realV2 = readManifestV2();
const HASHES = { manifestSha256: 'manifest-sha', manifestV2Sha256: 'manifest-v2-sha' };
const family = { seed: 1, description: 'test' };
const manifest: Manifest = {
  schemaVersion: 2,
  status: 'test',
  runtime: { node: '24.22.1', flags: ['--expose-gc'] },
  reference: 'ref',
  candidate: 'cand',
  candidateDeferredLanes: {},
  consensus: ['ref'],
  competitors: { ref: '1.0.0', fast: '2.0.0' },
  implementations: [
    { id: 'ref', package: 'ref', lanes: ['B1', 'B2'] },
    { id: 'fast', package: 'fast', lanes: ['B1', 'B2'] },
  ],
  unsupported: [],
  unavailable: [],
  measurement: {
    warmupMs: 500,
    minWarmupOps: 3,
    samples: 7,
    minSampleMs: 250,
    repetitions: 3,
    s1ChunkBytes: 65536,
    orderSeed: 1,
  },
  scoring: {
    inconclusiveSpread: 0.1,
    reportedChecks: { smallInputVsReferenceMax: 0.1, peakMemoryVsReferenceMax: 0.1 },
  },
  limits: {
    rssLimitBytes: 1,
    rssPollMs: 1,
    diskFloorBytes: 1,
    tempCapBytes: 1,
    tempCapExpandedBytes: 1,
    expandCapAtFreeBytes: 1,
  },
  campaign: {
    maxShardMinutes: 30,
    maxCampaignMinutes: 120,
    shards: [
      { id: 'S1', cases: ['B1-a', 'B1-small'] },
      { id: 'S2', cases: ['B2-a'] },
    ],
    coldStartShard: 'S1',
    coldStartCase: 'B1-a',
  },
  families: {
    simple: family,
    'quote-heavy': family,
    multiline: family,
    wide: family,
    unicode: family,
    'long-field': family,
  },
  cases: [
    { id: 'B1-a', lane: 'B1', class: 'primary', weight: 1 },
    { id: 'B2-a', lane: 'B2', class: 'primary', weight: 1 },
    { id: 'B1-small', lane: 'B1', class: 'regression', weight: 0 },
  ],
};
// The scoring tests are written for 10 rounds; the real manifest's process count is pinned in bench-v2-run.test.ts.
const v2: ManifestV2 = {
  ...realV2,
  measurement: { ...realV2.measurement, processes: 10 },
  aa: { impl: 'cand-aa', distDir: 'twin' },
};

// Ten per-process deviations within 1%, the same multiset for every arm unless a test says otherwise.
const JITTER = [-0.008, 0.004, 0, 0.006, -0.003, 0.009, -0.006, 0.002, -0.001, 0.007];
type Ms = (impl: string, caseId: string, round: number) => number;
const steady =
  (base: Record<string, number>, shift: Record<string, number> = {}): Ms =>
  (impl, _case, round) =>
    (base[impl] ?? 10) * (1 + (JITTER[(round - 1 + (shift[impl] ?? 0)) % 10] ?? 0));

const IDENTITY = {
  v8Seed: 1000,
  harnessCommit: 'c0ffee',
  commit: 'c0ffee',
  distSha256: 'dist-sha',
  node: 'v24.22.1',
  cpuModel: 'AMD EPYC 7B12',
  kernel: '6.1.0-54-cloud-amd64',
  tasksetMask: '3',
  padLength: 100,
  checkoutCopy: 1,
  checkoutPath: '/copies/c2/d/e',
};
/** The identity of a process of a round: every round has its own V8 seed, shared by all arms. */
const seeded = (round: number) => ({ ...IDENTITY, v8Seed: 1000 + round });
const SETTINGS = { samples: 3, minSampleMs: 250, warmupMs: 500, minWarmupOps: 3 };
// What a worker reports of its own start: a process that repeats the operation carries the manifest's flags.
const REPEATED = { execArgv: ['--expose-gc', ...realV2.measurement.repeatedNodeFlags] };
const ONE_PARSE = { execArgv: ['--expose-gc'] };
const PEAK = { ref: 100, fast: 80, cand: 90, 'cand-aa': 90 } as Record<string, number>;

interface Build {
  kind?: 'campaign' | 'calibration';
  ms?: Ms;
  processes?: number;
}

function shard(id: string, build: Build = {}): Shard {
  const kind = build.kind ?? 'campaign';
  const ms = build.ms ?? steady({ ref: 20, fast: 15, cand: 10, 'cand-aa': 10 });
  const caseIds = manifest.campaign.shards.find((s) => s.id === id)?.cases ?? [];
  const records: JobRecord[] = [];
  for (const caseId of caseIds) {
    const primary = manifest.cases.find((c) => c.id === caseId)?.class === 'primary';
    const impls =
      kind === 'calibration'
        ? primary
          ? ['cand', 'cand-aa']
          : []
        : primary
          ? ['ref', 'fast', 'cand', 'cand-aa']
          : ['ref', 'cand'];
    for (const impl of impls) {
      records.push({
        type: 'check',
        impl,
        case: caseId,
        round: 0,
        status: 'PASS',
        identity: IDENTITY,
      });
      for (let round = 1; round <= (build.processes ?? 10); round++) {
        const t = ms(impl, caseId, round);
        records.push({
          type: 'time',
          impl,
          case: caseId,
          round,
          identity: seeded(round),
          measurement: SETTINGS,
          process: REPEATED,
          samplesMs: [t * 1.01, t, t * 0.99],
        });
      }
    }
  }
  for (let round = 1; round <= (build.processes ?? 10); round++) {
    records.push({
      type: 'empty',
      impl: '-',
      case: '-',
      round,
      identity: seeded(round),
      rssBytes: 40 * 2 ** 20,
      workerMaxRssBytes: 42 * 2 ** 20,
      peakRssMethod: 'linux-proc-self-status-VmHWM',
      maxRssKiB: 110 * 1024,
    });
  }
  const start = {
    type: 'start',
    method: 'v2',
    kind,
    phase: 'timing',
    campaignId: 'c1',
    shardId: id,
    seed: 20261110,
    plannedCases: kind === 'calibration' ? caseIds.filter((c) => c !== 'B1-small') : caseIds,
    measurement: { ...v2.measurement, processes: build.processes ?? 10 },
    filters: { cases: null, impls: null, processes: null, memoryProcesses: null },
    runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
    packages: { ref: '1.0.0', fast: '2.0.0' },
    ...HASHES,
    source: { gitCommit: 'c0ffee', sha256: 'source' },
    candidate: { commit: 'c0ffee', distSha256: 'dist-sha', aaImpl: 'cand-aa' },
    pinning: { cpu: 3, siblings: [3, 7], runnerCpus: [2] },
    environment: { cpu: 'AMD EPYC 7B12', cpuCount: 8, totalMemBytes: 8, osRelease: '6.1.0' },
  };
  const end = { type: 'end', status: 'complete', ...HASHES, source: start.source };
  return { file: `${id}.jsonl`, start, records, end } as unknown as Shard;
}

// The memory phase: its own run after the timing shards, 5 rounds of one memory
// process per primary pair and one empty process; no checks and no timings.
function memoryPhase(): Shard {
  const records: JobRecord[] = [];
  const primary = manifest.cases.filter((c) => c.class === 'primary').map((c) => c.id);
  for (let round = 1; round <= 5; round++) {
    for (const caseId of primary) {
      for (const impl of ['ref', 'fast', 'cand', 'cand-aa']) {
        records.push({
          type: 'memory',
          impl,
          case: caseId,
          round,
          identity: seeded(round),
          peakRssMethod: 'linux-proc-self-status-VmHWM',
          loadedInputPeakRssBytes: 60 * 2 ** 20,
          peakRssBytes: ((PEAK[impl] ?? 100) + round - 3) * 2 ** 20,
          rssBeforeParseBytes: 55 * 2 ** 20,
          maxRssKiB: 120 * 1024,
        });
      }
    }
    records.push({
      type: 'empty',
      impl: '-',
      case: '-',
      round,
      identity: seeded(round),
      rssBytes: 40 * 2 ** 20,
      workerMaxRssBytes: 42 * 2 ** 20,
      peakRssMethod: 'linux-proc-self-status-VmHWM',
      maxRssKiB: 110 * 1024,
    });
  }
  const timing = shard('S1');
  const start = { ...timing.start, phase: 'memory', shardId: 'M', plannedCases: primary };
  return { file: 'M.jsonl', start, records, end: timing.end };
}
/** S1, S2 and, for a campaign, the memory phase M; a calibration has none. */
const campaign = (build: Build = {}) =>
  build.kind === 'calibration'
    ? [shard('S1', build), shard('S2', build)]
    : [shard('S1', build), shard('S2', build), memoryPhase()];
const score = (shards: Shard[]) => scoreV2(manifest, v2, HASHES, shards);
const without = (s: Shard, drop: (r: JobRecord) => boolean): Shard => ({
  ...s,
  records: s.records.filter((r) => !drop(r)),
});

describe('Holm correction', () => {
  it('rejects step-down on a known set and stops at the first failure', () => {
    // Sorted 0.005, 0.01, 0.03, 0.04 against 0.0125, 0.0167, 0.025, 0.05: the third fails.
    expect(holm([0.01, 0.04, 0.03, 0.005], 0.05)).toEqual([true, false, false, true]);
    expect(holm([0.001, 0.01, 0.02, 0.03, 0.04], 0.05)).toEqual([true, true, false, false, false]);
    expect(holm([0.04, 0.04], 0.05)).toEqual([false, false]);
    expect(holm([0.02, 0.02], 0.05)).toEqual([true, true]);
    expect(holm([], 0.05)).toEqual([]);
  });

  it('with 24 cases the smallest p must be at most 0.05 / 24', () => {
    const p = Array.from({ length: 24 }, () => 1);
    p[5] = 0.0021;
    expect(holm(p, 0.05)[5]).toBe(false);
    p[5] = 0.002;
    expect(holm(p, 0.05)[5]).toBe(true);
  });
});

describe('bootstrap of a ratio of medians', () => {
  it('is the ratio of the medians of the process medians', () => {
    const r = bootstrapRatio([20, 22, 21], [10, 11, 10.5], 1, 10000, 0.95);
    expect(r.ratio).toBe(21 / 10.5);
    expect(r.replicates).toHaveLength(10000);
  });

  it('is deterministic for a seed and independent of the order of the processes', () => {
    const a = bootstrapRatio([3, 1, 2, 5, 4], [2, 2.5, 3, 1.5, 2.2], 7, 10000, 0.95);
    const b = bootstrapRatio([5, 4, 3, 2, 1], [1.5, 3, 2.2, 2, 2.5], 7, 10000, 0.95);
    expect(b).toEqual(a);
    const c = bootstrapRatio([3, 1, 2, 5, 4], [2, 2.5, 3, 1.5, 2.2], 8, 10000, 0.95);
    expect(c.ratio).toBe(a.ratio);
    expect(c.replicates).not.toEqual(a.replicates);
  });

  it('a two-process arm has the interval its three possible medians give', () => {
    // Median of a resample of [1, 3] is 1, 2 or 3 with probability 1/4, 1/2, 1/4.
    const r = bootstrapRatio([1, 3], [2, 2], 3, 10000, 0.95);
    expect(new Set(r.replicates)).toEqual(new Set([0.5, 1, 1.5]));
    expect([r.lo, r.hi]).toEqual([0.5, 1.5]);
    expect(r.p).toBe(1);
    const share = r.replicates.filter((x) => x === 1).length / 10000;
    expect(share).toBeGreaterThan(0.48);
    expect(share).toBeLessThan(0.52);
  });

  it('identical arms give ratio 1 with p = 1; a separated pair gives the smallest p', () => {
    const same = bootstrapRatio([10, 10, 10], [10, 10, 10], 1, 10000, 0.95);
    expect(same).toMatchObject({ ratio: 1, lo: 1, hi: 1, p: 1 });
    const apart = bootstrapRatio([20, 21, 22], [10, 11, 12], 1, 10000, 0.95);
    expect(apart.p).toBe(2 / 10001);
    expect(apart.lo).toBeGreaterThan(1);
  });
});

describe('pairing arms by round', () => {
  // A process may run in one of two modes (here near 6.9 ms or near 7.6 ms). With
  // one V8 seed per round the mode belongs to the round, so both arms of a round share it.
  const mode = [6.9, 7.6, 7.6, 6.9, 6.9, 7.6, 6.9, 7.6, 7.6, 6.9];
  const a = mode.map((m, i) => m * (1 + (JITTER[i] ?? 0) / 10));
  const b = mode.map((m, i) => m * (1 + (JITTER[(i + 3) % 10] ?? 0) / 10));
  const halfWidth = (r: { lo: number; hi: number }) => (r.hi - r.lo) / 2;

  it('a bimodal A/A whose modes are tied to the round is narrow paired and wide unpaired', () => {
    const paired = pairedBootstrapRatio(a, b, 5, 10000, 0.95);
    const unpaired = bootstrapRatio(a, b, 5, 10000, 0.95);
    expect(paired.ratio).toBe(unpaired.ratio);
    expect(paired.ratio).toBeCloseTo(1, 2);
    expect(halfWidth(paired)).toBeLessThan(0.002);
    expect(halfWidth(unpaired)).toBeGreaterThan(0.04);
    expect(paired.lo).toBeLessThanOrEqual(1);
    expect(paired.hi).toBeGreaterThanOrEqual(1);
  });

  it('modes that are not tied to the round do not cancel: pairing is not a noise filter', () => {
    const shuffled = [7.6, 7.6, 6.9, 7.6, 6.9, 6.9, 7.6, 6.9, 6.9, 7.6];
    const other = shuffled.map((m, i) => m * (1 + (JITTER[(i + 3) % 10] ?? 0) / 10));
    expect(halfWidth(pairedBootstrapRatio(a, other, 5, 10000, 0.95))).toBeGreaterThan(0.04);
  });

  it('is deterministic, keeps a real difference, and uses the same rounds for the same seed', () => {
    const slow = b.map((x) => x * 1.05);
    const r = pairedBootstrapRatio(slow, a, 9, 10000, 0.95);
    expect(pairedBootstrapRatio(slow, a, 9, 10000, 0.95)).toEqual(r);
    expect(r.ratio).toBeCloseTo(1.05, 2);
    expect(r.lo).toBeGreaterThan(1.04);
    expect(r.hi).toBeLessThan(1.06);
    expect(r.p).toBe(2 / 10001);
    // Same seed and round count: replicate k resamples the same rounds, so a doubled arm doubles every replicate.
    const doubled = pairedBootstrapRatio(
      slow.map((x) => 2 * x),
      a,
      9,
      10000,
      0.95,
    );
    expect(
      doubled.replicates.every((x, k) => Math.abs(x - 2 * (r.replicates[k] ?? 0)) < 1e-12),
    ).toBe(true);
    expect(() => pairedBootstrapRatio([1, 2], [1], 1, 1000, 0.95)).toThrow(/one value per round/);
  });

  it('pairByRound keeps the rounds both arms have, in round order, and names the others', () => {
    const top = new Map([
      [3, 30],
      [1, 10],
      [2, 20],
    ]);
    const bottom = new Map([
      [2, 2],
      [4, 4],
      [1, 1],
    ]);
    expect(pairByRound(top, bottom)).toEqual({ top: [10, 20], bottom: [1, 2], unpaired: [3, 4] });
  });

  it('a campaign with round-tied modes passes the A/A check that the unpaired method would fail', () => {
    const ms: Ms = (impl, _case, round) =>
      (mode[round - 1] ?? 7) *
      (impl === 'ref' ? 2 : impl === 'fast' ? 1.5 : 1) *
      (1 + (JITTER[(round + (impl === 'cand-aa' ? 3 : 0)) % 10] ?? 0) / 10);
    const s = score(campaign({ ms }));
    expect(s.complete).toBe(true);
    expect(s.aaCheck.pass).toBe(true);
    expect(s.aaCheck.maxHalfWidth).toBeLessThan(0.002);
    expect(s.cases[0]?.ratio?.ratio).toBeCloseTo(1.5, 2);
    expect(s.cases[0]?.classification).toBe('ahead');
    // The cases of one shard are resampled over the same rounds; here both shards hold one case each.
    expect(s.overall?.ratio).toBeCloseTo(1.5, 2);
  });

  it('a round that lacks an arm is excluded from pairing and reported', () => {
    const [s1, s2, m] = campaign();
    const cut = without(
      s1 as Shard,
      (r) => r.type === 'time' && r.impl === 'cand-aa' && r.case === 'B1-a' && r.round === 6,
    );
    const s = score([cut, s2 as Shard, m as Shard]);
    expect(s.complete).toBe(false);
    expect(s.issues).toContain(
      'cand-aa / cand @ B1-a (aa): rounds 6 lack one arm and are excluded from pairing',
    );
    expect(s.cases[0]?.aa?.ratio).toBeCloseTo(1, 2);
  });

  it('every process of a round must have run with one V8 seed, and rounds must not share one', () => {
    const [s1, s2, m] = campaign();
    const reseed = (pick: (r: JobRecord) => boolean, v8Seed: number | null): Shard => ({
      ...(s1 as Shard),
      records: (s1 as Shard).records.map((r) =>
        pick(r) ? { ...r, identity: { ...(r.identity as object), v8Seed } } : r,
      ),
    });
    const issuesOf = (s: Shard) => score([s, s2 as Shard, m as Shard]).issues.join('\n');
    expect(score([s1 as Shard, s2 as Shard, m as Shard]).issues).toEqual([]);
    expect(
      issuesOf(reseed((r) => r.type === 'time' && r.impl === 'fast' && r.round === 3, 77)),
    ).toMatch(/S1\.jsonl \(S1\): round 3 did not run with one V8 seed/);
    expect(issuesOf(reseed((r) => r.round === 5, 1004))).toMatch(
      /S1\.jsonl \(S1\): rounds 4 and 5 share a V8 seed/,
    );
    expect(issuesOf(reseed((r) => r.round === 2, null))).toMatch(
      /identity lacks v8Seed[^]*round 2 did not run with one V8 seed/,
    );
  });
});

describe('a complete campaign', () => {
  it('scores each primary case against the fastest valid competitor with its interval', () => {
    const s = score(campaign());
    expect(s.issues).toEqual([]);
    expect(s.complete).toBe(true);
    expect(s.cases.map((c) => c.case)).toEqual(['B1-a', 'B2-a']);
    for (const c of s.cases) {
      expect(c.competitor).toBe('fast');
      expect(c.ratio?.ratio).toBeCloseTo(1.5, 10);
      expect(c.ratio?.lo).toBeGreaterThan(1.48);
      expect(c.ratio?.hi).toBeLessThan(1.52);
      expect(c.papa?.ratio).toBeCloseTo(2, 10);
      expect(c.aa?.ratio).toBeCloseTo(1, 10);
      expect(c.aa?.lo).toBeLessThanOrEqual(1);
      expect(c.aa?.hi).toBeGreaterThanOrEqual(1);
      expect(c.significant).toBe(true);
      expect(c.classification).toBe('ahead');
    }
    expect(s.counts).toEqual({ ahead: 2, behind: 0, inconclusive: 0 });
    expect(s.overall?.ratio).toBeCloseTo(1.5, 10);
    expect(s.overall?.lo).toBeGreaterThan(1.48);
    expect(s.overall?.hi).toBeLessThan(1.52);
    expect(s.b1?.ratio).toBeCloseTo(1.5, 10);
    expect(s.papaOverall?.ratio).toBeCloseTo(2, 10);
  });

  it('the overall is the geometric mean of the case ratios', () => {
    const ms: Ms = (impl, caseId, round) =>
      steady({ ref: 30, fast: caseId === 'B1-a' ? 15 : 20, cand: 10, 'cand-aa': 10 })(
        impl,
        caseId,
        round,
      );
    const s = score(campaign({ ms }));
    expect(s.cases.map((c) => c.ratio?.ratio)).toEqual([
      expect.closeTo(1.5, 10),
      expect.closeTo(2, 10),
    ]);
    expect(s.overall?.ratio).toBeCloseTo(Math.sqrt(3), 10);
    expect(s.b1?.ratio).toBeCloseTo(1.5, 10);
    expect(s.b2?.ratio).toBeCloseTo(2, 10);
  });

  it('is behind when the candidate is slower beyond the A/A band', () => {
    const s = score(campaign({ ms: steady({ ref: 20, fast: 8, cand: 10, 'cand-aa': 10 }) }));
    expect(s.cases.map((c) => c.classification)).toEqual(['behind', 'behind']);
    expect(s.cases[0]?.ratio?.hi).toBeLessThan(s.cases[0]?.aa?.lo ?? 0);
    expect(s.counts).toEqual({ ahead: 0, behind: 2, inconclusive: 0 });
  });

  it('a synthetic A/A with zero difference classifies everything inconclusive', () => {
    const s = score(campaign({ ms: steady({ ref: 10, fast: 10, cand: 10, 'cand-aa': 10 }) }));
    expect(s.complete).toBe(true);
    for (const c of s.cases) {
      expect(c.ratio).toMatchObject({ ratio: 1, p: 1 });
      expect(c.significant).toBe(false);
      expect(c.classification).toBe('inconclusive');
    }
    expect(s.counts).toEqual({ ahead: 0, behind: 0, inconclusive: 2 });
    expect(s.overall?.ratio).toBe(1);
  });

  it('a significant ratio inside the A/A band is inconclusive', () => {
    // The competitor is 1.2% slower in every process, but the A/A copy reads up to 3% off.
    const wide = [0.03, -0.03, 0.028, -0.028, 0.02, -0.02, 0.03, -0.03, 0.025, -0.025];
    const ms: Ms = (impl, _case, round) =>
      impl === 'cand-aa'
        ? 10 * (1 + (wide[round - 1] ?? 0))
        : impl === 'fast'
          ? 10.12 * (1 + (JITTER[round - 1] ?? 0) / 10)
          : impl === 'cand'
            ? 10 * (1 + (JITTER[round - 1] ?? 0) / 10)
            : 20;
    const [c] = score(campaign({ ms })).cases;
    expect(c?.ratio?.ratio).toBeCloseTo(1.012, 3);
    expect(c?.significant).toBe(true);
    expect(c?.ratio?.lo).toBeGreaterThan(1);
    expect(c?.ratio?.lo).toBeLessThan(c?.aa?.hi ?? 0);
    expect(c?.classification).toBe('inconclusive');
  });

  it('memory: candidate against the reference and against the lowest-peak competitor, with the empty-process baseline', () => {
    const s = score(campaign());
    expect(s.memory.baseline).toEqual({ rssBytes: 40 * 2 ** 20, peakRssBytes: 42 * 2 ** 20 });
    expect(s.memory.method).toBe('linux-proc-self-status-VmHWM');
    expect(s.memory.rows[0]).toMatchObject({
      case: 'B1-a',
      candidatePeakBytes: 90 * 2 ** 20,
      referencePeakBytes: 100 * 2 ** 20,
      leanest: 'fast',
      leanestPeakBytes: 80 * 2 ** 20,
    });
    expect(s.memory.rows[0]?.vsReference).toBeCloseTo(0.9, 10);
    expect(s.memory.rows[0]?.vsLeanest).toBeCloseTo(1.125, 10);
    expect(s.memory.check).toMatchObject({ limit: 1.1, met: true });
    expect(s.memory.check.value).toBeCloseTo(0.9, 10);
  });

  it('small inputs: reference over candidate with its interval', () => {
    const s = score(campaign());
    expect(s.smallInput).toHaveLength(1);
    expect(s.smallInput[0]?.case).toBe('B1-small');
    expect(s.smallInput[0]?.ratio?.ratio).toBeCloseTo(2, 10);
  });

  it('the A/A noise check: at most 3 intervals may exclude 1, and both half-width limits hold', () => {
    expect(score(campaign()).aaCheck).toMatchObject({ misses: [], unmeasured: [], pass: true });
    // The copy reads 5% slower on both cases: 2 intervals exclude 1, which the limit of 3 allows.
    const off: Ms = (impl, c, round) =>
      steady({ ref: 20, fast: 15, cand: 10, 'cand-aa': 10.5 })(impl, c, round);
    expect(score(campaign({ ms: off })).aaCheck).toMatchObject({
      misses: ['B1-a', 'B2-a'],
      pass: true,
    });
    const strict = { ...v2, calibration: { ...v2.calibration, maxIntervalsExcludingOne: 1 } };
    const failed = scoreV2(manifest, strict, HASHES, campaign({ ms: off }));
    expect(failed.aaCheck).toMatchObject({ misses: ['B1-a', 'B2-a'], pass: false });
    expect(renderV2(manifest, strict, HASHES, campaign({ ms: off })).text).toMatch(
      /Noise check: 2 of 2 intervals exclude 1\.000 \(at most 1: B1-a, B2-a\); largest half-width \d\.\d\d% \(limit 2\.50%\); median half-width \d\.\d\d% \(limit 1\.50%\): FAIL\./,
    );
    const wide = [0.06, -0.06, 0.05, -0.05, 0.04, -0.04, 0.06, -0.06, 0.05, -0.05];
    const noisy: Ms = (impl, _c, round) =>
      impl === 'cand-aa' ? 10 * (1 + (wide[round - 1] ?? 0)) : 10;
    const check = score(campaign({ ms: noisy })).aaCheck;
    expect(check.misses).toEqual([]);
    expect(check.maxHalfWidth).toBeGreaterThan(0.025);
    expect(check.pass).toBe(false);
  });
});

describe('one peak-RSS method per campaign', () => {
  // The memory phase knows no correctness results, so it also runs a competitor whose check
  // failed; that process ends blocked and its record holds no reading and no method
  // (for example web-csv-toolbox on the 32 MiB B2 cases).
  it('ignores blocked memory records, which hold no reading', () => {
    const [s1, s2] = campaign();
    const failed = (s: Shard): Shard => ({
      ...s,
      records: s.records.flatMap((r) =>
        r.impl !== 'fast' || r.case !== 'B2-a'
          ? [r]
          : r.type === 'check'
            ? [{ ...r, status: 'FAIL' }]
            : r.type === 'time'
              ? []
              : [r],
      ),
    });
    const m = memoryPhase();
    const blocked: Shard = {
      ...m,
      records: m.records.map((r) =>
        r.type === 'memory' && r.impl === 'fast' && r.case === 'B2-a'
          ? {
              type: 'memory',
              impl: 'fast',
              case: 'B2-a',
              round: r.round,
              identity: r.identity,
              wallMs: 277,
              peakPolledRssBytes: 0,
              status: 'BLOCKED',
              blocked: 'error',
              detail: 'RangeError: Buffer size exceeded',
            }
          : r,
      ),
    };
    const s = score([failed(s1 as Shard), failed(s2 as Shard), blocked]);
    expect(s.issues).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it('still rejects readings taken by two methods', () => {
    const [s1, s2] = campaign();
    const m = memoryPhase();
    const mixed: Shard = {
      ...m,
      records: m.records.map((r) =>
        r.type === 'memory' && r.impl === 'ref' && r.round === 1
          ? { ...r, peakRssMethod: 'getrusage-maxRSS' }
          : r,
      ),
    };
    expect(score([s1 as Shard, s2 as Shard, mixed]).issues).toContain(
      'memory records use different peak-RSS methods',
    );
  });
});

// Method v2's Node flags: a process that repeats the operation runs with the manifest's Node flags and a
// one-parse process without them; the report reads what each worker reported (execArgv).
const reflag = (s: Shard, pick: (r: JobRecord) => boolean, process: object | undefined): Shard => ({
  ...s,
  records: s.records.map((r) => (r.type === 'time' && pick(r) ? { ...r, process } : r)),
});

/** The shard as a run from before the flags recorded it: no repeatedNodeFlags in its start record. */
const withoutFlags = (s: Shard): Shard => {
  const recorded = (s.start as unknown as { measurement: Record<string, unknown> }).measurement;
  const measurement = Object.fromEntries(
    Object.entries(recorded).filter(([field]) => field !== 'repeatedNodeFlags'),
  );
  return { ...s, start: { ...s.start, measurement } as unknown as Shard['start'] };
};

describe('per-pair timing settings', () => {
  // A process that took one parse per sample with no untimed operations may hold more samples
  // (the runner fills singleOperationSampledMs); every other process has exactly
  // measurement.samples. All processes of a pair share their settings.
  const retime = (
    s: Shard,
    pick: (r: JobRecord) => boolean,
    n: number,
    settings: { ops: number; rewarm: number },
    recorded = n,
  ): Shard => ({
    ...s,
    records: s.records.map((r) =>
      r.type === 'time' && pick(r)
        ? {
            ...r,
            opsPerSample: settings.ops,
            rewarmOps: settings.rewarm,
            process: settings.ops === 1 && settings.rewarm === 0 ? ONE_PARSE : REPEATED,
            samplesMs: Array.from({ length: n }, (_, i) => (r.samplesMs as number[])[i % 3]),
            measurement: { ...(r.measurement as object), samples: recorded },
          }
        : r,
    ),
  });
  const one = { ops: 1, rewarm: 0 };
  const repeated = { ops: 5, rewarm: 4 };
  const onCase = (caseId: string) => (r: JobRecord) => r.case === caseId;

  it('accepts more samples from one-parse processes when the record states the count', () => {
    const [s1, s2, m] = campaign();
    const s = score([s1 as Shard, retime(s2 as Shard, onCase('B2-a'), 17, one), m as Shard]);
    expect(s.issues).toEqual([]);
    expect(s.complete).toBe(true);
  });

  it('rejects more samples from repeated processes, a count the record does not state, and fewer samples', () => {
    const [s1, s2, m] = campaign();
    const issues = (shards: Shard[]) => score(shards).issues.join('\n');
    expect(
      issues([retime(s1 as Shard, onCase('B1-a'), 17, repeated), s2 as Shard, m as Shard]),
    ).toMatch(/B1-a: timing rounds [\d,]+ missing/);
    expect(
      issues([s1 as Shard, retime(s2 as Shard, onCase('B2-a'), 16, one, 17), m as Shard]),
    ).toMatch(/B2-a: timing rounds [\d,]+ missing/);
    expect(issues([s1 as Shard, retime(s2 as Shard, onCase('B2-a'), 2, one), m as Shard])).toMatch(
      /B2-a: timing rounds [\d,]+ missing/,
    );
  });

  it('rejects a pair whose processes ran with different settings', () => {
    const [s1, s2, m] = campaign();
    const mixed = retime(
      s1 as Shard,
      (r) => r.case === 'B1-a' && r.impl === 'fast' && (r.round as number) <= 3,
      3,
      repeated,
    );
    expect(score([mixed, s2 as Shard, m as Shard]).issues.join('\n')).toMatch(
      /fast @ B1-a: processes ran with different timing settings/,
    );
  });

  it('rejects a process that ran outside the Node flags of its regime', () => {
    const [s1, s2, m] = campaign();
    const issues = (shards: Shard[]) => score(shards).issues;
    const early = (r: JobRecord) =>
      r.case === 'B1-a' && r.impl === 'cand' && (r.round as number) <= 2;
    const wrong =
      'cand @ B1-a: timing rounds 1,2 did not run with the Node flags of their regime (--no-osr-from-maglev for repeated operations only)';
    // A process that repeated without the flag, and one whose record does not say how it started.
    expect(issues([reflag(s1 as Shard, early, ONE_PARSE), s2 as Shard, m as Shard])).toEqual([
      wrong,
    ]);
    expect(issues([reflag(s1 as Shard, early, undefined), s2 as Shard, m as Shard])).toEqual([
      wrong,
    ]);
    // A one-parse process with the flag.
    const one = retime(s1 as Shard, (r) => r.case === 'B1-a' && r.impl === 'cand', 3, {
      ops: 1,
      rewarm: 0,
    });
    expect(issues([reflag(one, early, REPEATED), s2 as Shard, m as Shard])).toEqual([wrong]);
    expect(issues([one, s2 as Shard, m as Shard])).toEqual([]);
  });

  it('states the flags in the method line, and a campaign recorded without them is not complete under this manifest', () => {
    expect(renderV2(manifest, v2, HASHES, campaign()).text).toMatch(
      /the timing processes of a pair that repeats the operation run with --no-osr-from-maglev, those of a one-parse pair without; statistic per process: median\./,
    );
    // The shards of an earlier campaign: no flags in the start records, none on the processes. Its
    // measurement values are not the manifest's, as for any other changed value, and its method
    // line still reads as it ran.
    const earlier = campaign().map((s) => reflag(withoutFlags(s), () => true, ONE_PARSE));
    expect([...score(earlier).issues].sort()).toEqual(
      ['M.jsonl (M)', 'S1.jsonl (S1)', 'S2.jsonl (S2)'].map(
        (where) => `${where}: process counts differ from the v2 manifest`,
      ),
    );
    expect(renderV2(manifest, v2, HASHES, earlier).text).not.toMatch(/osr-from-maglev/);
  });

  // The publication method (bench/manifest-pub.json): v2 with its Node, no Node flag in either
  // regime, and its own manifest hash in the records.
  describe('publication method', () => {
    const real = readMethod('pub').v2.pub as ManifestPub;
    const pubManifest: Manifest = {
      ...manifest,
      runtime: { ...manifest.runtime, node: real.runtime.node },
    };
    const pubV2: ManifestV2 = {
      ...v2,
      measurement: { ...v2.measurement, ...real.measurement },
      pub: real,
    };
    const PUB_HASHES = { ...HASHES, manifestV2Sha256: 'manifest-pub-sha' };
    const SEEDED = { execArgv: ['--expose-gc', '--random-seed=7', '--hash-seed=7'] };
    /** A campaign as the publication method records it. */
    const asPub = (s: Shard): Shard =>
      ({
        ...reflag(s, () => true, SEEDED),
        start: {
          ...s.start,
          manifestV2Sha256: PUB_HASHES.manifestV2Sha256,
          runtime: { ...s.start.runtime, node: `v${real.runtime.node}` },
          measurement: {
            ...(s.start as unknown as { measurement: object }).measurement,
            ...real.measurement,
          },
        },
      }) as unknown as Shard;
    const pubScore = (shards: Shard[]) => scoreV2(pubManifest, pubV2, PUB_HASHES, shards);

    it('is complete under its own manifest, and the method line states what it replaces and that no flag is set', () => {
      const shards = campaign().map(asPub);
      expect(pubScore(shards).issues).toEqual([]);
      expect(pubScore(shards).complete).toBe(true);
      const { text } = renderV2(pubManifest, pubV2, PUB_HASHES, shards);
      expect(text).toContain(
        "- Publication method (bench/manifest-pub.json over manifest-v2.json): Node 26.13.1; papaparse 5.7.1; every process starts with --expose-gc and the round's --random-seed and --hash-seed, and with no other Node flag.\n- Harness commit c0ffee; Node v26.13.1;",
      );
      expect(text).not.toMatch(/osr-from-maglev/);
      // A v2 report has no such line.
      expect(renderV2(manifest, v2, HASHES, campaign()).text).not.toMatch(/Publication method/);
    });

    it('rejects a shard in which any process, of any kind, ran with another Node flag', () => {
      const [s1, s2, m] = campaign().map(asPub);
      const flagged = { execArgv: [...SEEDED.execArgv, '--no-osr-from-maglev'] };
      const early = (r: JobRecord) =>
        r.case === 'B1-a' && r.impl === 'fast' && (r.round as number) <= 2;
      expect(
        pubScore([reflag(s1 as Shard, early, flagged), s2 as Shard, m as Shard]).issues,
      ).toEqual([
        'S1.jsonl (S1): 2 processes ran with a Node flag the publication method does not set (--no-osr-from-maglev)',
      ]);
      // A memory process counts as a timing process does.
      const memory: Shard = {
        ...(m as Shard),
        records: (m as Shard).records.map((r) =>
          r.type === 'memory' && r.impl === 'cand' && r.round === 1
            ? { ...r, process: { execArgv: [...SEEDED.execArgv, '--max-lazy', '--no-opt'] } }
            : r,
        ),
      };
      expect(pubScore([s1 as Shard, s2 as Shard, memory]).issues).toEqual([
        'M.jsonl (M): 2 processes ran with a Node flag the publication method does not set (--max-lazy --no-opt)',
      ]);
      // Under v2 the same records are held to v2's own flags only.
      expect(score(campaign()).issues).toEqual([]);
    });

    it('a v2 campaign is not a result under the publication manifest, nor a publication campaign under v2', () => {
      const where = ['M.jsonl (M)', 'S1.jsonl (S1)', 'S2.jsonl (S2)'];
      const v3UnderPub = pubScore(campaign());
      expect(v3UnderPub.complete).toBe(false);
      expect(v3UnderPub.issues).toEqual(
        expect.arrayContaining([
          ...where.map((w) => `${w}: run with a different v2 manifest`),
          ...where.map((w) => `${w}: runtime v24.22.1, manifest requires v26.13.1`),
          ...where.map((w) => `${w}: process counts differ from the v2 manifest`),
        ]),
      );
      const pubUnderV2 = score(campaign().map(asPub));
      expect(pubUnderV2.complete).toBe(false);
      expect(pubUnderV2.issues).toEqual(
        expect.arrayContaining([
          ...where.map((w) => `${w}: run with a different v2 manifest`),
          ...where.map((w) => `${w}: runtime v26.13.1, manifest requires v24.22.1`),
          ...where.map((w) => `${w}: process counts differ from the v2 manifest`),
        ]),
      );
      // One campaign cannot hold shards of both methods.
      const [s1, s2, m] = campaign();
      expect(pubScore([asPub(s1 as Shard), s2 as Shard, asPub(m as Shard)]).issues).toContain(
        'S2.jsonl (S2): run with a different v2 manifest',
      );
    });
  });

  it('names the rows whose candidate and competitor were timed in different regimes', () => {
    const [s1, s2, m] = campaign();
    const shards = [
      retime(s1 as Shard, (r) => r.case === 'B1-a' && r.impl === 'fast', 3, one),
      s2 as Shard,
      m as Shard,
    ];
    expect(score(shards).complete).toBe(true);
    const { text } = renderV2(manifest, v2, HASHES, shards);
    expect(text).toContain(
      'Rows where cand and a compared side were timed differently: B1-a (cand repeated; fast one parse).',
    );
  });
});

describe('a calibration (A/A only)', () => {
  it('is complete with the two candidate arms on the primary cases and reports the check', () => {
    const shards = campaign({ kind: 'calibration' });
    const s = score(shards);
    expect(s.issues).toEqual([]);
    expect(s.complete).toBe(true);
    expect(s.aaCheck.pass).toBe(true);
    expect(s.overall).toBeNull();
    const text = renderV2(manifest, v2, HASHES, shards).text;
    expect(text).toMatch(
      /^# Benchmark report \(method v2\): calibration c1\n\nCOMPLETE calibration\./,
    );
    expect(text).toMatch(/median half-width \d\.\d\d% \(limit 1\.50%\): PASS/);
    expect(text).not.toMatch(/## Primary cases/);
    expect(text).toMatch(/0 of 2 intervals exclude 1\.000 \(at most 3\)/);
  });

  it('exit codes: 0 complete and passing, 1 incomplete, 3 a complete calibration that fails the noise check', () => {
    const off: Ms = (impl, c, round) => steady({ cand: 10, 'cand-aa': 10.5 })(impl, c, round);
    const strict = { ...v2, calibration: { ...v2.calibration, maxIntervalsExcludingOne: 0 } };
    const good = campaign({ kind: 'calibration' });
    const bad = campaign({ kind: 'calibration', ms: off });
    expect(renderV2(manifest, v2, HASHES, good).exitCode).toBe(0);
    const failed = renderV2(manifest, strict, HASHES, bad);
    expect(failed.complete).toBe(true);
    expect(failed.exitCode).toBe(CALIBRATION_FAILED);
    expect(CALIBRATION_FAILED).toBe(3);
    expect(renderV2(manifest, strict, HASHES, bad.slice(0, 1)).exitCode).toBe(1);
    // A campaign whose A/A arm misses is reported, not failed by this code.
    expect(
      renderV2(
        manifest,
        strict,
        HASHES,
        campaign({ ms: steady({ ref: 20, fast: 15, cand: 10, 'cand-aa': 10.5 }) }),
      ).exitCode,
    ).toBe(0);
    expect(exitCodeV2({ complete: false, kind: 'calibration', aaCheck: score(good).aaCheck })).toBe(
      1,
    );
  });
});

describe('an incomplete campaign is never scored as complete', () => {
  const rejected = (shards: Shard[], issue: RegExp, missing?: string) => {
    const s = score(shards);
    expect(s.complete).toBe(false);
    expect(s.issues.join('\n')).toMatch(issue);
    if (missing !== undefined) expect(s.missingPairs).toContain(missing);
    const { text, complete } = renderV2(manifest, v2, HASHES, shards);
    expect(complete).toBe(false);
    expect(text).toMatch(/\n\nINCOMPLETE: diagnostics only, not a result/);
    expect(text).not.toMatch(/COMPLETE campaign/);
    expect(text).not.toMatch(/^Ahead \d+, behind/m);
  };

  it('missing rounds of a pair are listed', () => {
    const [s1, s2] = campaign();
    const cut = without(
      s1 as Shard,
      (r) => r.type === 'time' && r.impl === 'fast' && (r.round as number) > 7,
    );
    rejected(
      [cut, s2 as Shard],
      /fast @ B1-a: timing rounds 8,9,10 missing/,
      'fast @ B1-a: timing rounds 8,9,10 missing',
    );
  });

  it('an interrupted shard (no end record) and a shard that did not end complete', () => {
    const [s1, s2] = campaign();
    rejected(
      [{ ...(s1 as Shard), end: null }, s2 as Shard],
      /S1\.jsonl \(S1\): no end record \(interrupted\)/,
    );
    const deadline = {
      ...(s1 as Shard),
      end: { ...(s1 as Shard).end, status: 'deadline' },
    } as Shard;
    rejected([deadline, s2 as Shard], /ended with deadline/);
  });

  it('a missing shard, a missing pair, a blocked process and a missing A/A arm', () => {
    const [s1, s2] = campaign();
    rejected([s1 as Shard], /shard S2 present 0 times/, 'cand @ B2-a: no correctness record');
    rejected(
      [without(s1 as Shard, (r) => r.impl === 'cand-aa'), s2 as Shard],
      /cand-aa @ B1-a: no correctness record/,
      'cand-aa @ B1-a: no correctness record',
    );
    const blocked = {
      ...(s1 as Shard),
      records: (s1 as Shard).records.map((r) =>
        r.type === 'time' && r.impl === 'ref' && r.round === 4
          ? {
              type: 'time',
              impl: 'ref',
              case: r.case,
              round: 4,
              identity: seeded(4),
              status: 'BLOCKED',
            }
          : r,
      ),
    };
    rejected([blocked, s2 as Shard], /ref @ B1-a: timing rounds 4 missing/);
  });

  it('too few samples, other settings, a record without identity, missing memory, no pinning, a smoke run', () => {
    const [s1, s2] = campaign();
    const edit = (change: (r: JobRecord) => JobRecord): Shard => ({
      ...(s1 as Shard),
      records: (s1 as Shard).records.map((r) =>
        r.type === 'time' && r.impl === 'cand' && r.case === 'B1-a' && r.round === 2
          ? change(r)
          : r,
      ),
    });
    rejected(
      [edit((r) => ({ ...r, samplesMs: [1, 2] })), s2 as Shard],
      /cand @ B1-a: timing rounds 2 missing/,
    );
    rejected(
      [edit((r) => ({ ...r, measurement: { ...SETTINGS, warmupMs: 100 } })), s2 as Shard],
      /cand @ B1-a: timing rounds 2 missing/,
    );
    rejected(
      [
        edit((r) => ({ ...r, identity: { ...(r.identity as object), distSha256: undefined } })),
        s2 as Shard,
      ],
      /cand @ B1-a round 2: identity lacks distSha256/,
    );
    rejected(
      [
        s1 as Shard,
        s2 as Shard,
        without(memoryPhase(), (r) => r.impl === 'ref' && r.case === 'B1-a' && r.round === 5),
      ],
      /ref @ B1-a: memory rounds 5 missing/,
    );
    const start = (s1 as Shard).start as unknown as Record<string, unknown>;
    const withStart = (extra: Record<string, unknown>) =>
      ({ ...(s1 as Shard), start: { ...start, ...extra } }) as unknown as Shard;
    rejected([withStart({ pinning: null }), s2 as Shard], /was not pinned/);
    rejected([withStart({ kind: 'smoke' }), s2 as Shard], /smoke run; diagnostics only/);
    rejected([withStart({ seed: 5 }), s2 as Shard], /different campaign seeds/);
    rejected([withStart({ manifestV2Sha256: 'x' }), s2 as Shard], /different v2 manifest/);
    rejected(
      [withStart({ candidate: { commit: 'c0ffee', distSha256: 'other' } }), s2 as Shard],
      /different bundles/,
    );
  }, 60_000);

  it('a smoke run shows its own measurements as diagnostics and is never complete', () => {
    const [s1, s2] = campaign();
    const smoke = (s: Shard) =>
      ({ ...s, start: { ...s.start, kind: 'smoke', shardId: 'smoke' } }) as unknown as Shard;
    const result = score([smoke(s1 as Shard), smoke(s2 as Shard)]);
    expect(result.complete).toBe(false);
    expect(result.issues.join('\n')).toMatch(/smoke run; diagnostics only/);
    expect(result.issues.join('\n')).toMatch(/not a manifest shard/);
    expect(result.cases[0]?.ratio?.ratio).toBeCloseTo(1.5, 10);
  });

  it('a full campaign needs the memory phase, exactly once, and memory counts only from it', () => {
    const [s1, s2, m] = campaign();
    rejected(
      [s1 as Shard, s2 as Shard],
      /memory phase present 0 times \(run --phase memory once, after the timing shards\)/,
      'ref @ B1-a: memory rounds 1,2,3,4,5 missing',
    );
    rejected([s1 as Shard, s2 as Shard, m as Shard, m as Shard], /memory phase present 2 times/);
    // A memory record inside a timing shard is an issue and is not used.
    const stray = (m as Shard).records.filter((r) => r.type === 'memory' && r.case === 'B1-a');
    const mixed = { ...(s1 as Shard), records: [...(s1 as Shard).records, ...stray] };
    rejected(
      [mixed, s2 as Shard, without(m as Shard, (r) => r.case === 'B1-a')],
      /S1\.jsonl \(S1\): memory record for ref @ B1-a in a timing run/,
      'ref @ B1-a: memory rounds 1,2,3,4,5 missing',
    );
    // A timing record inside the memory phase is an issue too.
    const timing = (s1 as Shard).records.find((r) => r.type === 'time') as JobRecord;
    rejected(
      [s1 as Shard, s2 as Shard, { ...(m as Shard), records: [...(m as Shard).records, timing] }],
      /M\.jsonl \(M\): time record for ref @ B1-a in the memory phase/,
    );
  });

  it('a calibration needs no memory phase and rejects one', () => {
    const shards = campaign({ kind: 'calibration' });
    expect(shards.flatMap((s) => s.records).some((r) => r.type === 'memory')).toBe(false);
    expect(score(shards).complete).toBe(true);
    const m = memoryPhase();
    const asCalibration = { ...m, start: { ...m.start, kind: 'calibration' } } as unknown as Shard;
    const s = score([...shards, asCalibration]);
    expect(s.complete).toBe(false);
    expect(s.issues).toContain('a calibration has no memory phase, but one is present');
  });

  it('a cut-off last line or an empty file is an interrupted shard, not an error', () => {
    const [s1, s2] = campaign();
    const text = (s: Shard) =>
      [s.start, ...s.records, s.end].map((r) => JSON.stringify(r)).join('\n') + '\n';
    const whole = text(s1 as Shard);
    // Killed while appending: the end record is missing and the last record is half written.
    const cut = whole.slice(0, whole.lastIndexOf('{"type":"end"') - 40);
    const parsed = parseShard(cut, 'S1.jsonl');
    expect(parsed.truncated).toBe(true);
    expect(parsed.end).toBeNull();
    expect(parsed.records.length).toBe((s1 as Shard).records.length - 1);
    rejected([parsed, s2 as Shard], /S1\.jsonl \(S1\): last line is cut off; an interrupted shard/);
    expect(score([parsed, s2 as Shard]).issues.join('\n')).toMatch(/no end record \(interrupted\)/);
    // A cut inside the end record itself: the shard has all its records and still no end.
    const noEnd = parseShard(whole.slice(0, -20), 'S1.jsonl');
    expect(noEnd.records.length).toBe((s1 as Shard).records.length);
    expect(noEnd.end).toBeNull();
    // An empty file stands for the shard its name says, with every pair missing.
    for (const content of ['', '\n', '{"type":"sta']) {
      const empty = parseShard(content, 'results/S1.jsonl');
      expect(empty).toMatchObject({ empty: true, truncated: true, end: null, records: [] });
      expect(empty.start.shardId).toBe('S1');
      const s = score([empty, s2 as Shard]);
      expect(s.complete).toBe(false);
      expect(s.issues.join('\n')).toMatch(
        /results\/S1\.jsonl \(S1\): empty file; an interrupted shard/,
      );
      expect(s.missingPairs).toContain('cand @ B1-a: no correctness record');
      // The readable shard still names the campaign.
      expect(renderV2(manifest, v2, HASHES, [empty, s2 as Shard]).text).toMatch(
        /^# Benchmark report \(method v2\): campaign c1\n\nINCOMPLETE/,
      );
    }
    // Corruption before the last line is not an interruption.
    expect(() => parseShard('{"type":"start"}\nnot json\n{"type":"end"}\n')).toThrow(SyntaxError);
  });

  it('the report command exits non-zero and lists the missing pairs', () => {
    const dir = scratchDir('report');
    const [s1] = campaignWithRealHashes();
    const file = join(dir, 'S1.jsonl');
    const cut = without(
      s1 as Shard,
      (r) => r.type === 'time' && r.impl === 'papaparse' && r.round === 10,
    );
    writeFileSync(
      file,
      [cut.start, ...cut.records, cut.end].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const report = fileURLToPath(new URL('../bench/report.ts', import.meta.url));
    const run = spawnSync(process.execPath, [report, file], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/INCOMPLETE: diagnostics only, not a result/);
    expect(run.stdout).toMatch(/Missing pairs \(\d+\):\n/);
    expect(run.stdout).toMatch(/- papaparse @ B2-wide-32MiB: timing rounds 10 missing/);
    expect(run.stdout).toMatch(/- shard S2 present 0 times/);
  });
});

// One shard of the real manifest, for the command-line and A/B tests.
const real = readManifest();
function campaignWithRealHashes(): Shard[] {
  const spec = real.campaign.shards[0];
  const records: JobRecord[] = [];
  for (const impl of ['papaparse', 'udsv', 'csv-engine', 'csv-engine-aa']) {
    records.push({
      type: 'check',
      impl,
      case: 'B2-wide-32MiB',
      round: 0,
      status: 'PASS',
      identity: IDENTITY,
    });
    for (let round = 1; round <= realV2.measurement.processes; round++) {
      records.push({
        type: 'time',
        impl,
        case: 'B2-wide-32MiB',
        round,
        identity: seeded(round),
        measurement: SETTINGS,
        process: REPEATED,
        samplesMs: [10, 10, 10],
      });
    }
  }
  const start = {
    type: 'start',
    method: 'v2',
    kind: 'campaign',
    campaignId: 'real',
    shardId: spec?.id,
    seed: 1,
    plannedCases: spec?.cases,
    measurement: realV2.measurement,
    filters: { cases: null, impls: null, processes: null, memoryProcesses: null },
    runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
    packages: real.competitors,
    manifestSha256: manifestSha256(),
    manifestV2Sha256: 'unknown',
    source: { gitCommit: 'c0ffee', sha256: 'source' },
    candidate: { commit: 'c0ffee', distSha256: 'dist-sha' },
    pinning: { cpu: 3, siblings: [3, 7], runnerCpus: [2] },
    environment: { cpu: 'cpu' },
  };
  const end = { type: 'end', status: 'complete', source: start.source };
  return [{ file: 'S1.jsonl', start, records, end } as unknown as Shard];
}

describe('the rendered report', () => {
  const GOLDEN = fileURLToPath(new URL('./fixtures/bench-v2-report.golden.txt', import.meta.url));
  // Two cases that differ, so the table has an ahead and a behind row.
  const ms: Ms = (impl, caseId, round) =>
    steady(
      { ref: 20, fast: caseId === 'B1-a' ? 12 : 9.5, cand: 10, 'cand-aa': 10.02 },
      { fast: 3, cand: 5, 'cand-aa': 7, ref: 1 },
    )(impl, caseId, round);

  it('fixed raw data give the fixed table (golden file)', () => {
    const { text, complete } = renderV2(manifest, v2, HASHES, campaign({ ms }));
    expect(complete).toBe(true);
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(text).toMatch(/^Ahead 1, behind 1, inconclusive 0 of 2 primary cases\.$/m);
    // Losing cases come first.
    expect(text.indexOf('| B2-a | fast | 0.9')).toBeGreaterThan(0);
    expect(text.indexOf('| B2-a | fast | 0.9')).toBeLessThan(text.indexOf('| B1-a | fast | 1.2'));
  });

  it('is the same text for the same raw data in any record order, byte for byte', () => {
    const a = renderV2(manifest, v2, HASHES, campaign({ ms })).text;
    const reversed = campaign({ ms })
      .reverse()
      .map((s) => ({ ...s, records: [...s.records].reverse() }));
    expect(renderV2(manifest, v2, HASHES, reversed).text).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });

  // /proc/stat lines: label user nice system idle iowait irq softirq steal guest guest_nice.
  function withMachine(s: Shard, siblingBusy: number, workerSteal: number): Shard {
    const line = (cpu: string, user: number, idle: number, steal: number) =>
      `${cpu} ${String(user)} 0 0 ${String(idle)} 0 0 0 ${String(steal)} 0 0`;
    const machine = (t: number) => ({
      loadavg: [t ? 1.05 : 0.02, 0, 0],
      cpuTimes: line('cpu ', 5000 + t * 1100, 80000 + t * 6900, 40 + t * 4),
      coreCpuTimes: [
        line('cpu3', 100 + t * (990 - workerSteal), 1000 + t * 10, t * workerSteal),
        line('cpu7', 50 + t * siblingBusy, 2000 + t * (1000 - siblingBusy), 0),
      ],
    });
    return {
      ...s,
      start: { ...s.start, machine: machine(0) },
      end: { ...s.end, machine: machine(1) },
    } as unknown as Shard;
  }

  it('does not depend on the order of its arguments, also with per-shard machine lines', () => {
    const [s1, s2] = campaign({ ms });
    const shards = [
      withMachine(s1 as Shard, 5, 2),
      withMachine(s2 as Shard, 30, 10),
      memoryPhase(),
    ];
    const forward = renderV2(manifest, v2, HASHES, shards).text;
    expect(renderV2(manifest, v2, HASHES, [...shards].reverse()).text).toBe(forward);
    expect(forward.indexOf('- S1: load 0.02 before, 1.05 after')).toBeGreaterThan(0);
    expect(forward.indexOf('- S1: load')).toBeLessThan(forward.indexOf('- S2: load'));
    expect(forward).toMatch(
      /- S1: load 0\.02 before, 1\.05 after; steal 0\.05% of CPU time; cpu3 busy 99\.00%, steal 0\.20%, cpu7 busy 0\.50%\./,
    );
  });

  it('flags a shard whose sibling CPU was busy or whose worker CPU lost time to steal (reported, not a gate)', () => {
    const [s1, s2] = campaign({ ms });
    const quiet = [withMachine(s1 as Shard, 5, 2), withMachine(s2 as Shard, 9, 4), memoryPhase()];
    expect(score(quiet).placementFlags).toEqual([]);
    expect(renderV2(manifest, v2, HASHES, quiet).text).toMatch(
      /Placement check \(reported, not a gate; sibling busy at most 1\.00%, worker steal at most 0\.50%\): no flag\./,
    );
    const disturbed = [
      withMachine(s1 as Shard, 5, 2),
      withMachine(s2 as Shard, 30, 10),
      memoryPhase(),
    ];
    const s = score(disturbed);
    expect(s.placementFlags).toEqual([
      { shard: 'S2', what: 'cpu3 (worker) steal', share: 0.01, limit: 0.005 },
      {
        shard: 'S2',
        what: 'cpu7 (sibling) busy',
        share: expect.closeTo(0.03, 10) as number,
        limit: 0.01,
      },
    ]);
    // A fact beside the result: the campaign stays complete.
    expect(s.complete).toBe(true);
    expect(renderV2(manifest, v2, HASHES, disturbed).text).toMatch(
      /FLAGGED S2 cpu3 \(worker\) steal 1\.00%; S2 cpu7 \(sibling\) busy 3\.00%\./,
    );
  });

  it('another campaign seed gives other bootstrap bounds for the same data', () => {
    const reseeded = campaign({ ms }).map(
      (s) => ({ ...s, start: { ...s.start, seed: 99 } }) as unknown as Shard,
    );
    const a = score(campaign({ ms })).cases[0]?.ratio;
    const b = score(reseeded).cases[0]?.ratio;
    expect(b?.ratio).toBe(a?.ratio);
    expect(b?.replicates).not.toEqual(a?.replicates);
  });
});

describe('A/B tool', () => {
  const primary = real.cases.filter((c) => c.class === 'primary').map((c) => c.id);
  const targets = ['B1-unicode-1MiB', 'B2-unicode-1MiB'];

  function ab(
    bOverA: (caseId: string) => number,
    options: { cases?: string[]; processes?: number; targets?: string[]; end?: string } = {},
  ): Shard {
    const cases = options.cases ?? primary;
    const processes = options.processes ?? 10;
    const records: JobRecord[] = [];
    for (const caseId of cases) {
      for (const impl of ['a', 'b']) {
        records.push({
          type: 'check',
          impl,
          case: caseId,
          round: 0,
          status: 'PASS',
          identity: IDENTITY,
        });
        for (let round = 1; round <= processes; round++) {
          const shift = impl === 'a' ? 0 : 4;
          const t =
            10 *
            (impl === 'b' ? bOverA(caseId) : 1) *
            (1 + (JITTER[(round - 1 + shift) % 10] ?? 0) / 4);
          records.push({
            type: 'time',
            impl,
            case: caseId,
            round,
            identity: seeded(round),
            measurement: SETTINGS,
            process: REPEATED,
            samplesMs: [t, t, t],
          });
        }
      }
    }
    const start = {
      type: 'start',
      method: 'v2',
      kind: 'ab',
      campaignId: 'ab-1',
      shardId: 'ab',
      seed: 77,
      plannedCases: cases,
      measurement: { ...realV2.measurement, processes, memoryProcesses: 0 },
      runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
      manifestSha256: 'm',
      manifestV2Sha256: 'm2',
      source: { gitCommit: 'harness', sha256: 'source' },
      pinning: { cpu: 3, siblings: [3, 7], runnerCpus: [2] },
      environment: { cpu: 'cpu' },
      ab: {
        a: { commit: 'aaaa', distSha256: 'da', dir: '/ab/a' },
        b: { commit: 'bbbb', distSha256: 'db', dir: '/ab/b' },
        targets: options.targets ?? targets,
      },
    };
    const end = { type: 'end', status: options.end ?? 'complete', source: start.source };
    return { file: 'ab.jsonl', start, records, end } as unknown as Shard;
  }
  const hashes = { manifestSha256: 'm', manifestV2Sha256: 'm2' };
  const decide = (shard: Shard) => scoreAb(real, realV2, hashes, shard);

  it('keeps a change that is at least 2% faster on every target and regresses nothing', () => {
    const s = decide(ab((c) => (targets.includes(c) ? 0.95 : 1)));
    expect(s.issues).toEqual([]);
    expect(s.rows).toHaveLength(24);
    const target = s.rows.find((r) => r.case === 'B1-unicode-1MiB');
    expect(target?.target).toBe(true);
    expect(target?.ratio?.ratio).toBeCloseTo(0.95, 3);
    expect(target?.ratio?.hi).toBeLessThan(0.98);
    expect(s.decision).toBe('keep');
    const text = renderAb(
      real,
      realV2,
      hashes,
      ab((c) => (targets.includes(c) ? 0.95 : 1)),
    ).text;
    expect(text).toMatch(/^DECISION: KEEP\b/m);
    expect(text).toMatch(/\| B1-unicode-1MiB \| target \|/);
  });

  // A real run from before the flags is refused by the manifest hash ("run with a different v2
  // manifest"); the hashes match here, so this shows only that such a run gets no issue about flags.
  it('raises no flag issue for an A/B whose start record holds no flags, and rejects the same processes under a start that states them', () => {
    const now = ab((c) => (targets.includes(c) ? 0.95 : 1));
    const unflagged = reflag(now, () => true, ONE_PARSE);
    const earlier = decide(withoutFlags(unflagged));
    expect(earlier.issues).toEqual([]);
    expect(earlier.decision).toBe('keep');
    expect(renderAb(real, realV2, hashes, withoutFlags(unflagged)).text).not.toMatch(
      /osr-from-maglev/,
    );
    expect(renderAb(real, realV2, hashes, now).text).toMatch(
      /run with --no-osr-from-maglev, those of a one-parse pair without; statistic per process: median\./,
    );
    const judged = decide(unflagged);
    expect(judged.decision).toBeNull();
    // Every arm and case: 48 pairs, all of whose rounds ran without the flag.
    expect(judged.issues).toHaveLength(48);
    for (const issue of judged.issues)
      expect(issue).toMatch(
        /^[ab] @ \S+: timing rounds 1,[\d,]+ did not run with the Node flags of their regime \(--no-osr-from-maglev for repeated operations only\)$/,
      );
  });

  it('rejects when a target gains less than 2% with certainty', () => {
    const s = decide(
      ab((c) => (c === 'B1-unicode-1MiB' ? 0.95 : c === 'B2-unicode-1MiB' ? 0.985 : 1)),
    );
    expect(s.decision).toBe('reject');
    expect(s.reasons.join('\n')).toMatch(
      /target B2-unicode-1MiB: upper bound 0\.98\d is not below 0\.98/,
    );
  });

  it('rejects when another primary case regresses beyond 1%', () => {
    const s = decide(ab((c) => (targets.includes(c) ? 0.95 : c === 'B2-wide-32MiB' ? 1.03 : 1)));
    expect(s.decision).toBe('reject');
    expect(s.reasons).toEqual([
      expect.stringMatching(/^B2-wide-32MiB: lower bound 1\.02\d is above 1\.01$/),
    ]);
    // A regression within 1% does not reject.
    expect(decide(ab((c) => (targets.includes(c) ? 0.95 : 1.005))).decision).toBe('keep');
  });

  it('gives no decision without all 24 primary cases, without targets, below 10 processes, or when interrupted', () => {
    const fast = (c: string) => (targets.includes(c) ? 0.95 : 1);
    const partial = decide(ab(fast, { cases: primary.filter((c) => !c.includes('long-field')) }));
    expect(partial.decision).toBeNull();
    expect(partial.issues.join('\n')).toMatch(/the keep rule needs every primary case; missing: /);
    expect(decide(ab(fast, { targets: [] })).issues.join('\n')).toMatch(/no target cases/);
    expect(decide(ab(fast, { targets: ['B1-simple-1KiB'] })).issues.join('\n')).toMatch(
      /target B1-simple-1KiB is not a primary case/,
    );
    expect(decide(ab(fast, { processes: 9 })).issues.join('\n')).toMatch(
      /9 processes per arm; the rule needs at least 10/,
    );
    expect(decide(ab(fast, { end: 'deadline' })).decision).toBeNull();
    const out = renderAb(real, realV2, hashes, ab(fast, { end: 'deadline' }));
    expect(out.decision).toBeNull();
    expect(out.text).toMatch(/^NO DECISION: /m);
    expect(out.text).not.toMatch(/^DECISION:/m);
  }, 60_000);
});
