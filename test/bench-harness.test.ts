import { describe, expect, it } from 'vitest';
import { loadAdapter } from '../bench/adapters/index.ts';
import { FAMILIES, generateFixture } from '../bench/fixtures.ts';
import { firstMismatch, type Adapter, type Dialect } from '../bench/lanes.ts';
import { readManifest, type CaseSpec } from '../bench/manifest.ts';
import { runJob, type Guards } from '../bench/run.ts';
import {
  check,
  measureMemory,
  memoryOperation,
  operation,
  parseVmHwmBytes,
  PEAK_RSS_METHOD,
  peakRssBytes,
  time,
  type Input,
} from '../bench/worker.ts';

const manifest = readManifest();

function input(family: (typeof FAMILIES)[number], targetBytes = 64 * 1024): Input {
  const f = generateFixture({ family, seed: manifest.families[family].seed, targetBytes });
  return {
    csv: f.csv,
    dialect: f.dialect,
    sha256: f.sha256,
    header: f.rows[0] ?? null,
    rows: f.rows,
  };
}

const spec = (lane: CaseSpec['lane']): CaseSpec => ({
  id: `test-${lane}`,
  lane,
  class: 'primary',
  weight: 1,
});

describe('fixture generator', () => {
  it('is deterministic for a seed', () => {
    const a = generateFixture({ family: 'unicode', seed: 7, targetBytes: 4096 });
    const b = generateFixture({ family: 'unicode', seed: 7, targetBytes: 4096 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(
      generateFixture({ family: 'unicode', seed: 8, targetBytes: 4096 }).sha256,
    );
  });

  it('matches the frozen manifest identity of a medium fixture', () => {
    const frozen = manifest.cases.find((c) => c.id === 'B1-multiline-1MiB')?.fixture;
    expect(input('multiline', 1 << 20).sha256).toBe(frozen?.sha256);
  });

  // Two independent parsers must read back exactly what the generator wrote,
  // otherwise the generator's quoting is wrong rather than any parser.
  it.each(FAMILIES)('%s round-trips through papaparse and csv-parse', async (family) => {
    const fixture = input(family);
    for (const id of ['papaparse', 'csv-parse']) {
      for (const lane of ['B1', 'B2'] as const) {
        expect(await check(await loadAdapter(id), spec(lane), fixture, manifest)).toMatchObject({
          status: 'PASS',
        });
      }
    }
  });
});

describe('correctness gate', () => {
  // Deliberately wrong: ignores quoting. Lives only in this test.
  const naive: Adapter = {
    package: 'naive-split',
    B1: (csv: string, dialect: Dialect) =>
      csv
        .slice(0, -dialect.newline.length)
        .split(dialect.newline)
        .map((line) => line.split(dialect.delimiter)),
  };

  it('fails an adapter that ignores quoting', async () => {
    expect(await check(naive, spec('B1'), input('quote-heavy'), manifest)).toMatchObject({
      status: 'FAIL',
    });
  });

  it('passes the same naive adapter on unquoted input, so the gate is per case', async () => {
    expect(await check(naive, spec('B1'), input('simple'), manifest)).toMatchObject({
      status: 'PASS',
    });
  });
});

describe('firstMismatch', () => {
  it('rejects unequal lengths even when the extra entries are undefined', () => {
    expect(firstMismatch([['a'], undefined], [['a']])).toMatchObject({
      reason: 'length',
      index: 1,
    });
    expect(firstMismatch([['a']], [['a'], undefined])).toMatchObject({
      reason: 'length',
      index: 1,
    });
  });

  it('validates lane shapes', () => {
    expect(firstMismatch([['a', 1]], [['a', '1']], 'B1')).toMatchObject({ reason: 'shape' });
    // A hole is not a string field.
    const holey: unknown[] = ['a'];
    holey[2] = 'c';
    expect(firstMismatch([holey], [['a', '', 'c']], 'B1')).toMatchObject({ reason: 'shape' });
    expect(firstMismatch([{ a: undefined }], [{ a: '' }], 'B2')).toMatchObject({ reason: 'shape' });
    expect(firstMismatch([['a']], [{ a: 'a' }], 'B2')).toMatchObject({ reason: 'shape' });
  });

  it('compares records by own keys and values, ignoring key order and prototype', () => {
    const nullProto = Object.assign(Object.create(null) as Record<string, string>, {
      b: '2',
      a: '1',
    });
    expect(firstMismatch([nullProto], [{ a: '1', b: '2' }], 'B2')).toBeNull();
    expect(firstMismatch([{ a: '1' }], [{ a: '1', b: '' }], 'B2')).toMatchObject({
      reason: 'value',
    });
  });
});

describe('measurement modes', () => {
  const m = { ...manifest.measurement, warmupMs: 5, minWarmupOps: 2, samples: 3, minSampleMs: 1 };

  it('times synchronous adapters in a plain loop and asynchronous ones in an awaiting loop', async () => {
    const sync = await time(() => 1, m);
    expect(sync).toMatchObject({ loop: 'sync' });
    const asyncResult = await time(() => Promise.resolve(1), m);
    expect(asyncResult).toMatchObject({ loop: 'async' });
    for (const r of [sync, asyncResult]) {
      expect(r.samplesMs).toHaveLength(3);
      expect(Number.isFinite(r.harnessNoopMsPerOp)).toBe(true);
    }
  });

  it('runs untimed operations after each forced collection, as many as fit in rewarmMs', async () => {
    for (const result of [() => 1, () => Promise.resolve(1)]) {
      let calls = 0;
      const op = () => {
        calls++;
        const end = performance.now() + 1;
        while (performance.now() < end);
        return result();
      };
      const r = await time(op, { ...m, minSampleMs: 4, rewarmMs: 20 });
      expect(r.rewarmOps).toBeGreaterThan(0);
      expect(calls).toBe(
        1 + (r.warmupOps - 1) + r.samplesMs.length * (r.rewarmOps + r.opsPerSample),
      );
    }
    expect((await time(() => 1, m)).rewarmOps).toBe(0);
  });

  it('uses the operations-per-sample count the runner fixed, sync and async', async () => {
    expect((await time(() => 1, { ...m, opsPerSample: 7 })).opsPerSample).toBe(7);
    expect((await time(() => Promise.resolve(1), { ...m, opsPerSample: 5 })).opsPerSample).toBe(5);
  });

  it('uses the re-warm count the runner fixed, 0 included, sync and async', async () => {
    for (const result of [() => 1, () => Promise.resolve(1)]) {
      let calls = 0;
      const op = () => {
        calls++;
        return result();
      };
      const r = await time(op, { ...m, rewarmMs: 250, rewarmOps: 0, opsPerSample: 1 });
      expect(r.rewarmOps).toBe(0);
      expect(calls).toBe(1 + (r.warmupOps - 1) + r.samplesMs.length);
    }
    expect((await time(() => 1, { ...m, rewarmMs: 0, rewarmOps: 3 })).rewarmOps).toBe(3);
  });

  it('fails if an adapter switches from synchronous to asynchronous results', async () => {
    let calls = 0;
    await expect(time(() => (++calls > 1 ? Promise.resolve(1) : 1), m)).rejects.toThrow(
      /Promise after a synchronous/,
    );
  });

  it('keeps the whole bulk output alive until the peak has been read', async () => {
    const fixture = input('simple');
    const papa = await loadAdapter('papaparse');
    const peaks: number[] = [];
    let retainedAtRead: number | undefined;
    const op = memoryOperation(papa, 'B1', fixture, 65536);
    const result = await measureMemory(
      async () => {
        const out = await op();
        retainedAtRead = out.retained?.length;
        return out;
      },
      () => peaks.push(peaks.length) && peaks.length,
    );
    expect(retainedAtRead).toBe(fixture.rows?.length);
    expect(result).toMatchObject({
      retainedRecords: fixture.rows?.length,
      loadedInputPeakRssBytes: 1,
      peakRssBytes: 2,
    });
  });

  it('keeps S1 incremental: nothing retained, everything consumed', async () => {
    const fixture = input('simple');
    const result = await measureMemory(
      memoryOperation(await loadAdapter('papaparse'), 'S1', fixture, 4096),
    );
    expect(result.retainedRecords).toBe(0);
    expect(result.consumed).toBe(operation(await loadAdapter('papaparse'), 'B2', fixture, 0)());
  });
});

describe('worker process modes', () => {
  const guards: Guards = {
    deadlineAt: Date.now() + 60_000,
    rssLimitBytes: 2 * 1024 ** 3,
    rssPollMs: 1000,
    diskFloorBytes: 0,
    tempCapBytes: Infinity,
    freeDiskBytes: () => Infinity,
    tempUsageBytes: () => 0,
    signal: new AbortController().signal,
  };
  const worker = new URL('../bench/worker.ts', import.meta.url).pathname;

  it('cold mode reports startup, import, fixture setup and first parse separately', async () => {
    const out = await runJob(
      [worker, '--impl', 'papaparse', '--case', 'B1-simple-1KiB', '--mode', 'cold'],
      guards,
    );
    if (out.status !== 'ok') throw new Error(out.detail);
    const r = out.record as Record<string, number>;
    for (const field of [
      'workerReadyMs',
      'importMs',
      'fixtureSetupMs',
      'firstParseMs',
      'processStartToFirstParseEndMs',
    ]) {
      expect(r[field]).toBeGreaterThan(0);
    }
    expect(r.processStartToFirstParseEndMs).toBeGreaterThanOrEqual(
      (r.workerReadyMs ?? 0) +
        (r.importMs ?? 0) +
        (r.fixtureSetupMs ?? 0) +
        (r.firstParseMs ?? 0) -
        1,
    );
    // Every worker states how its peak was read; the value is that method's bytes.
    expect(out.record.peakRssMethod).toBe(PEAK_RSS_METHOD);
    expect(r.workerMaxRssBytes).toBeGreaterThan(0);
  });

  it('memory mode refuses to generate a synthetic fixture in the measured process', async () => {
    const out = await runJob(
      [
        '--expose-gc',
        worker,
        '--impl',
        'papaparse',
        '--case',
        'B1-simple-1MiB',
        '--mode',
        'memory',
      ],
      guards,
    );
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('needs --input-file') as unknown,
    });
  });
});

describe('peak resident memory', () => {
  const status = (hwm: string) =>
    ['Name:\tnode', 'VmPeak:\t 1000 kB', hwm, 'VmRSS:\t   50 kB', 'Threads:\t7'].join('\n');

  it('reads Linux VmHWM in bytes (the kernel kB is KiB)', () => {
    expect(parseVmHwmBytes(status('VmHWM:\t   45772 kB'))).toBe(45772 * 1024);
  });

  it.each([
    ['missing', 'VmLck:\t 0 kB'],
    ['another unit', 'VmHWM:\t 45 MB'],
    ['not a number', 'VmHWM:\t abc kB'],
    ['zero', 'VmHWM:\t 0 kB'],
    ['negative', 'VmHWM:\t -5 kB'],
    ['beyond safe integers', 'VmHWM:\t 99999999999999999999 kB'],
  ])('rejects a %s value instead of substituting one', (_name, line) => {
    expect(() => parseVmHwmBytes(status(line))).toThrow(/VmHWM/);
  });

  it('names the method for this platform and returns a positive byte count', () => {
    expect(PEAK_RSS_METHOD).toBe(
      process.platform === 'linux' ? 'linux-proc-self-status-VmHWM' : 'getrusage-maxRSS',
    );
    expect(Number.isSafeInteger(peakRssBytes()) && peakRssBytes() > 0).toBe(true);
  });
});
