import { resolveParseConfig } from '../src/options.ts';
import { BatchBuilder } from '../src/batches.ts';

// Linearity GUARD for a record that spans many chunks: one record with an 8 MiB quoted field goes through a
// BatchBuilder in 1 KiB and in 64 KiB pieces. A carry that is rescanned or
// rejoined per piece would make the small pieces about 64 times slower; linear
// work keeps the ratio near 1. Prints both medians of five runs and their
// ratio, and exits non-zero when the ratio is 8 or more. It is a coarse guard
// against a mistake, not a measurement.
// Usage: node bench/stream-linear.ts

const FIELD = 8 * 1024 * 1024;
const RUNS = 5;
const LIMIT = 8;
const TEXT = `id,"${'x'.repeat(FIELD)}"\n`;

function time(size: number): number {
  const pieces: string[] = [];
  for (let at = 0; at < TEXT.length; at += size) pieces.push(TEXT.slice(at, at + size));
  const builder = new BatchBuilder(resolveParseConfig({ delimiter: ',', newline: '\n' }, 'main'), {
    batchSize: 1024,
    maxRecordLength: 0,
  });
  let rows = 0;
  let units = 0;
  const take = () => {
    for (let batch = builder.take(); batch !== undefined; batch = builder.take()) {
      rows += batch.data.length;
      for (const row of batch.data as string[][]) for (const field of row) units += field.length;
    }
  };
  const start = performance.now();
  for (const piece of pieces) {
    builder.push(piece);
    take();
  }
  builder.end();
  take();
  const elapsed = performance.now() - start;
  // The record and the [''] after its line break.
  if (rows !== 2 || units !== 2 + FIELD) throw new Error('stream-linear: wrong result');
  return elapsed;
}

function median(size: number): number {
  const times = Array.from({ length: RUNS }, () => time(size)).sort((a, b) => a - b);
  return times[(RUNS - 1) / 2] ?? NaN;
}

const small = median(1024);
const large = median(65_536);
const ratio = small / large;
const ok = ratio < LIMIT;
process.stdout.write(
  `GUARD stream-linear (not a measurement): node ${process.version}, one record with an ` +
    `${String(FIELD)}-unit quoted field, median of ${String(RUNS)} runs\n` +
    `1 KiB pieces: ${small.toFixed(1)} ms\n64 KiB pieces: ${large.toFixed(1)} ms\n` +
    `ratio: ${ratio.toFixed(2)} (limit ${String(LIMIT)}): ${ok ? 'PASS' : 'FAIL'}\n`,
);
if (!ok) process.exitCode = 1;
