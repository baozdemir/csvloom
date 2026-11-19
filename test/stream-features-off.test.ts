import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchBuilder } from '../src/batches.ts';
import * as detectModule from '../src/detect.ts';
import * as locateModule from '../src/locate.ts';
import { resolveDetailedConfig, resolveParseConfig } from '../src/options.ts';
import * as parserModule from '../src/parser.ts';
import * as repairModule from '../src/repair.ts';
import * as schemaModule from '../src/schema.ts';
import { parseStream } from '../src/stream.ts';
import type { ParseConfig, StandardSchemaV1, StreamConfig } from '../src/types.ts';
import { fuzz } from './differential.ts';
import { PARSE_FIXTURES } from './fixtures/groups.ts';
import { drawn } from './stream-split.ts';

// "Off means off": without a feature key, parseStream and the BatchBuilder make no call into the
// four feature modules. In a file of its own, because every export of the four modules is a spy
// here, which records each call.

vi.mock(import('../src/detect.ts'), { spy: true });
vi.mock(import('../src/locate.ts'), { spy: true });
vi.mock(import('../src/repair.ts'), { spy: true });
vi.mock(import('../src/schema.ts'), { spy: true });
// Counted only: the scanner is not a feature module.
vi.mock(import('../src/parser.ts'), { spy: true });

beforeEach(() => {
  vi.clearAllMocks();
});

const spies = () =>
  [detectModule, locateModule, repairModule, schemaModule]
    .flatMap((module) => Object.values(module) as unknown[])
    .filter((value) => vi.isMockFunction(value));
const calls = () => spies().reduce((sum, spy) => sum + spy.mock.calls.length, 0);

const passThrough: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

async function run(chunks: readonly string[], config: StreamConfig): Promise<number> {
  let batches = 0;
  try {
    for await (const batch of parseStream(chunks, config))
      batches += batch.data.length >= 0 ? 1 : 0;
  } catch {
    // An input that bulk rejects too.
  }
  return batches;
}

describe('linear work after a "sep=" line', () => {
  it('a quoted field with 2,000 line breaks, one chunk each: as many scanRows calls as with the delimiter given, not one per line break', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i)}\n`);
    const body = ['id;note\n1;"a\n', ...lines, 'z"\n2;x\n'];
    const scans = async (chunks: readonly string[], config: StreamConfig) => {
      vi.clearAllMocks();
      const rows: unknown[] = [];
      for await (const batch of parseStream(chunks, config)) rows.push(...batch.data);
      return { rows, calls: vi.mocked(parserModule.scanRows).mock.calls.length };
    };
    const given = await scans(body, { delimiter: ';', newline: '\n' });
    const named = await scans(['sep=;\n', ...body], { sepLine: true, newline: '\n' });
    expect(named.rows).toStrictEqual(given.rows);
    // The header record, two records, and the empty record after the final line break.
    expect(given.rows.length).toBe(4);
    expect(given.calls).toBeLessThan(20);
    expect(named.calls).toBe(given.calls);
  });
});

describe('off means off: a stream without a feature key never reaches the feature modules', () => {
  it('the spies count the calls a stream with the five keys makes', async () => {
    // recordStarts, positionsAt, advance, formatError; repairRows, mixedNewline; isStandardSchema,
    // validateRow, validateRowSync, rowResult; sampleOf, sepLineDelimiter, detectDialect, detect.
    expect(spies().length).toBeGreaterThanOrEqual(14);
    await run(['a,b\n1\n'], {
      header: true,
      detect: true,
      positions: true,
      repair: true,
      sepLine: true,
      schema: passThrough,
    });
    expect(vi.mocked(detectModule.detectDialect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairModule.mixedNewline)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairModule.repairRows)).toHaveBeenCalledTimes(1);
    // One row: repair removed the empty record after the final line break.
    expect(vi.mocked(schemaModule.validateRow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(locateModule.positionsAt)).toHaveBeenCalled();
    expect(vi.mocked(locateModule.advance)).toHaveBeenCalled();
    vi.clearAllMocks();
    await run(['sep=;\na;b\n1\n'], { sepLine: true });
    expect(vi.mocked(detectModule.sepLineDelimiter)).toHaveBeenCalled();
  });

  it('parseStream over the grouped fixtures and 2,016 seeded fuzz inputs under every overlay, whole and one unit per chunk: zero calls', async () => {
    let batches = 0;
    let inputs = 0;
    const cases = [
      ...PARSE_FIXTURES.map(({ input, config }) => ({ input, config: config as ParseConfig })),
      ...drawn(20261115, 56),
    ];
    for (const { input, config } of cases) {
      let valid = true;
      try {
        resolveParseConfig(config, 'main');
      } catch {
        valid = false;
      }
      if (!valid || typeof input !== 'string') continue;
      inputs++;
      for (const batchSize of [1, 1024]) {
        batches += await run([input], { ...config, batchSize });
        batches += await run(Array.from(input), { ...config, batchSize });
      }
    }
    expect(inputs).toBeGreaterThanOrEqual(2016);
    expect(batches).toBeGreaterThan(4 * 2016);
    expect(calls()).toBe(0);
  }, 300_000);

  it('a key set to false, undefined or an empty rule list is off: zero calls beyond the config check', async () => {
    const off = { detect: false, positions: false, repair: [], sepLine: false, schema: undefined };
    expect(resolveDetailedConfig(off).features).toBeNull();
    vi.clearAllMocks();
    await run(['sep=;\na;b\n"x'], off);
    await run(['a,b\r1\n2,3\n'], { ...off, repair: false, header: true });
    expect(calls()).toBe(0);
  });

  it('the BatchBuilder itself: given options without features, zero calls', () => {
    const builder = new BatchBuilder(resolveParseConfig({ header: true }, 'main'), {
      batchSize: 1,
      maxRecordLength: 0,
    });
    builder.push('﻿a,b\n1\n"x');
    builder.end();
    let batches = 0;
    while (builder.take() !== undefined) batches++;
    expect(batches).toBe(2);
    expect(calls()).toBe(0);
  });

  it('the fuzz of test/differential.ts still passes, and parse makes no call either', () => {
    const summary = fuzz(0x5eed07, 50);
    expect(summary.failures).toStrictEqual([]);
    expect(calls()).toBe(0);
  }, 120_000);
});
