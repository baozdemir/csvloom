import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FAMILIES, familyFormat, generateFixture, mulberry32 } from '../bench/fixtures.ts';
import { readManifest } from '../bench/manifest.ts';
import type { ParseConfig } from '../src/types.ts';
import { DIALECTS, OVERLAYS, records, soup } from './differential.ts';
import { byteSplits, checkStream, collect, splits, streamDifference } from './stream-split.ts';

// parseStream equals bulk parse through the public API (rules (a)-(d) of test/stream-split.ts), for
// string and byte chunks cut everywhere, through every source kind.

const SEED = 20261119;
const PER_DIALECT = 56;
const BATCH_SIZES = [1, 2, 3, 1024];

const encoder = new TextEncoder();
/** T of test/stream-split.ts for byte input: the bytes as UTF-8, a BOM left for the parser. */
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

interface Case {
  input: string;
  config: ParseConfig;
  overlays: readonly number[];
}

/** The fuzz of test/differential.ts as it draws: 0 to 3 of all OVERLAYS per pair, one soup and one record input. */
function drawn(seed: number, perDialect: number): Case[] {
  const random = mulberry32(seed);
  const list: Case[] = [];
  for (const dialect of DIALECTS) {
    for (let k = 0; k < perDialect; k++) {
      const overlays: number[] = [];
      let config: ParseConfig = { ...dialect };
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const index = Math.floor(random() * OVERLAYS.length);
        const overlay = OVERLAYS[index] ?? {};
        overlays.push(index);
        config =
          typeof overlay === 'function'
            ? overlay(config, dialect, random)
            : { ...config, ...overlay };
      }
      const given = config.delimiter;
      const delimiter = typeof given === 'string' && given !== '' ? given : dialect.delimiter;
      const newline = config.newline || dialect.newline;
      for (const input of [soup(random), records(random, delimiter, newline, config.quoteChar)]) {
        list.push({ input, config, overlays });
      }
    }
  }
  return list;
}

/** What the equality test covered; computed once and pinned, so that a change of coverage shows. */
const EXPECTED_COVERAGE = {
  inputs: 2016,
  runs: 1_119_764,
  throwing: 43,
  early: 0,
  s2: 0,
  pairs: 1078,
  boms: 49,
  multiByte: 1614,
  lone: 135,
};

describe(`parseStream equals bulk at every split, through every source kind (seed ${String(SEED)})`, () => {
  const CASES = drawn(SEED, PER_DIALECT);

  it('draws at least 2,000 inputs from all of OVERLAYS and DIALECTS', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(2000);
    const used = new Set(CASES.flatMap((c) => c.overlays));
    expect([...used].sort((a, b) => a - b)).toStrictEqual(OVERLAYS.map((_, index) => index));
  });

  it('string chunks at every split and UTF-8 bytes at every byte split, as an array, an async generator, a Node Readable and a ReadableStream: rules (a)-(d), callback calls and thrown messages', async () => {
    const random = mulberry32(SEED + 1);
    const failures: unknown[] = [];
    const coverage = {
      inputs: 0,
      runs: 0,
      throwing: 0,
      early: 0,
      s2: 0,
      /** Inputs with a surrogate pair, which the string splits cut between its two units. */
      pairs: 0,
      /** Inputs that start with a BOM, which the byte splits cut inside. */
      boms: 0,
      /** Inputs with a multi-byte UTF-8 sequence, which the byte splits cut inside. */
      multiByte: 0,
      /** Inputs with a lone surrogate (records() slices soup): byte runs are checked against their own T. */
      lone: 0,
    };
    for (const { input, config } of CASES) {
      const batchSize = BATCH_SIZES[Math.floor(random() * BATCH_SIZES.length)] ?? 1;
      const bytes = encoder.encode(input);
      const decoded = decode(bytes);
      const stringRuns = [[input], ...splits(input, random, 5)];
      const byteRuns = [[bytes], ...byteSplits(bytes, random, 5)];
      const groups: Array<[string, ReadonlyArray<ReadonlyArray<string | Uint8Array>>]> =
        decoded === input
          ? [[input, [...stringRuns, ...byteRuns]]]
          : [
              [input, stringRuns],
              [decoded, byteRuns],
            ];
      coverage.inputs++;
      if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(input)) coverage.pairs++;
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) coverage.boms++;
      if (bytes.some((byte) => byte >= 0x80)) coverage.multiByte++;
      if (decoded !== input) coverage.lone++;
      for (const [text, runs] of groups) {
        const check = await checkStream(text, config, batchSize, runs);
        coverage.runs += check.splits;
        coverage.early += check.early;
        if (check.throwing) coverage.throwing++;
        if (check.s2) coverage.s2++;
        if (check.failure !== null && failures.length < 5) {
          failures.push({ ...check.failure, text, config, batchSize });
        }
      }
    }
    expect(failures).toStrictEqual([]);
    expect(coverage).toStrictEqual(EXPECTED_COVERAGE);
  }, 1_800_000);
});

const MANIFEST = readManifest();
const MIB = 1_048_576;
const SIZES = [1, 2, 3, 64, 4096, 65_536];

/** `bytes` in pieces of `sizes` (the last repeated), as a sync iterable that makes each piece when read. */
function* pieces(bytes: Uint8Array, sizes: readonly number[]) {
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[Math.min(i, sizes.length - 1)] ?? 1;
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

/** Piece lengths from 1 to 65,536 bytes, about evenly spread over their powers of two, that cover `length`. */
function randomSizes(length: number, random: () => number): number[] {
  const sizes: number[] = [];
  for (let total = 0; total < length;) {
    const size = 1 + Math.floor(random() * 2 ** Math.floor(random() * 17));
    sizes.push(size);
    total += size;
  }
  return sizes;
}

describe('each benchmark family’s 1 MiB fixture as byte chunks equals bulk', () => {
  it.each(FAMILIES.flatMap((family) => [false, true].map((header) => [family, header] as const)))(
    '%s, header %s: chunks of 1, 2, 3, 64, 4096 and 65,536 bytes and 20 seeded random splittings',
    async (family, header) => {
      const { csv } = generateFixture({
        family,
        seed: MANIFEST.families[family].seed,
        targetBytes: MIB,
      });
      const { dialect } = familyFormat(family);
      const config = { delimiter: dialect.delimiter, newline: dialect.newline, header };
      const bytes = encoder.encode(csv);
      expect(bytes.length).toBeGreaterThanOrEqual(MIB);
      const random = mulberry32(SEED + FAMILIES.indexOf(family));
      const sizings = [
        ...SIZES.map((size) => [size]),
        ...Array.from({ length: 20 }, () => randomSizes(bytes.length, random)),
      ];
      let first: unknown;
      for (const sizes of sizings) {
        const { batches, thrown } = await collect(pieces(bytes, sizes), config);
        expect([sizes[0], thrown]).toStrictEqual([sizes[0], undefined]);
        expect(streamDifference(batches, csv, config, 1024)).toBeNull();
        first ??= batches;
        expect(isDeepStrictEqual(batches, first)).toBe(true);
      }
    },
    600_000,
  );
});
