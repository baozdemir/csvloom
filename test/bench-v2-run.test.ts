import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scratchDir } from './scratch.ts';
import {
  expectedPairs,
  expectedPairsV2,
  MANIFEST_PUB_PATH,
  manifestPubIssues,
  manifestSha256,
  manifestV2Issues,
  methodOf,
  pairNodeFlags,
  readManifest,
  readManifestV2,
  readMethod,
  seedFor,
  type ManifestPub,
  type ManifestV2,
} from '../bench/manifest.ts';
import { abPreflight } from '../bench/ab.ts';
import {
  commitOf,
  installedVersions,
  jsonlCheckpoint,
  dryRunCases,
  loopMs,
  parseCpuList,
  prepareCopies,
  projectMs,
  refuseNodeEnvironment,
  requestedPinning,
  roundOrder,
  runJob,
  runShard,
  runShardV2,
  runV2,
  setupFor,
  treeSha256,
  v8Seeds,
  verifyCopyPackages,
  verifyDist,
  verifyPinning,
  type Guards,
  type JobOutcome,
  type PinDeps,
  type ShardV2Context,
  type SpawnV2,
} from '../bench/run.ts';

// Method v2 runner: the manifest, the seeded order and setup, the bundle and its
// A/A copy, pinning, the identity on every record, the stale-bundle refusal and
// the projection. Only the tests that say so start real worker processes.

const V1_SHA = 'd7581c13f2a50f5e126bbe697ae6131c6aad253deb437f493346cbf64ee93e5b';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = readManifest();
const v2 = readManifestV2();

function guards(overrides: Partial<Guards> = {}): Guards {
  return {
    deadlineAt: Date.now() + 120_000,
    rssLimitBytes: 2 * 1024 ** 3,
    rssPollMs: 1000,
    diskFloorBytes: 0,
    tempCapBytes: Infinity,
    freeDiskBytes: () => Infinity,
    tempUsageBytes: () => 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}
const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const scratch = scratchDir;

describe('manifest v2', () => {
  it('holds the values method v2 fixes', () => {
    expect(v2.measurement).toEqual({
      processes: 20,
      samples: 3,
      minSampleMs: 250,
      warmupMs: 500,
      minWarmupOps: 3,
      rewarmMs: 250,
      singleOperationMinMs: 90,
      singleOperationSampledMs: 750,
      repeatedNodeFlags: ['--no-osr-from-maglev'],
      processStatistic: 'median',
      memoryProcesses: 5,
      memoryShard: 'M',
    });
    expect(v2.setup).toEqual({
      copies: ['c1', 'c2/d/e', 'c3/d/e/f/g'],
      padEnv: 'CSV_BENCH_PAD',
      padMaxLength: 4096,
    });
    expect(v2.seeds).toEqual({
      scope: 'round',
      flags: ['--random-seed', '--hash-seed'],
      min: 1,
      max: 2147483647,
    });
    expect(v2.candidate).toEqual({
      distDir: 'dist',
      entry: 'index.js',
      buildCommand: ['node', 'scripts/build.mjs'],
    });
    expect(v2.aa).toEqual({ impl: 'csv-engine-aa', distDir: 'twin' });
    expect(v2.placement).toEqual({
      tool: 'taskset',
      requiredFor: ['campaign', 'calibration', 'ab'],
      reportedChecks: { siblingBusyMax: 0.01, stealMax: 0.005 },
    });
    expect(v2.statistics).toEqual({
      bootstrapResamples: 10000,
      confidence: 0.95,
      familyWiseAlpha: 0.05,
    });
    expect(v2.calibration).toEqual({
      maxIntervalsExcludingOne: 3,
      maxHalfWidth: 0.025,
      maxMedianHalfWidth: 0.015,
    });
    expect(v2.ab).toEqual({ minProcesses: 10, targetUpperBelow: 0.98, otherLowerAbove: 1.01 });
    expect(v2.budget).toEqual({
      defaultMinutes: 240,
      dryRun: {
        targetBytes: 1048576,
        checkFamily: 'simple',
        samples: 1,
        minSampleMs: 50,
        warmupMs: 150,
      },
    });
  });

  it('names the frozen v1 manifest by hash, and v1 is byte-identical', () => {
    expect(manifestSha256()).toBe(V1_SHA);
    expect(v2.base).toEqual({ path: 'manifest.json', sha256: V1_SHA });
    expect(manifest.measurement).toMatchObject({ samples: 7, repetitions: 3, orderSeed: 20261026 });
  });

  it('rejects each invalid setting with its reason', () => {
    const issues = (change: (m: ManifestV2) => void) => {
      const copy = structuredClone(v2);
      change(copy);
      return manifestV2Issues(copy, manifest, V1_SHA).join('\n');
    };
    expect(manifestV2Issues(v2, manifest, V1_SHA)).toEqual([]);
    expect(manifestV2Issues(v2, manifest, 'other')).toEqual([
      `base manifest sha256 is other, not ${V1_SHA}`,
    ]);
    expect(issues((m) => (m.measurement.processes = 1))).toMatch(/processes must be an integer/);
    expect(issues((m) => (m.measurement.samples = 0))).toMatch(/samples must be a positive/);
    expect(issues((m) => (m.measurement.memoryProcesses = m.measurement.processes + 1))).toMatch(
      /memoryProcesses/,
    );
    expect(issues((m) => (m.measurement.repeatedNodeFlags = ['no-osr-from-maglev']))).toMatch(
      /repeatedNodeFlags must be a list of Node flags/,
    );
    expect(issues((m) => (m.measurement.repeatedNodeFlags = []))).toBe('');
    expect(issues((m) => (m.aa.distDir = 'dist'))).toMatch(/aa\.distDir must differ/);
    expect(issues((m) => (m.aa.distDir = 'dist-aa'))).toMatch(/same length/);
    expect(issues((m) => (m.aa.impl = 'papaparse'))).toMatch(/aa\.impl must not name/);
    expect(issues((m) => (m.setup.copies = ['a', 'b', 'c']))).toMatch(/different path depths/);
    expect(issues((m) => (m.setup.padMaxLength = -1))).toMatch(/padMaxLength/);
    expect(issues((m) => (m.statistics.bootstrapResamples = 10))).toMatch(/bootstrapResamples/);
    expect(issues((m) => (m.statistics.confidence = 1))).toMatch(/confidence/);
    expect(issues((m) => (m.budget.dryRun.targetBytes = 5))).toMatch(
      /budget\.dryRun: no B1 simple case of 5 bytes/,
    );
    expect(issues((m) => (m.budget.dryRun.samples = 0))).toMatch(/budget\.dryRun needs/);
  });

  it('readManifestV2 throws on an invalid file', () => {
    const file = join(scratch('v2'), 'manifest-v2.json');
    writeFileSync(file, JSON.stringify({ ...v2, measurement: { ...v2.measurement, samples: 0 } }));
    expect(() => readManifestV2(file)).toThrow(/invalid v2 manifest .*samples must be a positive/);
  });

  it('adds the A/A arm on the 24 primary cases; a calibration has only the two candidate arms', () => {
    const campaign = expectedPairsV2(manifest, v2, 'campaign');
    const aa = campaign.filter((p) => p.impl === 'csv-engine-aa');
    expect(aa).toHaveLength(24);
    expect(aa.every((p) => p.expect === 'measure')).toBe(true);
    expect(campaign.filter((p) => p.impl !== 'csv-engine-aa')).toEqual(expectedPairs(manifest));
    const calibration = expectedPairsV2(manifest, v2, 'calibration');
    expect(calibration).toHaveLength(48);
    expect(new Set(calibration.map((p) => p.impl))).toEqual(
      new Set(['csv-engine', 'csv-engine-aa']),
    );
    expect(new Set(calibration.map((p) => p.case)).size).toBe(24);
  });
});

// The publication method: v2 with the values of bench/manifest-pub.json in place of its own.
describe('publication method (bench/manifest-pub.json)', () => {
  const V2_SHA = '2ac72f3204f89c9a2b590fcd02bd4e21413277996760c43e687a01e8c0eb1d9e';
  const file = () => JSON.parse(readFileSync(MANIFEST_PUB_PATH, 'utf8')) as ManifestPub;
  const fileSha = () => createHash('sha256').update(readFileSync(MANIFEST_PUB_PATH)).digest('hex');

  it('states only what differs, and names manifest-v2.json by hash', () => {
    expect(readMethod('v2').sha256).toBe(V2_SHA);
    const { status, ...values } = file();
    expect(status).toMatch(/^The publication method /);
    expect(values).toEqual({
      schemaVersion: 1,
      method: 'pub',
      base: { path: 'manifest-v2.json', sha256: V2_SHA },
      runtime: { node: '26.13.1' },
      competitors: { papaparse: '5.7.1' },
      installedAs: { papaparse: 'papaparse-5.7.1' },
      measurement: { repeatedNodeFlags: [] },
    });
  });

  it('is v2 with those values replaced, in the v1 manifest and in the W1 section, and nothing else', () => {
    const pub = readMethod('pub');
    expect(pub.manifest).toEqual({
      ...manifest,
      runtime: { ...manifest.runtime, node: '26.13.1' },
      competitors: { ...manifest.competitors, papaparse: '5.7.1' },
    });
    expect(pub.v2).toEqual({
      ...v2,
      measurement: { ...v2.measurement, repeatedNodeFlags: [] },
      w1: { ...v2.w1, competitors: { ...v2.w1.competitors, papaparse: '5.7.1' } },
      pub: file(),
    });
    expect(pub).toMatchObject({
      name: 'pub',
      path: MANIFEST_PUB_PATH,
      sha256: fileSha(),
      installedAs: { papaparse: 'papaparse-5.7.1' },
    });
    // Method v2 itself keeps its own values, its Node flag included, for decisions and diagnosis.
    expect(readMethod('v2')).toMatchObject({
      name: 'v2',
      manifest,
      v2,
      installedAs: { papaparse: 'papaparse-5.7.0' },
    });
    expect(readMethod('v2').v2.pub).toBeUndefined();
    expect(() => readMethod('v9')).toThrow(/unknown method v9 \(v2 or pub\)/);
  });

  it('rejects each invalid file with its reason', () => {
    const issues = (change: (m: ManifestPub) => void) => {
      const copy = file();
      change(copy);
      return manifestPubIssues(copy, manifest, V2_SHA).join('\n');
    };
    expect(manifestPubIssues(file(), manifest, V2_SHA)).toEqual([]);
    expect(manifestPubIssues(file(), manifest, 'other')).toEqual([
      `manifest-v2.json sha256 is other, not ${V2_SHA}`,
    ]);
    expect(issues((m) => (m.method = 'v2'))).toMatch(/schemaVersion must be 1 and method "pub"/);
    expect(issues((m) => (m.runtime.node = '26'))).toMatch(/runtime\.node must be a version/);
    expect(issues((m) => (m.competitors.papaparse = 'latest'))).toMatch(
      /papaparse needs a version/,
    );
    expect(issues((m) => (m.competitors.nothing = '1.0.0'))).toMatch(
      /nothing is not a package of the manifest/,
    );
    expect(issues((m) => (m.installedAs.udsv = 'udsv-2'))).toMatch(
      /installedAs may name only packages of competitors/,
    );
    // Anything else stays as the frozen manifests have it.
    expect(issues((m) => Object.assign(m.measurement, { processes: 5 }))).toMatch(
      /it may replace only runtime\.node, competitors/,
    );
    expect(issues((m) => Object.assign(m.runtime, { flags: [] }))).toMatch(/it may replace only/);
    expect(issues((m) => Object.assign(m, { calibration: {} }))).toMatch(/it may replace only/);
  });

  it('a run is read under the method whose manifest its start record names by hash, else under v2', () => {
    expect(methodOf(fileSha()).name).toBe('pub');
    expect(methodOf(V2_SHA).name).toBe('v2');
    expect(methodOf('the hash of an earlier manifest').name).toBe('v2');
    expect(methodOf(undefined).name).toBe('v2');
  });

  it('the installed packages are the ones each method names: papaparse 5.7.0 for v2, 5.7.1 for publication and the tests', () => {
    const v2Method = readMethod('v2');
    const pub = readMethod('pub');
    expect(installedVersions(manifest, v2Method.installedAs)).toEqual(manifest.competitors);
    expect(installedVersions(pub.manifest, pub.installedAs)).toEqual(pub.manifest.competitors);
    expect(installedVersions(manifest, v2Method.installedAs).papaparse).toBe('5.7.0');
    expect(installedVersions(pub.manifest, pub.installedAs).papaparse).toBe('5.7.1');
    // The root holds the tests' papaparse, 5.7.1: v2 and v1 runs need their copies or refuse.
    expect(installedVersions(manifest).papaparse).toBe('5.7.1');
    verifyCopyPackages(pub.manifest, [ROOT]);
    expect(() => {
      verifyCopyPackages(manifest, [ROOT]);
    }).toThrow(/holds papaparse 5\.7\.1 \(manifest: 5\.7\.0\); run npm ci$/);
  });
});

describe('seeded order and setup', () => {
  const jobs = Array.from({ length: 40 }, (_, i) => `job-${String(i)}`);

  it('seedFor is a stable 32-bit value per seed and label', () => {
    expect(seedFor(1, 'order:S1:1')).toBe(seedFor(1, 'order:S1:1'));
    expect(seedFor(1, 'order:S1:1')).not.toBe(seedFor(1, 'order:S1:2'));
    expect(seedFor(1, 'order:S1:1')).not.toBe(seedFor(2, 'order:S1:1'));
    expect(seedFor(7, 'x')).toBe(1836028174);
  });

  it('a round order is a permutation, the same for a seed, new for another seed, round or shard', () => {
    const order = roundOrder(jobs, 12345, 'S1', 1);
    expect([...order].sort()).toEqual([...jobs].sort());
    expect(order).not.toEqual(jobs);
    expect(roundOrder(jobs, 12345, 'S1', 1)).toEqual(order);
    expect(roundOrder(jobs, 12346, 'S1', 1)).not.toEqual(order);
    expect(roundOrder(jobs, 12345, 'S1', 2)).not.toEqual(order);
    expect(roundOrder(jobs, 12345, 'S2', 1)).not.toEqual(order);
  });

  it('a process setup is seeded, uses every checkout copy and pad lengths over 0-4096', () => {
    expect(setupFor(v2, 3, 5, 'S1:1:time:udsv:B1-simple-1MiB')).toEqual(
      setupFor(v2, 3, 5, 'S1:1:time:udsv:B1-simple-1MiB'),
    );
    const setups = Array.from({ length: 3000 }, (_, i) => setupFor(v2, 3, 5, `label-${String(i)}`));
    expect(new Set(setups.map((s) => s.checkoutCopy))).toEqual(new Set([0, 1, 2]));
    const pads = setups.map((s) => s.padLength);
    expect(pads.every((p) => Number.isInteger(p) && p >= 0 && p <= 4096)).toBe(true);
    expect(Math.min(...pads)).toBeLessThan(50);
    expect(Math.max(...pads)).toBeGreaterThan(4046);
    expect(setupFor(v2, 3, 6, 'label-0')).not.toEqual(setupFor(v2, 3, 5, 'label-0'));
  });
});

describe('one V8 seed per round', () => {
  it('seeds are derived from the campaign seed, non-zero, inside the 32-bit signed range and distinct per round', () => {
    const seeds = v8Seeds(v2, 20261110, 'S1', 10);
    expect(seeds).toHaveLength(11);
    expect(new Set(seeds).size).toBe(11);
    expect(seeds.every((s) => Number.isInteger(s) && s >= 1 && s <= 2147483647)).toBe(true);
    expect(v8Seeds(v2, 20261110, 'S1', 10)).toEqual(seeds);
    expect(v8Seeds(v2, 20261110, 'S1', 4)).toEqual(seeds.slice(0, 5));
    expect(v8Seeds(v2, 20261111, 'S1', 10)).not.toEqual(seeds);
    expect(v8Seeds(v2, 20261110, 'S2', 10)).not.toEqual(seeds);
    expect(seeds[1]).toBe(1 + (seedFor(20261110, 'v8:S1:1') % 2147483647));
    // A range too small to avoid repeats by chance still gives distinct seeds.
    const tiny = { ...v2, seeds: { ...v2.seeds, min: 1, max: 12 } };
    const few = v8Seeds(tiny, 1, 'S1', 10);
    expect(new Set(few).size).toBe(11);
    expect(few.every((s) => s >= 1 && s <= 12)).toBe(true);
  });

  it('every process of a round gets the round seed as --random-seed and --hash-seed, and the record states it', async () => {
    const { spawn, calls } = fakeWorker();
    const { file, ctx } = context(spawn);
    await runShardV2(ctx);
    const seeds = v8Seeds(v2, ctx.campaignSeed, ctx.shardId, ctx.processes);
    const records = lines(file).filter((r) => typeof r.wallMs === 'number');
    expect(records).toHaveLength(calls.length);
    for (const [i, r] of records.entries()) {
      const seed = seeds[r.round as number];
      expect((r.identity as { v8Seed: number }).v8Seed).toBe(seed);
      expect(calls[i]?.argv).toContain(`--random-seed=${String(seed)}`);
      expect(calls[i]?.argv).toContain(`--hash-seed=${String(seed)}`);
    }
    // Same round: one seed for every arm, the empty process included. Different rounds: different seeds.
    for (const round of [1, 2, 3, 4]) {
      const inRound = records.filter((r) => r.round === round);
      expect(new Set(inRound.map((r) => r.impl)).size).toBeGreaterThan(4);
      expect(new Set(inRound.map((r) => (r.identity as { v8Seed: number }).v8Seed))).toEqual(
        new Set([seeds[round]]),
      );
    }
    expect(new Set(seeds.slice(1)).size).toBe(4);
    // The memory phase follows the same rule with its own seeds.
    const memory = fakeWorker();
    const run = context(memory.spawn, { phase: 'memory', shardId: 'M' });
    await runShardV2(run.ctx);
    const memorySeeds = v8Seeds(v2, run.ctx.campaignSeed, 'M', 2);
    for (const r of lines(run.file))
      expect((r.identity as { v8Seed: number }).v8Seed).toBe(memorySeeds[r.round as number]);
  });

  it('ends the shard when a worker did not start with the seed flags', async () => {
    const { spawn } = fakeWorker();
    const unseeded: SpawnV2 = async (argv, g, command, options) => {
      const out = await spawn(argv, g, command, options);
      if (out.status === 'ok' && argv.includes('time'))
        (out.record.process as Record<string, unknown>).execArgv = ['--expose-gc'];
      return out;
    };
    const { file, ctx } = context(unseeded);
    expect(await runShardV2(ctx)).toBe('setup-mismatch');
    expect(lines(file).at(-1)).toMatchObject({
      status: 'BLOCKED',
      blocked: 'setup-mismatch',
      detail: expect.stringMatching(
        /^execArgv is \["--expose-gc"\], requested --random-seed=\d+ --hash-seed=\d+$/,
      ) as unknown,
    });
  });
});

describe('the bundle the campaign measures', () => {
  function tree() {
    const dir = join(scratch('dist'), 'dist');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'export const parse = 1;\n');
    writeFileSync(join(dir, 'sub', 'a.js'), 'a\n');
    return dir;
  }

  it('treeSha256 covers file bytes and names, and is null for a missing or empty directory', () => {
    const dir = tree();
    const sha = treeSha256(dir);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(treeSha256(dir)).toBe(sha);
    writeFileSync(join(dir, 'sub', 'a.js'), 'b\n');
    const changed = treeSha256(dir);
    expect(changed).not.toBe(sha);
    renameSync(join(dir, 'sub', 'a.js'), join(dir, 'sub', 'b.js'));
    expect(treeSha256(dir)).not.toBe(changed);
    expect(treeSha256(join(dir, 'missing'))).toBeNull();
    mkdirSync(join(dir, 'empty'));
    expect(treeSha256(join(dir, 'empty'))).toBeNull();
  });

  it('refuses a missing bundle, modified build inputs and a bundle that a fresh build does not reproduce', () => {
    const distDir = tree();
    const sha = treeSha256(distDir) ?? '';
    const check = {
      commit: 'abc123',
      distDir,
      dirtyBuildInputs: () => '',
      freshBuildSha256: () => sha,
    };
    expect(verifyDist(check)).toBe(sha);
    expect(() => verifyDist({ ...check, distDir: join(distDir, 'missing') })).toThrow(
      /missing or empty: build it at commit abc123/,
    );
    expect(() => verifyDist({ ...check, dirtyBuildInputs: () => ' M src/parser.ts' })).toThrow(
      /build inputs differ from commit abc123[^]* M src\/parser\.ts/,
    );
    expect(() => verifyDist({ ...check, freshBuildSha256: () => 'f'.repeat(64) })).toThrow(
      new RegExp(`is stale: its SHA-256 ${sha} is not that of a fresh build of abc123 \\(f{64}\\)`),
    );
  });
});

// A root with the real harness, no packages and a stand-in bundle that re-exports
// the source parser: enough for the two candidate arms to run as real processes.
function fakeRoot(measurement: Partial<ManifestV2['measurement']> = {}) {
  const root = scratch('root');
  cpSync(join(ROOT, 'bench'), join(root, 'bench'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'node_modules', 'some-package'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'some-package', 'index.js'), 'export default 1;\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'dist', 'index.js'),
    `export { parse } from ${JSON.stringify(join(ROOT, 'src', 'parse.ts'))};\n`,
  );
  const quick = { ...v2, measurement: { ...v2.measurement, ...measurement } };
  writeFileSync(join(root, 'bench', 'manifest-v2.json'), JSON.stringify(quick));
  return { root, quick, distSha256: treeSha256(join(root, 'dist')) ?? '' };
}

describe('checkout copies and the A/A arm', () => {
  it('makes three copies at different depths; the A/A bundle is another path with identical bytes', () => {
    const { root, quick, distSha256 } = fakeRoot();
    const copies = prepareCopies(root, join(root, 'work', 'copies'), quick, distSha256);
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.split('/').length - root.split('/').length)).toEqual([3, 5, 7]);
    for (const copy of copies) {
      const candidate = join(copy, 'dist', 'index.js');
      const aa = join(copy, 'twin', 'index.js');
      expect(aa).not.toBe(candidate);
      expect(aa).toHaveLength(candidate.length);
      expect(realpathSync(aa)).not.toBe(realpathSync(candidate));
      expect(readFileSync(aa).equals(readFileSync(candidate))).toBe(true);
      expect(treeSha256(join(copy, 'twin'))).toBe(distSha256);
      expect(treeSha256(join(copy, 'bench'))).toBe(treeSha256(join(root, 'bench')));
      // Packages are real files at the copy's own path, not links back to the root.
      const pkg = join(copy, 'node_modules', 'some-package', 'index.js');
      expect(realpathSync(pkg)).toBe(pkg);
    }
  });

  it('copies a bundle built elsewhere (--candidate-commit) instead of the root dist/', () => {
    const { root, quick } = fakeRoot();
    const built = join(scratch('built'), 'dist');
    mkdirSync(built);
    writeFileSync(join(built, 'index.js'), 'export const parse = () => ({ data: [] });\n');
    const sha = treeSha256(built) ?? '';
    expect(sha).not.toBe(treeSha256(join(root, 'dist')));
    const copies = prepareCopies(root, join(root, 'work', 'copies'), quick, sha, built);
    for (const copy of copies) {
      expect(treeSha256(join(copy, 'dist'))).toBe(sha);
      expect(treeSha256(join(copy, 'twin'))).toBe(sha);
    }
    // The root's own dist/ is not what was asked for: refused.
    expect(() => prepareCopies(root, join(root, 'work', 'copies'), quick, sha)).toThrow(
      /does not hold the verified bundle/,
    );
  });

  it('a copy holds the papaparse its method names, under the name the adapters import: 5.7.0 under v2, 5.7.1 under the publication method', () => {
    const { root, quick, distSha256 } = fakeRoot();
    const v2Method = readMethod('v2');
    const pub = readMethod('pub');
    for (const dir of ['papaparse', 'papaparse-5.7.0', 'papaparse-5.7.1'])
      cpSync(join(ROOT, 'node_modules', dir), join(root, 'node_modules', dir), { recursive: true });
    // By behaviour: 5.7.1 writes the header of an empty input with columns, 5.7.0 writes nothing.
    const header = (from: string) =>
      (
        createRequire(join(from, 'bench', 'adapters', 'papaparse.ts'))('papaparse') as {
          unparse: (rows: unknown[], config: { columns: string[] }) => string;
        }
      ).unparse([], { columns: ['a', 'b', 'c'] });
    // The copies' packages, read where a worker resolves them (the fake root holds papaparse only).
    const only = (m: typeof manifest) => ({
      ...m,
      competitors: { papaparse: m.competitors.papaparse ?? '' },
    });
    const copiesOf = (name: string, installedAs: Record<string, string>) =>
      prepareCopies(root, join(root, 'work', name), quick, distSha256, undefined, installedAs);
    const v2Copies = copiesOf('copies-v2', v2Method.installedAs);
    const pubCopies = copiesOf('copies-pub', pub.installedAs);
    for (const [copies, written] of [
      [v2Copies, ''],
      [pubCopies, 'a,b,c'],
    ] as const) {
      expect(copies).toHaveLength(3);
      for (const copy of copies) {
        expect(header(copy)).toBe(written);
        // Real files at the copy's own path, like every other package.
        const pkg = join(copy, 'node_modules', 'papaparse', 'papaparse.js');
        expect(realpathSync(pkg)).toBe(pkg);
      }
    }
    verifyCopyPackages(only(manifest), v2Copies);
    verifyCopyPackages(only(pub.manifest), pubCopies);
    // A run whose copies hold another method's papaparse is refused.
    expect(() => {
      verifyCopyPackages(only(pub.manifest), v2Copies);
    }).toThrow(/copies-v2\/c1 holds papaparse 5\.7\.0 \(manifest: 5\.7\.1\)/);
    expect(() => {
      verifyCopyPackages(only(manifest), pubCopies);
    }).toThrow(/copies-pub\/c1 holds papaparse 5\.7\.1 \(manifest: 5\.7\.0\)/);
    // Without a method's packages a copy holds the root's own papaparse.
    for (const copy of copiesOf('copies-root', {})) expect(header(copy)).toBe(header(root));
    expect(header(root)).toBe('a,b,c');
  });

  it('refuses a bundle that is not the verified one', () => {
    const { root, quick } = fakeRoot();
    expect(() => prepareCopies(root, join(root, 'work', 'copies'), quick, 'f'.repeat(64))).toThrow(
      /does not hold the verified bundle/,
    );
  });

  it('real processes: the two arms import different files with the same SHA-256, and a checkout copy holds no src/', async () => {
    const { root, quick, distSha256 } = fakeRoot({ warmupMs: 20, minSampleMs: 5 });
    const copies = prepareCopies(root, join(root, 'work', 'copies'), quick, distSha256);
    const file = join(root, 'shard.jsonl');
    const entrySha = createHash('sha256')
      .update(readFileSync(join(root, 'dist', 'index.js')))
      .digest('hex');
    const status = await runShardV2({
      manifest,
      v2: quick,
      shardId: 'S1',
      campaignSeed: 99,
      cases: manifest.cases.filter((c) => c.id === 'B1-simple-1KiB'),
      pairs: [
        { impl: 'csv-engine', case: 'B1-simple-1KiB', expect: 'measure' },
        { impl: 'csv-engine-aa', case: 'B1-simple-1KiB', expect: 'measure' },
      ],
      processes: 2,
      memoryProcesses: 0,
      copies,
      entries: { 'csv-engine': 'dist/index.js', 'csv-engine-aa': 'twin/index.js' },
      entrySha256: { 'csv-engine': entrySha, 'csv-engine-aa': entrySha },
      identities: { '*': { commit: 'commit', distSha256 } },
      harnessCommit: 'harness',
      phase: 'timing',
      machine: { cpuModel: 'cpu', kernel: 'kernel' },
      pinCpu: null,
      inputs: {},
      guards: guards(),
      checkpoint: jsonlCheckpoint(file),
    });
    expect(status).toBe('complete');
    // The stand-in bundle re-exports the repository's parser by absolute path; a copy
    // itself has no src/, so a v2 worker cannot fall back to the source adapter.
    for (const copy of copies) expect(existsSync(join(copy, 'src'))).toBe(false);
    const records = lines(file);
    expect(records.filter((r) => r.type === 'check').map((r) => r.status)).toEqual([
      'PASS',
      'PASS',
    ]);
    const times = records.filter((r) => r.type === 'time');
    expect(times).toHaveLength(4);
    const seen = (impl: string) =>
      times
        .filter((r) => r.impl === impl)
        .map(
          (r) =>
            r.process as { entry: string; entrySha256: string; cwd: string; padLength: number },
        );
    for (const p of seen('csv-engine')) expect(p.entry).toMatch(/\/dist\/index\.js$/);
    for (const p of seen('csv-engine-aa')) expect(p.entry).toMatch(/\/twin\/index\.js$/);
    const all = [...seen('csv-engine'), ...seen('csv-engine-aa')];
    expect(new Set(all.map((p) => p.entrySha256))).toEqual(new Set([entrySha]));
    for (const [i, r] of times.entries()) {
      const id = r.identity as { checkoutPath: string; padLength: number };
      expect(all.some((p) => p.cwd === id.checkoutPath && p.padLength === id.padLength)).toBe(true);
      expect((r.samplesMs as number[]).length, `record ${String(i)}`).toBe(3);
      expect(r.measurement).toMatchObject({ samples: 3, minSampleMs: 5, warmupMs: 20 });
      expect(r.rssBeforeParseBytes).toBeGreaterThan(0);
      expect(r.maxRssKiB).toBeGreaterThan(0);
    }
    const empties = records.filter((r) => r.type === 'empty');
    expect(empties).toHaveLength(2);
    for (const e of empties) expect(e.rssBytes).toBeGreaterThan(0);
  }, 60_000);
});

// A stand-in worker that reports what a real one would about its own process.
function fakeWorker(
  override: (argv: string[], command: string) => Record<string, unknown> = () => ({}),
): { spawn: SpawnV2; calls: Array<{ argv: string[]; command: string; cwd: string }> } {
  const calls: Array<{ argv: string[]; command: string; cwd: string }> = [];
  const spawn: SpawnV2 = (argv, _guards, command, options) => {
    calls.push({ argv, command, cwd: options.cwd });
    const arg = (name: string) => {
      const i = argv.indexOf(name);
      return i < 0 ? undefined : argv[i + 1];
    };
    const mode = arg('--mode');
    const bundle = arg('--load') === 'entry';
    const record = {
      mode,
      ...(mode === 'check' ? { status: 'PASS' } : {}),
      ...(mode === 'time' ? { samplesMs: [10, 10, 10], inputLoadMs: 1 } : {}),
      process: {
        node: process.version,
        cwd: options.cwd,
        // A real worker reports process.execArgv: the Node flags before the script.
        execArgv: argv
          .slice(command === 'taskset' ? 3 : 0)
          .filter(
            (a, i, all) => a.startsWith('--') && i < all.findIndex((x) => x.endsWith('worker.ts')),
          ),
        cpusAllowed: command === 'taskset' ? argv[1] : null,
        padLength: (options.env.CSV_BENCH_PAD ?? '').length,
        entry: bundle ? arg('--entry') : null,
        entrySha256: bundle ? 'entry-sha' : null,
      },
      ...override(argv, command),
    };
    const outcome: JobOutcome = { status: 'ok', record, wallMs: 1, peakPolledRssBytes: 1 };
    return Promise.resolve(outcome);
  };
  return { spawn, calls };
}

function context(spawnWorker: SpawnV2, overrides: Partial<ShardV2Context> = {}) {
  const file = join(scratch('shard'), 'shard.jsonl');
  const caseIds = ['B1-simple-1MiB', 'B1-simple-1KiB'];
  const ctx: ShardV2Context = {
    manifest,
    v2,
    shardId: 'S1',
    campaignSeed: 4242,
    cases: manifest.cases.filter((c) => caseIds.includes(c.id)),
    pairs: [
      { impl: 'papaparse', case: 'B1-simple-1MiB', expect: 'measure' },
      { impl: 'udsv', case: 'B1-simple-1MiB', expect: 'measure' },
      { impl: 'csv-engine', case: 'B1-simple-1MiB', expect: 'measure' },
      { impl: 'csv-engine-aa', case: 'B1-simple-1MiB', expect: 'measure' },
      { impl: 'papaparse', case: 'B1-simple-1KiB', expect: 'measure' },
      { impl: 'csv-engine', case: 'B1-simple-1KiB', expect: 'measure' },
      { impl: 'csv-parser', case: 'B1-simple-1KiB', expect: 'unsupported', reason: 'declared' },
    ],
    processes: 4,
    memoryProcesses: 2,
    copies: ['/copies/c1', '/copies/c2/d/e', '/copies/c3/d/e/f/g'],
    entries: { 'csv-engine': 'dist/index.js', 'csv-engine-aa': 'twin/index.js' },
    entrySha256: { 'csv-engine': 'entry-sha', 'csv-engine-aa': 'entry-sha' },
    identities: { '*': { commit: 'c0ffee', distSha256: 'dist-sha' } },
    harnessCommit: 'ba5e',
    phase: 'timing',
    machine: { cpuModel: 'AMD EPYC 7B12', kernel: '6.1.0-54-cloud-amd64' },
    pinCpu: 3,
    inputs: { 'B1-simple-1MiB': '/fixtures/1MiB.csv', 'B1-simple-1KiB': '/fixtures/1KiB.csv' },
    guards: guards(),
    checkpoint: jsonlCheckpoint(file),
    spawnWorker,
    ...overrides,
  };
  return { file, ctx };
}

describe('runShardV2 with a stand-in worker', () => {
  // The flags a stand-in worker received for its timing processes of one pair:
  // "operations per sample, untimed operations, samples" ("-" for a flag not passed).
  const timingFlags = (calls: Array<{ argv: string[] }>, impl: string, caseId: string) =>
    new Set(
      calls
        .filter(
          (c) =>
            c.argv.includes('time') &&
            c.argv[c.argv.indexOf('--impl') + 1] === impl &&
            c.argv[c.argv.indexOf('--case') + 1] === caseId,
        )
        .map((c) =>
          ['--ops-per-sample', '--rewarm-ops', '--samples']
            .map((f) => (c.argv.includes(f) ? c.argv[c.argv.indexOf(f) + 1] : '-'))
            .join(' '),
        ),
    );
  const probing = (checkMs: Record<string, number>, otherwise: number) =>
    fakeWorker((argv) => {
      const impl = argv[argv.indexOf('--impl') + 1] ?? '';
      return argv.includes('check') ? { opMs: checkMs[impl] ?? otherwise } : {};
    });

  it("fixes each pair's operations per sample and untimed operations from its check, shared by the A/A arms", async () => {
    // Below singleOperationMinMs (90 ms) a pair repeats the parse: 250 ms / 40 ms gives 7 per sample
    // and 6 untimed; the A/A copy takes the candidate's counts, not its own (250 / 60: 5 and 4).
    const { spawn, calls } = probing({ 'csv-engine': 40, 'csv-engine-aa': 60, papaparse: 89 }, 10);
    const { ctx } = context(spawn);
    expect(await runShardV2(ctx)).toBe('complete');
    expect(timingFlags(calls, 'csv-engine', 'B1-simple-1MiB')).toEqual(new Set(['7 6 -']));
    expect(timingFlags(calls, 'csv-engine-aa', 'B1-simple-1MiB')).toEqual(new Set(['7 6 -']));
    // 89 ms is still repeated, with at least two untimed operations.
    expect(timingFlags(calls, 'papaparse', 'B1-simple-1MiB')).toEqual(new Set(['3 2 -']));
    expect(timingFlags(calls, 'udsv', 'B1-simple-1MiB')).toEqual(new Set(['25 25 -']));
  });

  it('times a pair whose check took at least singleOperationMinMs as one parse per sample on a collected heap', async () => {
    // At 90 ms and above: one operation per sample, no untimed operations, and as many samples as
    // fill singleOperationSampledMs (750 / 90 rounds up to 9; 750 / 300 is below 3, so 3).
    const { spawn, calls } = probing({ 'csv-engine': 90, 'csv-engine-aa': 45, papaparse: 300 }, 40);
    const { ctx } = context(spawn);
    expect(await runShardV2(ctx)).toBe('complete');
    expect(timingFlags(calls, 'csv-engine', 'B1-simple-1MiB')).toEqual(new Set(['1 0 9']));
    expect(timingFlags(calls, 'csv-engine-aa', 'B1-simple-1MiB')).toEqual(new Set(['1 0 9']));
    expect(timingFlags(calls, 'papaparse', 'B1-simple-1MiB')).toEqual(new Set(['1 0 3']));
    expect(timingFlags(calls, 'udsv', 'B1-simple-1MiB')).toEqual(new Set(['7 6 -']));
  });

  it('chooses the regime by the probe, not by the case: one case can hold both', async () => {
    const { spawn, calls } = probing({ papaparse: 300 }, 45);
    const { ctx } = context(spawn, {
      cases: manifest.cases.filter((c) => c.id === 'B2-long-field-32MiB'),
      pairs: ['papaparse', 'csv-engine', 'csv-engine-aa'].map((impl) => ({
        impl,
        case: 'B2-long-field-32MiB',
        expect: 'measure' as const,
      })),
      inputs: { 'B2-long-field-32MiB': '/fixtures/long-field-32MiB.csv' },
    });
    expect(await runShardV2(ctx)).toBe('complete');
    expect(timingFlags(calls, 'csv-engine', 'B2-long-field-32MiB')).toEqual(new Set(['6 5 -']));
    expect(timingFlags(calls, 'csv-engine-aa', 'B2-long-field-32MiB')).toEqual(new Set(['6 5 -']));
    expect(timingFlags(calls, 'papaparse', 'B2-long-field-32MiB')).toEqual(new Set(['1 0 3']));
  });

  // The Node flags of one pair's processes of a mode beyond --expose-gc and the round's seeds, as
  // they stand before the script.
  const nodeFlags = (
    calls: Array<{ argv: string[] }>,
    impl: string,
    caseId: string,
    mode: string,
  ) =>
    new Set(
      calls
        .filter(
          (c) =>
            c.argv.includes(mode) &&
            c.argv[c.argv.indexOf('--impl') + 1] === impl &&
            c.argv[c.argv.indexOf('--case') + 1] === caseId,
        )
        .map((c) =>
          c.argv
            .slice(
              0,
              c.argv.findIndex((a) => a.endsWith('worker.ts')),
            )
            .filter((a) => a.startsWith('--') && !/^--(expose-gc|(random|hash)-seed=\d+)$/.test(a))
            .join(' '),
        ),
    );

  it("starts the timing processes of a pair that repeats the operation with the manifest's Node flags, and no other process", async () => {
    expect(pairNodeFlags(89, v2.measurement)).toEqual(['--no-osr-from-maglev']);
    expect(pairNodeFlags(90, v2.measurement)).toEqual([]);
    // 40 ms repeats and 300 ms is one parse per sample; the A/A copy follows the candidate's probe,
    // not its own 95 ms, so both arms of the same code start alike.
    const { spawn, calls } = probing({ 'csv-engine': 40, 'csv-engine-aa': 95, papaparse: 300 }, 10);
    const { ctx } = context(spawn);
    expect(await runShardV2(ctx)).toBe('complete');
    const flag = new Set(['--no-osr-from-maglev']);
    expect(nodeFlags(calls, 'csv-engine', 'B1-simple-1MiB', 'time')).toEqual(flag);
    expect(nodeFlags(calls, 'csv-engine-aa', 'B1-simple-1MiB', 'time')).toEqual(flag);
    expect(nodeFlags(calls, 'udsv', 'B1-simple-1MiB', 'time')).toEqual(flag);
    expect(nodeFlags(calls, 'papaparse', 'B1-simple-1MiB', 'time')).toEqual(new Set(['']));
    // The probe itself (the check) and the empty process run with V8's defaults.
    expect(nodeFlags(calls, 'csv-engine', 'B1-simple-1MiB', 'check')).toEqual(new Set(['']));
    const others = calls.filter((c) => !c.argv.includes('time'));
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((c) => c.argv.includes('--no-osr-from-maglev'))).toBe(false);
    // So does every process of the memory phase: one parse each.
    const memory = probing({ 'csv-engine': 40 }, 10);
    await runShardV2(context(memory.spawn, { phase: 'memory', shardId: 'M' }).ctx);
    expect(memory.calls.some((c) => c.argv.includes('memory'))).toBe(true);
    expect(memory.calls.some((c) => c.argv.includes('--no-osr-from-maglev'))).toBe(false);
  });

  it("under the publication method no process of any regime or mode starts with a Node flag beyond --expose-gc and the round's seeds", async () => {
    const pub = readMethod('pub').v2;
    expect(pairNodeFlags(89, pub.measurement)).toEqual([]);
    expect(pairNodeFlags(90, pub.measurement)).toEqual([]);
    // The same probes as above: two pairs repeat the operation, papaparse is one parse per sample.
    const { spawn, calls } = probing({ 'csv-engine': 40, 'csv-engine-aa': 95, papaparse: 300 }, 10);
    expect(await runShardV2(context(spawn, { v2: pub }).ctx)).toBe('complete');
    const memory = probing({ 'csv-engine': 40 }, 10);
    await runShardV2(context(memory.spawn, { v2: pub, phase: 'memory', shardId: 'M' }).ctx);
    for (const mode of ['check', 'time', 'empty'])
      expect(calls.some((c) => c.argv.includes(mode))).toBe(true);
    expect(memory.calls.some((c) => c.argv.includes('memory'))).toBe(true);
    for (const impl of ['csv-engine', 'csv-engine-aa', 'udsv', 'papaparse'])
      expect(nodeFlags(calls, impl, 'B1-simple-1MiB', 'time')).toEqual(new Set(['']));
    const started = [...calls, ...memory.calls].flatMap((c) =>
      c.argv
        .slice(
          0,
          c.argv.findIndex((a) => a.endsWith('worker.ts')),
        )
        .filter((a) => a.startsWith('--')),
    );
    expect(new Set(started.map((a) => a.replace(/=\d+$/, '')))).toEqual(
      new Set(['--expose-gc', '--random-seed', '--hash-seed']),
    );
  });

  it("ends the shard when a worker did not start with its pair's Node flags", async () => {
    const { spawn } = probing({}, 10);
    const lost: SpawnV2 = async (argv, g, command, options) => {
      const out = await spawn(argv, g, command, options);
      if (out.status === 'ok' && argv.includes('time')) {
        const reported = out.record.process as { execArgv: string[] };
        reported.execArgv = reported.execArgv.filter((a) => a !== '--no-osr-from-maglev');
      }
      return out;
    };
    const { file, ctx } = context(lost);
    expect(await runShardV2(ctx)).toBe('setup-mismatch');
    expect(lines(file).at(-1)).toMatchObject({
      status: 'BLOCKED',
      blocked: 'setup-mismatch',
      detail: expect.stringMatching(
        /^execArgv is \[.*\], requested --random-seed=\d+ --hash-seed=\d+ --no-osr-from-maglev$/,
      ) as unknown,
    });
  });

  it('a timing shard runs every passing pair once per round with one empty process, and never a memory process', async () => {
    const { spawn, calls } = fakeWorker();
    const { file, ctx } = context(spawn);
    expect(await runShardV2(ctx)).toBe('complete');
    const records = lines(file);
    const count = (type: string) => records.filter((r) => r.type === type).length;
    expect(count('check')).toBe(7);
    expect(count('time')).toBe(6 * 4);
    expect(count('empty')).toBe(4);
    expect(count('memory')).toBe(0);
    expect(calls.some((c) => c.argv.includes('memory'))).toBe(false);
    for (const impl of ['papaparse', 'udsv', 'csv-engine', 'csv-engine-aa']) {
      const rounds = records
        .filter((r) => r.type === 'time' && r.impl === impl && r.case === 'B1-simple-1MiB')
        .map((r) => r.round);
      expect(rounds).toEqual([1, 2, 3, 4]);
    }
    expect(records.find((r) => r.impl === 'csv-parser')).toMatchObject({
      type: 'check',
      status: 'UNSUPPORTED',
      declared: true,
    });
  });

  it('the memory phase runs only memory processes of the primary pairs and one empty process per round', async () => {
    const { spawn, calls } = fakeWorker();
    const { file, ctx } = context(spawn, { phase: 'memory', shardId: 'M' });
    expect(await runShardV2(ctx)).toBe('complete');
    const records = lines(file);
    // 4 measured pairs on the primary case, 2 rounds (memoryProcesses of this context); the 1 KiB case is not primary.
    expect(records.map((r) => r.type).sort()).toEqual([
      ...Array.from({ length: 2 }, () => 'empty'),
      ...Array.from({ length: 8 }, () => 'memory'),
    ]);
    expect(new Set(records.filter((r) => r.type === 'memory').map((r) => r.case))).toEqual(
      new Set(['B1-simple-1MiB']),
    );
    expect(new Set(records.map((r) => r.round))).toEqual(new Set([1, 2]));
    expect(calls.some((c) => c.argv.includes('time') || c.argv.includes('check'))).toBe(false);
    for (const c of calls.filter((x) => x.argv.includes('memory')))
      expect(c.argv).toContain('--input-file');
    for (const r of records) expect((r.identity as { tasksetMask: string }).tasksetMask).toBe('3');
  });

  it('orders each round by the campaign seed: reproducible, and different between rounds and seeds', async () => {
    const sequence = async (seed: number) => {
      const { spawn } = fakeWorker();
      const { file, ctx } = context(spawn, { campaignSeed: seed });
      await runShardV2(ctx);
      const timed = lines(file).filter((r) => r.type === 'time');
      const key = (r: Record<string, unknown>) => `${String(r.impl)}@${String(r.case)}`;
      return [1, 2, 3, 4].map((round) => timed.filter((r) => r.round === round).map(key));
    };
    const a = await sequence(4242);
    expect(await sequence(4242)).toEqual(a);
    expect(a[1]).not.toEqual(a[0]);
    expect(a[2]).not.toEqual(a[1]);
    expect([...(a[1] ?? [])].sort()).toEqual([...(a[0] ?? [])].sort());
    expect((await sequence(4243))[0]).not.toEqual(a[0]);
  });

  it('states the identity on every job record, blocked ones included', async () => {
    const { spawn } = fakeWorker();
    const failing: SpawnV2 = (argv, g, command, options) =>
      argv.includes('udsv') && argv.includes('time')
        ? Promise.resolve({ status: 'error', detail: 'boom', wallMs: 1, peakPolledRssBytes: 0 })
        : spawn(argv, g, command, options);
    const { file, ctx } = context(failing);
    expect(await runShardV2(ctx)).toBe('complete');
    // Every record of the shard: 6 checks, 1 declared-unsupported pair, 24 timing, 4 empty.
    const jobs = lines(file);
    expect(jobs).toHaveLength(6 + 1 + 24 + 4);
    expect(jobs.filter((r) => r.status === 'BLOCKED')).toHaveLength(4);
    for (const r of jobs) {
      expect(r.identity, `${String(r.type)} ${String(r.impl)}`).toBeDefined();
      const id = r.identity as Record<string, unknown>;
      expect(Object.keys(id)).toEqual([
        'harnessCommit',
        'commit',
        'distSha256',
        'node',
        'cpuModel',
        'kernel',
        'tasksetMask',
        'v8Seed',
        'padLength',
        'checkoutCopy',
        'checkoutPath',
      ]);
      // The candidate may be another commit than the harness that measures it.
      expect(id).toMatchObject({
        harnessCommit: 'ba5e',
        commit: 'c0ffee',
        distSha256: 'dist-sha',
        node: process.version,
        cpuModel: 'AMD EPYC 7B12',
        kernel: '6.1.0-54-cloud-amd64',
        tasksetMask: '3',
      });
      if (r.status === 'UNSUPPORTED') {
        // Recorded without a process: there is no pad and no checkout copy to state.
        expect(id).toMatchObject({
          v8Seed: null,
          padLength: null,
          checkoutCopy: null,
          checkoutPath: null,
        });
        continue;
      }
      expect(id.padLength).toBeGreaterThanOrEqual(0);
      expect(id.padLength).toBeLessThanOrEqual(4096);
      expect(ctx.copies[id.checkoutCopy as number]).toBe(id.checkoutPath);
    }
    expect(
      new Set(jobs.map((r) => (r.identity as { checkoutCopy: unknown }).checkoutCopy)),
    ).toEqual(new Set([0, 1, 2, null]));
  });

  it('pins every worker with taskset, runs it from its checkout copy with the pad, and gives every arm the same arguments', async () => {
    const { spawn, calls } = fakeWorker();
    const { ctx } = context(spawn);
    await runShardV2(ctx);
    for (const call of calls) {
      expect(call.command).toBe('taskset');
      expect(call.argv.slice(0, 4)).toEqual(['-c', '3', process.execPath, '--expose-gc']);
      expect(call.argv[4]).toMatch(/^--random-seed=[1-9]\d*$/);
      expect(call.argv[5]).toBe(call.argv[4]?.replace('--random-seed', '--hash-seed'));
      expect(call.argv[6]).toBe(join(call.cwd, 'bench', 'worker.ts'));
      expect(ctx.copies).toContain(call.cwd);
    }
    const shape = (impl: string) =>
      calls
        .find((c) => c.argv.includes(impl) && c.argv.includes('time'))
        ?.argv.filter((a) => a.startsWith('--'));
    expect(shape('papaparse')).toEqual(shape('csv-engine'));
    expect(shape('csv-engine-aa')).toEqual(shape('csv-engine'));
    const entryOf = (impl: string) => {
      const argv = calls.find((c) => c.argv.includes(impl) && c.argv.includes('time'))?.argv ?? [];
      return [argv[argv.indexOf('--load') + 1], argv[argv.indexOf('--entry') + 1]];
    };
    expect(entryOf('papaparse')[0]).toBe('adapter');
    expect(entryOf('csv-engine')).toEqual(['entry', expect.stringMatching(/\/dist\/index\.js$/)]);
    expect(entryOf('csv-engine-aa')).toEqual([
      'entry',
      expect.stringMatching(/\/twin\/index\.js$/),
    ]);
    // Checks of synthetic cases regenerate the fixture; timing reads the cached file.
    const check = calls.find((c) => c.argv.includes('check'))?.argv ?? [];
    expect(check).not.toContain('--input-file');
    const time = calls.find((c) => c.argv.includes('time'))?.argv ?? [];
    expect(time).toContain('--input-file');
  });

  it('ends the shard when a worker is not on the requested CPU', async () => {
    const { spawn } = fakeWorker();
    const unpinned: SpawnV2 = async (argv, g, command, options) => {
      const out = await spawn(argv, g, command, options);
      if (out.status === 'ok' && argv.includes('time'))
        (out.record.process as Record<string, unknown>).cpusAllowed = '0-7';
      return out;
    };
    const { file, ctx } = context(unpinned);
    expect(await runShardV2(ctx)).toBe('pinning-lost');
    const last = lines(file).at(-1);
    expect(last).toMatchObject({
      type: 'time',
      status: 'BLOCKED',
      blocked: 'pinning-lost',
      detail: 'cpusAllowed is "0-7", requested "3"',
    });
    expect(lines(file).filter((r) => r.type === 'time')).toHaveLength(1);
  });

  it('ends the shard when a bundle arm imported another file, other bytes, or ran with another pad', async () => {
    for (const [field, value, detail] of [
      ['entry', '/elsewhere/src/parse.ts', /^entry is "\/elsewhere\/src\/parse\.ts", requested/],
      ['entrySha256', 'other', /^entrySha256 is "other", requested "entry-sha"$/],
      ['padLength', 5000, /^padLength is 5000, requested \d+$/],
    ] as const) {
      const { spawn } = fakeWorker();
      const wrong: SpawnV2 = async (argv, g, command, options) => {
        const out = await spawn(argv, g, command, options);
        if (out.status === 'ok' && argv.includes('csv-engine'))
          (out.record.process as Record<string, unknown>)[field] = value;
        return out;
      };
      const { file, ctx } = context(wrong);
      expect(await runShardV2(ctx)).toBe('setup-mismatch');
      expect(lines(file).at(-1)).toMatchObject({
        status: 'BLOCKED',
        blocked: 'setup-mismatch',
        detail: expect.stringMatching(detail) as unknown,
      });
    }
  });
});

describe('preconditions of a v2 run', () => {
  it('refuses NODE_OPTIONS and NODE_COMPILE_CACHE, which would change every process', () => {
    expect(() => {
      refuseNodeEnvironment({});
    }).not.toThrow();
    expect(() => {
      refuseNodeEnvironment({ NODE_OPTIONS: '', PATH: '/bin' });
    }).not.toThrow();
    expect(() => {
      refuseNodeEnvironment({ NODE_OPTIONS: '--max-old-space-size=512' });
    }).toThrow('unset NODE_OPTIONS before a v2 run');
    expect(() => {
      refuseNodeEnvironment({ NODE_OPTIONS: '--x', NODE_COMPILE_CACHE: '/tmp/cache' });
    }).toThrow('unset NODE_OPTIONS and NODE_COMPILE_CACHE before a v2 run');
  });

  it('resolves a revision to its full commit and rejects what is not one', () => {
    expect(commitOf('HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(() => commitOf('no-such-revision')).toThrow(/no-such-revision is not a commit here/);
  });

  it('A/B: refuses an existing id, a dirty harness, another Node and unknown cases or targets, before building', () => {
    const primary = manifest.cases.filter((c) => c.class === 'primary').map((c) => c.id);
    const ok = {
      id: 'ab-1',
      exists: false,
      dirty: false,
      node: 'v24.22.1',
      requiredNode: '24.22.1',
      known: manifest.cases.map((c) => c.id),
      primary,
      cases: primary,
      targets: ['B1-unicode-1MiB'],
    };
    expect(abPreflight(ok)).toEqual([]);
    expect(abPreflight({ ...ok, targets: [] })).toEqual([]);
    expect(abPreflight({ ...ok, exists: true })).toEqual([
      'work/bench-v2/ab/ab-1 already exists: choose a new --id or remove it',
    ]);
    expect(abPreflight({ ...ok, dirty: true })).toEqual([
      'the harness working tree differs from its commit',
    ]);
    expect(abPreflight({ ...ok, node: 'v26.12.1' })).toEqual([
      'A/B runs require Node 24.22.1; this is v26.12.1',
    ]);
    expect(
      abPreflight({ ...ok, targets: ['B1-unicode-1MiB', 'B1-nope', 'B1-simple-1KiB'] }),
    ).toEqual([
      'target B1-nope is not a primary case',
      'target B1-simple-1KiB is not a primary case',
    ]);
    expect(abPreflight({ ...ok, cases: ['B1-simple-1MiB', 'B9-x'] })).toEqual([
      'unknown case B9-x in --cases',
      'target B1-unicode-1MiB is not among the cases of this run',
    ]);
    expect(abPreflight({ ...ok, id: '../x' })[0]).toMatch(/--id \.\.\/x must use only/);
  });
});

describe('pinning', () => {
  const deps = (overrides: Partial<PinDeps> = {}): PinDeps => ({
    run: () => ({ status: 0, stderr: '' }),
    siblings: () => [3, 7],
    runnerCpus: () => [1, 5],
    ...overrides,
  });

  it('parses CPU lists', () => {
    expect(parseCpuList('0-2,5\n')).toEqual([0, 1, 2, 5]);
    expect(parseCpuList('3')).toEqual([3]);
    expect(() => parseCpuList('a')).toThrow(/invalid CPU list/);
  });

  it('accepts a CPU whose core the runner cannot use, and probes taskset with that CPU', () => {
    const probes: string[][] = [];
    const run: PinDeps['run'] = (command, args) => {
      probes.push([command, ...args]);
      return { status: 0, stderr: '' };
    };
    expect(verifyPinning(3, deps({ run }))).toEqual({
      cpu: 3,
      siblings: [3, 7],
      runnerCpus: [1, 5],
    });
    expect(probes).toEqual([['taskset', '-c', '3', process.execPath, '-e', '']]);
  });

  it('aborts when taskset is missing; it never falls back to unpinned', () => {
    const missing = deps({
      run: () => ({ status: null, stderr: '', error: new Error('spawnSync taskset ENOENT') }),
    });
    expect(() => verifyPinning(3, missing)).toThrow(
      'pinning to CPU 3 was requested but taskset is unavailable (spawnSync taskset ENOENT); refusing to run unpinned',
    );
  });

  it('aborts when taskset fails', () => {
    const failing = deps({
      run: () => ({ status: 1, stderr: 'taskset: failed to set affinity\n' }),
    });
    expect(() => verifyPinning(9, failing)).toThrow(
      /taskset failed \(exit 1: taskset: failed to set affinity\); refusing to run unpinned/,
    );
  });

  it('aborts when the runner may run on the worker CPU or its hyperthread sibling', () => {
    expect(() => verifyPinning(3, deps({ runnerCpus: () => [0, 1, 2, 3, 4, 5, 6, 7] }))).toThrow(
      /the runner may run on CPU\(s\) 3,7, the worker CPU or its hyperthread sibling/,
    );
    expect(() => verifyPinning(3, deps({ runnerCpus: () => [7] }))).toThrow(/CPU\(s\) 7/);
    expect(() => verifyPinning(3, deps({ runnerCpus: () => [] }))).toThrow(
      /refusing to run unpinned/,
    );
  });

  it('is required for campaign, calibration and A/B runs, optional for a smoke run', () => {
    for (const kind of ['campaign', 'calibration', 'ab'] as const) {
      expect(() => requestedPinning(v2, kind, undefined)).toThrow(
        `a ${kind} run must be pinned: pass --pin-cpu <cpu>`,
      );
    }
    expect(requestedPinning(v2, 'smoke', undefined)).toBeNull();
    expect(requestedPinning(v2, 'campaign', '3', deps())).toMatchObject({ cpu: 3 });
    expect(() =>
      requestedPinning(
        v2,
        'smoke',
        '3',
        deps({ run: () => ({ status: null, stderr: '', error: new Error('ENOENT') }) }),
      ),
    ).toThrow(/refusing to run unpinned/);
  });
});

describe('projected duration and budget', () => {
  const m = v2.measurement;

  it('models the timing loop: first call, warm-up of at least 500 ms and 3 operations, 3 samples of at least 250 ms', () => {
    expect(loopMs(10, m)).toBe(10 * (1 + 50 + 3 * 25));
    expect(loopMs(2000, m)).toBe(2000 * (1 + 2 + 3));
    expect(loopMs(300, m)).toBe(300 * (1 + 2 + 3));
    expect(loopMs(100, m)).toBe(100 * (1 + 5 + 3 * 3));
  });

  it('the dry-run cases are the 1 MiB case of every lane and family', () => {
    const cases = dryRunCases(manifest, v2);
    expect(cases).toHaveLength(18);
    expect(new Set(cases.map((c) => `${c.lane} ${String(c.family)}`)).size).toBe(18);
    expect(cases.every((c) => c.targetBytes === 1048576)).toBe(true);
  });

  it('projects a pair from the dry measurement of its implementation, lane and family, scaled by bytes', () => {
    const bytesOf = (id: string) => manifest.cases.find((c) => c.id === id)?.fixture?.bytes ?? 0;
    const bytes = bytesOf('B1-simple-1MiB');
    const quoted = bytesOf('B1-quote-heavy-1MiB');
    const dry = new Map([
      ['papaparse\0B1\0simple', { bytes, opMs: 10, inputLoadMs: 5, fixedMs: 100, checkMs: 400 }],
      ['papaparse\0B1\0quote-heavy', { bytes: quoted, opMs: 30, inputLoadMs: 5, fixedMs: 120 }],
    ]);
    const pair = (impl: string, id: string) => ({ impl, case: id, expect: 'measure' as const });
    // The timing shards and the memory phase are projected separately; this is their sum.
    const project = (impl: string, id: string, empty = 0, processes = 10, memory = 5) =>
      projectMs([pair(impl, id)], manifest, v2, dry, empty, processes, memory, 'timing') +
      projectMs([pair(impl, id)], manifest, v2, dry, empty, processes, memory, 'memory');
    // fixed 100; check 100 + 300; time 100 + 5 + 1260; memory 100 + 15.
    const timingOnly = projectMs(
      [pair('papaparse', 'B1-simple-1MiB')],
      manifest,
      v2,
      dry,
      50,
      10,
      5,
      'timing',
    );
    expect(timingOnly).toBeCloseTo(10 * 50 + 400 + 10 * 1365, 6);
    expect(project('papaparse', 'B1-simple-1MiB', 50)).toBeCloseTo(
      (10 + 5) * 50 + 400 + 10 * 1365 + 5 * 115,
      6,
    );
    const ratio = bytesOf('B1-simple-32MiB') / bytes;
    expect(project('papaparse', 'B1-simple-32MiB')).toBeCloseTo(
      100 + 300 * ratio + 10 * (100 + 5 * ratio + loopMs(10 * ratio, m)) + 5 * (100 + 15 * ratio),
      6,
    );
    // Another family takes its own measurement; its check scales the lane's dry check.
    const q = bytesOf('B1-quote-heavy-32MiB') / quoted;
    expect(project('papaparse', 'B1-quote-heavy-32MiB')).toBeCloseTo(
      120 +
        (300 * bytesOf('B1-quote-heavy-32MiB')) / bytes +
        10 * (120 + 5 * q + loopMs(30 * q, m)) +
        5 * (120 + 35 * q),
      6,
    );
    // No measurement for the family (or an external dataset): the implementation's costliest per byte.
    const multiline = bytesOf('B1-multiline-1MiB') / quoted;
    expect(project('papaparse', 'B1-multiline-1MiB', 0, 1, 0)).toBeCloseTo(
      120 +
        (300 * bytesOf('B1-multiline-1MiB')) / bytes +
        120 +
        5 * multiline +
        loopMs(30 * multiline, m),
      6,
    );
    // No measurement for the implementation: the costliest of all; no dry check: three operations.
    expect(project('udsv', 'B1-quote-heavy-1MiB', 0, 1, 0)).toBeCloseTo(
      120 + 5 + 3 * 30 + 120 + 5 + loopMs(30, m),
      6,
    );
    expect(
      projectMs(
        [{ impl: 'udsv', case: 'B1-simple-1MiB', expect: 'unsupported', reason: 'x' }],
        manifest,
        v2,
        dry,
        0,
        1,
        0,
        'timing',
      ),
    ).toBe(0);
    // A regression case (not primary) has no memory processes, and the A/A arm costs what the candidate costs.
    expect(project('papaparse', 'B1-simple-1KiB')).toBeLessThan(
      project('papaparse', 'B1-simple-1MiB'),
    );
    const cand = new Map([
      ['csv-engine\0B1\0simple', { bytes, opMs: 7, inputLoadMs: 2, fixedMs: 90 }],
    ]);
    const one = (impl: string) =>
      projectMs([pair(impl, 'B1-simple-1MiB')], manifest, v2, cand, 0, 10, 5, 'timing');
    expect(one('csv-engine-aa')).toBe(one('csv-engine'));
  });

  function options(budgetMinutes: number, dryRunOnly: boolean) {
    const { spawn, calls } = fakeWorker((argv) =>
      argv.includes('time') ? { samplesMs: [1000, 1000, 1000], inputLoadMs: 1 } : {},
    );
    const dir = scratch('runv2');
    const quick: ManifestV2 = {
      ...v2,
      budget: { defaultMinutes: 240, dryRun: { ...v2.budget.dryRun, targetBytes: 1024 } },
    };
    const pairs = [{ impl: 'papaparse', case: 'B1-simple-1KiB', expect: 'measure' as const }];
    return {
      calls,
      file: join(dir, 'smoke.jsonl'),
      options: {
        kind: 'smoke' as const,
        campaignId: 'test',
        shardId: 'smoke',
        seed: 1,
        outFile: join(dir, 'smoke.jsonl'),
        manifest,
        v2: quick,
        cases: manifest.cases.filter((c) => c.id === 'B1-simple-1KiB'),
        pairs,
        campaignShards: { smoke: pairs },
        processes: 10,
        memoryProcesses: 0,
        memoryPairs: [],
        phase: 'timing' as const,
        pinning: null,
        budgetMinutes,
        dryRunOnly,
        copies: [ROOT.replace(/\/$/, '')],
        entries: {},
        entrySha256: {},
        identities: { '*': { commit: 'c', distSha256: 'd' } },
        start: {},
        unchanged: () => true,
        spawnWorker: spawn,
        fixtureDir: join(dir, 'fixtures'),
      },
    };
  }

  it('prints the projection, and refuses to start above the budget', async () => {
    // One pair, 10 processes, an operation of 1000 ms: 10 x 6 s of timing loops alone.
    const { options: o, file, calls } = options(0.5, false);
    expect(await runV2(o)).toBe(1);
    const records = lines(file);
    const projection = records.find((r) => r.type === 'projection');
    expect(projection).toMatchObject({ budgetMinutes: 0.5, overBudget: true });
    expect(projection?.campaignMinutes).toBeGreaterThan(1);
    expect(records.at(-1)).toMatchObject({ type: 'end', status: 'over-budget' });
    expect(records.some((r) => r.type === 'time' || r.type === 'check')).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('a dry run stops after the projection; within the budget the rounds run', async () => {
    const dry = options(240, true);
    expect(await runV2(dry.options)).toBe(0);
    expect(lines(dry.file).at(-1)).toMatchObject({ type: 'end', status: 'dry-run' });
    expect(lines(dry.file).some((r) => r.type === 'time')).toBe(false);
    const full = options(240, false);
    expect(await runV2(full.options)).toBe(0);
    const records = lines(full.file);
    expect(records[0]).toMatchObject({
      type: 'start',
      method: 'v2',
      kind: 'smoke',
      seed: 1,
      nodeEnvironment: { NODE_OPTIONS: null, NODE_COMPILE_CACHE: null },
    });
    expect((records[1]?.identity as { harnessCommit: string }).harnessCommit).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(records.filter((r) => r.type === 'time')).toHaveLength(10);
    expect(records.at(-1)).toMatchObject({ type: 'end', status: 'complete', sourceChanged: false });
    await expect(runV2(full.options)).rejects.toThrow(/never appended to or rerun in place/);
  });
});

describe('method v1 is unchanged', () => {
  const worker = join(ROOT, 'bench', 'worker.ts');

  it('v1 workers get the v1 arguments, in the v1 order', async () => {
    const spawned: string[][] = [];
    const file = join(scratch('v1'), 'shard.jsonl');
    await runShard({
      manifest,
      cases: manifest.cases.filter((c) => c.id === 'B1-simple-1KiB'),
      pairs: [{ impl: 'papaparse', case: 'B1-simple-1KiB', expect: 'measure' }],
      timingArgs: [],
      repetitions: 1,
      memory: false,
      coldStart: false,
      fixtureDir: join(file, '..', 'fixtures'),
      guards: guards(),
      checkpoint: jsonlCheckpoint(file),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return Promise.resolve({
          status: 'ok',
          record: { status: 'PASS' },
          wallMs: 1,
          peakPolledRssBytes: 1,
        });
      },
    });
    const base = ['--expose-gc', worker, '--impl', 'papaparse', '--case', 'B1-simple-1KiB'];
    expect(spawned).toEqual([
      [...base, '--mode', 'check'],
      [...base, '--mode', 'time'],
    ]);
  });

  it('a v1 worker record has the v1 fields only, and the candidate still loads from source', async () => {
    const out = await runJob(
      [
        '--expose-gc',
        worker,
        ...['--impl', 'csv-engine', '--case', 'B1-simple-1KiB', '--mode', 'time'],
        ...['--samples', '2', '--min-sample-ms', '5', '--warmup-ms', '10'],
      ],
      guards(),
    );
    if (out.status !== 'ok') throw new Error(out.detail);
    const linux = process.platform === 'linux' ? ['diagnosticRusageMaxRssBytes'] : [];
    expect(Object.keys(out.record)).toEqual([
      'impl',
      'case',
      'mode',
      'inputSha256',
      'options',
      'measurement',
      'loop',
      'warmupOps',
      'opsPerSample',
      'samplesMs',
      'harnessNoopMsPerOp',
      'sink',
      'workerMaxRssBytes',
      'peakRssMethod',
      ...linux,
    ]);
    expect(out.record.measurement).toMatchObject({ samples: 2, repetitions: 3 });
  });
});

describe('v2 worker', () => {
  const worker = join(ROOT, 'bench', 'worker.ts');

  it('the empty mode reports a process with the harness and nothing else, and its pad', async () => {
    const out = await runJob(
      ['--expose-gc', worker, '--method', 'v2', '--mode', 'empty'],
      guards(),
      process.execPath,
      {
        env: { ...process.env, CSV_BENCH_PAD: 'x'.repeat(1234) },
      },
    );
    if (out.status !== 'ok') throw new Error(out.detail);
    expect(out.record).toMatchObject({
      mode: 'empty',
      process: { node: process.version, padLength: 1234 },
    });
    expect(out.record.rssBytes).toBeGreaterThan(0);
    expect(out.record.maxRssKiB).toBeGreaterThan(0);
    expect(out.record.workerMaxRssBytes).toBeGreaterThan(0);
  });

  it('refuses to guess where the implementation comes from', async () => {
    const out = await runJob(
      [
        worker,
        '--method',
        'v2',
        '--impl',
        'papaparse',
        '--case',
        'B1-simple-1KiB',
        '--mode',
        'check',
      ],
      guards(),
    );
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('method v2 needs --load entry') as unknown,
    });
  });
});
