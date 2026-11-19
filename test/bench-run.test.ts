import { getEventListeners } from 'node:events';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scratchDir } from './scratch.ts';
import { readManifest } from '../bench/manifest.ts';
import {
  directoryBytes,
  guardBreach,
  jsonlCheckpoint,
  MAX_WORKER_STDOUT_BYTES,
  runJob,
  runShard,
  sourceIdentity,
  writeEnd,
  type Guards,
  type JobOutcome,
} from '../bench/run.ts';

// Budget, deadline and checkpoint behavior with tiny limits and trivial child
// processes. Nothing here allocates near the real limits or fills the disk.

const MiB = 1024 ** 2;

function guards(overrides: Partial<Guards> = {}): Guards {
  return {
    deadlineAt: Date.now() + 60_000,
    rssLimitBytes: 2048 * MiB,
    rssPollMs: 20,
    diskFloorBytes: 0,
    tempCapBytes: Infinity,
    freeDiskBytes: () => 100 * MiB,
    tempUsageBytes: () => 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('guardBreach', () => {
  it('reports cancellation, deadline, disk floor and temp cap in that order', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(guardBreach(guards({ signal: aborted.signal, deadlineAt: 0 }))).toBe('cancelled');
    expect(guardBreach(guards({ deadlineAt: 0 }))).toBe('deadline');
    expect(guardBreach(guards({ diskFloorBytes: 200 * MiB }))).toBe('disk-floor');
    expect(guardBreach(guards({ tempCapBytes: 1, tempUsageBytes: () => 2 }))).toBe('temp-cap');
    expect(guardBreach(guards())).toBeNull();
  });
});

describe('runJob with trivial child processes', () => {
  it('returns the last stdout line as JSON', async () => {
    const out = await runJob(
      ['-e', 'console.log("noise"); console.log(JSON.stringify({ ok: 1 }))'],
      guards(),
    );
    expect(out).toMatchObject({ status: 'ok', record: { ok: 1 } });
  });

  it('reports a failing child as an error with its stderr', async () => {
    const out = await runJob(['-e', 'console.error("boom"); process.exit(3)'], guards());
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('boom') as unknown,
    });
  });

  it('kills a child at the shard deadline', async () => {
    const start = Date.now();
    const out = await runJob(
      ['-e', 'setTimeout(() => {}, 30000)'],
      guards({ deadlineAt: Date.now() + 300 }),
    );
    expect(out.status).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('kills a child whose polled RSS exceeds the budget', async () => {
    const out = await runJob(
      ['-e', 'globalThis.keep = Buffer.alloc(80 * 1024 * 1024, 1); setTimeout(() => {}, 30000)'],
      guards({ rssLimitBytes: 40 * MiB }),
    );
    expect(out.status).toBe('memory-limit');
    expect(out.peakPolledRssBytes).toBeGreaterThan(40 * MiB);
  });

  it('kills a child when the shard is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 200);
    const out = await runJob(
      ['-e', 'setTimeout(() => {}, 30000)'],
      guards({ signal: controller.signal }),
    );
    expect(out.status).toBe('cancelled');
  });
});

describe('runJob protocol failures settle as structured outcomes', () => {
  it('invalid JSON on the result line', async () => {
    const out = await runJob(['-e', 'console.log("not-json")'], guards());
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('protocol: invalid JSON') as unknown,
    });
  });

  it('no result line', async () => {
    const out = await runJob(['-e', ''], guards());
    expect(out).toMatchObject({
      status: 'error',
      detail: 'protocol: worker printed no result line',
    });
  });

  it('a result line that is not a JSON object', async () => {
    const out = await runJob(['-e', 'console.log("[1,2]")'], guards());
    expect(out).toMatchObject({
      status: 'error',
      detail: 'protocol: result line is not a JSON object',
    });
  });

  it('a spawn failure', async () => {
    const out = await runJob([], guards(), '/nonexistent/csv-engine-worker');
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('spawn failed') as unknown,
    });
  });

  it('every completion path settles once and removes its abort listener', async () => {
    const cases: Array<[string[], Partial<Guards>, string?]> = [
      [['-e', 'console.log(JSON.stringify({ ok: 1 }))'], {}],
      [['-e', 'console.log("not-json")'], {}],
      [[], {}, '/nonexistent/csv-engine-worker'],
      [['-e', 'setTimeout(() => {}, 30000)'], { deadlineAt: Date.now() + 200 }],
    ];
    for (const [argv, overrides, command] of cases) {
      const controller = new AbortController();
      const out = await runJob(argv, guards({ ...overrides, signal: controller.signal }), command);
      expect(out.status).toBeDefined();
      // Late child events (for example 'close' after 'error') must not re-settle.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('stdout overflow is a protocol failure, never a truncated result', async () => {
    const bytes = MAX_WORKER_STDOUT_BYTES + 1024;
    const out = await runJob(
      ['-e', `process.stdout.write('x'.repeat(${String(bytes)}) + '\\n{"ok":1}\\n')`],
      guards(),
    );
    expect(out).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('stdout exceeded') as unknown,
    });
  });
});

describe('runShard checkpointing', () => {
  const manifest = readManifest();
  const caseIds = ['B1-simple-1KiB', 'B1-ext-geonames-cities1000'];
  const cases = manifest.cases.filter((c) => caseIds.includes(c.id));
  const pairs = [
    { impl: 'papaparse', case: 'B1-simple-1KiB', expect: 'measure' as const },
    { impl: 'no-such-adapter', case: 'B1-simple-1KiB', expect: 'measure' as const },
    {
      impl: 'but-csv',
      case: 'B1-ext-geonames-cities1000',
      expect: 'unsupported' as const,
      reason: 'declared',
    },
  ];

  function context(spawnWorker: (argv: string[], g: Guards) => Promise<JobOutcome>, g = guards()) {
    const file = join(scratchDir('shard'), 'shard.jsonl');
    return {
      file,
      ctx: {
        manifest,
        cases,
        pairs,
        timingArgs: [],
        repetitions: 2,
        memory: false,
        coldStart: false,
        fixtureDir: join(file, '..', 'fixtures'),
        guards: g,
        checkpoint: jsonlCheckpoint(file),
        spawnWorker,
      },
    };
  }
  const lines = (file: string) =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const ok = (record: Record<string, unknown>): JobOutcome => ({
    status: 'ok',
    record,
    wallMs: 1,
    peakPolledRssBytes: 1,
  });

  it('records declared unsupported and unavailable pairs without spawning, and times only passing pairs', async () => {
    const spawned: string[][] = [];
    const { file, ctx } = context((argv) => {
      spawned.push(argv);
      const mode = argv[argv.indexOf('--mode') + 1];
      return Promise.resolve(ok(mode === 'check' ? { status: 'PASS' } : { samplesMs: [1, 1, 1] }));
    });
    expect(await runShard(ctx)).toBe('complete');
    const records = lines(file);
    expect(records.filter((r) => r.type === 'check').map((r) => [r.impl, r.status])).toStrictEqual([
      ['papaparse', 'PASS'],
      ['no-such-adapter', 'UNAVAILABLE'],
      ['but-csv', 'UNSUPPORTED'],
    ]);
    expect(records.filter((r) => r.type === 'time').map((r) => [r.impl, r.rep])).toStrictEqual([
      ['papaparse', 1],
      ['papaparse', 2],
    ]);
    expect(spawned).toHaveLength(3);
  });

  it('records a crashed worker as BLOCKED and continues', async () => {
    const { file, ctx } = context(() =>
      Promise.resolve({ status: 'error', detail: 'segfault', wallMs: 1, peakPolledRssBytes: 1 }),
    );
    expect(await runShard(ctx)).toBe('complete');
    expect(lines(file)[0]).toMatchObject({
      type: 'check',
      impl: 'papaparse',
      status: 'BLOCKED',
      blocked: 'error',
    });
  });

  it('stops and checkpoints on a timeout, memory limit or cancellation', async () => {
    for (const [status, end] of [
      ['timeout', 'deadline'],
      ['memory-limit', 'memory-limit'],
      ['cancelled', 'cancelled'],
    ] as const) {
      const { file, ctx } = context(() =>
        Promise.resolve({ status, detail: '', wallMs: 1, peakPolledRssBytes: 1 }),
      );
      expect(await runShard(ctx)).toBe(end);
      expect(lines(file)).toHaveLength(1);
      expect(lines(file)[0]).toMatchObject({ status: 'BLOCKED', blocked: status });
    }
  });

  it('checkpoints a rejected spawn as BLOCKED and continues', async () => {
    let calls = 0;
    const { file, ctx } = context(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('fork failed'))
        : Promise.resolve(ok({ status: 'PASS' }));
    });
    expect(await runShard({ ...ctx, repetitions: 0 })).toBe('complete');
    expect(lines(file)[0]).toMatchObject({
      type: 'check',
      status: 'BLOCKED',
      blocked: 'error',
      detail: expect.stringContaining('orchestration: Error: fork failed') as unknown,
    });
  });

  it('records deferred candidate lanes without spawning and runs the candidate cold start', async () => {
    const spawned: string[][] = [];
    const s1 = manifest.cases.filter((c) => c.id === 'S1-simple-1MiB');
    const { file, ctx } = context((argv) => {
      spawned.push(argv);
      return Promise.resolve(ok({ firstParseMs: 1 }));
    });
    const status = await runShard({
      ...ctx,
      cases: s1,
      pairs: [
        {
          impl: 'csv-engine',
          case: 'S1-simple-1MiB',
          expect: 'deferred',
          reason: 'no candidate adapter in this lane',
        },
      ],
      repetitions: 0,
      coldStart: true,
    });
    expect(status).toBe('complete');
    const records = lines(file);
    expect(records[0]).toMatchObject({
      type: 'check',
      impl: 'csv-engine',
      status: 'DEFERRED',
      reason: 'no candidate adapter in this lane',
    });
    expect(records.find((r) => r.type === 'cold' && r.impl === 'csv-engine')).toMatchObject({
      firstParseMs: 1,
    });
    const candidateJobs = spawned.filter((argv) => argv.includes('csv-engine'));
    expect(candidateJobs.map((argv) => argv[argv.indexOf('--mode') + 1])).toStrictEqual(['cold']);
  });

  it('records a cold start without an adapter as UNAVAILABLE without spawning', async () => {
    const spawned: string[][] = [];
    const { file, ctx } = context((argv) => {
      spawned.push(argv);
      return Promise.resolve(ok({ firstParseMs: 1 }));
    });
    const status = await runShard({
      ...ctx,
      manifest: { ...manifest, candidate: 'no-such-adapter' },
      pairs: [],
      repetitions: 0,
      coldStart: true,
    });
    expect(status).toBe('complete');
    expect(lines(file).find((r) => r.impl === 'no-such-adapter')).toMatchObject({
      type: 'cold',
      status: 'UNAVAILABLE',
    });
    expect(spawned.every((argv) => !argv.includes('no-such-adapter'))).toBe(true);
  });

  it('does not start jobs past the deadline or below the disk floor', async () => {
    const never = () => Promise.reject(new Error('must not spawn'));
    expect(await runShard(context(never, guards({ deadlineAt: 0 })).ctx)).toBe('deadline');
    expect(await runShard(context(never, guards({ diskFloorBytes: 200 * MiB })).ctx)).toBe(
      'disk-floor',
    );
  });

  it('refuses to write a memory fixture that would cross the temp cap', async () => {
    const memoryCase = manifest.cases.filter((c) => c.id === 'B1-simple-1MiB');
    const { file, ctx } = context(
      () => Promise.resolve(ok({ status: 'PASS' })),
      guards({ tempCapBytes: 1.5 * MiB, tempUsageBytes: () => MiB }),
    );
    const status = await runShard({
      ...ctx,
      cases: memoryCase,
      pairs: [{ impl: 'papaparse', case: 'B1-simple-1MiB', expect: 'measure' }],
      repetitions: 0,
      memory: true,
    });
    expect(status).toBe('temp-cap');
    expect(directoryBytes(ctx.fixtureDir)).toBe(0);
    expect(lines(file).map((r) => r.type)).toStrictEqual(['check']);
  });
});

describe('writeEnd', () => {
  it('reports a failed evidence write instead of throwing or pretending', () => {
    expect(writeEnd(() => undefined, { status: 'complete' })).toStrictEqual({ ok: true });
    const failed = writeEnd(
      () => {
        throw new Error('EACCES');
      },
      { status: 'complete' },
    );
    expect(failed).toMatchObject({
      ok: false,
      error: expect.stringContaining('EACCES') as unknown,
    });
  });
});

describe('accounting helpers', () => {
  it('directoryBytes counts every file under a directory, including existing ones', () => {
    const dir = scratchDir('bytes');
    writeFileSync(join(dir, 'a'), 'x'.repeat(10));
    writeFileSync(join(dir, 'b'), 'x'.repeat(5));
    expect(directoryBytes(dir)).toBe(15);
    expect(directoryBytes(join(dir, 'missing'))).toBe(0);
  });

  it('directoryBytes counts as du does: symbolic links not followed, hard links once', () => {
    const dir = scratchDir('bytes-links');
    const outside = scratchDir('bytes-links-target');
    writeFileSync(join(outside, 'big'), 'x'.repeat(1000));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a'), 'x'.repeat(10));
    linkSync(join(dir, 'sub', 'a'), join(dir, 'a-again'));
    symlinkSync(outside, join(dir, 'linked'));
    expect(directoryBytes(dir)).toBe(10);
  });

  it('sourceIdentity is deterministic for an unchanged tree', () => {
    const a = sourceIdentity();
    expect(a.files).toBeGreaterThan(10);
    expect(sourceIdentity()).toStrictEqual(a);
  });
});
