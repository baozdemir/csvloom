import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scratchDir } from './scratch.ts';
import { abCases, abPreflight, abRunOptions, type AbArm } from '../bench/ab.ts';
import { FAMILIES, familyFormat, generateFixture } from '../bench/fixtures.ts';
import {
  BULK_IMPL,
  bulkAdapter,
  candidateAdapter,
  firstMismatch,
  type CandidateParseStream,
  type Dialect,
  type RecordRow,
} from '../bench/lanes.ts';
import {
  abManifest,
  expectedPairs,
  expectedPairsV2,
  laneManifest,
  MANIFEST_V2_PATH,
  manifestSha256,
  manifestV2Issues,
  readManifest,
  readManifestV2,
  s1Manifest,
  scoredCases,
  w1Manifest,
  type CaseSpec,
  type Manifest,
  type ManifestV2,
} from '../bench/manifest.ts';
import {
  parseShard,
  renderAb,
  renderV2,
  scoreAb,
  scoreV2,
  type JobRecord,
  type Shard,
} from '../bench/report.ts';
import {
  bundleArms,
  jsonlCheckpoint,
  projectMs,
  runShardV2,
  runV2,
  treeSha256,
  type Guards,
  type JobOutcome,
  type SpawnV2,
} from '../bench/run.ts';
import { check, collect, type Input } from '../bench/worker.ts';
import { parse } from '../src/parse.ts';
import { parseStream } from '../src/stream.ts';

// The S1 lane under method v2: the candidate's S1 function and the csv-engine-bulk arm, the S1
// cases of manifest-v2.json, and the A/B tool's S1 and W1 modes.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const base = readManifest();
const v2 = readManifestV2();
const ids = (cases: ReadonlyArray<{ id: string }>) => cases.map((c) => c.id);
const run = {
  id: 's1-preflight',
  exists: false,
  dirty: false,
  node: 'v24.22.1',
  requiredNode: '24.22.1',
};

describe('bench/ab.ts: lanes (preflight, before anything is built)', () => {
  it('without --lane, a target that is not a primary case is refused as before', () => {
    const primary = ids(base.cases.filter((c) => c.class === 'primary'));
    expect(
      abPreflight({
        ...run,
        known: ids(base.cases),
        primary,
        cases: primary,
        targets: ['S1-simple-1MiB', 'B1-unicode-1MiB'],
      }),
    ).toEqual(['target S1-simple-1MiB is not a primary case']);
  });

  it('--lane S1 refuses a primary target: targets are S1 cases of class additional', () => {
    const s1 = ids(base.cases.filter((c) => c.lane === 'S1'));
    const check = { ...run, lane: 'S1', known: s1, primary: s1, cases: s1 };
    expect(abPreflight({ ...check, targets: ['S1-unicode-1MiB'] })).toEqual([]);
    expect(abPreflight({ ...check, targets: ['B1-unicode-1MiB', 'S1-unicode-1MiB'] })).toEqual([
      'target B1-unicode-1MiB is not an S1 case of class additional (--lane S1)',
    ]);
  });

  it('--lane W1 refuses a case or a target that is not a W1 case', () => {
    const w1 = ids(v2.w1.cases);
    const check = { ...run, lane: 'W1', known: w1, primary: w1 };
    expect(abPreflight({ ...check, cases: w1, targets: ['W1-rows-unicode-1MiB'] })).toEqual([]);
    expect(
      abPreflight({
        ...check,
        cases: ['W1-rows-unicode-1MiB', 'B1-unicode-1MiB'],
        targets: ['W1-rows-unicode-1MiB', 'B1-unicode-1MiB'],
      }),
    ).toEqual([
      'case B1-unicode-1MiB in --cases is not a W1 case (--lane W1)',
      'target B1-unicode-1MiB is not a W1 case (--lane W1)',
    ]);
  });

  it('refuses an unknown lane', () => {
    const s1 = ids(base.cases.filter((c) => c.lane === 'S1'));
    expect(
      abPreflight({ ...run, lane: 'B3', known: s1, primary: s1, cases: s1, targets: [] }),
    ).toEqual(['unknown --lane B3 (S1 or W1)']);
  });

  // The command itself, so that the lists it derives from each lane are the ones
  // pinned above; it refuses (exit 2) before it builds or measures anything.
  const ab = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        'bench/ab.ts',
        '--id',
        `s1-test-${String(process.pid)}`,
        '--a',
        'HEAD',
        '--b',
        'HEAD',
        ...args,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );

  it('the command: the old refusal, --lane S1 with a primary target, --lane W1 with a B1 case', () => {
    const old = ab('--targets', 'S1-simple-1MiB', '--pin-cpu', '2');
    expect(old.status, old.stderr).toBe(2);
    expect(old.stderr).toContain('- target S1-simple-1MiB is not a primary case\n');
    const s1 = ab('--lane', 'S1', '--targets', 'B1-unicode-1MiB', '--pin-cpu', '2');
    expect(s1.status, s1.stderr).toBe(2);
    expect(s1.stderr).toContain(
      '- target B1-unicode-1MiB is not an S1 case of class additional (--lane S1)\n',
    );
    const w1 = ab('--lane', 'W1', '--cases', 'B1-unicode-1MiB', '--targets', 'B1-unicode-1MiB');
    expect(w1.status, w1.stderr).toBe(2);
    expect(w1.stderr).toContain('- case B1-unicode-1MiB in --cases is not a W1 case (--lane W1)\n');
    expect(w1.stderr).toContain('- target B1-unicode-1MiB is not a W1 case (--lane W1)\n');
    for (const r of [old, s1, w1])
      expect(r.stderr).toContain('refused, nothing was built or measured:\n');
  }, 60_000);
});

describe('the S1 cases (manifest-v2.json, s1Manifest, abManifest)', () => {
  // The A/B tool's S1 manifest: the campaign's twelve cases and the six one-chunk variants.
  const s1 = abManifest('S1', base, v2);
  const b1 = (family: string, size: number) =>
    base.cases.find((c) => c.lane === 'B1' && c.family === family && c.targetBytes === size);

  it('validates; 18 S1 cases: v1 six at 1 MiB, six at 32 MiB, six one-chunk 32 MiB variants', () => {
    expect(manifestV2Issues(v2, base, manifestSha256())).toEqual([]);
    expect(s1.cases).toHaveLength(18);
    // The campaign has the twelve in the default chunks, in three shards.
    const campaign = s1Manifest(base, v2);
    expect(ids(campaign.cases)).toEqual(ids(s1.cases.filter((c) => c.chunkBytes === undefined)));
    expect(campaign.campaign.shards.map((x) => [x.id, x.cases.length])).toEqual([
      ['S1-1MiB', 6],
      ['S1-32MiB-a', 3],
      ['S1-32MiB-b', 3],
    ]);
    expect(campaign.campaign.shards.flatMap((x) => x.cases).sort()).toEqual(
      ids(campaign.cases).sort(),
    );
    expect(v2.s1.arms).toEqual({
      'csv-engine-batch256': { batchSize: 256 },
      'csv-engine-batch4096': { batchSize: 4096 },
      [BULK_IMPL]: {},
    });
    expect(ids(s1.cases.slice(0, 6))).toEqual(ids(base.cases.filter((c) => c.lane === 'S1')));
    for (const c of s1.cases) {
      expect([c.lane, c.class, c.weight]).toEqual(['S1', 'additional', 0]);
      expect(c.fixture).toStrictEqual(b1(c.family ?? '', c.targetBytes ?? 0)?.fixture);
    }
    const oneChunk = s1.cases.filter((c) => c.chunkBytes !== undefined);
    expect(ids(oneChunk)).toEqual(FAMILIES.map((f) => `S1-${f}-32MiB-one-chunk`));
    for (const c of oneChunk) expect(c.chunkBytes).toBe(c.fixture?.bytes);
    expect(
      ids(s1.cases.filter((c) => c.chunkBytes === undefined && c.targetBytes === 33_554_432)),
    ).toEqual(FAMILIES.map((f) => `S1-${f}-32MiB`));
    expect(s1.cases.some((c) => c.class === 'primary')).toBe(false);
  });

  it('the candidate S1 lane is measured in the S1 manifests and still deferred in the frozen v1 manifest', () => {
    expect(s1.candidateDeferredLanes).toEqual({});
    expect(s1.implementations).toBe(base.implementations);
    const candidate = expectedPairs(s1).filter((p) => p.impl === s1.candidate);
    expect(candidate).toHaveLength(18);
    expect(candidate.every((p) => p.expect === 'measure')).toBe(true);
    const competitors = expectedPairs(s1).filter(
      (p) => p.impl !== s1.candidate && p.expect === 'measure',
    );
    expect(new Set(competitors.map((p) => p.impl))).toEqual(
      new Set(base.implementations.filter((i) => i.lanes.includes('S1')).map((i) => i.id)),
    );
    expect(
      expectedPairs(base).filter((p) => p.impl === base.candidate && p.case.startsWith('S1-')),
    ).toEqual(
      ids(base.cases.filter((c) => c.lane === 'S1')).map((id) => ({
        impl: base.candidate,
        case: id,
        expect: 'deferred',
        reason: base.candidateDeferredLanes.S1,
      })),
    );
  });

  it('rejects a section with a v1 id, a primary case, another fixture, a bad chunk size or a family missing', () => {
    const issues = (edit: (cases: CaseSpec[]) => CaseSpec[]) => {
      const copy = JSON.parse(JSON.stringify(v2)) as ManifestV2;
      copy.s1.cases = edit(copy.s1.cases);
      return manifestV2Issues(copy, base, manifestSha256());
    };
    const at = (i: number, patch: Partial<CaseSpec>) => (cases: CaseSpec[]) =>
      cases.map((c, j) => (j === i ? { ...c, ...patch } : c));
    expect(issues(at(0, { id: 'S1-simple-1MiB' }))).toContain(
      's1: S1-simple-1MiB is a case of bench/manifest.json',
    );
    expect(issues(at(0, { class: 'primary', weight: 1 }))).toContain(
      's1: S1-simple-32MiB must be lane S1, class additional, weight 0',
    );
    const small = b1('simple', 1_048_576)?.fixture;
    expect(issues(at(0, small ? { fixture: small } : {}))).toContain(
      's1: S1-simple-32MiB must use the frozen fixture of its family and size',
    );
    expect(issues(at(6, { chunkBytes: 0 }))).toEqual([
      's1: S1-simple-32MiB-one-chunk: chunkBytes must be a positive integer',
    ]);
    expect(issues((cases) => cases.filter((c) => c.id !== 'S1-unicode-32MiB'))).toEqual([
      's1: needs one unicode case of 33554432 bytes in the default chunks',
      's1: every case in the default chunks must be in exactly one shard, and no variant in any',
    ]);
  });

  it('rejects shards and arms that do not fit', () => {
    const issues = (edit: (s1: ManifestV2['s1']) => void) => {
      const copy = JSON.parse(JSON.stringify(v2)) as ManifestV2;
      edit(copy.s1);
      return manifestV2Issues(copy, base, manifestSha256());
    };
    const shardRule =
      's1: every case in the default chunks must be in exactly one shard, and no variant in any';
    expect(issues((x) => x.shards[0]?.cases.push('S1-simple-32MiB-one-chunk'))).toEqual([
      shardRule,
    ]);
    expect(issues((x) => x.shards[1]?.cases.pop())).toEqual([shardRule]);
    expect(issues((x) => (x.shards[2] = { id: 'M', cases: x.shards[2]?.cases ?? [] }))).toEqual([
      's1: shard ids must be distinct and differ from measurement.memoryShard',
    ]);
    expect(issues((x) => (x.arms = { ...x.arms, papaparse: {} }))).toEqual([
      's1: arm papaparse is already an implementation or the candidate',
    ]);
    expect(
      issues(
        (x) => (x.arms = { ...x.arms, 'csv-engine-x': 3 as unknown as Record<string, never> }),
      ),
    ).toEqual(['s1: arm csv-engine-x: options must be an object']);
    expect(
      issues((x) => {
        x.arms = Object.fromEntries(Object.entries(x.arms).filter(([arm]) => arm !== BULK_IMPL));
      }),
    ).toEqual([`s1: arms must include ${BULK_IMPL}`]);
  });

  it('laneManifest: none, W1, S1, and an unknown lane', () => {
    expect(laneManifest(undefined, base, v2)).toBe(base);
    expect(laneManifest('W1', base, v2)).toEqual(w1Manifest(base, v2));
    expect(laneManifest('S1', base, v2)).toEqual(s1Manifest(base, v2));
    expect(abManifest('S1', base, v2)).toEqual(s1);
    expect(abManifest('W1', base, v2)).toEqual(w1Manifest(base, v2));
    expect(abManifest(undefined, base, v2)).toBe(base);
    expect(() => laneManifest('B3', base, v2)).toThrow('unknown lane B3 (S1 or W1)');
  });
});

describe('bench/ab.ts: the case lists of each lane (abCases)', () => {
  const s1Ids = ids(abManifest('S1', base, v2).cases);
  const of = (size: number) =>
    ids(abManifest('S1', base, v2).cases.filter((c) => c.targetBytes === size));

  it('--lane S1: every S1 case, and by default those of the targets sizes', () => {
    const all = abCases('S1', [], base, v2);
    expect([all.known, all.primary, all.cases]).toEqual([s1Ids, s1Ids, s1Ids]);
    const w = abCases(
      'S1',
      FAMILIES.map((f) => `S1-${f}-32MiB-one-chunk`),
    );
    expect(w.cases).toEqual(of(33_554_432));
    expect(w.cases).toHaveLength(12);
    expect(abCases('S1', ['S1-unicode-1MiB']).cases).toEqual(of(1_048_576));
    expect(all.known.some((id) => !id.startsWith('S1-'))).toBe(false);
  });

  it('--lane W1: the 24 W1 cases; no lane: the 24 primary cases, as before', () => {
    const w1 = abCases('W1', [], base, v2);
    expect([w1.known, w1.primary, w1.cases]).toEqual([
      ids(v2.w1.cases),
      ids(v2.w1.cases),
      ids(v2.w1.cases),
    ]);
    const none = abCases(undefined, ['B1-unicode-1MiB'], base, v2);
    const primary = ids(base.cases.filter((c) => c.class === 'primary'));
    expect([none.known, none.primary, none.cases]).toEqual([ids(base.cases), primary, primary]);
    expect(none.manifest).toBe(base);
  });
});

// A/B result files as bench/ab.ts writes them, for the keep rule of each lane.
const JITTER = [-0.008, 0.004, 0, 0.006, -0.003, 0.009, -0.006, 0.002, -0.001, 0.007];
const IDENTITY = {
  harnessCommit: 'c0ffee',
  commit: 'c0ffee',
  distSha256: 'dist-sha',
  node: 'v24.22.1',
  cpuModel: 'cpu',
  kernel: 'kernel',
  tasksetMask: '3',
  padLength: 100,
  checkoutCopy: 1,
  checkoutPath: '/copies/c2/d/e',
};
const SETTINGS = { samples: 3, minSampleMs: 250, warmupMs: 500, minWarmupOps: 3 };
const HASHES = { manifestSha256: 'm', manifestV2Sha256: 'm2' };

function abShard(
  lane: string | undefined,
  cases: readonly string[],
  targets: readonly string[],
  bOverA: (caseId: string) => number,
): Shard {
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
      for (let round = 1; round <= 10; round++) {
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
          identity: { ...IDENTITY, v8Seed: 1000 + round },
          measurement: SETTINGS,
          process: { execArgv: ['--expose-gc', ...v2.measurement.repeatedNodeFlags] },
          samplesMs: [t, t, t],
        });
      }
    }
  }
  const start = {
    type: 'start',
    method: 'v2',
    kind: 'ab',
    ...(lane === undefined ? {} : { lane }),
    campaignId: 'ab-s1',
    shardId: 'ab',
    seed: 77,
    plannedCases: cases,
    measurement: { ...v2.measurement, processes: 10, memoryProcesses: 0 },
    runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
    manifestSha256: 'm',
    manifestV2Sha256: 'm2',
    source: { gitCommit: 'harness', sha256: 'source' },
    pinning: { cpu: 3, siblings: [3, 7], runnerCpus: [2] },
    environment: { cpu: 'cpu' },
    ab: {
      a: { commit: 'aaaa', distSha256: 'da', dir: '/ab/a' },
      b: { commit: 'bbbb', distSha256: 'db', dir: '/ab/b' },
      targets,
    },
  };
  const end = { type: 'end', status: 'complete', source: start.source };
  return { file: 'ab.jsonl', start, records, end } as unknown as Shard;
}

describe('the keep rule of an S1 or a W1 A/B (report.ts scoreAb, renderAb)', () => {
  const s1 = abManifest('S1', base, v2);
  const w1 = w1Manifest(base, v2);
  const oneChunk = FAMILIES.map((f) => `S1-${f}-32MiB-one-chunk`);
  const at32 = ids(s1.cases.filter((c) => c.targetBytes === 33_554_432));
  const decide = (m: Manifest, shard: Shard) => scoreAb(m, v2, HASHES, shard);
  const faster =
    (targets: readonly string[], other: Record<string, number> = {}) =>
    (c: string) =>
      targets.includes(c) ? 0.95 : (other[c] ?? 1);

  it('S1: the rule reads every S1 case of the same size as a target for every other primary case', () => {
    const shard = abShard(
      'S1',
      [...at32, 'S1-simple-1MiB'],
      oneChunk,
      faster(oneChunk, { 'S1-simple-1MiB': 1.05 }),
    );
    const s = decide(s1, shard);
    expect(s.issues).toEqual([]);
    expect(s.decision).toBe('keep');
    expect(s.rows.filter((r) => r.inRule).map((r) => r.case)).toEqual(at32);
    expect(s.rows.find((r) => r.case === 'S1-simple-1MiB')?.inRule).toBe(false);
    const text = renderAb(s1, v2, HASHES, shard).text;
    expect(text).toMatch(/^# A\/B report \(method v2, S1\): ab-s1$/m);
    expect(text).toContain(
      "- Rule: keep if every target case's B/A upper 95% bound is below 0.98 and no other S1 case of the same size as a target's lower bound is above 1.01; otherwise reject.",
    );
    expect(text).toMatch(/^\| S1-simple-32MiB \| other \|.* \| ok \|$/m);
    expect(text).toMatch(/^\| S1-simple-1MiB \| not in the rule \|.* \| - \|$/m);
    expect(text).toMatch(
      /^DECISION: KEEP \(every target case's upper bound is below the threshold and no other S1 case of the same size as a target regresses beyond its threshold\)\.$/m,
    );
  });

  it('S1: a guard of the same size that regresses rejects; a missing one, a primary target or the wrong manifest gives no decision', () => {
    const reject = decide(
      s1,
      abShard('S1', at32, oneChunk, faster(oneChunk, { 'S1-wide-32MiB': 1.03 })),
    );
    expect(reject.decision).toBe('reject');
    expect(reject.reasons).toEqual([
      expect.stringMatching(/^S1-wide-32MiB: lower bound 1\.02\d is above 1\.01$/),
    ]);
    const partial = decide(
      s1,
      abShard(
        'S1',
        at32.filter((c) => c !== 'S1-wide-32MiB'),
        oneChunk,
        faster(oneChunk),
      ),
    );
    expect(partial.decision).toBeNull();
    expect(partial.issues).toEqual([
      'the keep rule needs every S1 case of the same size as a target; missing: S1-wide-32MiB',
    ]);
    expect(decide(s1, abShard('S1', at32, ['B1-unicode-1MiB'], faster([]))).issues).toContain(
      'target B1-unicode-1MiB is not an S1 case of class additional',
    );
    expect(decide(base, abShard('S1', at32, oneChunk, faster(oneChunk))).issues).toContain(
      'an S1 A/B run read with the B1/B2/S1 manifest',
    );
    expect(decide(s1, abShard(undefined, at32, oneChunk, faster(oneChunk))).issues).toContain(
      'a B1/B2 A/B run read with the S1 manifest',
    );
  });

  it('W1: targets and guards are the W1 cases, and the rule needs every one of them', () => {
    const all = ids(w1.cases);
    const target = ['W1-rows-unicode-1MiB'];
    const shard = abShard('W1', all, target, faster(target));
    const s = decide(w1, shard);
    expect(s.issues).toEqual([]);
    expect(s.decision).toBe('keep');
    const text = renderAb(w1, v2, HASHES, shard).text;
    expect(text).toMatch(/^# A\/B report \(method v2, W1\): ab-s1$/m);
    expect(text).toContain("no other W1 case's lower bound is above 1.01");
    const partial = decide(w1, abShard('W1', all.slice(1), target, faster(target)));
    expect(partial.issues).toEqual([`the keep rule needs every W1 case; missing: ${all[0] ?? ''}`]);
    expect(decide(w1, abShard('W1', all, ['B1-unicode-1MiB'], faster([]))).issues).toContain(
      'target B1-unicode-1MiB is not a W1 case',
    );
  });
});

const bytes = (text: string) => new TextEncoder().encode(text);
// eslint-disable-next-line @typescript-eslint/require-await -- an in-memory async source has nothing to await
async function* chunksOf(data: Uint8Array, size: number) {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}
async function records(
  run: NonNullable<ReturnType<typeof candidateAdapter>['S1']>,
  data: Uint8Array,
  dialect: Dialect,
  size: number,
  options = {},
) {
  const out: RecordRow[] = [];
  await run(chunksOf(data, size), dialect, (r) => out.push(r), options);
  return out;
}

describe('the candidate S1 function and the csv-engine-bulk arm (from src, outside any timed region)', () => {
  const candidate = candidateAdapter(parse, undefined, parseStream);
  const stream = candidate.S1 as NonNullable<typeof candidate.S1>;
  const bulk = bulkAdapter(parse).S1 as NonNullable<typeof candidate.S1>;
  const b2 = candidate.B2 as (csv: string, dialect: Dialect) => RecordRow[];
  const lf: Dialect = { delimiter: ',', quote: '"', newline: '\n' };
  const crlf: Dialect = { ...lf, newline: '\r\n' };

  it('both pass the generator check on every family, in chunks of 1 to all bytes', async () => {
    for (const family of FAMILIES) {
      const fixture = generateFixture({
        family,
        seed: base.families[family].seed,
        targetBytes: 8192,
      });
      const { header, dialect } = familyFormat(family);
      const input: Input = {
        csv: fixture.csv,
        dialect,
        sha256: fixture.sha256,
        header,
        rows: fixture.rows,
      };
      for (const chunkBytes of [1, 7, 4096, 65_536, 1 << 30]) {
        const spec: CaseSpec = {
          id: `S1-${family}-8KiB`,
          lane: 'S1',
          class: 'additional',
          weight: 0,
          chunkBytes,
        };
        for (const adapter of [candidate, { package: 'csv-engine', S1: bulk }]) {
          expect(
            await check(adapter, spec, input, base),
            `${family} ${String(chunkBytes)}`,
          ).toEqual({
            status: 'PASS',
            oracle: 'generator',
            outputLength: fixture.rows.length - 1,
          });
        }
      }
    }
  }, 60_000);

  it('drops only the record a final line break gives, as the B2 function does, at every split and batch size', async () => {
    const texts: Array<[string, Dialect]> = [
      ['a,b\n1,2\n', lf],
      ['a,b\n1,2\n\n', lf],
      ['a,b\n1,2\n""', lf],
      ['a,b\n1,2\n\n\n', lf],
      ['a,b\n1,2', lf],
      ['a,b\n', lf],
      ['a,b\r\n1,2\r\n', crlf],
      ['a,b\r\n1,2\n', crlf],
      ['a,b\r\n1,2\r\n\r\n', crlf],
      ['', lf],
    ];
    for (const [text, dialect] of texts) {
      const want = b2(text, dialect);
      for (const size of [1, 2, 3, 1 << 20])
        for (const batchSize of [1, 2, 1024]) {
          const label = `${JSON.stringify(text)} size ${String(size)} batch ${String(batchSize)}`;
          expect(
            firstMismatch(await records(stream, bytes(text), dialect, size, { batchSize }), want),
            label,
          ).toBeNull();
          expect(
            firstMismatch(await records(bulk, bytes(text), dialect, size), want),
            label,
          ).toBeNull();
        }
    }
    expect(await records(stream, bytes('a,b\n1,2\n\n'), lf, 1, { batchSize: 1 })).toEqual([
      { a: '1', b: '2' },
      { a: '' },
    ]);
    expect(await records(stream, bytes('a,b\n1,2\n""'), lf, 1)).toEqual([
      { a: '1', b: '2' },
      { a: '' },
    ]);
  });

  it('BOMs give what the B2 function gives for the text with them; invalid UTF-8 rejects in both arms', async () => {
    const bom = [0xef, 0xbb, 0xbf];
    const text = 'a,b\n1,2\n';
    for (const run of [stream, bulk]) {
      for (const count of [1, 2]) {
        const data = Uint8Array.from([...Array<number[]>(count).fill(bom).flat(), ...bytes(text)]);
        const want = b2(String.fromCharCode(0xfeff).repeat(count) + text, lf);
        expect(want).toEqual([{ a: '1', b: '2' }]);
        expect(await records(run, data, lf, 1)).toEqual(want);
      }
      await expect(
        records(run, Uint8Array.from([...bytes('a,b\n1,'), 0xff, 0x0a]), lf, 3),
      ).rejects.toThrow(TypeError);
    }
  });

  it('passes batchSize (default 1024) and maxRecordLength (default none) from the case options, nothing else', async () => {
    const configs: unknown[] = [];
    const spy: CandidateParseStream = (source, config) => {
      configs.push(config);
      return parseStream(source, config);
    };
    const run = candidateAdapter(parse, undefined, spy).S1 as NonNullable<typeof candidate.S1>;
    await records(run, bytes('a,b\n1,2\n'), lf, 4, {
      batchSize: 7,
      maxRecordLength: 100,
      chunkBytes: 5,
    });
    await records(run, bytes('a;b\r\n1;2\r\n'), { delimiter: ';', quote: "'", newline: '\r\n' }, 4);
    expect(configs).toEqual([
      {
        delimiter: ',',
        newline: '\n',
        quoteChar: '"',
        header: true,
        batchSize: 7,
        maxRecordLength: 100,
      },
      { delimiter: ';', newline: '\r\n', quoteChar: "'", header: true, batchSize: 1024 },
    ]);
    await expect(
      records(stream, bytes('a,b\n1234567,2\n'), lf, 3, { maxRecordLength: 3 }),
    ).rejects.toThrow();
  });

  it("collect cuts the source as the case says (the worker's chunk size)", async () => {
    const input: Input = {
      csv: 'a,b\n1,2\n',
      dialect: lf,
      sha256: '',
      header: ['a', 'b'],
      rows: null,
    };
    let seen = 0;
    const counting = {
      package: 'x',
      S1: async (chunks: AsyncIterable<Uint8Array>) => {
        for await (const chunk of chunks) seen += chunk.length > 0 ? 1 : 0;
      },
    };
    await collect(counting, 'S1', input, 3);
    expect(seen).toBe(3);
  });
});

// The worker as the runner starts it, on a stand-in bundle whose stream entry
// re-exports the source's parseStream and reports, on stderr, how many chunks it
// read and with which config: proof of the chunking and options of each arm.
describe('bench/worker.ts: S1 arms from a bundle (check mode, real processes)', () => {
  const root = scratchDir('s1-root');
  cpSync(join(ROOT, 'bench'), join(root, 'bench'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'dist', 'index.js'),
    `export { parse } from ${JSON.stringify(join(ROOT, 'src', 'parse.ts'))};\n`,
  );
  writeFileSync(
    join(root, 'dist', 'stream.js'),
    [
      `import { parseStream as real } from ${JSON.stringify(join(ROOT, 'src', 'stream.ts'))};`,
      'export function parseStream(source, config) {',
      '  async function* counted() {',
      '    let n = 0;',
      '    for await (const chunk of source) { n++; yield chunk; }',
      '    process.stderr.write(`chunks ${n} ${JSON.stringify(config)}\\n`);',
      '  }',
      '  return real(counted(), config);',
      '}',
      '',
    ].join('\n'),
  );
  const fixture = base.cases.find((c) => c.id === 'S1-simple-1MiB')?.fixture;
  const local = JSON.parse(JSON.stringify(v2)) as ManifestV2;
  local.s1.cases.push({
    id: 'S1-simple-1MiB-one-chunk',
    lane: 'S1',
    class: 'additional',
    weight: 0,
    family: 'simple',
    targetBytes: 1_048_576,
    chunkBytes: fixture?.bytes ?? 0,
    fixture,
    adapterOptions: { 'csv-engine': { batchSize: 7 } },
  } as CaseSpec);
  writeFileSync(join(root, 'bench', 'manifest-v2.json'), JSON.stringify(local));
  const streamSha = createHash('sha256')
    .update(readFileSync(join(root, 'dist', 'stream.js')))
    .digest('hex');
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
      counted: r.stderr.split('\n').filter((line) => line.startsWith('chunks ')),
    };
  };

  it('a one-chunk case: arms a, b and the A/A arm read one chunk with the candidate options', () => {
    for (const impl of ['a', 'b', v2.aa.impl, 'csv-engine']) {
      const { record, counted } = worker(impl, 'S1-simple-1MiB-one-chunk');
      expect(record).toMatchObject({
        status: 'PASS',
        outputLength: 18_939,
        options: { batchSize: 7 },
      });
      // The check parses once and its probe (method v2) parses again: every read is one chunk.
      expect(counted.length).toBeGreaterThan(0);
      expect(new Set(counted)).toEqual(
        new Set([
          'chunks 1 {"delimiter":",","newline":"\\n","quoteChar":"\\"","header":true,"batchSize":7}',
        ]),
      );
      expect(record.process).toMatchObject({
        streamEntry: join(root, 'dist', 'stream.js'),
        streamEntrySha256: streamSha,
      });
    }
  }, 60_000);

  it('a default case reads 65,536-byte chunks; the bulk arm and a B1 process load no stream entry', () => {
    const plain = worker('csv-engine', 'S1-simple-1MiB');
    expect(plain.record).toMatchObject({ status: 'PASS', outputLength: 18_939, options: {} });
    expect(plain.counted.length).toBeGreaterThan(0);
    for (const line of plain.counted) expect(line).toMatch(/^chunks 17 \{.*"batchSize":1024\}$/);
    const bulk = worker(BULK_IMPL, 'S1-simple-1MiB-one-chunk');
    expect(bulk.record).toMatchObject({ status: 'PASS', outputLength: 18_939 });
    expect(bulk.counted).toEqual([]);
    expect(bulk.record.process).toMatchObject({ streamEntry: null, streamEntrySha256: null });
    for (const [arm, size] of [
      ['csv-engine-batch256', 256],
      ['csv-engine-batch4096', 4096],
    ] as const) {
      const r = worker(arm, 'S1-simple-1MiB');
      expect(r.record).toMatchObject({ status: 'PASS', options: { batchSize: size } });
      expect(r.counted[0]).toMatch(new RegExp(`^chunks 17 \\{.*"batchSize":${String(size)}\\}$`));
    }
    const b1 = worker('csv-engine', 'B1-simple-1KiB');
    expect(b1.record).toMatchObject({ status: 'PASS' });
    expect(b1.record.process).toMatchObject({ streamEntry: null, streamEntrySha256: null });
  }, 60_000);
});

describe('the S1 campaign: pairs, arms and the runner (stand-in worker, no timing)', () => {
  const s1 = s1Manifest(base, v2);
  const arms = Object.keys(v2.s1.arms);

  it('scores every S1 case (A/A arm, memory phase), and the arms join the candidate on every case', () => {
    expect(ids(scoredCases(s1))).toEqual(ids(s1.cases));
    expect(ids(scoredCases(base))).toEqual(ids(base.cases.filter((c) => c.class === 'primary')));
    expect(ids(scoredCases(w1Manifest(base, v2)))).toEqual(ids(v2.w1.cases));
    const pairs = expectedPairsV2(s1, v2, 'campaign');
    for (const c of s1.cases) {
      const on = pairs.filter((p) => p.case === c.id && p.expect === 'measure').map((p) => p.impl);
      for (const impl of [s1.candidate, v2.aa.impl, ...arms]) expect(on).toContain(impl);
    }
    expect(pairs.filter((p) => arms.includes(p.impl))).toHaveLength(3 * 12);
    // A calibration has the candidate and the A/A arm only; the B1/B2 campaign has no arm.
    expect(new Set(expectedPairsV2(s1, v2, 'calibration').map((p) => p.impl))).toEqual(
      new Set([s1.candidate, v2.aa.impl]),
    );
    expect(expectedPairsV2(base, v2, 'campaign').some((p) => arms.includes(p.impl))).toBe(false);
  });

  it('bundleArms: the arms load the candidate entry in an S1 run only', () => {
    const run = bundleArms(s1, v2, 'S1', 'dist/index.js', 'twin/index.js', 'sha');
    expect(run.entries).toEqual({
      'csv-engine': 'dist/index.js',
      'csv-engine-aa': 'twin/index.js',
      'csv-engine-batch256': 'dist/index.js',
      'csv-engine-batch4096': 'dist/index.js',
      'csv-engine-bulk': 'dist/index.js',
    });
    expect(Object.values(run.entrySha256)).toEqual(['sha', 'sha', 'sha', 'sha', 'sha']);
    expect(Object.keys(bundleArms(base, v2, undefined, 'd', 't', 's').entries)).toEqual([
      'csv-engine',
      'csv-engine-aa',
    ]);
  });

  it('projects memory processes for the S1 cases although they are not primary', () => {
    const bytes = s1.cases[0]?.fixture?.bytes ?? 0;
    const dry = new Map([
      ['papaparse\0S1\0simple', { bytes, opMs: 10, inputLoadMs: 5, fixedMs: 100 }],
    ]);
    const one = [{ impl: 'papaparse', case: 'S1-simple-1MiB', expect: 'measure' as const }];
    expect(projectMs(one, s1, v2, dry, 0, 1, 1, 'memory')).toBeGreaterThan(0);
    expect(projectMs(one, base, v2, dry, 0, 1, 1, 'memory')).toBe(0);
  });

  it('runs a shard: checks every pair once, times every passing one with the arms, never spawns a declared pair', async () => {
    const shard = s1.campaign.shards.find((x) => x.id === 'S1-1MiB');
    const caseIds = shard?.cases ?? [];
    const pairs = expectedPairsV2(s1, v2, 'campaign', caseIds);
    const file = join(scratchDir('s1-shard'), 'S1-1MiB.jsonl');
    const { spawn, argv } = standIn();
    const { entries, entrySha256 } = bundleArms(
      s1,
      v2,
      'S1',
      'dist/index.js',
      'twin/index.js',
      'entry-sha',
    );
    const common = {
      manifest: s1,
      v2,
      shardId: 'S1-1MiB',
      campaignSeed: 7,
      cases: s1.cases.filter((c) => caseIds.includes(c.id)),
      processes: 2,
      memoryProcesses: 1,
      copies: ['/copies/c1'],
      entries,
      entrySha256,
      identities: { '*': { commit: 'c0ffee', distSha256: 'dist-sha' } },
      harnessCommit: 'ba5e',
      machine: { cpuModel: 'cpu', kernel: 'k' },
      pinCpu: null,
      inputs: Object.fromEntries(caseIds.map((id) => [id, `/fixtures/${id}.csv`])),
      guards: guards(),
      checkpoint: jsonlCheckpoint(file),
      spawnWorker: spawn,
    };
    expect(await runShardV2({ ...common, pairs, phase: 'timing' })).toBe('complete');
    const records = lines(file);
    const of = (type: string, impl: string) =>
      records.filter((r) => r.type === type && r.impl === impl);
    for (const impl of [s1.candidate, v2.aa.impl, ...arms, 'papaparse']) {
      expect(of('check', impl)).toHaveLength(6);
      expect(of('time', impl)).toHaveLength(6 * 2);
    }
    expect(records.find((r) => r.impl === 'd3-dsv')).toMatchObject({
      status: 'UNSUPPORTED',
      declared: true,
    });
    expect(argv.some((a) => a.includes('d3-dsv'))).toBe(false);
    const armJobs = argv.filter((a) => arms.some((arm) => a.includes(arm)));
    expect(
      armJobs.every(
        (a) =>
          a[a.indexOf('--load') + 1] === 'entry' &&
          a[a.indexOf('--entry') + 1] === '/copies/c1/dist/index.js',
      ),
    ).toBe(true);
    // The memory phase: one memory process per measured pair of every S1 case, the arms included.
    const memFile = join(scratchDir('s1-memory'), 'M.jsonl');
    const scored = expectedPairsV2(s1, v2, 'campaign', ids(s1.cases));
    expect(
      await runShardV2({
        ...common,
        shardId: 'M',
        cases: s1.cases,
        pairs: scored,
        phase: 'memory',
        checkpoint: jsonlCheckpoint(memFile),
      }),
    ).toBe('complete');
    const memory = lines(memFile).filter((r) => r.type === 'memory');
    expect(memory.filter((r) => r.impl === BULK_IMPL)).toHaveLength(12);
    expect(memory.filter((r) => r.impl === 'papaparse')).toHaveLength(12);
  });

  it('bench/run.ts names S1 among the lanes it accepts', () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_COMPILE_CACHE;
    const r = spawnSync(process.execPath, ['bench/run.ts', '--method', 'v2', '--lane', 'B3'], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'unknown --lane B3 (S1 or W1; without it the B1/B2/S1 manifest runs)',
    );
  });
});

describe('the S1 report (report.ts scoreV2, renderV2)', () => {
  // The campaigns below are written for 10 rounds; the real process count is pinned in
  // bench-v2-run.test.ts.
  const scoring: ManifestV2 = { ...v2, measurement: { ...v2.measurement, processes: 10 } };
  const s1 = s1Manifest(base, v2);
  const settings = {
    samples: v2.measurement.samples,
    minSampleMs: v2.measurement.minSampleMs,
    warmupMs: v2.measurement.warmupMs,
    minWarmupOps: v2.measurement.minWarmupOps,
  };
  const ms = (impl: string, c: string) =>
    impl === 'udsv' && c === 'S1-wide-1MiB'
      ? 8
      : impl === 'csv-engine-batch4096' && c === 'S1-unicode-32MiB'
        ? 9
        : impl === BULK_IMPL && c === 'S1-quote-heavy-1MiB'
          ? 9
          : ({
              'csv-engine': 10,
              'csv-engine-aa': 10,
              'csv-engine-batch256': 11,
              'csv-engine-batch4096': 10.5,
              [BULK_IMPL]: 12,
              papaparse: 20,
            }[impl] ?? 15);
  const startOf = (
    id: string,
    phase: 'timing' | 'memory',
    planned: string[],
    lane: string | null,
  ) => ({
    type: 'start',
    method: 'v2',
    kind: 'campaign',
    phase,
    ...(lane === null ? {} : { lane }),
    campaignId: 's1',
    shardId: id,
    seed: 42,
    plannedCases: planned,
    measurement: scoring.measurement,
    filters: { cases: null, impls: null, processes: null, memoryProcesses: null },
    runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
    packages: s1.competitors,
    ...HASHES,
    source: { gitCommit: 'c0ffee', sha256: 'source' },
    candidate: { commit: 'c0ffee', distSha256: 'dist-sha', aaImpl: v2.aa.impl },
    pinning: { cpu: 2, siblings: [2, 6], runnerCpus: [3] },
    environment: { cpu: 'cpu' },
  });
  const empty = (round: number, seedBase: number): JobRecord => ({
    type: 'empty',
    impl: '-',
    case: '-',
    round,
    identity: { ...IDENTITY, v8Seed: seedBase + round },
    rssBytes: 40 * 2 ** 20,
    workerMaxRssBytes: 42 * 2 ** 20,
    peakRssMethod: 'linux-proc-self-status-VmHWM',
  });
  function timing(id: string, lane: string | null = 'S1'): Shard {
    const caseIds = s1.campaign.shards.find((x) => x.id === id)?.cases ?? [];
    const records: JobRecord[] = [];
    for (const p of expectedPairsV2(s1, v2, 'campaign', caseIds)) {
      if (p.expect !== 'measure') {
        records.push({
          type: 'check',
          impl: p.impl,
          case: p.case,
          round: 0,
          status: 'UNSUPPORTED',
          declared: true,
          reason: p.reason ?? '',
          identity: IDENTITY,
        });
        continue;
      }
      records.push({
        type: 'check',
        impl: p.impl,
        case: p.case,
        round: 0,
        status: 'PASS',
        identity: IDENTITY,
      });
      for (let round = 1; round <= 10; round++) {
        // The same round effect for every arm: the ratios are exact, so the tables can be read off.
        const t = ms(p.impl, p.case) * (1 + (JITTER[round - 1] ?? 0));
        records.push({
          type: 'time',
          impl: p.impl,
          case: p.case,
          round,
          identity: { ...IDENTITY, v8Seed: 100 + round },
          measurement: settings,
          process: { execArgv: ['--expose-gc', ...v2.measurement.repeatedNodeFlags] },
          samplesMs: [t * 1.01, t, t * 0.99],
        });
      }
    }
    for (let round = 1; round <= 10; round++) records.push(empty(round, 100));
    const start = startOf(id, 'timing', caseIds, lane);
    return {
      file: `${id}.jsonl`,
      start,
      records,
      end: { type: 'end', status: 'complete', source: start.source },
    } as unknown as Shard;
  }
  function memoryShard(): Shard {
    const records: JobRecord[] = [];
    const caseIds = ids(s1.cases);
    for (let round = 1; round <= 5; round++) {
      for (const p of expectedPairsV2(s1, v2, 'campaign', caseIds).filter(
        (x) => x.expect === 'measure',
      )) {
        const peak = (p.impl === BULK_IMPL ? 150 : 50) * 2 ** 20;
        records.push({
          type: 'memory',
          impl: p.impl,
          case: p.case,
          round,
          identity: { ...IDENTITY, v8Seed: 200 + round },
          peakRssMethod: 'linux-proc-self-status-VmHWM',
          loadedInputPeakRssBytes: 45 * 2 ** 20,
          peakRssBytes: peak,
          rssBeforeParseBytes: 44 * 2 ** 20,
        });
      }
      records.push(empty(round, 200));
    }
    const start = startOf('M', 'memory', caseIds, 'S1');
    return {
      file: 'M.jsonl',
      start,
      records,
      end: { type: 'end', status: 'complete', source: start.source },
    } as unknown as Shard;
  }
  const campaign = () => [
    timing('S1-1MiB'),
    timing('S1-32MiB-a'),
    timing('S1-32MiB-b'),
    memoryShard(),
  ];

  it('a complete S1 campaign: its own sections, the arms tables, losing cases first, no overall and no B1/B2 checks', () => {
    const s = scoreV2(s1, scoring, HASHES, campaign());
    expect(s.issues).toEqual([]);
    expect(s.cases).toHaveLength(12);
    expect(s.cases.find((r) => r.case === 'S1-wide-1MiB')).toMatchObject({
      competitor: 'udsv',
      classification: 'behind',
    });
    expect(s.counts.behind).toBe(1);
    expect(s.s1?.arms).toHaveLength(36);
    expect(
      s.s1?.arms.find((a) => a.case === 'S1-unicode-32MiB' && a.impl === 'csv-engine-batch4096')
        ?.ratio?.ratio,
    ).toBeCloseTo(0.9, 9);
    expect(s.s1?.memory.find((m) => m.case === 'S1-simple-1MiB')?.ratio).toBeCloseTo(1 / 3, 5);
    const { text, complete } = renderV2(s1, scoring, HASHES, campaign());
    expect(complete).toBe(true);
    expect(text).toMatch(/^# Benchmark report \(method v2, S1\): campaign s1$/m);
    expect(text).toMatch(/^## S1 \(byte chunks to records\)$/m);
    expect(text).toMatch(/^## S1 cases \(behind first, then inconclusive, then ahead\)$/m);
    expect(text).toMatch(/^Ahead 11, behind 1, inconclusive 0 of 12 S1 cases\.$/m);
    expect(text).not.toMatch(
      /## Result|## Primary cases|## Small inputs|Overall against|Reported check/,
    );
    const after = (heading: string) =>
      text
        .slice(text.indexOf(heading))
        .split('\n')
        .filter((l) => l.startsWith('| S1-'));
    expect(after('## S1 cases')[0]).toMatch(/^\| S1-wide-1MiB \| udsv \| 0\.800 /);
    expect(after('## Batch size')[0]).toMatch(
      /^\| S1-unicode-32MiB \| 1\.100 \[1\.100, 1\.100\] \| 0\.900 \[0\.900, 0\.900\] \| /,
    );
    expect(after('## Stream against bulk')[0]).toMatch(
      /^\| S1-quote-heavy-1MiB \| 0\.900 \[0\.900, 0\.900\] \|.*\| 50\.0 \| 150\.0 \| 0\.333 \|$/,
    );
    expect(text).toMatch(/^## Memory \(single run, no record retained/m);
  });

  it('a missing arm leaves the campaign incomplete, and S1 never mixes with B1/B2 or W1 runs', () => {
    const shards = campaign();
    const [first] = shards;
    if (first)
      first.records = first.records.filter(
        (r) => !(r.impl === BULK_IMPL && r.case === 'S1-simple-1MiB' && r.type === 'time'),
      );
    expect(scoreV2(s1, scoring, HASHES, shards).missingPairs).toContain(
      'csv-engine-bulk @ S1-simple-1MiB: timing rounds 1,2,3,4,5,6,7,8,9,10 missing',
    );
    const mixed = [
      timing('S1-1MiB', null),
      timing('S1-32MiB-a'),
      timing('S1-32MiB-b'),
      memoryShard(),
    ];
    expect(scoreV2(s1, scoring, HASHES, mixed).issues.join('\n')).toMatch(
      /S1-1MiB\.jsonl \(S1-1MiB\): a B1\/B2\/S1 run in a S1 report/,
    );
    expect(scoreV2(base, scoring, HASHES, campaign()).issues.join('\n')).toMatch(
      /an S1 run in a B1\/B2\/S1 report/,
    );
  });
});

describe('bench/ab.ts: the run path end to end with a stand-in worker (no timing)', () => {
  const hashes = {
    manifestSha256: manifestSha256(),
    manifestV2Sha256: createHash('sha256').update(readFileSync(MANIFEST_V2_PATH)).digest('hex'),
  };
  function arm(name: string): AbArm {
    const dir = scratchDir(`ab-${name}`);
    const distDir = join(dir, 'dist');
    mkdirSync(distDir);
    writeFileSync(join(distDir, 'index.js'), `export const arm = '${name}';\n`);
    return {
      commit: name.repeat(4),
      distSha256: treeSha256(distDir) ?? '',
      dir,
      distDir,
      entry: join(distDir, 'index.js'),
    };
  }
  async function ab(lane: 'S1' | 'W1', targets: string[], bOverA: (c: string) => number) {
    const lists = abCases(lane, targets, base, v2);
    const dir = scratchDir(`ab-${lane}`);
    // Placeholder fixtures: the stand-in worker reads no input, and nothing is generated.
    mkdirSync(join(dir, 'fixtures'));
    for (const c of lists.manifest.cases)
      writeFileSync(join(dir, 'fixtures', `${c.fixture?.sha256 ?? ''}.csv`), 'x\n');
    const a = arm('a');
    const b = arm('b');
    const { spawn } = standIn((impl, c) => (impl === 'b' ? 10 * bOverA(c) : 10), {
      a: a.entry,
      b: b.entry,
    });
    const outFile = join(dir, 'ab.jsonl');
    const options = abRunOptions({
      id: `ab-${lane}`,
      lane,
      manifest: lists.manifest,
      v2,
      caseIds: lists.cases,
      targets,
      seed: 9,
      processes: 10,
      budgetMinutes: 240,
      dryRunOnly: false,
      pinning: { cpu: 2, siblings: [2, 6], runnerCpus: [3] },
      outFile,
      copies: [ROOT],
      a,
      b,
    });
    const code = await runV2({ ...options, spawnWorker: spawn, fixtureDir: join(dir, 'fixtures') });
    const shard = parseShard(readFileSync(outFile, 'utf8'), outFile);
    // bench/ab.ts itself refuses any Node but the manifest's; this test runs on three.
    (shard.start as unknown as { runtime: { node: string } }).runtime.node =
      `v${base.runtime.node}`;
    return {
      code,
      shard,
      records: lines(outFile),
      report: renderAb(lists.manifest, v2, hashes, shard),
    };
  }
  const oneChunk = FAMILIES.map((f) => `S1-${f}-32MiB-one-chunk`);

  it('--lane S1: the twelve 32 MiB cases, both arms checked and timed, labelled S1; keep, then reject on a guard', async () => {
    const keep = await ab('S1', oneChunk, (c) => (oneChunk.includes(c) ? 0.95 : 1));
    expect(keep.code).toBe(0);
    expect(keep.records[0]).toMatchObject({
      type: 'start',
      kind: 'ab',
      lane: 'S1',
      ab: { targets: oneChunk },
    });
    const timed = keep.records.filter((r) => r.type === 'time');
    expect(new Set(timed.map((r) => r.case)).size).toBe(12);
    expect(timed).toHaveLength(12 * 2 * 10);
    expect(keep.records.filter((r) => r.type === 'check')).toHaveLength(24);
    expect(keep.report.decision).toBe('keep');
    expect(keep.report.text).toMatch(/^# A\/B report \(method v2, S1\): ab-S1$/m);
    const reject = await ab('S1', oneChunk, (c) =>
      oneChunk.includes(c) ? 0.95 : c === 'S1-wide-32MiB' ? 1.03 : 1,
    );
    expect(reject.report.decision).toBe('reject');
    expect(reject.report.text).toMatch(/^- S1-wide-32MiB: lower bound 1\.0\d\d is above 1\.01$/m);
  }, 120_000);

  it('--lane W1: the 24 W1 cases, labelled W1; keep', async () => {
    const target = ['W1-rows-unicode-1MiB'];
    const keep = await ab('W1', target, (c) => (target.includes(c) ? 0.95 : 1));
    expect(keep.records[0]).toMatchObject({ type: 'start', kind: 'ab', lane: 'W1' });
    expect(new Set(keep.records.filter((r) => r.type === 'time').map((r) => r.case)).size).toBe(24);
    expect(keep.report.decision).toBe('keep');
    expect(keep.report.text).toMatch(/^# A\/B report \(method v2, W1\): ab-W1$/m);
  }, 120_000);
});

function guards(): Guards {
  return {
    deadlineAt: Date.now() + 120_000,
    rssLimitBytes: 2 * 1024 ** 3,
    rssPollMs: 1000,
    diskFloorBytes: 0,
    tempCapBytes: Infinity,
    freeDiskBytes: () => Infinity,
    tempUsageBytes: () => 0,
    signal: new AbortController().signal,
  };
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A worker that answers at once: every check PASS, time records with three equal samples
 * of `ms(impl, case)` and the manifest's loop settings, and the process fields the runner
 * compares (cwd, pad, CPU, seed flags, entry and its hash).
 */
function standIn(
  ms: (impl: string, c: string) => number = () => 10,
  entrySha: Record<string, string> = {},
): { spawn: SpawnV2; argv: string[][] } {
  const argv: string[][] = [];
  const spawn: SpawnV2 = (args, _guards, command, options) => {
    argv.push(args);
    const arg = (name: string) => args[args.indexOf(name) + 1] ?? '';
    const mode = arg('--mode');
    const impl = arg('--impl');
    const entry = arg('--entry');
    const t = ms(impl, arg('--case'));
    const record = {
      mode,
      // A real check reports its probe; the runner takes the pair's regime and Node flags from it.
      ...(mode === 'check' ? { status: 'PASS', opMs: t } : {}),
      ...(mode === 'time'
        ? {
            samplesMs: [t, t, t],
            inputLoadMs: 1,
            measurement: {
              samples: v2.measurement.samples,
              minSampleMs: v2.measurement.minSampleMs,
              warmupMs: v2.measurement.warmupMs,
              minWarmupOps: v2.measurement.minWarmupOps,
            },
          }
        : {}),
      ...(mode === 'memory'
        ? {
            peakRssMethod: 'linux-proc-self-status-VmHWM',
            peakRssBytes: 2,
            loadedInputPeakRssBytes: 1,
          }
        : {}),
      ...(mode === 'empty' ? { rssBytes: 1, workerMaxRssBytes: 1 } : {}),
      process: {
        node: process.version,
        cwd: options.cwd,
        execArgv: args.filter(
          (a, i) => a.startsWith('--') && i < args.findIndex((x) => x.endsWith('worker.ts')),
        ),
        cpusAllowed: command === 'taskset' ? args[1] : null,
        padLength: (options.env.CSV_BENCH_PAD ?? '').length,
        entry: arg('--load') === 'entry' ? entry : null,
        entrySha256:
          arg('--load') === 'entry'
            ? Object.entries(entrySha).some(([, e]) => e === entry)
              ? createHash('sha256').update(readFileSync(entry)).digest('hex')
              : 'entry-sha'
            : null,
      },
    };
    const outcome: JobOutcome = { status: 'ok', record, wallMs: 1, peakPolledRssBytes: 1 };
    return Promise.resolve(outcome);
  };
  return { spawn, argv };
}
