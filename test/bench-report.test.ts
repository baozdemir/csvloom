import { describe, expect, it } from 'vitest';
import { readManifest, type Manifest } from '../bench/manifest.ts';
import {
  parseShard,
  renderMarkdown,
  score,
  validateCampaign,
  type JobRecord,
  type Shard,
} from '../bench/report.ts';

// A complete, valid two-shard campaign over a tiny manifest, and one mutation per
// way evidence can be incomplete or invalid. Each mutation must make the campaign
// ineligible: no overall score.

const SHA = 'manifest-sha';
const SOURCE = { gitCommit: 'commit', sha256: 'source' };
const ENVIRONMENT = { cpu: 'cpu', cpuCount: 2, totalMemBytes: 8, osRelease: 'os' };
const METHOD = 'getrusage-maxRSS';

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
    samples: 3,
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
      { id: 'S1', cases: ['B1-a'] },
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
  ],
};

const MS = { ref: 20, fast: 15, cand: 10 } as const;
const settings = { warmupMs: 500, minWarmupOps: 3, samples: 3, minSampleMs: 250 };

function shard(id: 'S1' | 'S2', caseId: string): Shard {
  const records: JobRecord[] = [];
  for (const impl of ['ref', 'fast', 'cand'] as const) {
    records.push({ type: 'check', impl, case: caseId, status: 'PASS' });
    for (const rep of [1, 2, 3]) {
      records.push({
        type: 'time',
        impl,
        case: caseId,
        rep,
        samplesMs: [MS[impl], MS[impl], MS[impl]],
        measurement: settings,
      });
    }
    records.push({
      type: 'memory',
      impl,
      case: caseId,
      loadedInputPeakRssBytes: 50,
      peakRssBytes: impl === 'cand' ? 90 : 100,
      peakRssMethod: METHOD,
    });
  }
  // The designated cold-start shard holds one cold record per implementation.
  if (id === manifest.campaign.coldStartShard) {
    for (const impl of ['ref', 'fast', 'cand']) {
      records.push({ type: 'cold', impl, case: manifest.campaign.coldStartCase, firstParseMs: 1 });
    }
  }
  return {
    file: `${id}.jsonl`,
    start: {
      type: 'start',
      kind: 'campaign',
      campaignId: 'c1',
      shardId: id,
      plannedCases: [caseId],
      filters: { cases: null, impls: null, reps: null, noMemory: false },
      runtime: { node: 'v24.22.1', workerFlags: ['--expose-gc'] },
      packages: { ref: '1.0.0', fast: '2.0.0' },
      manifestSha256: SHA,
      source: SOURCE,
      environment: ENVIRONMENT,
    },
    records,
    end: { type: 'end', status: 'complete', manifestSha256: SHA, source: SOURCE },
  };
}

const campaign = () => [shard('S1', 'B1-a'), shard('S2', 'B2-a')];

function expectRejected(shards: Shard[], issue: RegExp) {
  const result = score(manifest, SHA, shards);
  expect(result.validation.eligible).toBe(false);
  expect(result.overall).toBeNull();
  expect(result.evidenceUsable).toBe(false);
  expect(result.validation.issues.join('\n')).toMatch(issue);
}

const without = (records: JobRecord[], drop: (r: JobRecord) => boolean) =>
  records.filter((r) => !drop(r));

describe('a complete valid campaign', () => {
  it('is eligible, scores against the fastest valid competitor, and reports B1/B2 subgroups', () => {
    const result = score(manifest, SHA, campaign());
    expect(result.validation).toStrictEqual({ eligible: true, issues: [] });
    expect(result.overall).toBeCloseTo(1.5, 12);
    expect(result.b1).toBeCloseTo(1.5, 12);
    expect(result.b2).toBeCloseTo(1.5, 12);
    expect(result.diagnostic.perRepetition).toStrictEqual([1.5, 1.5, 1.5]);
    expect(result.perCase.map((c) => c.referenceImpl)).toStrictEqual(['fast', 'fast']);
    expect(result.evidenceUsable).toBe(true);
    expect(result.spreadFlags).toStrictEqual([]);
    expect(result.peakRssVsReference.map((r) => r.ratio)).toStrictEqual([0.9, 0.9]);
  });

  it('round-trips through JSONL', () => {
    const s = shard('S1', 'B1-a');
    const text = [s.start, ...s.records, s.end].map((r) => JSON.stringify(r)).join('\n');
    expect(parseShard(text, 'S1.jsonl')).toStrictEqual(s);
  });
});

describe('scorer defects are rejected', () => {
  it('two repetitions instead of three', () => {
    const shards = campaign();
    for (const s of shards) s.records = without(s.records, (r) => r.rep === 3);
    expectRejected(shards, /repetitions \[1,2\], required \[1,2,3\]/);
  });

  it('three copies of repetition 1', () => {
    const shards = campaign();
    for (const s of shards) for (const r of s.records) if (r.type === 'time') r.rep = 1;
    expectRejected(shards, /repetitions \[1,1,1\], required \[1,2,3\]/);
  });

  it('a filtered subset of the primary cases', () => {
    const [s1] = campaign();
    if (!s1) throw new Error('fixture');
    s1.start.filters = { ...s1.start.filters, cases: 'B1-a' };
    expectRejected([s1], /filtered run[\s\S]*shard S2 present 0 times[\s\S]*no correctness record/);
  });

  it('a competitor with a PASS record but no timing does not drop out of reference selection', () => {
    const shards = campaign();
    for (const s of shards)
      s.records = without(s.records, (r) => r.type === 'time' && r.impl === 'fast');
    expectRejected(shards, /fast @ B1-a: repetitions \[\], required/);
    // The slower 'ref' must not silently become the reference.
    expect(score(manifest, SHA, shards).perCase.map((c) => c.referenceImpl)).toStrictEqual([
      null,
      null,
    ]);
  });

  it('zero-duration candidate samples', () => {
    const shards = campaign();
    for (const s of shards)
      for (const r of s.records)
        if (r.impl === 'cand' && r.type === 'time') r.samplesMs = [0, 0, 0];
    expectRejected(shards, /non-finite or non-positive sample/);
    expect(score(manifest, SHA, shards).diagnostic.overall).toBeNull();
  });
});

describe('other incomplete or invalid evidence', () => {
  it('a missing case', () => {
    const shards = campaign();
    const s2 = shards[1];
    if (!s2) throw new Error('fixture');
    s2.records = [];
    expectRejected(shards, /cand @ B2-a: no correctness record/);
  });

  it('a failed competitor is excluded from the reference without invalidating the campaign', () => {
    const shards = campaign();
    for (const s of shards) {
      s.records = without(
        s.records,
        (r) => r.impl === 'fast' && (r.type === 'time' || r.type === 'memory'),
      );
      for (const r of s.records) if (r.impl === 'fast' && r.type === 'check') r.status = 'FAIL';
    }
    const result = score(manifest, SHA, shards);
    expect(result.validation.eligible).toBe(true);
    expect(result.overall).toBeCloseTo(2, 12);
  });

  it('a failed candidate', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? [])
      if (r.impl === 'cand' && r.type === 'check') r.status = 'FAIL';
    expectRejected(shards, /cand @ B1-a: FAIL/);
  });

  it('an errored (blocked) competitor run', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? [])
      if (r.impl === 'fast' && r.type === 'check') r.status = 'BLOCKED';
    expectRejected(shards, /fast @ B1-a: BLOCKED \(missing measurement\)/);
  });

  it('a blocked timing job', () => {
    const shards = campaign();
    const t = shards[0]?.records.find((r) => r.impl === 'fast' && r.type === 'time');
    if (!t) throw new Error('fixture');
    t.status = 'BLOCKED';
    delete t.samplesMs;
    expectRejected(shards, /1 timing job\(s\) blocked/);
  });

  it('incomplete samples', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? [])
      if (r.type === 'time' && r.impl === 'ref') r.samplesMs = [20, 20];
    expectRejected(shards, /2 samples, required 3/);
  });

  it('measurement settings overridden on the command line', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? [])
      if (r.type === 'time') r.measurement = { ...settings, samples: 2, minSampleMs: 50 };
    expectRejected(shards, /samples differs from the manifest[\s\S]*minSampleMs differs/);
  });

  it('a runtime UNSUPPORTED that the manifest does not declare', () => {
    const shards = campaign();
    for (const s of shards) {
      s.records = without(
        s.records,
        (r) => r.impl === 'fast' && (r.type === 'time' || r.type === 'memory'),
      );
      for (const r of s.records)
        if (r.impl === 'fast' && r.type === 'check') r.status = 'UNSUPPORTED';
    }
    expectRejected(shards, /UNSUPPORTED at run time but not declared/);
  });

  it('a declared unsupported pair is accounted for, not missing', () => {
    const declared = {
      ...manifest,
      unsupported: [{ impl: 'fast', cases: ['B1-a', 'B2-a'], reason: 'test' }],
    };
    const shards = campaign();
    for (const s of shards) {
      s.records = without(
        s.records,
        (r) => r.impl === 'fast' && (r.type === 'time' || r.type === 'memory'),
      );
      for (const r of s.records)
        if (r.impl === 'fast' && r.type === 'check')
          Object.assign(r, { status: 'UNSUPPORTED', reason: 'test' });
    }
    const result = score(declared, SHA, shards);
    expect(result.validation.eligible).toBe(true);
    expect(result.perCase.map((c) => c.referenceImpl)).toStrictEqual(['ref', 'ref']);
  });

  it('missing peak-RSS evidence for the reference or candidate', () => {
    const shards = campaign();
    for (const s of shards)
      s.records = without(s.records, (r) => r.type === 'memory' && r.impl === 'cand');
    expectRejected(shards, /cand @ B1-a: no memory record/);
  });
});

describe('identity and shard merging', () => {
  const mutate = (f: (s: Shard) => void) => {
    const shards = campaign();
    const first = shards[0];
    if (!first) throw new Error('fixture');
    f(first);
    return shards;
  };

  it('a different manifest', () => {
    expectRejected(
      mutate((s) => (s.start.manifestSha256 = 'other')),
      /run with a different manifest/,
    );
  });

  it('a different runtime', () => {
    expectRejected(
      mutate((s) => (s.start.runtime.node = 'v26.12.1')),
      /runtime v26\.12\.1, manifest requires v24\.22\.1/,
    );
  });

  it('different package versions', () => {
    expectRejected(
      mutate((s) => (s.start.packages = { ref: '1.0.0', fast: '2.0.1' })),
      /package versions differ/,
    );
  });

  it('a different source identity between shards', () => {
    const changed = { ...SOURCE, sha256: 'edited' };
    expectRejected(
      mutate((s) => {
        s.start.source = changed;
        if (s.end) s.end.source = changed;
      }),
      /different source identities/,
    );
  });

  it('source changed during a shard', () => {
    expectRejected(
      mutate((s) => {
        if (s.end) s.end.source = { ...SOURCE, sha256: 'edited' };
      }),
      /source changed during the shard/,
    );
  });

  it('an interrupted shard with no end record', () => {
    expectRejected(
      mutate((s) => (s.end = null)),
      /no end record \(interrupted\)/,
    );
  });

  it('a shard that hit its deadline', () => {
    expectRejected(
      mutate((s) => s.end && (s.end.status = 'deadline')),
      /ended with deadline/,
    );
  });

  it('a duplicated shard', () => {
    expectRejected([...campaign(), shard('S2', 'B2-a')], /shard S2 present 2 times/);
  });

  it('shards from different campaigns', () => {
    expectRejected(
      mutate((s) => (s.start.campaignId = 'c2')),
      /different campaigns/,
    );
  });

  it('a smoke run, even when the candidate is present', () => {
    expectRejected(
      mutate((s) => (s.start.kind = 'smoke')),
      /smoke run; diagnostics only/,
    );
  });

  it('validates the manifest itself', () => {
    const broken: Manifest = {
      ...manifest,
      cases: [...manifest.cases, { id: 'B1-orphan', lane: 'B1', class: 'primary', weight: 0 }],
    };
    const issues = validateCampaign(broken, SHA, campaign()).issues.join('\n');
    expect(issues).toMatch(/case B1-orphan is in no shard/);
    expect(issues).toMatch(/invalid weight 0/);
  });
});

describe('rendered report', () => {
  it('lists the manifest UNAVAILABLE packages with their reasons', () => {
    const withUnavailable: Manifest = {
      ...manifest,
      unavailable: [{ package: 'gone', version: '1.0.0', reason: 'no dist entry' }],
    };
    expect(renderMarkdown(withUnavailable, SHA, campaign())).toContain(
      '- gone 1.0.0: no dist entry',
    );
  });
});

describe('record ownership and memory uniqueness', () => {
  it('rejects jobs moved into a shard that does not own their case', () => {
    const shards = campaign();
    const [s1, s2] = shards;
    if (!s1 || !s2) throw new Error('fixture');
    s1.records.push(...s2.records);
    s2.records = [];
    expectRejected(
      shards,
      /check record for ref @ B2-a belongs to another shard[\s\S]*ref @ B2-a: no correctness record/,
    );
  });

  it('rejects a duplicate memory record and does not let either value reach the report', () => {
    const shards = campaign();
    shards[0]?.records.unshift({
      type: 'memory',
      impl: 'cand',
      case: 'B1-a',
      loadedInputPeakRssBytes: 10,
      peakRssBytes: 20,
    });
    expectRejected(shards, /cand @ B1-a: 2 memory records[\s\S]*exactly one valid success/);
    const result = score(manifest, SHA, shards);
    expect(result.peakRssVsReference[0]?.ratio).toBeNull();
    // A missing ratio is the only case in which a reported check is not evaluated.
    expect(result.reportedChecks.peakMemory).toStrictEqual({ value: null, limit: 1.1, met: null });
  });

  it('rejects a blocked memory attempt that carries peak values', () => {
    const shards = campaign();
    const mem = shards[0]?.records.find((r) => r.type === 'memory' && r.impl === 'cand');
    if (!mem) throw new Error('fixture');
    mem.status = 'BLOCKED';
    expectRejected(
      shards,
      /cand @ B1-a: memory result must be exactly one valid success \(1 record/,
    );
  });

  it('rejects an inconsistent memory record (peak below the loaded-input baseline)', () => {
    const shards = campaign();
    const mem = shards[0]?.records.find((r) => r.type === 'memory' && r.impl === 'ref');
    if (!mem) throw new Error('fixture');
    mem.loadedInputPeakRssBytes = 500;
    expectRejected(shards, /ref @ B1-a: memory result must be exactly one valid success/);
  });

  it('names a failing reference instead of reporting a missing memory measurement', () => {
    const shards = campaign();
    for (const s of shards) {
      s.records = without(s.records, (r) => r.impl === 'ref' && r.type !== 'check');
      for (const r of s.records) if (r.impl === 'ref') r.status = 'FAIL';
    }
    const issues = score(manifest, SHA, shards).validation.issues.join('\n');
    expect(issues).toMatch(
      /reference ref @ B1-a: FAIL; the memory comparison needs a passing reference/,
    );
    expect(issues).not.toMatch(/ref @ B1-a: no memory record/);
  });

  it('accepts cold-start records for a case owned by another shard when they are in the cold-start shard', () => {
    const crossCase: Manifest = {
      ...manifest,
      campaign: { ...manifest.campaign, coldStartCase: 'B2-a' },
    };
    const shards = campaign();
    for (const r of shards[0]?.records ?? []) if (r.type === 'cold') r.case = 'B2-a';
    expect(validateCampaign(crossCase, SHA, shards)).toStrictEqual({ eligible: true, issues: [] });
  });

  it('rejects cold-start records outside the cold-start shard, and a missing one', () => {
    const shards = campaign();
    const [s1, s2] = shards;
    if (!s1 || !s2) throw new Error('fixture');
    const cold = s1.records.filter((r) => r.type === 'cold' && r.impl === 'cand');
    s1.records = without(s1.records, (r) => r.type === 'cold' && r.impl === 'cand');
    s2.records.push(...cold);
    expectRejected(
      shards,
      /cold record for cand @ B1-a is outside the cold-start shard and case[\s\S]*cand: cold start needs exactly one valid result/,
    );
  });
});

describe('unscored validation cases still block completion', () => {
  // An additional (weight 0) real-dataset case owned by S2: it adds no speedup
  // weight, but the candidate must pass it.
  const withExternal: Manifest = {
    ...manifest,
    campaign: {
      ...manifest.campaign,
      shards: [
        { id: 'S1', cases: ['B1-a'] },
        { id: 'S2', cases: ['B2-a', 'B1-ext'] },
      ],
    },
    cases: [...manifest.cases, { id: 'B1-ext', lane: 'B1', class: 'additional', weight: 0 }],
  };
  const shards = (candidateStatus: string | null) => {
    const all = campaign();
    const s2 = all[1];
    if (!s2) throw new Error('fixture');
    s2.start.plannedCases = ['B2-a', 'B1-ext'];
    for (const impl of ['ref', 'fast', 'cand']) {
      const status = impl === 'cand' ? candidateStatus : 'PASS';
      if (status === null) continue;
      s2.records.push({ type: 'check', impl, case: 'B1-ext', status });
      if (status !== 'PASS') continue;
      for (const rep of [1, 2, 3]) {
        s2.records.push({
          type: 'time',
          impl,
          case: 'B1-ext',
          rep,
          samplesMs: [MS[impl as 'ref'], MS[impl as 'ref'], MS[impl as 'ref']],
          measurement: settings,
        });
      }
    }
    return all;
  };

  it('passes with the candidate passing, and the weight-0 case leaves the score unchanged', () => {
    const result = score(withExternal, SHA, shards('PASS'));
    expect(result.validation).toStrictEqual({ eligible: true, issues: [] });
    expect(result.overall).toBeCloseTo(1.5, 12);
  });

  it.each([['FAIL'], ['NO-ORACLE'], ['UNAVAILABLE'], [null]])(
    'rejects candidate status %s',
    (status) => {
      const result = score(withExternal, SHA, shards(status));
      expect(result.validation.eligible).toBe(false);
      expect(result.validation.issues.join('\n')).toMatch(/cand @ B1-ext/);
    },
  );
});

describe('reported checks are facts, separate from evidence usability', () => {
  it('reports the checks and no overall target', () => {
    const result = score(manifest, SHA, campaign());
    expect(result.evidenceUsable).toBe(true);
    expect(result).not.toHaveProperty('targets');
    expect(result.overall).toBeCloseTo(1.5, 12);
    expect(result.reportedChecks.peakMemory).toStrictEqual({ value: 0.9, limit: 1.1, met: true });
    // No regression cases in this manifest: the check cannot be evaluated, not passed.
    expect(result.reportedChecks.smallInputRegression).toStrictEqual({
      value: null,
      limit: 1.1,
      met: null,
    });
    expect(renderMarkdown(manifest, SHA, campaign())).toContain(
      'Reported checks vs ref (facts, not gates): small-input worst ratio n/a (limit 1.10: not evaluated); peak RSS worst ratio 0.900 (limit 1.10: within).',
    );
  });

  it('keeps evidence usable while the candidate is slower and a check is above its limit', () => {
    const shards = campaign();
    for (const s of shards)
      for (const r of s.records) {
        if (r.type === 'time' && r.impl === 'cand') r.samplesMs = [30, 30, 30];
        if (r.type === 'memory' && r.impl === 'cand') r.peakRssBytes = 120;
      }
    const result = score(manifest, SHA, shards);
    expect(result.evidenceUsable).toBe(true);
    expect(result.spreadFlags).toStrictEqual([]);
    expect(result.overall).toBeCloseTo(0.5, 12);
    expect(result.diagnostic.perRepetition).toStrictEqual([0.5, 0.5, 0.5]);
    expect(result.reportedChecks.peakMemory).toStrictEqual({ value: 1.2, limit: 1.1, met: false });
    expect(renderMarkdown(manifest, SHA, shards)).toContain(
      'peak RSS worst ratio 1.200 (limit 1.10: above).',
    );
  });

  it('evaluates the checks whenever data allow, also for an ineligible run', () => {
    const shards = campaign();
    if (shards[0]) shards[0].start.kind = 'smoke';
    const result = score(manifest, SHA, shards);
    expect(result.validation.eligible).toBe(false);
    expect(result.overall).toBeNull();
    expect(result.evidenceUsable).toBe(false);
    expect(result.reportedChecks.peakMemory).toStrictEqual({ value: 0.9, limit: 1.1, met: true });
    expect(result.reportedChecks.smallInputRegression.met).toBeNull();
  });
});

describe('inconclusive measurements', () => {
  it('keep a noisy fast competitor as the reference, the evidence unusable, and flag it', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? []) {
      if (r.type === 'time' && r.impl === 'fast' && r.rep === 3) r.samplesMs = [12, 12, 12];
    }
    const result = score(manifest, SHA, shards);
    expect(result.validation.eligible).toBe(true);
    expect(result.perCase[0]).toMatchObject({ referenceImpl: 'fast', inconclusive: true });
    expect(result.evidenceUsable).toBe(false);
    // Medians 15, 15 and 12: (15 - 12) / 15.
    expect(result.spreadFlags).toStrictEqual([
      { case: 'B1-a', impl: 'fast', spread: 0.2, bestRepetitionMs: 12 },
    ]);
  });
});

describe('small-input comparisons (required candidate/reference pairs)', () => {
  // One regression case owned by S1. Only the reference and the candidate run on
  // it. Medians are mock values, not measurements.
  const withSmall: Manifest = {
    ...manifest,
    campaign: {
      ...manifest.campaign,
      shards: [
        { id: 'S1', cases: ['B1-a', 'B1-small'] },
        { id: 'S2', cases: ['B2-a'] },
      ],
    },
    cases: [...manifest.cases, { id: 'B1-small', lane: 'B1', class: 'regression', weight: 0 }],
  };
  const shards = (cand: readonly number[], ref: readonly number[]) => {
    const all = campaign();
    const s1 = all[0];
    if (!s1) throw new Error('fixture');
    s1.start.plannedCases = ['B1-a', 'B1-small'];
    for (const [impl, medians] of [
      ['ref', ref],
      ['cand', cand],
    ] as const) {
      s1.records.push({ type: 'check', impl, case: 'B1-small', status: 'PASS' });
      medians.forEach((ms, i) => {
        s1.records.push({
          type: 'time',
          impl,
          case: 'B1-small',
          rep: i + 1,
          samplesMs: [ms, ms, ms],
          measurement: settings,
        });
      });
    }
    return all;
  };

  it('a stable passing comparison keeps the evidence usable and is within the limit', () => {
    const result = score(withSmall, SHA, shards([10, 10, 10], [20, 20, 20]));
    expect(result.validation).toStrictEqual({ eligible: true, issues: [] });
    expect(result.smallInputRegression).toStrictEqual([
      { case: 'B1-small', ratio: 0.5, inconclusive: false },
    ]);
    expect(result.evidenceUsable).toBe(true);
    expect(result.spreadFlags).toStrictEqual([]);
    expect(result.reportedChecks.smallInputRegression).toStrictEqual({
      value: 0.5,
      limit: 1.1,
      met: true,
    });
    expect(renderMarkdown(withSmall, SHA, shards([10, 10, 10], [20, 20, 20]))).toContain(
      'Spread flags (above 10%): none.',
    );
  });

  it.each([
    [
      'candidate',
      [10, 20, 10],
      [20, 20, 20],
      { case: 'B1-small', impl: 'cand', spread: 1, bestRepetitionMs: 10 },
      'cand @ B1-small 100.0% (best repetition 10.00 ms)',
    ],
    [
      'reference',
      [10, 10, 10],
      [20, 30, 20],
      { case: 'B1-small', impl: 'ref', spread: 0.5, bestRepetitionMs: 20 },
      'ref @ B1-small 50.0% (best repetition 20.00 ms)',
    ],
  ] as const)(
    'a noisy %s leaves the comparison unresolved, flags it and still reports the check',
    (_who, cand, ref, flag, rendered) => {
      const result = score(withSmall, SHA, shards(cand, ref));
      expect(result.validation).toStrictEqual({ eligible: true, issues: [] });
      // The primary cases stay complete, valid and stable.
      expect(result.perCase.every((c) => !c.inconclusive)).toBe(true);
      // The ratio is kept and the comparison stays unresolved; the noisy side is flagged.
      expect(result.smallInputRegression).toStrictEqual([
        { case: 'B1-small', ratio: 0.5, inconclusive: true },
      ]);
      expect(result.evidenceUsable).toBe(false);
      expect(result.spreadFlags).toStrictEqual([flag]);
      expect(result.reportedChecks.smallInputRegression).toStrictEqual({
        value: 0.5,
        limit: 1.1,
        met: true,
      });
      expect(renderMarkdown(withSmall, SHA, shards(cand, ref))).toContain(
        `Spread flags (above 10%): ${rendered}.`,
      );
    },
  );

  describe('flags and reported checks instead of gates', () => {
    // fast's repetition medians on B1-a are 15, 15 and 11.25 (a 25% spread); the candidate is stable.
    const medians = [15, 15, 11.25];
    const noisy = () => {
      const all = shards([10, 10, 10], [20, 20, 20]);
      for (const r of all[0]?.records ?? [])
        if (r.type === 'time' && r.impl === 'fast' && r.case === 'B1-a' && r.rep === 3)
          r.samplesMs = [11.25, 11.25, 11.25];
      return all;
    };

    it('reportedChecks are evaluated when a competitor is noisy', () => {
      const result = score(withSmall, SHA, noisy());
      expect(result.validation).toStrictEqual({ eligible: true, issues: [] });
      expect(result.evidenceUsable).toBe(false);
      expect(result.reportedChecks.smallInputRegression).toStrictEqual({
        value: 0.5,
        limit: 1.1,
        met: true,
      });
      expect(result.reportedChecks.peakMemory).toStrictEqual({ value: 0.9, limit: 1.1, met: true });
    });

    it('spreadFlags name the implementation, the spread and its best repetition', () => {
      const result = score(withSmall, SHA, noisy());
      const spread = (Math.max(...medians) - Math.min(...medians)) / 15; // median 15
      expect(result.spreadFlags).toHaveLength(1);
      const [flag] = result.spreadFlags;
      expect(flag).toMatchObject({ case: 'B1-a', impl: 'fast' });
      expect(Object.keys(flag ?? {}).sort()).toStrictEqual([
        'bestRepetitionMs',
        'case',
        'impl',
        'spread',
      ]);
      expect(Math.abs((flag?.spread ?? Number.NaN) - spread)).toBeLessThan(0.001);
      expect(flag?.bestRepetitionMs).toBe(Math.min(...medians));
    });

    it('the manifest has no overall target', () => {
      const real = readManifest();
      expect(real.scoring).not.toHaveProperty('targets');
      expect(real.scoring.reportedChecks).toStrictEqual({
        smallInputVsReferenceMax: 0.1,
        peakMemoryVsReferenceMax: 0.1,
      });
      // The scoring block has no overall target.
      expect(JSON.stringify(real.scoring)).not.toContain('overallMin');
    });

    it('the rendered header reports flags and checks, not gates', () => {
      // The fixture's reference renamed to the real one, so that the header names it.
      const papa = <T>(x: T): T =>
        JSON.parse(JSON.stringify(x).replaceAll('"ref"', '"papaparse"')) as T;
      const text = renderMarkdown(papa(withSmall), SHA, papa(noisy()));
      expect(text.split('\n').slice(0, 3)).toStrictEqual([
        'ELIGIBLE campaign. Overall vs fastest valid competitor (reported; no numeric target): 1.500 (B1 1.500, B2 1.500); per repetition 1.500 / 1.500 / 1.299.',
        'Spread flags (above 10%): fast @ B1-a 25.0% (best repetition 11.25 ms).',
        'Reported checks vs papaparse (facts, not gates): small-input worst ratio 0.500 (limit 1.10: within); peak RSS worst ratio 0.900 (limit 1.10: within).',
      ]);
      expect(text).not.toContain('Target checks');
      expect(text).not.toContain('>= 1.25');
    });
  });
});

describe('one machine and one peak-RSS method per campaign', () => {
  it('rejects shards run on different machines', () => {
    const shards = campaign();
    if (shards[1]) shards[1].start.environment = { ...ENVIRONMENT, osRelease: 'other' };
    expectRejected(shards, /shards were run on different machines/);
  });

  it('rejects a shard without a machine environment identity', () => {
    const shards = campaign();
    if (shards[1]) delete shards[1].start.environment;
    expectRejected(shards, /a shard has no machine environment identity/);
  });

  it('rejects memory records taken by different peak-RSS methods', () => {
    const shards = campaign();
    for (const r of shards[1]?.records ?? []) {
      if (r.type === 'memory') r.peakRssMethod = 'linux-proc-self-status-VmHWM';
    }
    expectRejected(shards, /different peak-RSS methods/);
  });

  it('does not accept a memory record that does not state its method', () => {
    const shards = campaign();
    for (const r of shards[0]?.records ?? []) {
      if (r.type === 'memory' && r.impl === 'cand') delete r.peakRssMethod;
    }
    expectRejected(shards, /cand @ B1-a/);
  });
});
