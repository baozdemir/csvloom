import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './fixtures.ts';
import { BULK_IMPL } from './lanes.ts';
import {
  armsOf,
  expectedColdImpls,
  expectedPairs,
  abManifest,
  expectedPairsV2,
  laneManifest,
  manifestLane,
  manifestSha256,
  methodOf,
  readManifest,
  scoredCases,
  seedFor,
  type Manifest,
  type ManifestV2,
} from './manifest.ts';

// Validates shard checkpoints (run.ts JSONL) against the complete frozen manifest
// and computes the method v1 score. Anything incomplete, filtered, smoke,
// interrupted or inconsistent can be shown as a labelled diagnostic but never
// yields an eligible score. Repetition spreads beyond the limit are flagged, and
// the Papa-relative checks are reported as facts; neither gates anything.

export interface ShardStart {
  type: 'start';
  kind: 'campaign' | 'smoke';
  campaignId: string;
  shardId: string;
  plannedCases: string[];
  filters: Record<string, unknown>;
  runtime: { node: string; workerFlags: string[] };
  packages: Record<string, string>;
  manifestSha256: string;
  source: { gitCommit: string; sha256: string };
  /** Machine identity written by bench/run.ts; every shard of a campaign must share it. */
  environment?: Record<string, unknown>;
}

export interface ShardEnd {
  type: 'end';
  status: string;
  manifestSha256: string;
  source: { gitCommit: string; sha256: string };
}

export interface JobRecord {
  /** check, time, memory or cold; parsed from JSON, so anything else is reported. */
  type: string;
  impl: string;
  case: string;
  status?: string;
  reason?: string;
  rep?: number;
  samplesMs?: unknown;
  measurement?: Record<string, unknown>;
  peakRssBytes?: unknown;
  [key: string]: unknown;
}

export interface Shard {
  file: string;
  start: ShardStart;
  records: JobRecord[];
  end: ShardEnd | null;
  /** The last line was cut off or the file was empty: an interrupted shard. */
  truncated?: boolean;
  /** No start record at all; `start` is a placeholder named after the file. */
  empty?: boolean;
}

/**
 * A runner killed while appending leaves a cut last line, or an empty file. Such
 * a file is an interrupted shard (`truncated`, no end record), never an error: an
 * unparsable last line is dropped, and a file without a start record gets a
 * placeholder start named after the file. An unparsable line before the last one
 * is corruption and still throws.
 */
export function parseShard(text: string, file = '(memory)'): Shard {
  const raw = text.split('\n').filter(Boolean);
  const lines: Array<{ type: string }> = [];
  let truncated = raw.length === 0;
  for (const [i, line] of raw.entries()) {
    try {
      lines.push(JSON.parse(line) as { type: string });
    } catch (error) {
      if (i !== raw.length - 1) throw error;
      truncated = true;
    }
  }
  const [start, ...rest] = lines;
  if (!start && truncated) {
    const placeholder: ShardStart = {
      type: 'start',
      kind: 'smoke',
      campaignId: '',
      shardId: (file.split('/').pop() ?? file).replace(/\.jsonl$/, ''),
      plannedCases: [],
      filters: {},
      runtime: { node: '', workerFlags: [] },
      packages: {},
      manifestSha256: '',
      source: { gitCommit: '', sha256: '' },
    };
    return { file, start: placeholder, records: [], end: null, truncated: true, empty: true };
  }
  if (start?.type !== 'start') throw new Error(`${file}: first record is not a start record`);
  const last = rest.at(-1);
  const end = !truncated && last?.type === 'end' ? (last as ShardEnd) : null;
  const records = (end ? rest.slice(0, -1) : rest) as JobRecord[];
  return { file, start: start as ShardStart, records, end, ...(truncated ? { truncated } : {}) };
}

const key = (impl: string, caseId: string) => `${impl}\u0000${caseId}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedKeys = (o: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;

export interface Validation {
  eligible: boolean;
  issues: string[];
}

interface PairRecords {
  checks: JobRecord[];
  times: JobRecord[];
  memory: JobRecord[];
}

interface RecordIndex {
  pairs: Map<string, PairRecords>;
  cold: Map<string, JobRecord[]>;
}

/**
 * Indexes job records by implementation/case. A check, time or memory record
 * counts only inside the shard that owns its case; a cold record only inside the
 * designated cold-start shard, for the cold-start case (which may belong to
 * another shard). Everything else is reported and left out, so validation and
 * summaries read the same records.
 */
function indexRecords(manifest: Manifest, shards: readonly Shard[], issues: string[]): RecordIndex {
  const pairs = new Map<string, PairRecords>();
  const cold = new Map<string, JobRecord[]>();
  const expected = new Set(expectedPairs(manifest).map((p) => key(p.impl, p.case)));
  for (const s of shards) {
    const where = `${s.file} (${s.start.shardId})`;
    const owned = new Set(manifest.campaign.shards.find((x) => x.id === s.start.shardId)?.cases);
    for (const r of s.records) {
      const what = `${r.type} record for ${r.impl} @ ${r.case}`;
      if (r.type === 'cold') {
        const { coldStartShard, coldStartCase } = manifest.campaign;
        if (s.start.shardId === coldStartShard && r.case === coldStartCase) {
          cold.set(r.impl, [...(cold.get(r.impl) ?? []), r]);
        } else issues.push(`${where}: ${what} is outside the cold-start shard and case`);
        continue;
      }
      if (r.type !== 'check' && r.type !== 'time' && r.type !== 'memory') {
        issues.push(`${where}: unknown record type ${r.type}`);
        continue;
      }
      if (!owned.has(r.case)) {
        issues.push(`${where}: ${what} belongs to another shard`);
        continue;
      }
      if (!expected.has(key(r.impl, r.case))) {
        issues.push(`${where}: unexpected ${what}`);
        continue;
      }
      const entry = pairs.get(key(r.impl, r.case)) ?? { checks: [], times: [], memory: [] };
      if (r.type === 'check') entry.checks.push(r);
      else if (r.type === 'time') entry.times.push(r);
      else entry.memory.push(r);
      pairs.set(key(r.impl, r.case), entry);
    }
  }
  return { pairs, cold };
}

/** A successful memory job: no failure status and consistent positive peaks. */
const validMemory = (r: JobRecord) =>
  r.status === undefined &&
  typeof r.peakRssMethod === 'string' &&
  positive(r.peakRssBytes) &&
  positive(r.loadedInputPeakRssBytes) &&
  (r.peakRssBytes as number) >= (r.loadedInputPeakRssBytes as number);

/** The pair's memory result: exactly one record, and it is a valid success; otherwise null. */
function memoryResult(records: readonly JobRecord[] | undefined): JobRecord | null {
  const [only] = records ?? [];
  return records?.length === 1 && only && validMemory(only) ? only : null;
}

export function validateCampaign(
  manifest: Manifest,
  manifestSha: string,
  shards: readonly Shard[],
): Validation {
  const issues: string[] = [];
  const m = manifest.measurement;
  if (shards.length === 0) issues.push('no shard results');

  // Manifest sanity: every case in exactly one shard, valid primary weights.
  const shardOf = new Map<string, string>();
  for (const s of manifest.campaign.shards) {
    for (const c of s.cases) {
      if (shardOf.has(c)) issues.push(`manifest: case ${c} is in more than one shard`);
      shardOf.set(c, s.id);
    }
  }
  for (const c of manifest.cases) {
    if (!shardOf.has(c.id)) issues.push(`manifest: case ${c.id} is in no shard`);
    if (c.class === 'primary' && !positive(c.weight)) {
      issues.push(`manifest: primary case ${c.id} has invalid weight ${String(c.weight)}`);
    }
  }

  // Shard identity and completion.
  const campaignIds = new Set(shards.map((s) => s.start.campaignId));
  if (campaignIds.size > 1) {
    issues.push(`shards come from different campaigns: ${[...campaignIds].join(', ')}`);
  }
  const sources = new Set(
    shards.map((s) => `${s.start.source.gitCommit}/${s.start.source.sha256}`),
  );
  if (sources.size > 1) issues.push('shards were run from different source identities');
  // Timings and memory from different machines, or peak-RSS readings taken by
  // different methods, are never combined into one campaign.
  const environments = new Set(shards.map((s) => JSON.stringify(s.start.environment ?? null)));
  if (environments.has('null')) issues.push('a shard has no machine environment identity');
  if (environments.size > 1) issues.push('shards were run on different machines');
  const methods = new Set(
    shards.flatMap((s) => s.records.filter((r) => r.type === 'memory').map((r) => r.peakRssMethod)),
  );
  if (methods.size > 1) {
    issues.push(
      `memory records use different peak-RSS methods: ${[...methods].map(String).join(', ')}`,
    );
  }
  const seen = new Map<string, number>();
  for (const s of shards) {
    const where = `${s.file} (${s.start.shardId})`;
    seen.set(s.start.shardId, (seen.get(s.start.shardId) ?? 0) + 1);
    if (s.start.kind !== 'campaign') issues.push(`${where}: ${s.start.kind} run; diagnostics only`);
    if (Object.values(s.start.filters).some((v) => v !== null && v !== false)) {
      issues.push(`${where}: filtered run ${JSON.stringify(s.start.filters)}`);
    }
    if (s.start.manifestSha256 !== manifestSha)
      issues.push(`${where}: run with a different manifest`);
    if (s.start.runtime.node !== `v${manifest.runtime.node}`) {
      issues.push(
        `${where}: runtime ${s.start.runtime.node}, manifest requires v${manifest.runtime.node}`,
      );
    }
    if (!same(s.start.runtime.workerFlags, manifest.runtime.flags)) {
      issues.push(`${where}: worker flags differ from the manifest`);
    }
    if (sortedKeys(s.start.packages) !== sortedKeys(manifest.competitors)) {
      issues.push(`${where}: installed package versions differ from the manifest`);
    }
    const planned = manifest.campaign.shards.find((x) => x.id === s.start.shardId);
    if (!planned) issues.push(`${where}: not a manifest shard`);
    else if (!same([...s.start.plannedCases].sort(), [...planned.cases].sort())) {
      issues.push(`${where}: planned cases differ from the manifest shard`);
    }
    if (!s.end) issues.push(`${where}: no end record (interrupted)`);
    else {
      if (s.end.status !== 'complete') issues.push(`${where}: ended with ${s.end.status}`);
      if (
        s.end.source.sha256 !== s.start.source.sha256 ||
        s.end.source.gitCommit !== s.start.source.gitCommit
      ) {
        issues.push(`${where}: source changed during the shard`);
      }
      if (s.end.manifestSha256 !== manifestSha)
        issues.push(`${where}: manifest changed during the shard`);
    }
  }
  for (const s of manifest.campaign.shards) {
    const n = seen.get(s.id) ?? 0;
    if (n !== 1) issues.push(`shard ${s.id} present ${String(n)} times`);
  }

  // Every expected pair is accounted for, by records its own shard holds.
  const { pairs, cold } = indexRecords(manifest, shards, issues);
  const caseClass = new Map(manifest.cases.map((c) => [c.id, c.class]));
  const statusOf = (impl: string, caseId: string) => {
    const checks = pairs.get(key(impl, caseId))?.checks ?? [];
    return checks.length === 1 ? checks[0]?.status : undefined;
  };
  for (const p of expectedPairs(manifest)) {
    const where = `${p.impl} @ ${p.case}`;
    const entry = pairs.get(key(p.impl, p.case));
    const checks = entry?.checks ?? [];
    if (checks.length !== 1) {
      issues.push(
        `${where}: ${checks.length === 0 ? 'no correctness record' : 'duplicate correctness records'}`,
      );
      continue;
    }
    if ((entry?.memory.length ?? 0) > 1)
      issues.push(`${where}: ${String(entry?.memory.length)} memory records`);
    const status = checks[0]?.status;
    if (p.expect !== 'measure') {
      const wanted = p.expect === 'unsupported' ? 'UNSUPPORTED' : 'DEFERRED';
      if (status !== wanted)
        issues.push(`${where}: declared ${wanted} but reported ${String(status)}`);
      continue;
    }
    if (status === 'UNSUPPORTED' || status === 'DEFERRED') {
      issues.push(`${where}: ${status} at run time but not declared in the manifest`);
      continue;
    }
    if (status !== 'PASS') {
      // A competitor may fail correctness (it is then not a reference); the
      // candidate (every required case, real datasets included) and the
      // regression reference must pass. Anything else (UNAVAILABLE, BLOCKED, ...)
      // is a missing measurement.
      const mustPass = p.impl === manifest.candidate || caseClass.get(p.case) === 'regression';
      if (status !== 'FAIL' && status !== 'NO-ORACLE')
        issues.push(`${where}: ${String(status)} (missing measurement)`);
      else if (mustPass) issues.push(`${where}: ${status}`);
      continue;
    }
    const all = entry?.times ?? [];
    const reps = all.filter((t) => t.status !== 'BLOCKED');
    if (reps.length !== all.length)
      issues.push(`${where}: ${String(all.length - reps.length)} timing job(s) blocked`);
    const repIds = reps.map((t) => t.rep).sort();
    const wanted = Array.from({ length: m.repetitions }, (_, i) => i + 1);
    if (!same(repIds, wanted)) {
      issues.push(
        `${where}: repetitions ${JSON.stringify(repIds)}, required ${JSON.stringify(wanted)}`,
      );
    }
    for (const t of reps) {
      const samples = Array.isArray(t.samplesMs) ? (t.samplesMs as unknown[]) : [];
      const at = `${where} rep ${String(t.rep)}`;
      if (samples.length !== m.samples) {
        issues.push(`${at}: ${String(samples.length)} samples, required ${String(m.samples)}`);
      }
      if (!samples.every(positive)) issues.push(`${at}: non-finite or non-positive sample`);
      const settings = t.measurement ?? {};
      for (const field of ['warmupMs', 'minWarmupOps', 'samples', 'minSampleMs'] as const) {
        if (settings[field] !== m[field]) issues.push(`${at}: ${field} differs from the manifest`);
      }
    }
  }

  // Memory and small-input comparisons are made against the reference, so it
  // must pass wherever they use it; each side needs exactly one valid result.
  for (const c of manifest.cases.filter((x) => x.class === 'primary')) {
    const refStatus = statusOf(manifest.reference, c.id);
    if (refStatus !== 'PASS') {
      issues.push(
        `reference ${manifest.reference} @ ${c.id}: ${String(refStatus)}; the memory comparison needs a passing reference`,
      );
    }
    for (const impl of [manifest.reference, manifest.candidate]) {
      if (impl === manifest.reference && refStatus !== 'PASS') continue;
      if (impl === manifest.candidate && statusOf(impl, c.id) !== 'PASS') continue;
      const records = pairs.get(key(impl, c.id))?.memory ?? [];
      if (records.length === 0) issues.push(`${impl} @ ${c.id}: no memory record`);
      else if (!memoryResult(records)) {
        issues.push(
          `${impl} @ ${c.id}: memory result must be exactly one valid success (${String(records.length)} record(s))`,
        );
      }
    }
  }

  // Cold start: one valid result per expected implementation.
  const coldImpls = expectedColdImpls(manifest);
  for (const impl of coldImpls) {
    const records = cold.get(impl) ?? [];
    const [only] = records;
    if (
      records.length !== 1 ||
      !only ||
      only.status !== undefined ||
      !positive(only.firstParseMs)
    ) {
      issues.push(
        `${impl}: cold start needs exactly one valid result (${String(records.length)} record(s), status ${String(only?.status)})`,
      );
    }
  }
  for (const impl of cold.keys()) {
    if (!coldImpls.includes(impl)) issues.push(`unexpected cold-start record for ${impl}`);
  }
  return { eligible: issues.length === 0, issues };
}

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

export function median(xs: readonly number[]): number {
  const s = sorted(xs);
  const mid = s.length >> 1;
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest-rank quantile. */
export function quantile(xs: readonly number[], q: number): number {
  const s = sorted(xs);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)] ?? Number.NaN;
}

export interface Summary {
  impl: string;
  case: string;
  status: string;
  reason?: string;
  samples: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  /** Median per repetition, in repetition order. */
  repetitionMedians: number[];
  spread: number;
  inconclusive: boolean;
  /** From the pair's single valid memory result (the record validation accepts), else null. */
  peakRssBytes: number | null;
}

/** One row per implementation/case with exactly one owned correctness record. */
export function summarize(manifest: Manifest, shards: readonly Shard[]): Summary[] {
  const { pairs } = indexRecords(manifest, shards, []);
  const out: Summary[] = [];
  for (const entry of pairs.values()) {
    const [check] = entry.checks;
    if (entry.checks.length !== 1 || !check) continue;
    const reps = entry.times
      .filter((r) => r.status !== 'BLOCKED' && Array.isArray(r.samplesMs))
      .sort((a, b) => (a.rep ?? 0) - (b.rep ?? 0));
    const repetitionMedians = reps.map((r) => median(r.samplesMs as number[]));
    const pooled = reps.flatMap((r) => r.samplesMs as number[]);
    const medianMs = median(repetitionMedians);
    const spread = (Math.max(...repetitionMedians) - Math.min(...repetitionMedians)) / medianMs;
    const memory = memoryResult(entry.memory);
    out.push({
      impl: check.impl,
      case: check.case,
      status: check.status ?? 'UNKNOWN',
      ...(typeof check.reason === 'string' ? { reason: check.reason } : {}),
      samples: pooled.length,
      minMs: pooled.length ? Math.min(...pooled) : Number.NaN,
      medianMs,
      p95Ms: quantile(pooled, 0.95),
      repetitionMedians,
      spread,
      inconclusive:
        repetitionMedians.length < 2 || !(spread <= manifest.scoring.inconclusiveSpread),
      peakRssBytes: memory ? (memory.peakRssBytes as number) : null,
    });
  }
  return out;
}

export interface CaseScore {
  case: string;
  lane: string;
  weight: number;
  referenceImpl: string | null;
  speedup: number | null;
  /** Speedup computed from each repetition's medians alone. */
  repetitionSpeedups: Array<number | null>;
  inconclusive: boolean;
}

/** A reported check against a limit. `met` is null only when a ratio is missing. */
export interface TargetCheck {
  value: number | null;
  limit: number;
  met: boolean | null;
}

export interface SpreadFlag {
  case: string;
  impl: string;
  spread: number;
  /** The smallest repetition median: for a competitor, its most favourable reading. */
  bestRepetitionMs: number;
}

export interface Score {
  validation: Validation;
  /**
   * The measurements are complete, valid and conclusive (no compared side spreads
   * beyond the limit). Reported only; it gates nothing.
   */
  evidenceUsable: boolean;
  /** Null unless the campaign validated. */
  overall: number | null;
  b1: number | null;
  b2: number | null;
  /** Computed whenever data allow; labelled diagnostics only. */
  diagnostic: {
    overall: number | null;
    b1: number | null;
    b2: number | null;
    perRepetition: Array<number | null>;
  };
  perCase: CaseScore[];
  /**
   * Candidate/reference median ratio per regression case. `inconclusive` when
   * either side's repetitions spread beyond the limit (or a side is missing): the
   * ratio stays visible, but the comparison is unresolved and the evidence is not
   * usable.
   */
  smallInputRegression: Array<{ case: string; ratio: number | null; inconclusive: boolean }>;
  /** Candidate absolute peak RSS / reference absolute peak RSS, same case and loading. */
  peakRssVsReference: Array<{ case: string; ratio: number | null }>;
  /** Every passing pair whose repetition medians spread beyond the limit, in manifest case order. */
  spreadFlags: SpreadFlag[];
  /** Evaluated whenever both sides have data, flagged or not. */
  reportedChecks: {
    /** Worst candidate/reference median ratio on regression cases. */
    smallInputRegression: TargetCheck;
    /** Worst candidate/reference peak-RSS ratio on primary cases. */
    peakMemory: TargetCheck;
  };
}

function geomean(
  cases: readonly CaseScore[],
  pick: (c: CaseScore) => number | null,
): number | null {
  const values = cases.map(pick);
  if (cases.length === 0 || !values.every(positive)) return null;
  const weight = cases.reduce((sum, c) => sum + c.weight, 0);
  return Math.exp(
    cases.reduce((sum, c, i) => sum + c.weight * Math.log(values[i] as number), 0) / weight,
  );
}

export function score(manifest: Manifest, manifestSha: string, shards: readonly Shard[]): Score {
  const validation = validateCampaign(manifest, manifestSha, shards);
  const summaries = summarize(manifest, shards);
  const find = (impl: string, caseId: string) =>
    summaries.find((s) => s.impl === impl && s.case === caseId);
  const reps = manifest.measurement.repetitions;
  const perCase: CaseScore[] = manifest.cases
    .filter((c) => c.class === 'primary')
    .map((c) => {
      // Every passing competitor competes, noisy or not: a noisy fast competitor
      // is never replaced by a slower one; the case is inconclusive instead.
      const competitors = summaries.filter(
        (s) => s.case === c.id && s.status === 'PASS' && s.impl !== manifest.candidate,
      );
      const candidate = find(manifest.candidate, c.id);
      const timed = competitors.length > 0 && competitors.every((s) => s.samples > 0);
      const reference = timed
        ? competitors.reduce((a, b) => (b.medianMs < a.medianMs ? b : a))
        : null;
      const cand = candidate?.status === 'PASS' && candidate.samples > 0 ? candidate : null;
      return {
        case: c.id,
        lane: c.lane,
        weight: c.weight,
        referenceImpl: reference?.impl ?? null,
        speedup: reference && cand ? reference.medianMs / cand.medianMs : null,
        repetitionSpeedups: Array.from({ length: reps }, (_, r) => {
          const ref = Math.min(...competitors.map((s) => s.repetitionMedians[r] ?? Number.NaN));
          const own = cand?.repetitionMedians[r];
          return timed && own !== undefined && Number.isFinite(ref) ? ref / own : null;
        }),
        inconclusive: [...competitors, ...(candidate ? [candidate] : [])].some(
          (s) => s.inconclusive,
        ),
      };
    });
  const lane = (l: string) => perCase.filter((c) => c.lane === l);
  const diagnostic = {
    overall: geomean(perCase, (c) => c.speedup),
    b1: geomean(lane('B1'), (c) => c.speedup),
    b2: geomean(lane('B2'), (c) => c.speedup),
    perRepetition: Array.from({ length: reps }, (_, r) =>
      geomean(perCase, (c) => c.repetitionSpeedups[r] ?? null),
    ),
  };
  const eligible = validation.eligible && diagnostic.overall !== null;
  // Comparisons against the reference only where it passed correctness.
  const ratio = (caseId: string, pick: (s: Summary) => number | null) => {
    const ref = find(manifest.reference, caseId);
    const cand = find(manifest.candidate, caseId);
    const a = cand?.status === 'PASS' ? pick(cand) : null;
    const b = ref?.status === 'PASS' ? pick(ref) : null;
    return a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && b > 0
      ? a / b
      : null;
  };
  const smallInputRegression = manifest.cases
    .filter((c) => c.class === 'regression')
    .map((c) => ({
      case: c.id,
      ratio: ratio(c.id, (s) => s.medianMs),
      inconclusive: [manifest.candidate, manifest.reference].some(
        (impl) => find(impl, c.id)?.inconclusive !== false,
      ),
    }));
  // Complete, valid and conclusive: every primary case and every required
  // small-input comparison.
  const evidenceUsable =
    eligible &&
    perCase.every((c) => !c.inconclusive) &&
    smallInputRegression.every((r) => !r.inconclusive);
  const peakRssVsReference = manifest.cases
    .filter((c) => c.class === 'primary')
    .map((c) => ({ case: c.id, ratio: ratio(c.id, (s) => s.peakRssBytes) }));
  const worst = (rows: Array<{ ratio: number | null }>) =>
    rows.length > 0 && rows.every((r) => r.ratio !== null)
      ? Math.max(...rows.map((r) => r.ratio as number))
      : null;
  const check = (value: number | null, max: number): TargetCheck => ({
    value,
    limit: 1 + max,
    met: value === null ? null : value <= 1 + max,
  });
  const spreadFlags = manifest.cases.flatMap((c) =>
    summaries
      .filter(
        (s) =>
          s.case === c.id && s.status === 'PASS' && s.spread > manifest.scoring.inconclusiveSpread,
      )
      .sort((a, b) => a.impl.localeCompare(b.impl))
      .map((s) => ({
        case: s.case,
        impl: s.impl,
        spread: s.spread,
        bestRepetitionMs: Math.min(...s.repetitionMedians),
      })),
  );
  const limits = manifest.scoring.reportedChecks;
  return {
    validation,
    evidenceUsable,
    overall: eligible ? diagnostic.overall : null,
    b1: eligible ? diagnostic.b1 : null,
    b2: eligible ? diagnostic.b2 : null,
    diagnostic,
    perCase,
    smallInputRegression,
    peakRssVsReference,
    spreadFlags,
    reportedChecks: {
      smallInputRegression: check(worst(smallInputRegression), limits.smallInputVsReferenceMax),
      peakMemory: check(worst(peakRssVsReference), limits.peakMemoryVsReferenceMax),
    },
  };
}

const fmt = (ms: number) =>
  !Number.isFinite(ms) ? '-' : ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(4);
const num = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));

export function renderMarkdown(
  manifest: Manifest,
  manifestSha: string,
  shards: readonly Shard[],
): string {
  const result = score(manifest, manifestSha, shards);
  const lines: string[] = [];
  if (result.validation.eligible) {
    const reps = result.diagnostic.perRepetition.map(num).join(' / ');
    lines.push(
      `ELIGIBLE campaign. Overall vs fastest valid competitor (reported; no numeric target): ${num(result.overall)} (B1 ${num(result.b1)}, B2 ${num(result.b2)}); per repetition ${reps}.`,
    );
    const flags = result.spreadFlags.map(
      (f) =>
        `${f.impl} @ ${f.case} ${(f.spread * 100).toFixed(1)}% (best repetition ${fmt(f.bestRepetitionMs)} ms)`,
    );
    lines.push(
      `Spread flags (above ${String(manifest.scoring.inconclusiveSpread * 100)}%): ${flags.length ? flags.join('; ') : 'none'}.`,
    );
    const c = result.reportedChecks;
    const fact = (t: TargetCheck) =>
      `${num(t.value)} (limit ${t.limit.toFixed(2)}: ${t.met === null ? 'not evaluated' : t.met ? 'within' : 'above'})`;
    lines.push(
      `Reported checks vs ${manifest.reference} (facts, not gates): small-input worst ratio ${fact(c.smallInputRegression)}; peak RSS worst ratio ${fact(c.peakMemory)}.`,
    );
  } else {
    const { issues } = result.validation;
    lines.push(`NOT ELIGIBLE: diagnostics only (${String(issues.length)} issues).`);
    for (const issue of issues.slice(0, 40)) lines.push(`- ${issue}`);
    if (issues.length > 40) lines.push(`- ... ${String(issues.length - 40)} more`);
    const d = result.diagnostic;
    lines.push(
      `Diagnostic overall ${num(d.overall)} (B1 ${num(d.b1)}, B2 ${num(d.b2)}); not a score.`,
    );
  }
  lines.push('', 'Unavailable (declared in the manifest; never run):');
  for (const u of manifest.unavailable) lines.push(`- ${u.package} ${u.version}: ${u.reason}`);
  lines.push('');
  const summaries = summarize(manifest, shards);
  for (const c of manifest.cases) {
    const rows = summaries
      .filter((s) => s.case === c.id)
      .sort(
        (a, b) =>
          (a.medianMs || Infinity) - (b.medianMs || Infinity) || a.impl.localeCompare(b.impl),
      );
    if (rows.length === 0) continue;
    lines.push(`### ${c.id} (${c.class})`, '');
    lines.push('| impl | status | median ms | min | p95 | n | rep spread | peak RSS MiB |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const s of rows) {
      const status = s.reason ? `${s.status} (${s.reason})` : s.status;
      const spread = s.samples
        ? `${(s.spread * 100).toFixed(1)}%${s.inconclusive ? ' INCONCLUSIVE' : ''}`
        : '-';
      const rss = s.peakRssBytes === null ? '-' : (s.peakRssBytes / 1048576).toFixed(1);
      lines.push(
        `| ${s.impl} | ${status} | ${fmt(s.medianMs)} | ${fmt(s.minMs)} | ${fmt(s.p95Ms)} | ${String(s.samples)} | ${spread} | ${rss} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Method v2 (docs/benchmarks.md, "Decision"): every ratio is a ratio of medians
// of per-process medians with a seeded percentile-bootstrap interval; a case is
// ahead or behind only when Holm-significant and outside its own A/A interval.
// The same raw data always give the same text.

/** Holm's step-down procedure: the hypotheses rejected at family-wise level alpha, in input order. */
export function holm(pValues: readonly number[], alpha: number): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const rejected = pValues.map(() => false);
  for (const [rank, { p, i }] of order.entries()) {
    if (!(p <= alpha / (pValues.length - rank))) break;
    rejected[i] = true;
  }
  return rejected;
}

export interface RatioInterval {
  /** median(numerator) / median(denominator). */
  ratio: number;
  lo: number;
  hi: number;
  /** Two-sided bootstrap p-value for ratio = 1: min(1, 2 (min(#{r* <= 1}, #{r* >= 1}) + 1) / (B + 1)). */
  p: number;
  /** The B resampled ratios, in resampling order. */
  replicates: number[];
}

function percentileBounds(replicates: readonly number[], confidence: number) {
  const s = sorted(replicates);
  const tail = Math.round(((1 - confidence) / 2) * s.length);
  return { lo: s[tail] ?? Number.NaN, hi: s[s.length - 1 - tail] ?? Number.NaN };
}

/**
 * Paired percentile bootstrap of a ratio of medians. `numerator[i]` and
 * `denominator[i]` are the process medians of the two arms in the same round, which
 * ran with the same V8 seed. Each replicate resamples round indices with
 * replacement once and takes both arms at those rounds, so whatever a round's seed
 * does to both arms (for example processes that settle near one of two speeds in both
 * arms) stays in both and cancels in the ratio, instead of being split unevenly
 * between the arms by chance. The statistic is still median over median. Two
 * comparisons bootstrapped with the same seed and the same number of rounds use
 * the same resampled rounds, replicate by replicate.
 */
export function pairedBootstrapRatio(
  numerator: readonly number[],
  denominator: readonly number[],
  seed: number,
  resamples: number,
  confidence: number,
): RatioInterval {
  if (numerator.length !== denominator.length)
    throw new Error('paired arms need one value per round each');
  const n = numerator.length;
  const random = mulberry32(seed);
  const top = new Array<number>(n);
  const bottom = new Array<number>(n);
  const replicates: number[] = [];
  for (let i = 0; i < resamples; i++) {
    for (let k = 0; k < n; k++) {
      const round = Math.floor(random() * n);
      top[k] = numerator[round] ?? NaN;
      bottom[k] = denominator[round] ?? NaN;
    }
    replicates.push(median(top) / median(bottom));
  }
  const atMost = replicates.filter((r) => r <= 1).length;
  const atLeast = replicates.filter((r) => r >= 1).length;
  return {
    ratio: median(numerator) / median(denominator),
    ...percentileBounds(replicates, confidence),
    p: Math.min(1, (2 * (Math.min(atMost, atLeast) + 1)) / (resamples + 1)),
    replicates,
  };
}

/**
 * The values of two arms in the rounds both have, in round order, and the rounds
 * only one of them has (excluded from pairing; a complete campaign has none).
 */
export function pairByRound(
  numerator: ReadonlyMap<number, number>,
  denominator: ReadonlyMap<number, number>,
): { top: number[]; bottom: number[]; unpaired: number[] } {
  const rounds = [...new Set([...numerator.keys(), ...denominator.keys()])].sort((a, b) => a - b);
  const both = rounds.filter((r) => numerator.has(r) && denominator.has(r));
  return {
    top: both.map((r) => numerator.get(r) ?? NaN),
    bottom: both.map((r) => denominator.get(r) ?? NaN),
    unpaired: rounds.filter((r) => !both.includes(r)),
  };
}

/**
 * Unpaired percentile bootstrap of a ratio of medians: each replicate resamples the
 * processes of each arm independently. The reports do not use it; it is the reference
 * the paired bootstrap is tested against.
 */
export function bootstrapRatio(
  numerator: readonly number[],
  denominator: readonly number[],
  seed: number,
  resamples: number,
  confidence: number,
): RatioInterval {
  const a = sorted(numerator);
  const b = sorted(denominator);
  const random = mulberry32(seed);
  // Median of one resample with replacement, kept sorted by insertion as it is drawn.
  const resampler = (xs: readonly number[]) => {
    const n = xs.length;
    const draw = new Float64Array(n);
    return () => {
      for (let i = 0; i < n; i++) {
        const value = xs[Math.floor(random() * n)] ?? NaN;
        let j = i;
        for (; j > 0 && (draw[j - 1] ?? NaN) > value; j--) draw[j] = draw[j - 1] ?? NaN;
        draw[j] = value;
      }
      const mid = n >> 1;
      return n % 2 ? (draw[mid] ?? NaN) : ((draw[mid - 1] ?? NaN) + (draw[mid] ?? NaN)) / 2;
    };
  };
  const top = resampler(a);
  const bottom = resampler(b);
  const replicates: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const t = top();
    replicates.push(t / bottom());
  }
  const atMost = replicates.filter((r) => r <= 1).length;
  const atLeast = replicates.filter((r) => r >= 1).length;
  return {
    ratio: median(a) / median(b),
    ...percentileBounds(replicates, confidence),
    p: Math.min(1, (2 * (Math.min(atMost, atLeast) + 1)) / (resamples + 1)),
    replicates,
  };
}

export interface Estimate {
  ratio: number;
  lo: number;
  hi: number;
}

/** Weighted geometric mean of case ratios; its interval takes replicate i of every case together. */
function geometricMean(
  rows: ReadonlyArray<{ weight: number; interval: RatioInterval | null }>,
  confidence: number,
): Estimate | null {
  const intervals = rows.map((r) => r.interval);
  if (rows.length === 0 || intervals.some((x) => x === null || !positive(x.ratio))) return null;
  const weight = rows.reduce((sum, r) => sum + r.weight, 0);
  const mean = (pick: (x: RatioInterval) => number) =>
    Math.exp(
      rows.reduce(
        (sum, r, i) => sum + r.weight * Math.log(pick(intervals[i] as RatioInterval)),
        0,
      ) / weight,
    );
  const n = (intervals[0] as RatioInterval).replicates.length;
  const replicates = Array.from({ length: n }, (_, i) =>
    mean((x) => x.replicates[i] ?? Number.NaN),
  );
  return { ratio: mean((x) => x.ratio), ...percentileBounds(replicates, confidence) };
}

export interface HashesV2 {
  manifestSha256: string;
  manifestV2Sha256: string;
}

interface StartV2 {
  method?: string;
  kind?: string;
  /** 'W1' for a W1 run (bench/run.ts or bench/ab.ts --lane W1), 'S1' for an S1 A/B; absent otherwise. */
  lane?: string;
  /** 'memory' for the memory phase; timing shards say 'timing'. */
  phase?: string;
  seed?: number;
  measurement?: Record<string, unknown>;
  manifestV2Sha256?: string;
  candidate?: { commit?: string; distSha256?: string };
  pinning?: { cpu: number; siblings: number[]; runnerCpus: number[] } | null;
  machine?: MachineV2;
  ab?: {
    a: { commit: string; distSha256: string };
    b: { commit: string; distSha256: string };
    targets: string[];
  };
}
interface MachineV2 {
  loadavg?: number[];
  cpuTimes?: string | null;
  coreCpuTimes?: string[] | null;
}
type StartRecordV2 = Omit<ShardStart, 'kind'> & StartV2;
const startV2 = (s: Shard) => s.start as StartRecordV2;
const laneOf = manifestLane;

/** What an A/B target must be in each mode of bench/ab.ts. */
export const abTargetKind = (lane: string | undefined) =>
  lane === 'S1' ? 'an S1 case of class additional' : lane === 'W1' ? 'a W1 case' : 'a primary case';

/** The cases the keep rule guards besides the targets, in words. */
const abOthers = (lane: string | undefined) =>
  lane === 'S1'
    ? 'other S1 case of the same size as a target'
    : lane === 'W1'
      ? 'other W1 case'
      : 'other primary case';

/** Identity every v2 job record must state. */
export const IDENTITY_FIELDS = [
  'v8Seed',
  'harnessCommit',
  'commit',
  'distSha256',
  'node',
  'cpuModel',
  'kernel',
  'tasksetMask',
  'padLength',
  'checkoutCopy',
] as const;

const LOOP_SETTINGS = ['minSampleMs', 'warmupMs', 'minWarmupOps'] as const;

/** A timing taken as one parse per sample with no untimed operations (one parse on a collected heap). */
const onePerSample = (r: JobRecord) => r.opsPerSample === 1 && r.rewarmOps === 0;

/** The timing settings a process ran with: operations per sample, untimed operations, samples. */
const timingSettings = (r: JobRecord) =>
  `${String(r.opsPerSample)} per sample, ${String(r.rewarmOps)} untimed, ${String(r.measurement?.samples)} samples`;

/**
 * A valid timing: no failure, the loop settings of the manifest, and as many positive samples as
 * the record states: exactly `samples`, or at least that many when the process took one parse per
 * sample (the runner then sets the count from singleOperationSampledMs).
 */
function validTimeV2(r: JobRecord, v2: ManifestV2): boolean {
  const samples = Array.isArray(r.samplesMs) ? (r.samplesMs as unknown[]) : [];
  const stated = r.measurement?.samples;
  const min = v2.measurement.samples;
  return (
    r.status === undefined &&
    typeof stated === 'number' &&
    samples.length === stated &&
    (onePerSample(r) ? stated >= min : stated === min) &&
    samples.every(positive) &&
    LOOP_SETTINGS.every((field) => r.measurement?.[field] === v2.measurement[field])
  );
}

/**
 * Whether the shards were run with the timing settings fixed once per pair (manifest v2
 * measurement.singleOperationMinMs recorded); then every process of a pair must have run with the
 * same settings, and the report names the rows whose sides were timed in different regimes.
 */
const fixedPairTiming = (shards: readonly Shard[]) =>
  shards.some((s) => !s.empty && typeof startV2(s).measurement?.singleOperationMinMs === 'number');

/**
 * The Node flags the shards recorded for pairs that repeat the operation (manifest v2
 * measurement.repeatedNodeFlags); none when the shards recorded none, whose processes are then
 * not held to any (the manifest hash check tells such a run apart).
 */
function repeatedNodeFlags(shards: readonly Shard[]): string[] {
  for (const s of shards) {
    const flags = s.empty ? undefined : startV2(s).measurement?.repeatedNodeFlags;
    if (Array.isArray(flags)) return flags.filter((f): f is string => typeof f === 'string');
  }
  return [];
}

/**
 * An issue when a valid process ran outside the flags of its regime: a process that repeated the
 * operation without one of them, or a one-parse process with one. Read from what the worker
 * reported (process.execArgv); a record without it counts as having no flag.
 */
function nodeFlagIssues(
  records: readonly JobRecord[],
  v2: ManifestV2,
  flags: readonly string[],
  where: string,
): string[] {
  const ran = (r: JobRecord) => {
    const argv = (r.process as { execArgv?: unknown } | undefined)?.execArgv;
    return Array.isArray(argv) ? (argv as unknown[]) : [];
  };
  const wrong = records
    .filter((r) => validTimeV2(r, v2))
    .filter((r) => flags.some((f) => ran(r).includes(f) === onePerSample(r)))
    .map(roundOf);
  return wrong.length > 0
    ? [
        `${where}: timing rounds ${list(wrong)} did not run with the Node flags of their regime (${flags.join(' ')} for repeated operations only)`,
      ]
    : [];
}

/**
 * Under the publication method no process has a Node flag beyond the runner's own and the round's
 * seeds: an issue per shard whose workers reported any other (process.execArgv), whatever the
 * record (check, timing, memory or empty process).
 */
function pubFlagIssues(shards: readonly Shard[], manifest: Manifest, v2: ManifestV2): string[] {
  if (!v2.pub) return [];
  const set = (a: unknown) =>
    manifest.runtime.flags.includes(String(a)) ||
    v2.seeds.flags.some((f) => String(a).startsWith(`${f}=`));
  return shards.flatMap((s) => {
    const other = s.records.flatMap((r) => {
      const argv = (r.process as { execArgv?: unknown } | undefined)?.execArgv;
      return Array.isArray(argv) ? [(argv as unknown[]).filter((a) => !set(a)).map(String)] : [];
    });
    const flags = [...new Set(other.flat())].sort();
    return flags.length > 0
      ? [
          `${s.file} (${s.start.shardId}): ${String(other.filter((o) => o.length > 0).length)} processes ran with a Node flag the publication method does not set (${flags.join(' ')})`,
        ]
      : [];
  });
}

/** An issue when the valid processes of a pair ran with different timing settings. */
function mixedSettings(records: readonly JobRecord[], v2: ManifestV2, where: string): string[] {
  const settings = new Set(records.filter((r) => validTimeV2(r, v2)).map(timingSettings));
  return settings.size > 1
    ? [`${where}: processes ran with different timing settings (${[...settings].join('; ')})`]
    : [];
}

const roundOf = (r: JobRecord) => (typeof r.round === 'number' ? r.round : -1);
const list = (xs: readonly number[]) => xs.join(',');

interface IndexV2 {
  checks: Map<string, JobRecord[]>;
  times: Map<string, JobRecord[]>;
  memory: Map<string, JobRecord[]>;
  empty: JobRecord[];
}

const isMemoryPhase = (s: Shard) => startV2(s).phase === 'memory';

/**
 * Job records by pair, each counted only in the run that owns it: a timing shard
 * owns the checks and timings of its cases (a run that is not a manifest shard,
 * such as a smoke run, owns whatever it measured), the memory phase owns the
 * memory records. Memory and timing records never count from the other's run.
 */
function indexV2(
  shards: readonly Shard[],
  owned: ((shardId: string) => ReadonlySet<string> | undefined) | null,
  issues: string[],
): IndexV2 {
  const index: IndexV2 = { checks: new Map(), times: new Map(), memory: new Map(), empty: [] };
  const add = (map: Map<string, JobRecord[]>, r: JobRecord) => {
    map.set(key(r.impl, r.case), [...(map.get(key(r.impl, r.case)) ?? []), r]);
  };
  for (const s of shards) {
    const where = `${s.file} (${s.start.shardId})`;
    const cases = owned?.(s.start.shardId);
    for (const r of s.records) {
      if (r.type === 'empty') index.empty.push(r);
      else if (r.type === 'projection' || r.type.startsWith('dry-')) continue;
      else if (r.type !== 'check' && r.type !== 'time' && r.type !== 'memory')
        issues.push(`${where}: unknown record type ${r.type}`);
      else if (owned && (r.type === 'memory') !== isMemoryPhase(s))
        issues.push(
          `${where}: ${r.type} record for ${r.impl} @ ${r.case} in ${isMemoryPhase(s) ? 'the memory phase' : 'a timing run'}`,
        );
      else if (cases && !isMemoryPhase(s) && !cases.has(r.case))
        issues.push(
          `${where}: ${r.type} record for ${r.impl} @ ${r.case} belongs to another shard`,
        );
      else
        add(r.type === 'check' ? index.checks : r.type === 'time' ? index.times : index.memory, r);
    }
  }
  return index;
}

/**
 * The rounds 1..wanted of a pair that lack exactly one valid record; duplicates
 * and records without the full identity are reported as issues.
 */
function missingRounds(
  records: readonly JobRecord[],
  wanted: number,
  valid: (r: JobRecord) => boolean,
  where: string,
  what: string,
  issues: string[],
): number[] {
  const missing: number[] = [];
  for (let round = 1; round <= wanted; round++) {
    const ok = records.filter((r) => roundOf(r) === round && valid(r));
    if (ok.length === 0) missing.push(round);
    if (ok.length > 1)
      issues.push(`${where}: ${what} round ${String(round)} recorded ${String(ok.length)} times`);
    for (const r of ok) {
      const identity = (r.identity ?? {}) as Record<string, unknown>;
      for (const field of IDENTITY_FIELDS) {
        if (identity[field] === undefined || identity[field] === null)
          issues.push(`${where} round ${String(round)}: identity lacks ${field}`);
      }
    }
  }
  return missing;
}

/**
 * The seed rule of a run: every process of a round ran with one V8 seed, and no
 * two rounds share one. Pairing arms by round rests on it.
 */
function seedIssues(s: Shard): string[] {
  const where = `${s.file} (${s.start.shardId})`;
  const byRound = new Map<number, Set<unknown>>();
  for (const r of s.records) {
    if (r.type !== 'time' && r.type !== 'memory' && r.type !== 'empty') continue;
    const seeds = byRound.get(roundOf(r)) ?? new Set<unknown>();
    seeds.add((r.identity as { v8Seed?: unknown } | undefined)?.v8Seed ?? null);
    byRound.set(roundOf(r), seeds);
  }
  const issues: string[] = [];
  const roundOfSeed = new Map<unknown, number>();
  for (const [round, seeds] of [...byRound].sort(([a], [b]) => a - b)) {
    if (seeds.size !== 1 || seeds.has(null)) {
      issues.push(`${where}: round ${String(round)} did not run with one V8 seed`);
      continue;
    }
    const [seed] = seeds;
    const earlier = roundOfSeed.get(seed);
    if (earlier !== undefined)
      issues.push(`${where}: rounds ${String(earlier)} and ${String(round)} share a V8 seed`);
    else roundOfSeed.set(seed, round);
  }
  return issues;
}

/** Shard-level checks shared by campaigns, calibrations and A/B runs. */
function shardIssuesV2(
  manifest: Manifest,
  v2: ManifestV2,
  hashes: HashesV2,
  s: Shard,
  kinds: readonly string[],
): string[] {
  const issues: string[] = [];
  const where = `${s.file} (${s.start.shardId})`;
  const start = startV2(s);
  if (s.truncated) {
    issues.push(
      `${where}: ${s.empty ? 'empty file' : 'last line is cut off'}; an interrupted shard`,
    );
  }
  if (start.method !== 'v2' && !s.empty) issues.push(`${where}: not a method v2 run`);
  if (!kinds.includes(start.kind ?? '')) {
    issues.push(`${where}: ${String(start.kind)} run; diagnostics only`);
  }
  if (start.manifestSha256 !== hashes.manifestSha256)
    issues.push(`${where}: run with a different manifest`);
  if (start.manifestV2Sha256 !== hashes.manifestV2Sha256)
    issues.push(`${where}: run with a different v2 manifest`);
  if (start.runtime.node !== `v${manifest.runtime.node}`) {
    issues.push(
      `${where}: runtime ${start.runtime.node}, manifest requires v${manifest.runtime.node}`,
    );
  }
  if (!same(start.runtime.workerFlags, manifest.runtime.flags))
    issues.push(`${where}: worker flags differ from the manifest`);
  if (start.pinning === undefined || start.pinning === null)
    issues.push(`${where}: was not pinned`);
  if (typeof start.seed !== 'number') issues.push(`${where}: no campaign seed`);
  for (const field of [...LOOP_SETTINGS, 'processStatistic'] as const) {
    if (start.measurement?.[field] !== v2.measurement[field])
      issues.push(`${where}: measurement.${field} differs from the v2 manifest`);
  }
  if (!s.end) issues.push(`${where}: no end record (interrupted)`);
  else {
    if (s.end.status !== 'complete') issues.push(`${where}: ended with ${s.end.status}`);
    if (
      s.end.source.sha256 !== start.source.sha256 ||
      s.end.source.gitCommit !== start.source.gitCommit
    ) {
      issues.push(`${where}: source changed during the shard`);
    }
  }
  return issues;
}

/** Shards by id, then file name: a report never depends on the order of its arguments. */
function inShardOrder(shards: readonly Shard[]): Shard[] {
  return [...shards].sort(
    (a, b) => a.start.shardId.localeCompare(b.start.shardId) || a.file.localeCompare(b.file),
  );
}

export interface PlacementFlag {
  shard: string;
  what: string;
  share: number;
  limit: number;
}

interface ShardLoad {
  loadBefore: number;
  loadAfter: number;
  /** Steal as a share of all CPU time of the machine during the shard. */
  steal: number | null;
  /** Per watched CPU (the worker's and its hyperthread siblings'): busy and steal shares. */
  cores: Array<{ cpu: string; worker: boolean; busy: number | null; steal: number | null }>;
}

/** Load, steal and per-CPU busy shares between a shard's start and end records; null without both. */
function shardLoad(s: Shard): ShardLoad | null {
  const start = startV2(s);
  const a = start.machine;
  const b = (s.end as { machine?: MachineV2 } | null)?.machine;
  if (!a || !b) return null;
  const share = (part: number, all: number) => (all > 0 ? part / all : null);
  const total = cpuTotal(b.cpuTimes) - cpuTotal(a.cpuTimes);
  return {
    loadBefore: a.loadavg?.[0] ?? Number.NaN,
    loadAfter: b.loadavg?.[0] ?? Number.NaN,
    steal: share(cpuField(b.cpuTimes, 8) - cpuField(a.cpuTimes, 8), total),
    cores: (a.coreCpuTimes ?? []).map((line, i) => {
      const after = b.coreCpuTimes?.[i];
      const all = cpuTotal(after) - cpuTotal(line);
      const idle = cpuField(after, 4) + cpuField(after, 5) - cpuField(line, 4) - cpuField(line, 5);
      const cpu = line.split(' ')[0] ?? '';
      return {
        cpu,
        worker: cpu === `cpu${String(start.pinning?.cpu)}`,
        busy: all > 0 ? 1 - idle / all : null,
        steal: share(cpuField(after, 8) - cpuField(line, 8), all),
      };
    }),
  };
}

/**
 * Reported placement check, not a gate: a shard is flagged when a hyperthread
 * sibling of the worker CPU was busier than `placement.reportedChecks.siblingBusyMax`
 * or the worker CPU lost more than `stealMax` of its time to the hypervisor.
 */
function placementFlags(shards: readonly Shard[], v2: ManifestV2): PlacementFlag[] {
  const limits = v2.placement.reportedChecks;
  return shards.flatMap((s) =>
    (shardLoad(s)?.cores ?? []).flatMap((c): PlacementFlag[] => {
      const flag = (what: string, share: number | null, limit: number) =>
        share !== null && share > limit
          ? [{ shard: s.start.shardId, what: `${c.cpu} ${what}`, share, limit }]
          : [];
      return c.worker
        ? flag('(worker) steal', c.steal, limits.stealMax)
        : flag('(sibling) busy', c.busy, limits.siblingBusyMax);
    }),
  );
}

export interface CaseRowV2 {
  case: string;
  lane: string;
  weight: number;
  /** The fastest valid competitor by its median of process medians, chosen once from the point estimates. */
  competitor: string | null;
  candidateMs: number | null;
  competitorMs: number | null;
  /** Competitor time / candidate time: above 1 means the candidate is faster. */
  ratio: RatioInterval | null;
  /** A/A copy time / candidate time. */
  aa: RatioInterval | null;
  /** Reference (Papa) time / candidate time. */
  papa: RatioInterval | null;
  /** Holm over the primary cases at the manifest's family-wise level. */
  significant: boolean;
  classification: 'ahead' | 'behind' | 'inconclusive';
}

export interface MemoryRowV2 {
  case: string;
  candidatePeakBytes: number | null;
  candidateBeforeParseBytes: number | null;
  referencePeakBytes: number | null;
  /** The competitor with the lowest peak on this case. */
  leanest: string | null;
  leanestPeakBytes: number | null;
  vsReference: number | null;
  vsLeanest: number | null;
}

export interface ArmSummaryV2 {
  case: string;
  impl: string;
  status: string;
  reason?: string;
  /** W1: UTF-8 bytes of the written CSV, from the check. */
  outputBytes?: number;
  processes: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface ScoreV2 {
  kind: string;
  seed: number;
  /** True only when no issue was found; nothing below is a result otherwise. */
  complete: boolean;
  issues: string[];
  /** The issues that name a pair without its full data, also contained in `issues`. */
  missingPairs: string[];
  cases: CaseRowV2[];
  counts: { ahead: number; behind: number; inconclusive: number };
  overall: Estimate | null;
  b1: Estimate | null;
  b2: Estimate | null;
  papaOverall: Estimate | null;
  /** The A/A intervals against the calibration limits of the v2 manifest. */
  aaCheck: {
    /** Primary cases whose A/A interval excludes 1.000. */
    misses: string[];
    /** Primary cases without an A/A interval; any of them fails the check. */
    unmeasured: string[];
    maxHalfWidth: number | null;
    medianHalfWidth: number | null;
    pass: boolean;
  };
  /** Shards whose worker core was disturbed beyond the reported limits; a fact, not a gate. */
  placementFlags: PlacementFlag[];
  memory: {
    method: string | null;
    baseline: { rssBytes: number; peakRssBytes: number } | null;
    rows: MemoryRowV2[];
    /** Worst candidate/reference peak ratio against the reported limit; a fact, not a gate. */
    check: TargetCheck;
  };
  /** Reference time / candidate time on the regression (small-input) cases. */
  smallInput: Array<{ case: string; ratio: RatioInterval | null }>;
  smallInputCheck: TargetCheck;
  arms: ArmSummaryV2[];
  /**
   * The timing regime of each pair ("one parse" on a collected heap, or "repeated"), keyed by
   * `impl\0case`; empty unless the shards fixed their timing settings per pair.
   */
  regimes: Map<string, 'one parse' | 'repeated'>;
  /** The S1 manifest only: the candidate's arms against it (batch sizes, and stream against bulk). */
  s1: S1ScoreV2 | null;
  /** The W1 manifest only: the diagnostic arms of manifest-v2 `w1.arms` against the candidate. */
  w1Arms: Array<
    ArmRowV2 & { armPeakBytes: number | null; candidatePeakBytes: number | null }
  > | null;
}

/** One arm of the candidate on one case: arm time / candidate time (above 1: the candidate is faster). */
export interface ArmRowV2 {
  case: string;
  impl: string;
  armMs: number | null;
  candidateMs: number | null;
  ratio: RatioInterval | null;
}

export interface S1ScoreV2 {
  /** Per case and arm of manifest-v2 `s1.arms`. */
  arms: ArmRowV2[];
  /** Per case: the candidate's peak and the bulk arm's, medians of the memory processes. */
  memory: Array<{
    case: string;
    streamPeakBytes: number | null;
    bulkPeakBytes: number | null;
    /** Stream peak / bulk peak: below 1 means the stream peaked lower. */
    ratio: number | null;
  }>;
}

const numbers = (records: readonly JobRecord[], field: string) =>
  records.map((r) => r[field]).filter(positive) as number[];
const medianOrNull = (xs: readonly number[]) => (xs.length > 0 ? median(xs) : null);

export function scoreV2(
  manifest: Manifest,
  v2: ManifestV2,
  hashes: HashesV2,
  given: readonly Shard[],
): ScoreV2 {
  const issues: string[] = [];
  const missingPairs: string[] = [];
  const shards = inShardOrder(given);
  const [firstRead] = shards.filter((s) => !s.empty);
  const first = firstRead ? startV2(firstRead) : undefined;
  const kind = first?.kind === 'calibration' ? 'calibration' : 'campaign';
  const seed = first?.seed ?? 0;
  const { processes, memoryProcesses } = v2.measurement;
  if (shards.length === 0) issues.push('no shard results');

  const distinct = (pick: (s: StartRecordV2) => unknown, message: string) => {
    const read = shards.filter((s) => !s.empty);
    if (new Set(read.map((s) => JSON.stringify(pick(startV2(s)) ?? null))).size > 1)
      issues.push(message);
  };
  distinct((s) => s.campaignId, 'shards come from different campaigns');
  distinct((s) => s.kind, 'shards are of different kinds');
  distinct((s) => s.seed, 'shards have different campaign seeds');
  distinct((s) => s.source, 'shards were run from different source identities');
  distinct((s) => s.candidate, 'shards measured different bundles');
  distinct((s) => s.environment, 'shards were run on different machines');
  distinct((s) => s.pinning, 'shards were pinned differently');
  const seen = new Map<string, number>();
  const scoredIds = scoredCases(manifest).map((c) => c.id);
  const scoredSet = new Set(scoredIds);
  const runLane = laneOf(manifest);
  const laneArms = Object.keys(armsOf(v2, runLane));
  let memoryRuns = 0;
  for (const s of shards) {
    const where = `${s.file} (${s.start.shardId})`;
    const start = startV2(s);
    issues.push(...shardIssuesV2(manifest, v2, hashes, s, ['campaign', 'calibration']));
    if (start.lane !== runLane && !s.empty)
      issues.push(
        `${where}: ${start.lane === 'S1' ? 'an' : 'a'} ${start.lane ?? 'B1/B2/S1'} run in a ${runLane ?? 'B1/B2/S1'} report`,
      );
    if (isMemoryPhase(s)) {
      memoryRuns++;
      if (start.shardId !== v2.measurement.memoryShard)
        issues.push(`${where}: the memory phase is run as ${v2.measurement.memoryShard}`);
      if (!same([...start.plannedCases].sort(), [...scoredIds].sort()))
        issues.push(
          `${where}: the memory phase must plan every ${runLane === 'S1' ? 'S1' : 'primary'} case`,
        );
      if (!same(start.measurement, v2.measurement))
        issues.push(`${where}: process counts differ from the v2 manifest`);
      if (Object.values(start.filters).some((v) => v !== null && v !== false))
        issues.push(`${where}: filtered run ${JSON.stringify(start.filters)}`);
      continue;
    }
    seen.set(start.shardId, (seen.get(start.shardId) ?? 0) + 1);
    if (Object.values(start.filters).some((v) => v !== null && v !== false))
      issues.push(`${where}: filtered run ${JSON.stringify(start.filters)}`);
    if (sortedKeys(start.packages) !== sortedKeys(manifest.competitors))
      issues.push(`${where}: installed package versions differ from the manifest`);
    if (!same(start.measurement, v2.measurement))
      issues.push(`${where}: process counts differ from the v2 manifest`);
    const planned = manifest.campaign.shards.find((x) => x.id === start.shardId);
    const wanted = new Set(expectedPairsV2(manifest, v2, kind, planned?.cases).map((p) => p.case));
    if (!planned) issues.push(`${where}: not a manifest shard`);
    else if (!same([...start.plannedCases].sort(), [...wanted].sort()))
      issues.push(`${where}: planned cases differ from the manifest shard`);
  }
  for (const s of manifest.campaign.shards) {
    const n = seen.get(s.id) ?? 0;
    if (n !== 1) issues.push(`shard ${s.id} present ${String(n)} times`);
  }
  // Memory is its own run after the timing shards; a calibration has none.
  if (kind === 'calibration') {
    if (memoryRuns > 0) issues.push('a calibration has no memory phase, but one is present');
  } else if (shards.length > 0 && memoryRuns !== 1) {
    issues.push(
      `memory phase present ${String(memoryRuns)} times (run --phase memory once, after the timing shards)`,
    );
  }

  const shardCases = new Map(manifest.campaign.shards.map((s) => [s.id, new Set(s.cases)]));
  const index = indexV2(shards, (id) => shardCases.get(id), issues);
  const fixed = fixedPairTiming(shards);
  const nodeFlags = repeatedNodeFlags(shards);
  issues.push(...pubFlagIssues(shards, manifest, v2));
  // Each pair's regime, from its first valid process, when the settings were fixed per pair.
  const regimes = new Map<string, 'one parse' | 'repeated'>();
  if (fixed) {
    for (const [k, times] of index.times) {
      const r = times.find((x) => validTimeV2(x, v2));
      if (r) regimes.set(k, onePerSample(r) ? 'one parse' : 'repeated');
    }
  }
  const caseById = new Map(manifest.cases.map((c) => [c.id, c]));
  const status = new Map<string, string>();
  const missing = (message: string) => {
    missingPairs.push(message);
    issues.push(message);
  };
  for (const p of expectedPairsV2(manifest, v2, kind)) {
    const where = `${p.impl} @ ${p.case}`;
    const k = key(p.impl, p.case);
    const checks = index.checks.get(k) ?? [];
    if (checks.length !== 1) {
      missing(
        `${where}: ${checks.length === 0 ? 'no correctness record' : 'duplicate correctness records'}`,
      );
      continue;
    }
    const s = checks[0]?.status ?? 'UNKNOWN';
    status.set(k, s);
    if (p.expect !== 'measure') {
      const wanted = p.expect === 'unsupported' ? 'UNSUPPORTED' : 'DEFERRED';
      if (s !== wanted) issues.push(`${where}: declared ${wanted} but reported ${s}`);
      continue;
    }
    if (s === 'UNSUPPORTED' || s === 'DEFERRED') {
      issues.push(`${where}: ${s} at run time but not declared in the manifest`);
      continue;
    }
    const c = caseById.get(p.case);
    if (s !== 'PASS') {
      // A competitor may fail correctness (it is then not compared); both candidate
      // arms must pass, and so must the reference where a comparison uses it.
      const mustPass =
        p.impl === manifest.candidate ||
        p.impl === v2.aa.impl ||
        laneArms.includes(p.impl) ||
        (p.impl === manifest.reference && c?.class !== 'additional');
      if (s !== 'FAIL' && s !== 'NO-ORACLE') missing(`${where}: ${s} (missing measurement)`);
      else if (mustPass) issues.push(`${where}: ${s}`);
      continue;
    }
    const times = index.times.get(k) ?? [];
    const lost = missingRounds(
      times,
      processes,
      (r) => validTimeV2(r, v2),
      where,
      'timing',
      issues,
    );
    if (lost.length > 0) missing(`${where}: timing rounds ${list(lost)} missing`);
    if (fixed) issues.push(...mixedSettings(times, v2, where));
    issues.push(...nodeFlagIssues(times, v2, nodeFlags, where));
    if (scoredSet.has(p.case) && kind === 'campaign') {
      const mem = index.memory.get(k) ?? [];
      const gone = missingRounds(mem, memoryProcesses, validMemory, where, 'memory', issues);
      if (gone.length > 0) missing(`${where}: memory rounds ${list(gone)} missing`);
    }
  }
  if (shards.length > 0 && numbers(index.empty, 'rssBytes').length === 0)
    issues.push('no empty-process baseline');
  // A blocked memory process (a competitor whose check failed) holds no reading and no method.
  const methods = new Set(
    [...index.memory.values()]
      .flat()
      .flatMap((r) => (typeof r.peakRssMethod === 'string' ? [r.peakRssMethod] : [])),
  );
  if (methods.size > 1) issues.push('memory records use different peak-RSS methods');
  issues.push(...shards.flatMap(seedIssues));

  // Statistics from whatever valid data exist; they are a result only when there is no issue.
  const byRound = (impl: string, caseId: string) =>
    new Map(
      status.get(key(impl, caseId)) === 'PASS'
        ? (index.times.get(key(impl, caseId)) ?? [])
            .filter((r) => validTimeV2(r, v2))
            .map((r) => [roundOf(r), median(r.samplesMs as number[])] as const)
        : [],
    );
  const mediansOf = (impl: string, caseId: string) => [...byRound(impl, caseId).values()];
  const { bootstrapResamples, confidence, familyWiseAlpha } = v2.statistics;
  // Arms are paired by round. Every comparison of a shard is bootstrapped from the
  // same seed, so replicate k resamples the same rounds for every case and arm of
  // that shard: the rounds of a shard share their V8 seeds across its cases, and the
  // overall geometric mean (replicate k of every case together) keeps that; rounds
  // of different shards have nothing in common and are resampled independently.
  const shardOf = (caseId: string) =>
    manifest.campaign.shards.find((x) => x.cases.includes(caseId))?.id ?? '';
  const compare = (caseId: string, impl: string | null, label: string) => {
    if (impl === null) return null;
    const pair = pairByRound(byRound(impl, caseId), byRound(manifest.candidate, caseId));
    if (pair.unpaired.length > 0 && pair.top.length > 0) {
      issues.push(
        `${impl} / ${manifest.candidate} @ ${caseId} (${label}): rounds ${list(pair.unpaired)} lack one arm and are excluded from pairing`,
      );
    }
    return pair.top.length > 0
      ? pairedBootstrapRatio(
          pair.top,
          pair.bottom,
          seedFor(seed, `bootstrap:${shardOf(caseId)}`),
          bootstrapResamples,
          confidence,
        )
      : null;
  };
  const competitorIds = manifest.implementations.map((i) => i.id);
  const primary = scoredCases(manifest);
  const rows = primary.map((c) => {
    const timed = competitorIds
      .map((impl) => ({ impl, ms: medianOrNull(mediansOf(impl, c.id)) }))
      .filter((x): x is { impl: string; ms: number } => x.ms !== null)
      .sort((a, b) => a.ms - b.ms || a.impl.localeCompare(b.impl));
    const fastest = kind === 'campaign' ? (timed[0] ?? null) : null;
    return {
      case: c.id,
      lane: c.lane,
      weight: c.weight,
      competitor: fastest?.impl ?? null,
      candidateMs: medianOrNull(mediansOf(manifest.candidate, c.id)),
      competitorMs: fastest?.ms ?? null,
      ratio: compare(c.id, fastest?.impl ?? null, 'competitor'),
      aa: compare(c.id, v2.aa.impl, 'aa'),
      papa: kind === 'campaign' ? compare(c.id, manifest.reference, 'reference') : null,
    };
  });
  const significant = holm(
    rows.map((r) => r.ratio?.p ?? 1),
    familyWiseAlpha,
  );
  const cases: CaseRowV2[] = rows.map((r, i) => {
    const sig = significant[i] === true;
    const { ratio, aa } = r;
    const ahead = sig && ratio !== null && aa !== null && ratio.ratio > 1 && ratio.lo > aa.hi;
    const behind = sig && ratio !== null && aa !== null && ratio.ratio < 1 && ratio.hi < aa.lo;
    return {
      ...r,
      significant: sig,
      classification: ahead ? 'ahead' : behind ? 'behind' : 'inconclusive',
    };
  });
  const count = (c: CaseRowV2['classification']) =>
    cases.filter((r) => r.classification === c).length;
  const mean = (subset: readonly CaseRowV2[], pick: (r: CaseRowV2) => RatioInterval | null) =>
    geometricMean(
      subset.map((r) => ({ weight: r.weight, interval: pick(r) })),
      confidence,
    );
  const lane = (l: string) => cases.filter((r) => r.lane === l);

  const halfWidths = cases.flatMap((r) => (r.aa ? [(r.aa.hi - r.aa.lo) / 2] : []));
  const misses = cases.filter((r) => r.aa && (r.aa.lo > 1 || r.aa.hi < 1)).map((r) => r.case);
  const unmeasured = cases.filter((r) => !r.aa).map((r) => r.case);
  const maxHalfWidth = halfWidths.length > 0 ? Math.max(...halfWidths) : null;
  const medianHalfWidth = medianOrNull(halfWidths);

  const peakOf = (impl: string, caseId: string, field = 'peakRssBytes') =>
    status.get(key(impl, caseId)) === 'PASS'
      ? medianOrNull(
          numbers((index.memory.get(key(impl, caseId)) ?? []).filter(validMemory), field),
        )
      : null;
  const over = (a: number | null, b: number | null) => (a !== null && b !== null ? a / b : null);
  const memoryRows: MemoryRowV2[] = primary.map((c) => {
    const candidate = peakOf(manifest.candidate, c.id);
    const reference = peakOf(manifest.reference, c.id);
    const leanest = competitorIds
      .map((impl) => ({ impl, peak: peakOf(impl, c.id) }))
      .filter((x): x is { impl: string; peak: number } => x.peak !== null)
      .sort((a, b) => a.peak - b.peak || a.impl.localeCompare(b.impl))[0];
    return {
      case: c.id,
      candidatePeakBytes: candidate,
      candidateBeforeParseBytes: peakOf(manifest.candidate, c.id, 'rssBeforeParseBytes'),
      referencePeakBytes: reference,
      leanest: leanest?.impl ?? null,
      leanestPeakBytes: leanest?.peak ?? null,
      vsReference: over(candidate, reference),
      vsLeanest: over(candidate, leanest?.peak ?? null),
    };
  });
  const worst = (values: ReadonlyArray<number | null>) =>
    values.length > 0 && values.every((v) => v !== null) ? Math.max(...(values as number[])) : null;
  const check = (value: number | null, max: number): TargetCheck => ({
    value,
    limit: 1 + max,
    met: value === null ? null : value <= 1 + max,
  });
  const emptyRss = numbers(index.empty, 'rssBytes');
  const emptyPeak = numbers(index.empty, 'workerMaxRssBytes');
  const smallInput =
    kind === 'campaign'
      ? manifest.cases
          .filter((c) => c.class === 'regression')
          .map((c) => ({ case: c.id, ratio: compare(c.id, manifest.reference, 'reference') }))
      : [];
  const limits = manifest.scoring.reportedChecks;

  // The candidate's arms of the lane, paired with it by round; never a competitor.
  const armRows: ArmRowV2[] = primary.flatMap((c) =>
    laneArms.map((impl) => ({
      case: c.id,
      impl,
      armMs: medianOrNull(mediansOf(impl, c.id)),
      candidateMs: medianOrNull(mediansOf(manifest.candidate, c.id)),
      ratio: kind === 'campaign' ? compare(c.id, impl, impl) : null,
    })),
  );

  const arms: ArmSummaryV2[] = [];
  for (const [k, checks] of index.checks) {
    const [check0] = checks;
    if (checks.length !== 1 || !check0) continue;
    const ms = mediansOf(check0.impl, check0.case);
    // A W1 pair that fails is listed with its first differing cell (or the error).
    const failure =
      runLane === 'W1' && check0.status === 'FAIL'
        ? JSON.stringify(check0.mismatch ?? check0.error ?? null)
        : undefined;
    arms.push({
      case: check0.case,
      impl: check0.impl,
      status: status.get(k) ?? check0.status ?? 'UNKNOWN',
      ...(typeof check0.reason === 'string' ? { reason: check0.reason } : {}),
      ...(failure === undefined ? {} : { reason: failure }),
      ...(typeof check0.outputBytes === 'number' ? { outputBytes: check0.outputBytes } : {}),
      processes: ms.length,
      medianMs: median(ms),
      minMs: ms.length ? Math.min(...ms) : Number.NaN,
      maxMs: ms.length ? Math.max(...ms) : Number.NaN,
    });
  }

  return {
    kind,
    seed,
    complete: issues.length === 0,
    issues,
    missingPairs,
    cases,
    counts: { ahead: count('ahead'), behind: count('behind'), inconclusive: count('inconclusive') },
    overall: mean(cases, (r) => r.ratio),
    b1: mean(lane('B1'), (r) => r.ratio),
    b2: mean(lane('B2'), (r) => r.ratio),
    papaOverall: mean(cases, (r) => r.papa),
    placementFlags: placementFlags(shards, v2),
    aaCheck: {
      misses,
      unmeasured,
      maxHalfWidth,
      medianHalfWidth,
      pass:
        unmeasured.length === 0 &&
        misses.length <= v2.calibration.maxIntervalsExcludingOne &&
        maxHalfWidth !== null &&
        medianHalfWidth !== null &&
        maxHalfWidth <= v2.calibration.maxHalfWidth &&
        medianHalfWidth <= v2.calibration.maxMedianHalfWidth,
    },
    memory: {
      method: methods.size === 1 ? String([...methods][0]) : null,
      baseline:
        emptyRss.length > 0 && emptyPeak.length > 0
          ? { rssBytes: median(emptyRss), peakRssBytes: median(emptyPeak) }
          : null,
      rows: memoryRows,
      check: check(worst(memoryRows.map((r) => r.vsReference)), limits.peakMemoryVsReferenceMax),
    },
    smallInput,
    smallInputCheck: check(
      worst(smallInput.map((r) => (r.ratio ? 1 / r.ratio.ratio : null))),
      limits.smallInputVsReferenceMax,
    ),
    arms,
    regimes,
    s1:
      runLane === 'S1'
        ? {
            arms: armRows,
            memory: primary.map((c) => {
              const stream = peakOf(manifest.candidate, c.id);
              const bulk = peakOf(BULK_IMPL, c.id);
              return {
                case: c.id,
                streamPeakBytes: stream,
                bulkPeakBytes: bulk,
                ratio: over(stream, bulk),
              };
            }),
          }
        : null,
    w1Arms:
      runLane === 'W1'
        ? armRows.map((r) => ({
            ...r,
            armPeakBytes: peakOf(r.impl, r.case),
            candidatePeakBytes: peakOf(manifest.candidate, r.case),
          }))
        : null,
  };
}

const interval = (x: Estimate | null) =>
  x === null ? 'n/a' : `${x.ratio.toFixed(3)} [${x.lo.toFixed(3)}, ${x.hi.toFixed(3)}]`;
const percent = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const mib = (bytes: number | null) => (bytes === null ? '-' : (bytes / 1048576).toFixed(1));
const fact = (t: TargetCheck) =>
  `${num(t.value)} (limit ${t.limit.toFixed(2)}: ${t.met === null ? 'not evaluated' : t.met ? 'within' : 'above'})`;

/** Field `n` (1-based, after the label) of a /proc/stat cpu line. */
const cpuField = (line: string | null | undefined, n: number) =>
  Number(line?.trim().split(/\s+/)[n] ?? Number.NaN);
const cpuTotal = (line: string | null | undefined) =>
  (line?.trim().split(/\s+/).slice(1) ?? []).reduce((sum, x) => sum + Number(x), 0);

/** Identity and machine lines shared by the campaign and the A/B report. */
function identityLines(given: readonly Shard[], v2: ManifestV2): string[] {
  const shards = inShardOrder(given).filter((s) => !s.empty);
  const [first] = shards;
  if (!first) return [];
  const start = startV2(first);
  const env = start.environment ?? {};
  const pin = start.pinning;
  const m = start.measurement ?? {};
  // Recorded only by a manifest that sets the one-parse regime.
  // The regime clause states only what the shards recorded, so older campaigns read as run.
  const single =
    typeof m.singleOperationMinMs === 'number'
      ? `, both counts fixed once per pair from its check; a pair whose check took at least ${String(m.singleOperationMinMs)} ms takes one operation per sample and no untimed operations instead (one parse on a collected heap), with as many samples as fill about ${String(m.singleOperationSampledMs)} ms, at least ${String(m.samples)}`
      : typeof m.singleOperationTargetBytes === 'number'
        ? `; on the cases of at least ${String(m.singleOperationTargetBytes / 2 ** 20)} MiB and the external cases, one operation per sample and no untimed operations (one parse on a collected heap)${typeof m.singleOperationSampledMs === 'number' ? `, as many samples as fill about ${String(m.singleOperationSampledMs)} ms and at least ${String(m.samples)}` : ''}`
        : '';
  // Recorded only by a manifest that has `measurement.repeatedNodeFlags`.
  const recorded = Array.isArray(m.repeatedNodeFlags) ? (m.repeatedNodeFlags as unknown[]) : [];
  const nodeFlags =
    recorded.length > 0
      ? `; the timing processes of a pair that repeats the operation run with ${recorded.map(String).join(' ')}, those of a one-parse pair without`
      : '';
  // The publication method: what it replaces in method v2, from its manifest (matched by hash).
  const versions = Object.entries(v2.pub?.competitors ?? {}).map(([pkg, v]) => `${pkg} ${v}`);
  const pub = v2.pub
    ? [
        `- Publication method (bench/manifest-pub.json over manifest-v2.json): Node ${v2.pub.runtime.node}; ${versions.join(', ')}; every process starts with ${start.runtime.workerFlags.join(' ')} and the round's ${v2.seeds.flags.join(' and ')}, and with no other Node flag.`,
      ]
    : [];
  const lines = [
    ...pub,
    `- Harness commit ${start.source.gitCommit}; Node ${start.runtime.node}; CPU ${String(env.cpu)}; kernel ${String(env.osRelease)}.`,
    `- Placement: ${pin ? `workers pinned with taskset to CPU ${String(pin.cpu)} (threads of its core: ${list(pin.siblings)}); runner on CPU(s) ${list(pin.runnerCpus)}` : 'not pinned'}.`,
    `- Campaign seed ${String(start.seed)} (round order, the V8 seed of each round, per-process checkout copy and pad length, bootstrap).`,
    `- Per implementation and case: ${String(m.processes)} fresh processes, ${String(m.samples)} samples of at least ${String(m.minSampleMs)} ms after at least ${String(m.warmupMs)} ms and ${String(m.minWarmupOps)} operations of warm-up, each sample after a forced collection and about ${String(m.rewarmMs)} ms of untimed operations${single}${nodeFlags}; statistic per process: median.`,
    `- Intervals: ${String(v2.statistics.confidence * 100)}% percentile bootstrap, ${String(v2.statistics.bootstrapResamples)} resamples of rounds; the arms of a round ran with the same V8 seed and are resampled together.`,
  ];
  for (const s of shards) {
    const load = shardLoad(s);
    if (!load) continue;
    const cores = load.cores.map(
      (c) => `${c.cpu} busy ${percent(c.busy)}${c.worker ? `, steal ${percent(c.steal)}` : ''}`,
    );
    lines.push(
      `- ${s.start.shardId}: load ${load.loadBefore.toFixed(2)} before, ${load.loadAfter.toFixed(2)} after; steal ${percent(load.steal)} of CPU time${cores.length ? `; ${cores.join(', ')}` : ''}.`,
    );
  }
  const limits = v2.placement.reportedChecks;
  const flags = placementFlags(shards, v2).map((f) => `${f.shard} ${f.what} ${percent(f.share)}`);
  lines.push(
    `- Placement check (reported, not a gate; sibling busy at most ${percent(limits.siblingBusyMax)}, worker steal at most ${percent(limits.stealMax)}): ${flags.length ? `FLAGGED ${flags.join('; ')}` : 'no flag'}.`,
  );
  return lines;
}

export function renderV2(
  manifest: Manifest,
  v2: ManifestV2,
  hashes: HashesV2,
  shards: readonly Shard[],
): { text: string; complete: boolean; exitCode: number } {
  const s = scoreV2(manifest, v2, hashes, shards);
  const [firstRead] = inShardOrder(shards).filter((x) => !x.empty);
  const start = firstRead ? startV2(firstRead) : undefined;
  const lane = laneOf(manifest);
  const w1 = lane === 'W1';
  const s1 = lane === 'S1';
  const scope = w1 ? 'W1 cases' : s1 ? 'S1 cases' : 'primary cases';
  const lines = [
    `# Benchmark report (method v2${lane === undefined ? '' : `, ${lane}`}): ${s.kind} ${start?.campaignId ?? ''}`,
    '',
  ];
  if (s.complete) lines.push(`COMPLETE ${s.kind}.`);
  else {
    const other = s.issues.filter((i) => !s.missingPairs.includes(i));
    lines.push(
      `INCOMPLETE: diagnostics only, not a result (${String(s.issues.length)} issues).`,
      ...other.slice(0, 40).map((i) => `- ${i}`),
      ...(other.length > 40 ? [`- ... ${String(other.length - 40)} more`] : []),
      '',
      `Missing pairs (${String(s.missingPairs.length)}):`,
      ...s.missingPairs.map((i) => `- ${i}`),
    );
  }
  const label = s.complete ? '' : 'Diagnostic, not a result: ';
  lines.push(
    '',
    `- Candidate ${manifest.candidate}: commit ${String(start?.candidate?.commit)}, bundle SHA-256 ${String(start?.candidate?.distSha256)}; A/A arm ${v2.aa.impl} is the same bundle in another directory.`,
    ...identityLines(shards, v2),
    '',
  );
  const n = s.cases.length;
  if (s.kind === 'campaign') {
    const c = s.counts;
    lines.push(
      w1 ? '## W1 (unparse throughput)' : s1 ? '## S1 (byte chunks to records)' : '## Result',
      '',
      ...(s1
        ? [
            `Each implementation reads the case's fixture as UTF-8 byte chunks of ${String(manifest.measurement.s1ChunkBytes)} bytes from an in-memory async iterable and hands each header-keyed record to a consumer that keeps nothing. ${manifest.candidate} is the bundle's \`parseStream\` with batchSize 1024; beside it, the same bundle as ${Object.entries(
              v2.s1.arms,
            )
              .map(
                ([arm, o]) =>
                  `${arm} (${arm === BULK_IMPL ? 'the chunks collected, one TextDecoder.decode, bulk parse' : JSON.stringify(o)})`,
              )
              .join(
                ', ',
              )}. The fastest valid competitor is chosen among the competitors only, never among these arms. S1 has no overall mean and is never combined with B1/B2 or W1.`,
            '',
          ]
        : []),
      ...(w1
        ? [
            `Each implementation writes the case's rows (header row first) or records (header as column order) to one CSV string in the fixture's dialect. The input is made outside the timed region by parsing the fixture once with ${manifest.reference}; a streaming writer is drained into one string inside the timed call. Before timing, every output is read back by ${manifest.reference} and must equal the fixture cell for cell: a pair that does not is FAIL, never timed, and listed with its first differing cell below. W1 has no threshold: it is reported only, and never combined with B1/B2 or S1. ${manifest.candidate} calls \`unparse\` with \`escapeFormulae: false\`, so it does the same work as the other writers whatever the main entry's default is; the diagnostic arms below are the same bundle with other adapter options, never a competitor and never in the counts.`,
            '',
          ]
        : []),
      `Ratios are competitor time / candidate time: above 1 means ${manifest.candidate} is faster.`,
      '',
      s.complete
        ? `Ahead ${String(c.ahead)}, behind ${String(c.behind)}, inconclusive ${String(c.inconclusive)} of ${String(n)} ${scope}.`
        : `${label}ahead ${String(c.ahead)}, behind ${String(c.behind)}, inconclusive ${String(c.inconclusive)} of ${String(n)} ${scope}.`,
      ...(lane !== undefined
        ? []
        : [
            `${label}Overall against the fastest valid competitor (geometric mean, 95% interval): ${interval(s.overall)}; B1 ${interval(s.b1)}; B2 ${interval(s.b2)}.`,
            `${label}Overall against ${manifest.reference}: ${interval(s.papaOverall)}.`,
          ]),
      '',
      `A case is ahead (behind) when its ratio differs from 1 after Holm correction over the ${String(n)} ${scope} at ${String(v2.statistics.familyWiseAlpha * 100)}% and its whole interval lies above (below) the A/A interval of the same case; otherwise it is inconclusive. The fastest competitor is chosen once, from the medians.`,
      '',
      `## ${w1 ? 'W1 cases' : s1 ? 'S1 cases' : 'Primary cases'} (behind first, then inconclusive, then ahead)`,
      '',
      `| case | fastest valid competitor | ratio [95%] | p | Holm | A/A [95%] | class | ${manifest.reference} ratio [95%] | candidate ms | competitor ms |`,
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    const rank = { behind: 0, inconclusive: 1, ahead: 2 };
    const ordered = [...s.cases].sort(
      (a, b) =>
        rank[a.classification] - rank[b.classification] ||
        (a.ratio?.ratio ?? 0) - (b.ratio?.ratio ?? 0) ||
        a.case.localeCompare(b.case),
    );
    for (const r of ordered) {
      lines.push(
        `| ${r.case} | ${r.competitor ?? '-'} | ${interval(r.ratio)} | ${r.ratio ? r.ratio.p.toFixed(4) : 'n/a'} | ${r.significant ? 'yes' : 'no'} | ${interval(r.aa)} | ${r.classification} | ${interval(r.papa)} | ${fmt(r.candidateMs ?? Number.NaN)} | ${fmt(r.competitorMs ?? Number.NaN)} |`,
      );
    }
    lines.push('');
    if (s.regimes.size > 0) {
      // A ratio whose two sides were timed in different regimes is named, not hidden.
      const mixed = ordered.flatMap((r) => {
        const own = s.regimes.get(key(manifest.candidate, r.case));
        const sides = [...new Set([r.competitor, manifest.reference])]
          .filter((impl): impl is string => impl !== null)
          .map((impl) => ({ impl, regime: s.regimes.get(key(impl, r.case)) }))
          .filter((x) => own !== undefined && x.regime !== undefined && x.regime !== own);
        return sides.length === 0
          ? []
          : [
              `${r.case} (${manifest.candidate} ${String(own)}; ${sides.map((x) => `${x.impl} ${String(x.regime)}`).join(', ')})`,
            ];
      });
      lines.push(
        `Timing regimes: a pair whose check took at least ${String(start?.measurement?.singleOperationMinMs)} ms is timed as one parse per sample on a collected heap, a shorter one by repeated parsing. Rows where ${manifest.candidate} and a compared side were timed differently: ${mixed.length > 0 ? mixed.join('; ') : 'none'}.`,
        '',
      );
    }
    if (s.s1) lines.push(...renderS1Arms(s.s1, manifest.candidate, label));
    if (s.w1Arms) lines.push(...renderW1Arms(s.w1Arms, manifest.candidate, v2.w1.arms, label));
  }
  const k = s.aaCheck;
  lines.push(
    `## A/A noise (${v2.aa.impl} time / ${manifest.candidate} time)`,
    '',
    '| case | A/A [95%] | half-width | contains 1 |',
    '|---|---|---|---|',
    ...s.cases.map(
      (r) =>
        `| ${r.case} | ${interval(r.aa)} | ${percent(r.aa ? (r.aa.hi - r.aa.lo) / 2 : null)} | ${r.aa ? (r.aa.lo <= 1 && r.aa.hi >= 1 ? 'yes' : 'no') : 'n/a'} |`,
    ),
    '',
    `${label}Noise check: ${String(k.misses.length)} of ${String(n)} intervals exclude 1.000 (at most ${String(v2.calibration.maxIntervalsExcludingOne)}${k.misses.length ? `: ${k.misses.join(', ')}` : ''})${k.unmeasured.length ? `; ${String(k.unmeasured.length)} without an interval` : ''}; largest half-width ${percent(k.maxHalfWidth)} (limit ${percent(v2.calibration.maxHalfWidth)}); median half-width ${percent(k.medianHalfWidth)} (limit ${percent(v2.calibration.maxMedianHalfWidth)}): ${k.pass ? 'PASS' : 'FAIL'}.`,
    '',
  );
  if (s.kind === 'campaign') {
    const base = s.memory.baseline;
    lines.push(
      w1
        ? '## Memory (single write, input and output held; median of the memory processes)'
        : s1
          ? '## Memory (single run, no record retained; median of the memory processes)'
          : '## Memory (single parse, output retained; median of the memory processes)',
      '',
      `Peak counter: ${s.memory.method ?? 'n/a'}. Empty process (harness loaded, no parser, no input): RSS ${mib(base?.rssBytes ?? null)} MiB, peak ${mib(base?.peakRssBytes ?? null)} MiB.`,
      ...(w1
        ? [
            `The input was parsed in the same process before the write; its own peak is \`loadedInputPeakRssBytes\` in the records, so a peak equal to it means the write did not raise the peak.`,
          ]
        : []),
      // The Papa-relative limit is a B1/B2 reported check; W1 and S1 have none.
      ...(lane !== undefined
        ? []
        : [
            `${label}Reported check against ${manifest.reference} (a fact, not a gate): worst peak ratio ${fact(s.memory.check)}.`,
          ]),
      '',
      `| case | candidate peak MiB | candidate RSS before ${w1 ? 'write' : 'parse'} MiB | ${manifest.reference} peak MiB | candidate / ${manifest.reference} | lowest-peak competitor | its peak MiB | candidate / lowest |`,
      '|---|---|---|---|---|---|---|---|',
      ...s.memory.rows.map(
        (r) =>
          `| ${r.case} | ${mib(r.candidatePeakBytes)} | ${mib(r.candidateBeforeParseBytes)} | ${mib(r.referencePeakBytes)} | ${num(r.vsReference)} | ${r.leanest ?? '-'} | ${mib(r.leanestPeakBytes)} | ${num(r.vsLeanest)} |`,
      ),
      '',
    );
  }
  if (s.kind === 'campaign' && lane === undefined) {
    lines.push(
      `## Small inputs (${manifest.reference} time / candidate time)`,
      '',
      `${label}Reported check (a fact, not a gate): worst candidate / ${manifest.reference} time ratio ${fact(s.smallInputCheck)}.`,
      '',
      '| case | ratio [95%] |',
      '|---|---|',
      ...s.smallInput.map((r) => `| ${r.case} | ${interval(r.ratio)} |`),
      '',
    );
  }
  lines.push(
    '## Every implementation per case (median, minimum and maximum of the process medians)',
    '',
  );
  for (const c of manifest.cases) {
    const rows = s.arms
      .filter((a) => a.case === c.id)
      .sort(
        (a, b) =>
          (a.medianMs || Infinity) - (b.medianMs || Infinity) || a.impl.localeCompare(b.impl),
      );
    if (rows.length === 0) continue;
    lines.push(
      `### ${c.id} (${c.class})`,
      '',
      `| impl | status |${w1 ? ' output bytes |' : ''} median ms | min | max | processes |`,
      `|---|---|${w1 ? '---|' : ''}---|---|---|---|`,
      ...rows.map(
        (a) =>
          `| ${a.impl} | ${a.reason ? `${a.status} (${a.reason})` : a.status} |${w1 ? ` ${a.outputBytes === undefined ? '-' : String(a.outputBytes)} |` : ''} ${fmt(a.medianMs)} | ${fmt(a.minMs)} | ${fmt(a.maxMs)} | ${String(a.processes)} |`,
      ),
      '',
    );
  }
  return { text: lines.join('\n'), complete: s.complete, exitCode: exitCodeV2(s) };
}

/**
 * The S1 arms' tables: batch size, and stream against bulk, each with its losing cases
 * first: for batch size the case where another batch size gains most over 1024, for
 * stream against bulk the case where the stream gains least over bulk.
 */
function renderS1Arms(s1: S1ScoreV2, candidate: string, label: string): string[] {
  const cases = [...new Set(s1.arms.map((a) => a.case))];
  const of = (c: string, impl: string) => s1.arms.find((a) => a.case === c && a.impl === impl);
  const batch = [...new Set(s1.arms.map((a) => a.impl))].filter((impl) => impl !== BULK_IMPL);
  const low = (c: string) =>
    Math.min(...batch.map((impl) => of(c, impl)?.ratio?.ratio ?? Number.POSITIVE_INFINITY));
  const bulk = (c: string) => of(c, BULK_IMPL)?.ratio?.ratio ?? Number.POSITIVE_INFINITY;
  const by = (key: (c: string) => number) => (a: string, b: string) =>
    key(a) - key(b) || a.localeCompare(b);
  const memory = new Map(s1.memory.map((m) => [m.case, m]));
  return [
    `## Batch size (arm time / ${candidate} time, batchSize 1024; above 1: 1024 is faster)`,
    '',
    `${label}Paired by round, 95% interval as above; the case where another batch size gains most comes first.`,
    '',
    `| case | ${batch.map((impl) => `${impl} [95%]`).join(' | ')} | ${candidate} ms |`,
    `|---|${batch.map(() => '---|').join('')}---|`,
    ...[...cases]
      .sort(by(low))
      .map(
        (c) =>
          `| ${c} | ${batch.map((impl) => interval(of(c, impl)?.ratio ?? null)).join(' | ')} | ${fmt(of(c, BULK_IMPL)?.candidateMs ?? Number.NaN)} |`,
      ),
    '',
    `## Stream against bulk (${BULK_IMPL} time / ${candidate} time: above 1 means the stream is faster)`,
    '',
    `${label}Peaks are the medians of the memory processes (no record retained by either); stream / bulk below 1 means the stream peaked lower. The case where the stream gains least comes first.`,
    '',
    `| case | ${BULK_IMPL} / ${candidate} [95%] | ${candidate} ms | ${BULK_IMPL} ms | ${candidate} peak MiB | ${BULK_IMPL} peak MiB | stream / bulk peak |`,
    '|---|---|---|---|---|---|---|',
    ...[...cases].sort(by(bulk)).map((c) => {
      const a = of(c, BULK_IMPL);
      const m = memory.get(c);
      return `| ${c} | ${interval(a?.ratio ?? null)} | ${fmt(a?.candidateMs ?? Number.NaN)} | ${fmt(a?.armMs ?? Number.NaN)} | ${mib(m?.streamPeakBytes ?? null)} | ${mib(m?.bulkPeakBytes ?? null)} | ${num(m?.ratio ?? null)} |`;
    }),
    '',
  ];
}

/**
 * The W1 diagnostic arms: each arm against the candidate
 * per W1 case, the case where the arm costs most first. Never in W1's score.
 */
function renderW1Arms(
  rows: NonNullable<ScoreV2['w1Arms']>,
  candidate: string,
  arms: ManifestV2['w1']['arms'],
  label: string,
): string[] {
  return Object.entries(arms).flatMap(([impl, options]) => [
    `## Diagnostic arm ${impl} (arm time / ${candidate} time: above 1 means the arm is slower)`,
    '',
    `${label}Never in the W1 score, never the fastest competitor, never in an A/B. ${impl} is the same bundle with the adapter options ${JSON.stringify(options)} (\`omitEscapeFormulae\`: \`unparse\` is called without \`escapeFormulae\`, so the main entry's default applies); ${candidate}, its A/A arm and the A/B arms pass \`escapeFormulae: false\`. Paired by round, 95% interval as above; peaks are the medians of the memory processes; the case where the arm costs most comes first.`,
    '',
    `| case | ${impl} / ${candidate} [95%] | ${candidate} ms | ${impl} ms | ${candidate} peak MiB | ${impl} peak MiB |`,
    '|---|---|---|---|---|---|',
    ...rows
      .filter((r) => r.impl === impl)
      .sort(
        (a, b) =>
          (b.ratio?.ratio ?? Number.NEGATIVE_INFINITY) -
            (a.ratio?.ratio ?? Number.NEGATIVE_INFINITY) || a.case.localeCompare(b.case),
      )
      .map(
        (r) =>
          `| ${r.case} | ${interval(r.ratio)} | ${fmt(r.candidateMs ?? Number.NaN)} | ${fmt(r.armMs ?? Number.NaN)} | ${mib(r.candidatePeakBytes)} | ${mib(r.armPeakBytes)} |`,
      ),
    '',
  ]);
}

/** Exit code of a v2 report: 0 complete, 1 incomplete, 3 a complete calibration that fails its noise check. */
export const CALIBRATION_FAILED = 3;
export function exitCodeV2(s: Pick<ScoreV2, 'complete' | 'kind' | 'aaCheck'>): number {
  if (!s.complete) return 1;
  return s.kind === 'calibration' && !s.aaCheck.pass ? CALIBRATION_FAILED : 0;
}

export interface AbScore {
  issues: string[];
  rows: Array<{
    case: string;
    target: boolean;
    aMs: number | null;
    bMs: number | null;
    /**
     * In the keep rule: a primary case; with --lane W1 a W1 case; with --lane S1 an S1
     * case of class additional of the same size as a target.
     */
    inRule: boolean;
    /** B time / A time: below 1 means B is faster. */
    ratio: RatioInterval | null;
  }>;
  /** Null when the run cannot decide (incomplete, no targets, missing primary cases). */
  decision: 'keep' | 'reject' | null;
  /** Why the rule rejects; empty for keep. */
  reasons: string[];
}

/**
 * A/B of two commits (arms `a` and `b`) and the keep rule: keep
 * if every target case's B/A upper bound is below `ab.targetUpperBelow` and no
 * other primary case's lower bound is above `ab.otherLowerAbove`. An S1 run (start
 * record `lane: 'S1'`, read with s1Manifest) reads "every S1 case of the same size as
 * a target" for "every other primary case"; a W1 run, read
 * with w1Manifest, has the W1 cases as its primary cases.
 */
export function scoreAb(
  manifest: Manifest,
  v2: ManifestV2,
  hashes: HashesV2,
  shard: Shard,
): AbScore {
  const start = startV2(shard);
  const { lane } = start;
  const issues = shardIssuesV2(manifest, v2, hashes, shard, ['ab']);
  if (lane !== laneOf(manifest))
    issues.push(
      `${lane === 'S1' ? 'an' : 'a'} ${lane ?? 'B1/B2'} A/B run read with the ${laneOf(manifest) ?? 'B1/B2/S1'} manifest`,
    );
  const processes = Number(start.measurement?.processes ?? 0);
  if (processes < v2.ab.minProcesses) {
    issues.push(
      `${String(processes)} processes per arm; the rule needs at least ${String(v2.ab.minProcesses)}`,
    );
  }
  const eligible = manifest.cases.filter((c) =>
    lane === 'S1' ? c.lane === 'S1' && c.class === 'additional' : c.class === 'primary',
  );
  const targets = start.ab?.targets ?? [];
  if (targets.length === 0) issues.push('no target cases: the keep rule cannot be applied');
  for (const t of targets) {
    if (!eligible.some((c) => c.id === t)) issues.push(`target ${t} is not ${abTargetKind(lane)}`);
  }
  const sizes = new Set(eligible.filter((c) => targets.includes(c.id)).map((c) => c.targetBytes));
  const ruled = eligible.filter((c) => lane !== 'S1' || sizes.has(c.targetBytes)).map((c) => c.id);
  const index = indexV2([shard], null, issues);
  const usable = (impl: string, caseId: string) => {
    const where = `${impl} @ ${caseId}`;
    const checks = index.checks.get(key(impl, caseId)) ?? [];
    if (checks.length !== 1 || checks[0]?.status !== 'PASS') {
      issues.push(`${where}: no passing correctness record`);
      return new Map<number, number>();
    }
    const times = index.times.get(key(impl, caseId)) ?? [];
    const lost = missingRounds(
      times,
      processes,
      (r) => validTimeV2(r, v2),
      where,
      'timing',
      issues,
    );
    if (lost.length > 0) issues.push(`${where}: timing rounds ${list(lost)} missing`);
    if (fixedPairTiming([shard])) issues.push(...mixedSettings(times, v2, where));
    issues.push(...nodeFlagIssues(times, v2, repeatedNodeFlags([shard]), where));
    return new Map(
      times
        .filter((r) => validTimeV2(r, v2))
        .map((r) => [roundOf(r), median(r.samplesMs as number[])] as const),
    );
  };
  issues.push(...seedIssues(shard));
  const rows = manifest.cases
    .filter((c) => start.plannedCases.includes(c.id))
    .map((c) => {
      const a = usable('a', c.id);
      const b = usable('b', c.id);
      // B over A, paired by round; one seed for all cases, so the rounds are resampled jointly.
      const pair = pairByRound(b, a);
      if (pair.unpaired.length > 0 && pair.top.length > 0) {
        issues.push(
          `${c.id}: rounds ${list(pair.unpaired)} lack one arm and are excluded from pairing`,
        );
      }
      return {
        case: c.id,
        target: targets.includes(c.id),
        inRule: ruled.includes(c.id),
        aMs: medianOrNull([...a.values()]),
        bMs: medianOrNull([...b.values()]),
        ratio:
          pair.top.length > 0
            ? pairedBootstrapRatio(
                pair.top,
                pair.bottom,
                seedFor(start.seed ?? 0, 'bootstrap:ab'),
                v2.statistics.bootstrapResamples,
                v2.statistics.confidence,
              )
            : null,
      };
    });
  const absent = ruled.filter((id) => !rows.some((r) => r.case === id && r.ratio !== null));
  if (absent.length > 0)
    issues.push(
      `the keep rule needs every ${lane === 'S1' ? 'S1 case of the same size as a target' : lane === 'W1' ? 'W1 case' : 'primary case'}; missing: ${absent.join(', ')}`,
    );
  if (issues.length > 0) return { issues, rows, decision: null, reasons: [] };
  const reasons: string[] = [];
  for (const r of rows) {
    if (!r.ratio || !r.inRule) continue;
    if (r.target && !(r.ratio.hi < v2.ab.targetUpperBelow)) {
      reasons.push(
        `target ${r.case}: upper bound ${r.ratio.hi.toFixed(3)} is not below ${String(v2.ab.targetUpperBelow)}`,
      );
    }
    if (!r.target && r.ratio.lo > v2.ab.otherLowerAbove) {
      reasons.push(
        `${r.case}: lower bound ${r.ratio.lo.toFixed(3)} is above ${String(v2.ab.otherLowerAbove)}`,
      );
    }
  }
  return { issues, rows, decision: reasons.length === 0 ? 'keep' : 'reject', reasons };
}

export function renderAb(
  manifest: Manifest,
  v2: ManifestV2,
  hashes: HashesV2,
  shard: Shard,
): { text: string; decision: AbScore['decision'] } {
  const s = scoreAb(manifest, v2, hashes, shard);
  const start = startV2(shard);
  const arm = (x?: { commit: string; distSha256: string }) =>
    `commit ${String(x?.commit)}, bundle SHA-256 ${String(x?.distSha256)}`;
  const lines = [
    `# A/B report (method v2${start.lane === undefined ? '' : `, ${start.lane}`}): ${start.campaignId}`,
    '',
    `- A: ${arm(start.ab?.a)}.`,
    `- B: ${arm(start.ab?.b)}.`,
    ...identityLines([shard], v2),
    `- Rule: keep if every target case's B/A upper 95% bound is below ${String(v2.ab.targetUpperBelow)} and no ${abOthers(start.lane)}'s lower bound is above ${String(v2.ab.otherLowerAbove)}; otherwise reject.`,
    '',
    'B/A is B time / A time: below 1 means B is faster.',
    '',
    '| case | role | A ms | B ms | B/A [95%] | rule |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of s.rows) {
    const fails =
      r.ratio !== null &&
      r.inRule &&
      (r.target ? !(r.ratio.hi < v2.ab.targetUpperBelow) : r.ratio.lo > v2.ab.otherLowerAbove);
    lines.push(
      `| ${r.case} | ${r.target ? 'target' : r.inRule ? 'other' : 'not in the rule'} | ${fmt(r.aMs ?? Number.NaN)} | ${fmt(r.bMs ?? Number.NaN)} | ${interval(r.ratio)} | ${r.ratio === null || !r.inRule ? '-' : fails ? 'fails' : 'ok'} |`,
    );
  }
  lines.push('');
  if (s.decision === null) {
    lines.push(`NO DECISION: the run cannot be judged (${String(s.issues.length)} issues).`);
    lines.push(...s.issues.map((i) => `- ${i}`));
  } else if (s.decision === 'keep') {
    lines.push(
      `DECISION: KEEP (every target case's upper bound is below the threshold and no ${abOthers(start.lane)} regresses beyond its threshold).`,
    );
  } else {
    lines.push('DECISION: REJECT', ...s.reasons.map((r) => `- ${r}`));
  }
  lines.push('');
  return { text: lines.join('\n'), decision: s.decision };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('usage: node bench/report.ts <shard.jsonl>...');
  const shards = files.map((f) => parseShard(readFileSync(f, 'utf8'), f));
  const read = shards.filter((s) => !s.empty);
  const methods = new Set(read.map((s) => startV2(s).method ?? 'v1'));
  if (methods.size > 1) throw new Error('the files mix method v1 and method v2 runs');
  if (read.length === 0) {
    process.stdout.write(`INCOMPLETE: no records in ${files.join(', ')} (interrupted).\n`);
    process.exitCode = 1;
  } else if (!methods.has('v2')) {
    process.stdout.write(renderMarkdown(readManifest(), manifestSha256(), shards));
  } else {
    const [only] = read;
    // The method is the one whose manifest file the first start record names by hash (v2, or
    // the publication method); a shard of another method or of an earlier manifest is flagged.
    const method = methodOf(only && startV2(only).manifestV2Sha256);
    const { v2 } = method;
    const hashes = { manifestSha256: manifestSha256(), manifestV2Sha256: method.sha256 };
    if (only && startV2(only).kind === 'ab') {
      if (shards.length !== 1) throw new Error('an A/B report takes exactly one result file');
      // The start record names the lane; scoreAb flags a lane its manifest does not fit.
      const { lane } = startV2(only);
      const manifest = abManifest(
        lane === 'S1' || lane === 'W1' ? lane : undefined,
        method.manifest,
        v2,
      );
      const out = renderAb(manifest, v2, hashes, only);
      process.stdout.write(out.text);
      if (out.decision === null) process.exitCode = 1;
    } else {
      // The first shard names the lane; the report flags any shard of another lane.
      const lane = only ? startV2(only).lane : undefined;
      const manifest = laneManifest(
        lane === 'S1' || lane === 'W1' ? lane : undefined,
        method.manifest,
        v2,
      );
      const out = renderV2(manifest, v2, hashes, shards);
      process.stdout.write(out.text);
      process.exitCode = out.exitCode;
    }
  }
}
