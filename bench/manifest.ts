import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Family } from './fixtures.ts';
import { BULK_IMPL, type AdapterOptions, type Dialect, type Lane } from './lanes.ts';

// The frozen campaign definition (bench/manifest.json) and the implementation/case
// pairs it requires. Both the job planner (run.ts) and the validator (report.ts)
// derive expectations from here, never from a command-line filter.

export interface CaseSpec {
  id: string;
  lane: Lane;
  class: 'primary' | 'regression' | 'additional';
  weight: number;
  family?: Family;
  targetBytes?: number;
  fixture?: { bytes: number; rows: number; columns: number; sha256: string };
  external?: { path: string; sha256: string; bytes: number; dialect: Dialect };
  /** Library options chosen for this input, by implementation id. */
  adapterOptions?: Record<string, AdapterOptions>;
  /** W1: the input handed to the writer, the fixture parsed once into rows or into records. */
  shape?: 'rows' | 'records';
  /**
   * S1: the source's chunk size in bytes for every implementation, in place of
   * measurement.s1ChunkBytes (a one-chunk variant gives the fixture's byte length).
   */
  chunkBytes?: number;
}

export interface ImplementationSpec {
  id: string;
  package: string;
  lanes: Lane[];
  /** Why a lane has no adapter. */
  missingLanes?: Partial<Record<Lane, string>>;
}

/** Pairs that are declared inapplicable; they are reported, never measured. */
export interface UnsupportedDeclaration {
  impl: string;
  families?: Family[];
  cases?: string[];
  reason: string;
}

export interface Measurement {
  warmupMs: number;
  minWarmupOps: number;
  samples: number;
  minSampleMs: number;
  /** Untimed operations after each forced collection, as many as fit in this time (method v2; v1: 0). */
  rewarmMs?: number;
  /** Operations per sample fixed by the runner for every process of a pair (method v2). */
  opsPerSample?: number;
  /** Untimed operations after each forced collection, fixed by the runner (overrides rewarmMs). */
  rewarmOps?: number;
  repetitions: number;
  s1ChunkBytes: number;
  orderSeed: number;
}

export interface Limits {
  rssLimitBytes: number;
  rssPollMs: number;
  diskFloorBytes: number;
  tempCapBytes: number;
  /** Cap allowed once a preflight finds at least expandCapAtFreeBytes free. */
  tempCapExpandedBytes: number;
  expandCapAtFreeBytes: number;
}

export interface CampaignSpec {
  maxShardMinutes: number;
  maxCampaignMinutes: number;
  shards: Array<{ id: string; cases: string[] }>;
  /** Shard that also runs the cold-start jobs. */
  coldStartShard: string;
  /** The case the cold-start jobs use; it may belong to another shard. */
  coldStartCase: string;
}

export interface Manifest {
  schemaVersion: number;
  status: string;
  runtime: { node: string; flags: string[] };
  reference: string;
  candidate: string;
  /** Candidate lanes this manifest does not measure, with the reason (S1 in the v1 manifest). */
  candidateDeferredLanes: Partial<Record<Lane, string>>;
  consensus: string[];
  competitors: Record<string, string>;
  implementations: ImplementationSpec[];
  unsupported: UnsupportedDeclaration[];
  unavailable: Array<{ package: string; version: string; reason: string }>;
  measurement: Measurement;
  scoring: {
    inconclusiveSpread: number;
    /** Papa-relative limits, reported as facts; they gate nothing. */
    reportedChecks: {
      smallInputVsReferenceMax: number;
      peakMemoryVsReferenceMax: number;
    };
  };
  limits: Limits;
  campaign: CampaignSpec;
  families: Record<Family, { seed: number; description: string }>;
  cases: CaseSpec[];
}

export const MANIFEST_PATH = fileURLToPath(new URL('./manifest.json', import.meta.url));

export function readManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function manifestSha256(path = MANIFEST_PATH): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface ExpectedPair {
  impl: string;
  case: string;
  /**
   * measure: correctness check plus timing; unsupported: declared inapplicable,
   * reported with its reason; deferred: a candidate lane this manifest does not measure (S1, which
   * runs under bench/manifest-v2.json).
   */
  expect: 'measure' | 'unsupported' | 'deferred';
  reason?: string;
}

function declaredUnsupported(manifest: Manifest, impl: string, c: CaseSpec): string | undefined {
  const spec = manifest.implementations.find((i) => i.id === impl);
  if (spec && !spec.lanes.includes(c.lane)) {
    return spec.missingLanes?.[c.lane] ?? `no ${c.lane} adapter`;
  }
  return manifest.unsupported.find(
    (d) =>
      d.impl === impl &&
      ((c.family !== undefined && d.families?.includes(c.family)) || d.cases?.includes(c.id)),
  )?.reason;
}

/**
 * Every implementation/case pair the campaign must account for. Regression cases
 * compare only the reference and the candidate. The candidate is
 * required on every case, additional real-dataset cases included (weight 0: they
 * validate, they do not score), except in the lanes the manifest defers.
 */
export function expectedPairs(manifest: Manifest, caseIds?: readonly string[]): ExpectedPair[] {
  const pairs: ExpectedPair[] = [];
  for (const c of manifest.cases) {
    if (caseIds && !caseIds.includes(c.id)) continue;
    const competitors =
      c.class === 'regression' ? [manifest.reference] : manifest.implementations.map((i) => i.id);
    for (const impl of competitors) {
      const reason = declaredUnsupported(manifest, impl, c);
      pairs.push(
        reason === undefined
          ? { impl, case: c.id, expect: 'measure' }
          : { impl, case: c.id, expect: 'unsupported', reason },
      );
    }
    const deferred = manifest.candidateDeferredLanes[c.lane];
    pairs.push(
      deferred === undefined
        ? { impl: manifest.candidate, case: c.id, expect: 'measure' }
        : { impl: manifest.candidate, case: c.id, expect: 'deferred', reason: deferred },
    );
  }
  return pairs;
}

/** Implementations in the cold-start comparison: every B1 adapter plus the candidate. */
export function expectedColdImpls(manifest: Manifest): string[] {
  const competitors = manifest.implementations
    .filter((i) => i.lanes.includes('B1'))
    .map((i) => i.id);
  return manifest.candidateDeferredLanes.B1 === undefined
    ? [...competitors, manifest.candidate]
    : competitors;
}

// Method v2 (bench/manifest-v2.json): the measurement, placement and statistics
// settings that replace v1's for decisions. Cases, fixtures, implementations and
// shards stay those of the frozen v1 manifest, which v2 names by hash.

export type KindV2 = 'campaign' | 'calibration' | 'ab' | 'smoke';

export interface ManifestV2 {
  schemaVersion: number;
  method: string;
  status: string;
  base: { path: string; sha256: string };
  measurement: {
    /** Fresh processes per implementation and case; one per round. */
    processes: number;
    samples: number;
    minSampleMs: number;
    warmupMs: number;
    minWarmupOps: number;
    /** After the forced collection before each sample, operations run untimed for about this long. */
    rewarmMs: number;
    /**
     * A pair whose check probe took at least this long is timed as one parse per sample on a
     * collected heap, since re-warm operations would leave a variable number of major collections
     * inside a long parse. A shorter pair repeats the operation (as many per sample as fill
     * `minSampleMs`, as many untimed as fill `rewarmMs`), since one short parse can hold a
     * recompilation. Both settings are fixed once per pair from its check and shared by arms that
     * run the same code.
     */
    singleOperationMinMs: number;
    /** A one-parse pair takes as many samples as fill about this long, at least `samples`. */
    singleOperationSampledMs: number;
    /**
     * Node (V8) flags for the timing processes of a pair that repeats the operation; a one-parse
     * pair and every other process run without them. `--no-osr-from-maglev`: by default a function
     * entered by on-stack replacement may keep running slower OSR code on every call, depending on
     * its bytecode length, so an edit with no effect can read as a regression; the flag keeps the
     * samples in normal Turbofan code. A one-parse pair compiles its OSR code inside every sample
     * either way and keeps the default.
     */
    repeatedNodeFlags: string[];
    /** How the samples of one process are reduced; only "median" is implemented. */
    processStatistic: string;
    /** Rounds of the memory phase: one single-parse memory process per primary pair in each. */
    memoryProcesses: number;
    /** Shard id of the memory phase, a run of its own after the timing shards (none in a calibration). */
    memoryShard: string;
  };
  candidate: { distDir: string; entry: string; buildCommand: string[] };
  /** The A/A arm: the same bundle loaded from a sibling directory of equal name length. */
  aa: { impl: string; distDir: string };
  setup: { copies: string[]; padEnv: string; padMaxLength: number };
  /**
   * One V8 seed per round, shared by every process of the round and passed with each
   * flag (`<flag>=<seed>`); distinct between the rounds of a run, within [min, max].
   */
  seeds: { scope: 'round'; flags: string[]; min: number; max: number };
  placement: {
    tool: 'taskset';
    requiredFor: KindV2[];
    /** Reported, not gates: the busy share of a sibling CPU and the steal share of the worker CPU. */
    reportedChecks: { siblingBusyMax: number; stealMax: number };
  };
  statistics: { bootstrapResamples: number; confidence: number; familyWiseAlpha: number };
  calibration: {
    /** How many of the primary-case A/A intervals may exclude 1.000. */
    maxIntervalsExcludingOne: number;
    maxHalfWidth: number;
    maxMedianHalfWidth: number;
  };
  ab: { minProcesses: number; targetUpperBelow: number; otherLowerAbove: number };
  budget: {
    defaultMinutes: number;
    /**
     * The dry run behind the projection: a short timing process per implementation
     * on the case of this size of every lane and family, and a check on checkFamily.
     */
    dryRun: {
      targetBytes: number;
      checkFamily: Family;
      samples: number;
      minSampleMs: number;
      warmupMs: number;
    };
  };
  limits: Pick<Limits, 'rssLimitBytes' | 'rssPollMs' | 'diskFloorBytes' | 'tempCapBytes'>;
  /**
   * The W1 lane: its own cases, implementations and shards,
   * never in a B1/B2 or S1 run or score. `w1Manifest` turns it into a manifest.
   */
  w1: {
    status: string;
    /**
     * Diagnostic arms beside the candidate on every W1 case: the
     * bundle with these adapter options, reported on their own, never in W1's score.
     */
    arms: Record<string, AdapterOptions>;
    competitors: Record<string, string>;
    implementations: ImplementationSpec[];
    unsupported: UnsupportedDeclaration[];
    shards: Array<{ id: string; cases: string[] }>;
    cases: CaseSpec[];
  };
  /**
   * The S1 lane under method v2: the S1 cases that
   * bench/manifest.json lacks (with a `chunkBytes` variant for the A/B tool only), the
   * shards of the campaign (`s1Manifest`) and the candidate's arms beside it: the
   * bundle with these adapter options in place of the case's (BULK_IMPL: bulk parse).
   * Never in a B1/B2 run or score.
   */
  s1: {
    status: string;
    arms: Record<string, AdapterOptions>;
    shards: Array<{ id: string; cases: string[] }>;
    cases: CaseSpec[];
  };
  /** Not in the file: set by `readMethod` under the publication method, whose values replaced this file's. */
  pub?: ManifestPub;
}

export const MANIFEST_V2_PATH = fileURLToPath(new URL('./manifest-v2.json', import.meta.url));

/** Every reason the object is not a usable v2 manifest for this base manifest; empty when valid. */
export function manifestV2Issues(v2: ManifestV2, base: Manifest, baseSha256: string): string[] {
  const issues: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) issues.push(message);
  };
  const int = (x: unknown, min: number) => Number.isSafeInteger(x) && (x as number) >= min;
  const m = v2.measurement;
  need(v2.schemaVersion === 3 && v2.method === 'v2', 'schemaVersion must be 3 and method "v2"');
  need(
    v2.base.sha256 === baseSha256,
    `base manifest sha256 is ${baseSha256}, not ${v2.base.sha256}`,
  );
  need(int(m.processes, 2), 'measurement.processes must be an integer of at least 2');
  need(int(m.samples, 1), 'measurement.samples must be a positive integer');
  need(int(m.minWarmupOps, 1), 'measurement.minWarmupOps must be a positive integer');
  need(m.minSampleMs > 0 && m.warmupMs >= 0, 'measurement times must be positive');
  need(Number.isFinite(m.rewarmMs) && m.rewarmMs >= 0, 'measurement.rewarmMs must be 0 or more');
  // Below the threshold a pair must still get at least two untimed operations.
  need(
    m.singleOperationMinMs > 0 && Math.floor(m.rewarmMs / m.singleOperationMinMs) >= 2,
    'measurement.singleOperationMinMs must be positive and at most half of rewarmMs',
  );
  need(m.singleOperationSampledMs > 0, 'measurement.singleOperationSampledMs must be positive');
  need(
    Array.isArray(m.repeatedNodeFlags) &&
      m.repeatedNodeFlags.every((f) => typeof f === 'string' && /^--[a-z0-9-]+(=\S+)?$/.test(f)),
    'measurement.repeatedNodeFlags must be a list of Node flags (--name or --name=value)',
  );
  need(m.processStatistic === 'median', 'measurement.processStatistic must be "median"');
  need(
    int(m.memoryProcesses, 1) && m.memoryProcesses <= m.processes,
    'measurement.memoryProcesses must be between 1 and measurement.processes',
  );
  need(
    m.memoryShard !== '' && !base.campaign.shards.some((x) => x.id === m.memoryShard),
    'measurement.memoryShard must be an id that no timing shard uses',
  );
  need(v2.candidate.buildCommand.length > 0, 'candidate.buildCommand is empty');
  need(
    v2.aa.distDir !== v2.candidate.distDir && v2.aa.distDir.length === v2.candidate.distDir.length,
    'aa.distDir must differ from candidate.distDir and have the same length',
  );
  need(
    v2.aa.impl !== base.candidate && !base.implementations.some((i) => i.id === v2.aa.impl),
    'aa.impl must not name an existing implementation',
  );
  const depths = v2.setup.copies.map((c) => c.split('/').length);
  need(
    v2.setup.copies.length >= 2 && new Set(depths).size === depths.length,
    'setup.copies must be at least two directories at different path depths',
  );
  need(int(v2.setup.padMaxLength, 0), 'setup.padMaxLength must be a non-negative integer');
  need(
    v2.seeds.flags.length > 0 && v2.seeds.flags.every((f) => f.startsWith('--')),
    'seeds.flags must name at least one Node flag',
  );
  need(
    int(v2.seeds.min, 1) && int(v2.seeds.max, v2.seeds.min + 1000) && v2.seeds.max <= 2 ** 31 - 1,
    'seeds.min and seeds.max must span non-zero values inside the 32-bit signed range',
  );
  need(int(v2.statistics.bootstrapResamples, 1000), 'statistics.bootstrapResamples below 1000');
  need(
    v2.statistics.confidence > 0 && v2.statistics.confidence < 1,
    'statistics.confidence must be inside (0, 1)',
  );
  need(
    v2.statistics.familyWiseAlpha > 0 && v2.statistics.familyWiseAlpha < 1,
    'statistics.familyWiseAlpha must be inside (0, 1)',
  );
  need(
    int(v2.calibration.maxIntervalsExcludingOne, 0),
    'calibration.maxIntervalsExcludingOne must be a non-negative integer',
  );
  need(int(v2.ab.minProcesses, 2), 'ab.minProcesses must be an integer of at least 2');
  need(v2.budget.defaultMinutes > 0, 'budget.defaultMinutes must be positive');
  const dry = base.cases.filter((c) => c.family && c.targetBytes === v2.budget.dryRun.targetBytes);
  for (const lane of new Set(base.cases.filter((c) => c.family).map((c) => c.lane))) {
    need(
      dry.some((c) => c.lane === lane && c.family === v2.budget.dryRun.checkFamily),
      `budget.dryRun: no ${lane} ${v2.budget.dryRun.checkFamily} case of ${String(v2.budget.dryRun.targetBytes)} bytes`,
    );
  }
  need(
    int(v2.budget.dryRun.samples, 1) && v2.budget.dryRun.minSampleMs > 0,
    'budget.dryRun needs at least one sample of positive length',
  );
  issues.push(...w1Issues(v2, base), ...s1Issues(v2, base));
  return issues;
}

/**
 * The worker flags of one pair's timing processes, from the operation time its check probe read
 * (manifest v2 measurement.singleOperationMinMs).
 */
export function pairTimingFlags(opMs: number, m: ManifestV2['measurement']): string[] {
  if (opMs >= m.singleOperationMinMs) {
    const samples = Math.max(m.samples, Math.ceil(m.singleOperationSampledMs / opMs));
    return ['--ops-per-sample', '1', '--rewarm-ops', '0', '--samples', String(samples)];
  }
  const ops = Math.ceil(m.minSampleMs / opMs);
  return ['--ops-per-sample', String(ops), '--rewarm-ops', String(Math.floor(m.rewarmMs / opMs))];
}

/**
 * The Node flags of one pair's timing processes, from the same probe: `repeatedNodeFlags` for a
 * pair that repeats the operation, none for a one-parse pair.
 */
export function pairNodeFlags(opMs: number, m: ManifestV2['measurement']): string[] {
  return opMs >= m.singleOperationMinMs ? [] : m.repeatedNodeFlags;
}

/**
 * The W1 section: 24 cases (six families x two sizes x rows and records), each a
 * frozen v1 fixture, primary with weight 1 inside the W1 manifest only; every case
 * in exactly one shard; every implementation either with a W1 function or with the
 * reason it has none.
 */
function w1Issues(v2: ManifestV2, base: Manifest): string[] {
  const issues: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) issues.push(`w1: ${message}`);
  };
  const { w1 } = v2;
  const ids = w1.cases.map((c) => c.id);
  need(new Set(ids).size === ids.length && ids.length === 24, 'needs 24 distinct case ids');
  for (const c of w1.cases) {
    const frozen = base.cases.find(
      (b) => b.lane === 'B1' && b.family === c.family && b.targetBytes === c.targetBytes,
    );
    need(
      c.lane === 'W1' && c.class === 'primary' && c.weight === 1,
      `${c.id} must be lane W1, class primary, weight 1`,
    );
    need(c.shape === 'rows' || c.shape === 'records', `${c.id} needs shape rows or records`);
    need(
      frozen?.fixture !== undefined && JSON.stringify(frozen.fixture) === JSON.stringify(c.fixture),
      `${c.id} must use the frozen fixture of its family and size`,
    );
  }
  const sharded = w1.shards.flatMap((s) => s.cases);
  need(
    sharded.length === ids.length && ids.every((id) => sharded.includes(id)),
    'every case must be in exactly one shard',
  );
  need(
    w1.shards.every((s) => s.id !== v2.measurement.memoryShard),
    'a shard id equals measurement.memoryShard',
  );
  const implIds = w1.implementations.map((i) => i.id);
  need(new Set(implIds).size === implIds.length, 'implementation ids must be distinct');
  need(!implIds.includes(v2.aa.impl), 'aa.impl must not name a W1 implementation');
  for (const i of w1.implementations) {
    need(
      i.lanes.includes('W1') !== (i.missingLanes?.W1 !== undefined),
      `${i.id} needs either lane W1 or missingLanes.W1`,
    );
    need(w1.competitors[i.package] !== undefined, `${i.id}: package ${i.package} has no version`);
  }
  issues.push(
    ...armIssues(w1.arms, [base.candidate, v2.aa.impl, ...implIds]).map((m) => `w1: ${m}`),
  );
  for (const shape of ['rows', 'records']) {
    need(
      w1.cases.some(
        (c) =>
          c.shape === shape &&
          c.family === v2.budget.dryRun.checkFamily &&
          c.targetBytes === v2.budget.dryRun.targetBytes,
      ),
      `budget.dryRun: no ${shape} ${v2.budget.dryRun.checkFamily} case of ${String(v2.budget.dryRun.targetBytes)} bytes`,
    );
  }
  return issues;
}

/**
 * The W1 lane as a manifest of its own: the v1 runtime, reference, candidate,
 * families, measurement and limits, with W1's cases, implementations, declared
 * unsupported pairs, package versions and shards. Its cases are primary (weight 1)
 * within W1, which gives them the A/A arm, the memory phase and Holm over the 24.
 */
export function w1Manifest(base: Manifest, v2: ManifestV2): Manifest {
  const { w1 } = v2;
  return {
    ...base,
    candidateDeferredLanes: {},
    competitors: w1.competitors,
    implementations: w1.implementations,
    unsupported: w1.unsupported,
    campaign: { ...base.campaign, shards: w1.shards, coldStartShard: '', coldStartCase: '' },
    cases: w1.cases,
  };
}

/**
 * The S1 section: S1 cases of class additional and weight 0, each on the frozen v1
 * fixture of its family and size, ids distinct from the v1 cases; with the v1 S1
 * cases, the six families at 1 MiB and 32 MiB in the default chunks.
 */
function s1Issues(v2: ManifestV2, base: Manifest): string[] {
  const issues: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) issues.push(`s1: ${message}`);
  };
  const ids = v2.s1.cases.map((c) => c.id);
  need(new Set(ids).size === ids.length, 'case ids must be distinct');
  for (const c of v2.s1.cases) {
    const frozen = base.cases.find(
      (b) => b.lane === 'B1' && b.family === c.family && b.targetBytes === c.targetBytes,
    );
    need(!base.cases.some((b) => b.id === c.id), `${c.id} is a case of bench/manifest.json`);
    need(
      c.lane === 'S1' && c.class === 'additional' && c.weight === 0,
      `${c.id} must be lane S1, class additional, weight 0`,
    );
    need(
      frozen?.fixture !== undefined && JSON.stringify(frozen.fixture) === JSON.stringify(c.fixture),
      `${c.id} must use the frozen fixture of its family and size`,
    );
    need(
      c.chunkBytes === undefined || (Number.isSafeInteger(c.chunkBytes) && c.chunkBytes > 0),
      `${c.id}: chunkBytes must be a positive integer`,
    );
  }
  const plain = s1Manifest(base, v2).cases;
  for (const family of Object.keys(base.families)) {
    for (const size of [1_048_576, 33_554_432]) {
      need(
        plain.filter((c) => c.family === family && c.targetBytes === size).length === 1,
        `needs one ${family} case of ${String(size)} bytes in the default chunks`,
      );
    }
  }
  const sharded = v2.s1.shards.flatMap((x) => x.cases);
  need(
    sharded.length === plain.length && plain.every((c) => sharded.includes(c.id)),
    'every case in the default chunks must be in exactly one shard, and no variant in any',
  );
  const shardIds = v2.s1.shards.map((x) => x.id);
  need(
    new Set(shardIds).size === shardIds.length && !shardIds.includes(v2.measurement.memoryShard),
    'shard ids must be distinct and differ from measurement.memoryShard',
  );
  const taken = [base.candidate, v2.aa.impl, ...base.implementations.map((i) => i.id)];
  issues.push(...armIssues(v2.s1.arms, taken).map((m) => `s1: ${m}`));
  need(v2.s1.arms[BULK_IMPL] !== undefined, `arms must include ${BULK_IMPL}`);
  return issues;
}

/** The candidate's arms of a lane: a name nothing else uses, and an options object. */
function armIssues(arms: Record<string, unknown>, taken: readonly string[]): string[] {
  return Object.entries(arms).flatMap(([arm, options]) => [
    ...(taken.includes(arm) ? [`arm ${arm} is already an implementation or the candidate`] : []),
    ...(options !== null && typeof options === 'object' && !Array.isArray(options)
      ? []
      : [`arm ${arm}: options must be an object`]),
  ]);
}

/**
 * The S1 lane's campaign as a manifest of its own: the six S1 1 MiB cases of
 * bench/manifest.json and the S1 cases of manifest-v2.json in the default chunks, its
 * shards, v1's implementations (each S1 lane as declared there) and the candidate's S1
 * lane, which the v1 manifest defers. With `variants`, also the cases with a `chunkBytes` of their
 * own, which only the A/B tool runs (abManifest).
 */
export function s1Manifest(base: Manifest, v2: ManifestV2, variants = false): Manifest {
  return {
    ...base,
    candidateDeferredLanes: {},
    campaign: { ...base.campaign, shards: v2.s1.shards, coldStartShard: '', coldStartCase: '' },
    cases: [
      ...base.cases.filter((c) => c.lane === 'S1'),
      ...v2.s1.cases.filter((c) => variants || c.chunkBytes === undefined),
    ],
  };
}

/** The manifest of a lane run on its own (--lane), or the B1/B2/S1 manifest without one. */
export function laneManifest(lane: string | undefined, base: Manifest, v2: ManifestV2): Manifest {
  if (lane === undefined) return base;
  if (lane === 'W1') return w1Manifest(base, v2);
  if (lane === 'S1') return s1Manifest(base, v2);
  throw new Error(`unknown lane ${lane} (S1 or W1)`);
}

/** The manifest of bench/ab.ts: its lane's, and for S1 with the one-chunk variants. */
export function abManifest(lane: string | undefined, base: Manifest, v2: ManifestV2): Manifest {
  return lane === 'S1' ? s1Manifest(base, v2, true) : laneManifest(lane, base, v2);
}

/** True for the S1 manifest (s1Manifest): every case is an S1 case. */
export const isS1Manifest = (manifest: Manifest) =>
  manifest.cases.length > 0 && manifest.cases.every((c) => c.lane === 'S1');

/** The lane of a lane manifest (laneManifest), undefined for the B1/B2/S1 manifest. */
export function manifestLane(manifest: Manifest): 'S1' | 'W1' | undefined {
  const lane = manifest.cases[0]?.lane;
  return (lane === 'S1' || lane === 'W1') && manifest.cases.every((c) => c.lane === lane)
    ? lane
    : undefined;
}

/** The candidate's arms of a lane run (manifest-v2 `s1.arms`, `w1.arms`); none without a lane. */
export const armsOf = (v2: ManifestV2, lane: string | undefined): Record<string, AdapterOptions> =>
  lane === 'S1' ? v2.s1.arms : lane === 'W1' ? v2.w1.arms : {};

/**
 * The cases a v2 run scores (A/A arm, Holm, memory phase): the primary ones; in the S1
 * manifest every case, which is reported on its own and never with B1/B2 or W1.
 */
export function scoredCases(manifest: Manifest): CaseSpec[] {
  const s1 = isS1Manifest(manifest);
  return manifest.cases.filter((c) => s1 || c.class === 'primary');
}

/** Reads and validates manifest-v2.json against the v1 manifest it names. Throws on any issue. */
export function readManifestV2(
  path = MANIFEST_V2_PATH,
  base = readManifest(),
  baseSha256 = manifestSha256(),
): ManifestV2 {
  const v2 = JSON.parse(readFileSync(path, 'utf8')) as ManifestV2;
  const issues = manifestV2Issues(v2, base, baseSha256);
  if (issues.length > 0) throw new Error(`invalid v2 manifest ${path}: ${issues.join('; ')}`);
  return v2;
}

// The publication method (bench/manifest-pub.json): method v2 with a few values replaced, for
// the numbers that are published (docs/benchmarks.md, "How the harness measures"). The file
// names manifest-v2.json by hash, as that file names the frozen v1 manifest, and states only what
// differs. Neither frozen file changes, so a v2 run still matches its own manifest.

export interface ManifestPub {
  schemaVersion: number;
  method: string;
  status: string;
  base: { path: string; sha256: string };
  /** The Node version of every process, in place of the v1 manifest's. */
  runtime: { node: string };
  /** Package versions in place of those of the v1 manifest and of the W1 section. */
  competitors: Record<string, string>;
  /**
   * The directory under node_modules that holds each such package: an npm alias, because the
   * tests keep the frozen version under the package's own name. A checkout copy gets the alias
   * under the package's name (bench/run.ts `prepareCopies`), so its workers import that version.
   */
  installedAs: Record<string, string>;
  /** No Node flag for any regime: V8's defaults apart from --expose-gc and the round's seeds. */
  measurement: Pick<ManifestV2['measurement'], 'repeatedNodeFlags'>;
}

export const MANIFEST_PUB_PATH = fileURLToPath(new URL('./manifest-pub.json', import.meta.url));

const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const VERSION = /^\d+\.\d+\.\d+$/;

/** Every reason the object is not a usable publication manifest over this v2 manifest; empty when valid. */
export function manifestPubIssues(pub: ManifestPub, base: Manifest, v2Sha256: string): string[] {
  const issues: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) issues.push(message);
  };
  const keys = (o: object) => Object.keys(o).sort().join(',');
  need(pub.schemaVersion === 1 && pub.method === 'pub', 'schemaVersion must be 1 and method "pub"');
  need(
    keys(pub) === 'base,competitors,installedAs,measurement,method,runtime,schemaVersion,status' &&
      keys(pub.runtime) === 'node' &&
      keys(pub.measurement) === 'repeatedNodeFlags',
    'it may replace only runtime.node, competitors (with installedAs) and measurement.repeatedNodeFlags',
  );
  need(
    pub.base.path === 'manifest-v2.json' && pub.base.sha256 === v2Sha256,
    `manifest-v2.json sha256 is ${v2Sha256}, not ${pub.base.sha256}`,
  );
  need(VERSION.test(pub.runtime.node), 'runtime.node must be a version x.y.z');
  for (const [pkg, version] of Object.entries(pub.competitors)) {
    need(
      base.competitors[pkg] !== undefined,
      `competitors: ${pkg} is not a package of the manifest`,
    );
    need(VERSION.test(version), `competitors: ${pkg} needs a version x.y.z`);
  }
  need(
    Object.keys(pub.installedAs).every((pkg) => pub.competitors[pkg] !== undefined),
    'installedAs may name only packages of competitors',
  );
  return issues;
}

/** One method v2 runs under: its two manifests and the file whose hash its records state. */
export interface Method {
  /** `--method`: v2 (bench/manifest-v2.json as it is) or pub. */
  name: string;
  /** The file a run records the hash of, as `manifestV2Sha256`: manifest-v2.json, or the publication manifest that names it. */
  path: string;
  sha256: string;
  manifest: Manifest;
  v2: ManifestV2;
  /** The directory under node_modules a checkout copy holds as each package (ManifestPub.installedAs). */
  installedAs: Record<string, string>;
}

/**
 * Method v2's papaparse. The frozen manifests name 5.7.0, and the tests' own
 * papaparse is 5.7.1, so v2 copies take 5.7.0 from the alias, as pub copies take 5.7.1.
 */
const V2_INSTALLED_AS: Readonly<Record<string, string>> = { papaparse: 'papaparse-5.7.0' };

/**
 * The manifests of a method. `pub` is v2 with the publication manifest's values in place of
 * their own, in the v1 manifest and in the W1 section alike. Throws on an invalid file.
 */
export function readMethod(name: string): Method {
  const manifest = readManifest();
  const v2 = readManifestV2();
  const v2Sha256 = fileSha256(MANIFEST_V2_PATH);
  if (name === 'v2')
    return {
      name,
      path: MANIFEST_V2_PATH,
      sha256: v2Sha256,
      manifest,
      v2,
      installedAs: { ...V2_INSTALLED_AS },
    };
  if (name !== 'pub') throw new Error(`unknown method ${name} (v2 or pub)`);
  const pub = JSON.parse(readFileSync(MANIFEST_PUB_PATH, 'utf8')) as ManifestPub;
  const versions = (own: Record<string, string>) =>
    Object.fromEntries(Object.entries(own).map(([p, v]) => [p, pub.competitors[p] ?? v]));
  const method: Method = {
    name,
    path: MANIFEST_PUB_PATH,
    sha256: fileSha256(MANIFEST_PUB_PATH),
    manifest: {
      ...manifest,
      runtime: { ...manifest.runtime, node: pub.runtime.node },
      competitors: versions(manifest.competitors),
    },
    v2: {
      ...v2,
      measurement: { ...v2.measurement, ...pub.measurement },
      w1: { ...v2.w1, competitors: versions(v2.w1.competitors) },
      pub,
    },
    installedAs: pub.installedAs,
  };
  const issues = [
    ...manifestPubIssues(pub, manifest, v2Sha256),
    ...manifestV2Issues(method.v2, method.manifest, manifestSha256()),
  ];
  if (issues.length > 0)
    throw new Error(`invalid publication manifest ${MANIFEST_PUB_PATH}: ${issues.join('; ')}`);
  return method;
}

/**
 * The method a run was recorded under: the one whose manifest file has the hash in its start
 * record, else v2, under which a run of any other manifest reads "run with a different v2
 * manifest" (bench/report.ts) and gets no result, so it renders at its own harness commit.
 */
export const methodOf = (manifestV2Sha256: unknown): Method =>
  readMethod(manifestV2Sha256 === fileSha256(MANIFEST_PUB_PATH) ? 'pub' : 'v2');

/** A 32-bit seed for one named use of the campaign seed (order of a round, a bootstrap, ...). */
export function seedFor(campaignSeed: number, label: string): number {
  return createHash('sha256')
    .update(`${String(campaignSeed)}\0${label}`)
    .digest()
    .readUInt32BE(0);
}

/**
 * Pairs a v2 run must account for. A campaign has v1's pairs plus the A/A arm on
 * every scored case (scoredCases) and, in the S1 and W1 manifests, the arms of
 * manifest-v2 `s1.arms` and `w1.arms` wherever the candidate is measured; a
 * calibration has only the candidate and the A/A arm on the scored cases.
 */
export function expectedPairsV2(
  manifest: Manifest,
  v2: ManifestV2,
  kind: 'campaign' | 'calibration',
  caseIds?: readonly string[],
): ExpectedPair[] {
  const scored = new Set(scoredCases(manifest).map((c) => c.id));
  const base = expectedPairs(manifest, caseIds).filter(
    (p) => kind === 'campaign' || (p.impl === manifest.candidate && scored.has(p.case)),
  );
  const measured = base.filter((p) => p.impl === manifest.candidate && p.expect === 'measure');
  const copy = (impl: string) => (p: ExpectedPair) => ({
    impl,
    case: p.case,
    expect: 'measure' as const,
  });
  const aa = measured.filter((p) => scored.has(p.case)).map(copy(v2.aa.impl));
  const arms =
    kind === 'campaign'
      ? Object.keys(armsOf(v2, manifestLane(manifest))).flatMap((arm) => measured.map(copy(arm)))
      : [];
  return [...base, ...aa, ...arms];
}
