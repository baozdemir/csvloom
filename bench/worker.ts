import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAdapter } from './adapters/index.ts';
import { familyFormat, generateFixture } from './fixtures.ts';
import {
  BULK_IMPL,
  bulkAdapter,
  candidateAdapter,
  consumeRecord,
  consumeRecords,
  consumeRows,
  consumeText,
  firstMismatch,
  toRecords,
  UnsupportedDialectError,
  type Adapter,
  type AdapterOptions,
  type CandidateParse,
  type CandidateParseStream,
  type CandidateUnparse,
  type Dialect,
  type Lane,
  type RecordRow,
  type Row,
} from './lanes.ts';
import {
  armsOf,
  readManifest,
  readManifestV2,
  type CaseSpec,
  type Manifest,
  type Measurement,
} from './manifest.ts';

// Runs one implementation on one case in this process and prints one JSON line.
// Modes: check (full correctness), time (warmed samples), memory (OS peak RSS,
// separate process), cold (startup, import, fixture setup and first parse, each
// reported separately). With --method v2 the measurement settings come from
// manifest-v2.json, the candidate is loaded from a built bundle (--load entry
// --entry <file>), every record states where and how the process ran, and the
// empty mode reports a process that loaded the harness and nothing else.

/** Process start (performance time origin) until this module ran: Node bootstrap plus loading the harness. */
const workerReadyMs = performance.now();

export interface Input {
  csv: string;
  dialect: Dialect;
  sha256: string;
  /** Header used to consume records; null when the case has no header semantics. */
  header: Row | null;
  /** Generator ground truth; null for external datasets and cached inputs. */
  rows: Row[] | null;
  /** W1: what the writer is given, made from the fixture outside any timed region (w1Input). */
  w1?: W1Input;
}

export interface W1Input {
  data: readonly Row[] | readonly RecordRow[];
  /** The column order of records; null for rows (their header row comes first). */
  header: readonly string[] | null;
}

/**
 * The W1 input: the fixture parsed once by the reference (Papa Parse) into rows
 * (B1) or records (B2), so every writer gets the same values.
 */
export async function w1Input(spec: CaseSpec, input: Input, reference: string): Promise<W1Input> {
  const papa = await loadAdapter(reference);
  const parse = spec.shape === 'records' ? papa.B2 : papa.B1;
  if (!parse) throw new Error(`${reference} cannot make the W1 input`);
  return {
    data: await parse(input.csv, input.dialect, {}),
    header: spec.shape === 'records' ? (input.header ?? []) : null,
  };
}

const requireW1 = (input: Input): W1Input => {
  if (!input.w1) throw new Error('W1 case without its input (w1Input)');
  return input.w1;
};

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/**
 * Synthetic cases are regenerated unless inputFile points at a cached copy. An
 * external dataset is read from inputFile when given (method v2 runs workers from
 * checkout copies that do not hold the datasets), else from its manifest path.
 */
export function loadInput(spec: CaseSpec, manifest: Manifest, inputFile?: string): Input {
  if (spec.external) {
    const bytes = readFileSync(
      inputFile ?? fileURLToPath(new URL(`../${spec.external.path}`, import.meta.url)),
    );
    return {
      csv: bytes.toString('utf8'),
      dialect: spec.external.dialect,
      sha256: sha256(bytes),
      header: null,
      rows: null,
    };
  }
  const { family, targetBytes } = spec;
  if (!family || !targetBytes) throw new Error(`Case ${spec.id} has no fixture source`);
  const { header, dialect } = familyFormat(family);
  if (inputFile) {
    const bytes = readFileSync(inputFile);
    return { csv: bytes.toString('utf8'), dialect, sha256: sha256(bytes), header, rows: null };
  }
  const fixture = generateFixture({ family, seed: manifest.families[family].seed, targetBytes });
  return { csv: fixture.csv, dialect, sha256: fixture.sha256, header, rows: fixture.rows };
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return chunks;
}

// eslint-disable-next-line @typescript-eslint/require-await -- an in-memory async source has nothing to await
async function* replay(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

export type Op = () => number | Promise<number>;

/** One timed operation: run the lane and fully consume its output, keeping nothing. */
export function operation(
  adapter: Adapter,
  lane: Lane,
  input: Input,
  s1ChunkBytes: number,
  options: AdapterOptions = {},
): Op {
  const { csv, dialect } = input;
  const header = input.header ?? [];
  if (lane === 'B1' && adapter.B1) {
    const run = adapter.B1;
    return () => {
      const out = run(csv, dialect, options);
      return out instanceof Promise ? out.then(consumeRows) : consumeRows(out);
    };
  }
  if (lane === 'B2' && adapter.B2) {
    const run = adapter.B2;
    return () => {
      const out = run(csv, dialect, options);
      return out instanceof Promise
        ? out.then((records) => consumeRecords(records, header))
        : consumeRecords(out, header);
    };
  }
  if (lane === 'W1' && adapter.W1) {
    const run = adapter.W1;
    const { data, header: columns } = requireW1(input);
    return () => {
      const out = run(data, columns, dialect, options);
      return out instanceof Promise ? out.then(consumeText) : consumeText(out);
    };
  }
  if (lane === 'S1' && adapter.S1) {
    const run = adapter.S1;
    const chunks = chunked(Buffer.from(csv, 'utf8'), s1ChunkBytes);
    return async () => {
      let total = 0;
      await run(
        replay(chunks),
        dialect,
        (record) => (total += consumeRecord(record, header)),
        options,
      );
      return total;
    };
  }
  throw new Error(`${adapter.package} adapter does not support ${lane}`);
}

/**
 * Memory variant: bulk lanes return their full output so the caller can keep it
 * alive until the peak is read; S1 stays incremental and retains nothing.
 */
export function memoryOperation(
  adapter: Adapter,
  lane: Lane,
  input: Input,
  s1ChunkBytes: number,
  options: AdapterOptions = {},
): () => Promise<{ retained: readonly unknown[] | null; consumed: number }> {
  const { csv, dialect } = input;
  const header = input.header ?? [];
  if (lane === 'B1' && adapter.B1) {
    const run = adapter.B1;
    return async () => {
      const out = await run(csv, dialect, options);
      return { retained: out, consumed: consumeRows(out) };
    };
  }
  if (lane === 'B2' && adapter.B2) {
    const run = adapter.B2;
    return async () => {
      const out = await run(csv, dialect, options);
      return { retained: out, consumed: consumeRecords(out, header) };
    };
  }
  if (lane === 'W1' && adapter.W1) {
    const run = adapter.W1;
    const { data, header: columns } = requireW1(input);
    return async () => {
      const out = await run(data, columns, dialect, options);
      return { retained: [out], consumed: consumeText(out) };
    };
  }
  const op = operation(adapter, lane, input, s1ChunkBytes, options);
  return async () => ({ retained: null, consumed: await op() });
}

export async function collect(
  adapter: Adapter,
  lane: Lane,
  input: Input,
  s1ChunkBytes: number,
  options: AdapterOptions = {},
): Promise<unknown[]> {
  const { csv, dialect } = input;
  if (lane === 'B1' && adapter.B1) return adapter.B1(csv, dialect, options);
  if (lane === 'B2' && adapter.B2) return adapter.B2(csv, dialect, options);
  if (lane === 'S1' && adapter.S1) {
    const records: RecordRow[] = [];
    await adapter.S1(
      replay(chunked(Buffer.from(csv, 'utf8'), s1ChunkBytes)),
      dialect,
      (record) => records.push(record),
      options,
    );
    return records;
  }
  throw new Error(`${adapter.package} adapter does not support ${lane}`);
}

export type CheckResult =
  | {
      status: 'PASS';
      outputLength: number;
      oracle: 'generator' | 'consensus';
      /** W1: UTF-8 bytes of the written CSV. */
      outputBytes?: number;
    }
  | {
      status: 'FAIL';
      oracle: 'generator' | 'consensus';
      error?: string;
      mismatch?: unknown;
      outputBytes?: number;
    }
  | { status: 'NO-ORACLE'; detail: unknown }
  | { status: 'UNSUPPORTED'; reason: string };

const optionsFor = (spec: CaseSpec, impl: string): AdapterOptions =>
  spec.adapterOptions?.[impl] ?? {};

async function expectedOutput(spec: CaseSpec, input: Input, manifest: Manifest) {
  if (input.rows) {
    return {
      oracle: 'generator' as const,
      rows: spec.lane === 'B1' ? input.rows : toRecords(input.rows),
    };
  }
  // External data has no ground truth: the consensus implementations must agree exactly.
  const outputs: unknown[][] = [];
  for (const id of manifest.consensus) {
    const adapter = await loadAdapter(id);
    outputs.push(
      await collect(
        adapter,
        spec.lane,
        input,
        manifest.measurement.s1ChunkBytes,
        optionsFor(spec, id),
      ),
    );
  }
  const [first = [], ...rest] = outputs;
  for (const [i, other] of rest.entries()) {
    const mismatch = firstMismatch(other, first, spec.lane);
    if (mismatch) {
      return {
        disagreement: { between: [manifest.consensus[0], manifest.consensus[i + 1]], mismatch },
      };
    }
  }
  return { oracle: 'consensus' as const, rows: first };
}

/** Values longer than this are cut in a FAIL record (a long-field cell reaches 64 KiB). */
const CELL_SHOWN = 200;
const shown = (value: unknown) =>
  typeof value === 'string' && value.length > CELL_SHOWN
    ? `${value.slice(0, CELL_SHOWN)}... (${String(value.length)} units)`
    : (value ?? null);

/** The first differing cell of a W1 read-back: row and column, both values shortened. */
function firstDifferingCell(actual: readonly Row[], expected: readonly Row[]) {
  const m = firstMismatch(actual, expected, 'B1');
  if (!m) return null;
  if (m.reason !== 'value') {
    return { reason: m.reason, row: m.index, expected: shown(m.expected), actual: shown(m.actual) };
  }
  const want = m.expected as Row;
  const got = m.actual as Row;
  let column = 0;
  while (column < Math.max(want.length, got.length) && want[column] === got[column]) column++;
  return {
    reason: column < Math.min(want.length, got.length) ? 'value' : 'fields',
    row: m.index,
    column,
    expected: shown(want[column]),
    actual: shown(got[column]),
    expectedFields: want.length,
    actualFields: got.length,
  };
}

const toRows = (data: readonly Row[] | readonly RecordRow[], header: readonly string[]) =>
  (data as readonly RecordRow[]).map((record) => header.map((key) => record[key] ?? ''));

/**
 * W1 correctness, outside any timed region: the writer's output is read back by
 * the reference in the fixture's dialect and must equal the fixture's rows (header
 * row first) cell for cell. Output bytes are recorded; byte equality is not asked,
 * since quoting policies differ.
 */
async function checkW1(
  adapter: Adapter,
  spec: CaseSpec,
  input: Input,
  manifest: Manifest,
  options: AdapterOptions,
): Promise<CheckResult> {
  if (!adapter.W1)
    return { status: 'UNSUPPORTED', reason: `${adapter.package} has no W1 function` };
  const { data, header } = requireW1(input);
  const papa = await loadAdapter(manifest.reference);
  if (!papa.B1) throw new Error(`${manifest.reference} has no B1 to read W1 output back`);
  const rows = input.rows ?? (header ? [[...header], ...toRows(data, header)] : (data as Row[]));
  // The input itself must equal the generator's rows, or every result below is moot.
  const made = header
    ? firstMismatch(data, toRecords(rows), 'B2')
    : firstMismatch(data, rows, 'B1');
  if (made)
    throw new Error(`${spec.id}: the W1 input differs from the fixture (${JSON.stringify(made)})`);
  let text: string;
  try {
    text = await adapter.W1(data, header, input.dialect, options);
  } catch (error) {
    if (error instanceof UnsupportedDialectError)
      return { status: 'UNSUPPORTED', reason: error.message };
    return { status: 'FAIL', oracle: 'generator', error: String(error) };
  }
  if (typeof text !== 'string')
    return { status: 'FAIL', oracle: 'generator', error: `output is ${typeof text}, not a string` };
  const outputBytes = Buffer.byteLength(text, 'utf8');
  // The reference's B1 already drops the record of a final line break (dropLineEndRecord).
  const back = await papa.B1(text, input.dialect, {});
  const cell = firstDifferingCell(back, rows);
  return cell
    ? { status: 'FAIL', oracle: 'generator', mismatch: cell, outputBytes }
    : { status: 'PASS', oracle: 'generator', outputLength: back.length, outputBytes };
}

export async function check(
  adapter: Adapter,
  spec: CaseSpec,
  input: Input,
  manifest: Manifest,
  options: AdapterOptions = {},
): Promise<CheckResult> {
  if (spec.lane === 'W1') return checkW1(adapter, spec, input, manifest, options);
  const expected = await expectedOutput(spec, input, manifest);
  if ('disagreement' in expected) return { status: 'NO-ORACLE', detail: expected.disagreement };
  const { oracle, rows } = expected;
  let actual: unknown[];
  try {
    actual = await collect(
      adapter,
      spec.lane,
      input,
      spec.chunkBytes ?? manifest.measurement.s1ChunkBytes,
      options,
    );
  } catch (error) {
    if (error instanceof UnsupportedDialectError)
      return { status: 'UNSUPPORTED', reason: error.message };
    return { status: 'FAIL', oracle, error: String(error) };
  }
  const mismatch = firstMismatch(actual, rows, spec.lane);
  return mismatch
    ? { status: 'FAIL', oracle, mismatch }
    : { status: 'PASS', oracle, outputLength: actual.length };
}

const gc = (globalThis as { gc?: () => void }).gc;

interface Timing {
  loop: 'sync' | 'async';
  warmupOps: number;
  opsPerSample: number;
  /** Untimed operations run after each forced collection, before the sample. */
  rewarmOps: number;
  samplesMs: number[];
  /** Per-operation cost of the same loop around a no-op of the same kind. Not subtracted. */
  harnessNoopMsPerOp: number;
  sink: number;
}

function syncValue(value: number | Promise<number>): number {
  if (typeof value !== 'number')
    throw new Error('adapter returned a Promise after a synchronous result');
  return value;
}

function timeSync(op: Op, m: Measurement, first: number): Timing {
  let sink = first;
  let warmupOps = 1;
  const warmupStart = performance.now();
  while (warmupOps < m.minWarmupOps || performance.now() - warmupStart < m.warmupMs) {
    sink += syncValue(op());
    warmupOps++;
  }
  const warmupOpMs = (performance.now() - warmupStart) / warmupOps;
  const opsPerSample = m.opsPerSample ?? Math.max(1, Math.ceil(m.minSampleMs / warmupOpMs));
  const rewarmOps = m.rewarmOps ?? Math.floor((m.rewarmMs ?? 0) / warmupOpMs);
  const sample = (fn: Op) => {
    const start = performance.now();
    for (let i = 0; i < opsPerSample; i++) sink += syncValue(fn());
    return (performance.now() - start) / opsPerSample;
  };
  const samplesMs: number[] = [];
  // A forced full collection makes V8 drop the optimized code; the untimed operations let it come
  // back before the sample.
  for (let s = 0; s < m.samples; s++) {
    gc?.();
    for (let i = 0; i < rewarmOps; i++) sink += syncValue(op());
    samplesMs.push(sample(op));
  }
  return {
    loop: 'sync',
    warmupOps,
    opsPerSample,
    rewarmOps,
    samplesMs,
    harnessNoopMsPerOp: sample(() => 0),
    sink,
  };
}

async function timeAsync(op: Op, m: Measurement, first: Promise<number>): Promise<Timing> {
  let sink = await first;
  let warmupOps = 1;
  const warmupStart = performance.now();
  while (warmupOps < m.minWarmupOps || performance.now() - warmupStart < m.warmupMs) {
    sink += await op();
    warmupOps++;
  }
  const warmupOpMs = (performance.now() - warmupStart) / warmupOps;
  const opsPerSample = m.opsPerSample ?? Math.max(1, Math.ceil(m.minSampleMs / warmupOpMs));
  const rewarmOps = m.rewarmOps ?? Math.floor((m.rewarmMs ?? 0) / warmupOpMs);
  const sample = async (fn: Op) => {
    const start = performance.now();
    for (let i = 0; i < opsPerSample; i++) sink += await fn();
    return (performance.now() - start) / opsPerSample;
  };
  const samplesMs: number[] = [];
  for (let s = 0; s < m.samples; s++) {
    gc?.();
    for (let i = 0; i < rewarmOps; i++) sink += await op();
    samplesMs.push(await sample(op));
  }
  const harnessNoopMsPerOp = await sample(() => Promise.resolve(0));
  return { loop: 'async', warmupOps, opsPerSample, rewarmOps, samplesMs, harnessNoopMsPerOp, sink };
}

/**
 * Mean operation time over a warm-up of at least warmupMs and minWarmupOps operations. A method v2
 * check reports it, and the runner turns it into one operations-per-sample count for every process of
 * the pair, so that no process picks its own count near minSampleMs.
 */
export async function probeOpMs(op: Op, m: Measurement): Promise<number> {
  let ops = 0;
  const start = performance.now();
  while (ops < m.minWarmupOps || performance.now() - start < m.warmupMs) {
    const value = op();
    if (value instanceof Promise) await value;
    ops++;
  }
  return (performance.now() - start) / ops;
}

/** Synchronous adapters are timed in a plain loop, asynchronous ones in an awaiting loop. */
export async function time(op: Op, m: Measurement): Promise<Timing> {
  const first = op();
  return first instanceof Promise ? timeAsync(op, m, first) : timeSync(op, m, first);
}

/**
 * How this process's peak resident memory is read. On Linux, getrusage maxRSS
 * survives execve and so includes the parent's resident memory at spawn;
 * /proc/self/status VmHWM belongs to this
 * process image only. macOS keeps getrusage maxRSS. Both are OS-reported peak
 * resident memory in bytes, not allocation accounting.
 */
export const PEAK_RSS_METHOD =
  process.platform === 'linux' ? 'linux-proc-self-status-VmHWM' : 'getrusage-maxRSS';

/** VmHWM from /proc/<pid>/status text, in bytes (the kernel's "kB" is KiB). Throws if absent or invalid. */
export function parseVmHwmBytes(status: string): number {
  const match = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  const kib = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(kib) || kib <= 0) {
    throw new Error(`no valid VmHWM in /proc/self/status (${match?.[0] ?? 'missing'})`);
  }
  return kib * 1024;
}

/** This process's peak resident memory in bytes, by PEAK_RSS_METHOD. Throws rather than guess. */
export function peakRssBytes(): number {
  if (process.platform === 'linux')
    return parseVmHwmBytes(readFileSync('/proc/self/status', 'utf8'));
  const kib = process.resourceUsage().maxRSS;
  if (!Number.isSafeInteger(kib) || kib <= 0)
    throw new Error(`invalid getrusage maxRSS ${String(kib)}`);
  return kib * 1024;
}

/** OS high-water RSS before and after one operation; bulk output stays alive until both are read. */
export async function measureMemory(
  memoryOp: ReturnType<typeof memoryOperation>,
  readPeakRssBytes = peakRssBytes,
) {
  gc?.();
  const loadedInputPeakRssBytes = readPeakRssBytes();
  const { retained, consumed } = await memoryOp();
  const peakRssBytes = readPeakRssBytes();
  return {
    loadedInputPeakRssBytes,
    peakRssBytes,
    retainedRecords: retained?.length ?? 0,
    consumed,
  };
}

/**
 * Loads the candidate from a built bundle (method v2) and reports the file that
 * was actually imported, after symlink resolution, with the SHA-256 of its bytes.
 * An S1 process also imports the bundle's stream entry (`stream.js` beside it) and
 * reports it the same way; no other process does. The arm BULK_IMPL gets the bulk
 * S1 function instead, which needs only `parse`.
 */
export async function loadEntry(
  entry: string,
  lane: Lane = 'B1',
  impl = '',
): Promise<{
  adapter: Adapter;
  entry: string;
  entrySha256: string;
  stream: { entry: string; entrySha256: string } | null;
}> {
  const file = realpathSync(entry);
  const module = (await import(pathToFileURL(file).href)) as { parse?: unknown; unparse?: unknown };
  if (typeof module.parse !== 'function') throw new Error(`${file} exports no parse function`);
  const parse = module.parse as CandidateParse;
  if (impl === BULK_IMPL)
    return {
      adapter: bulkAdapter(parse),
      entry: file,
      entrySha256: sha256(readFileSync(file)),
      stream: null,
    };
  let parseStream: CandidateParseStream | undefined;
  let stream: { entry: string; entrySha256: string } | null = null;
  if (lane === 'S1') {
    const near = join(dirname(file), 'stream.js');
    if (!existsSync(near)) throw new Error(`${near} does not exist: S1 needs the stream entry`);
    const streamFile = realpathSync(near);
    const streamModule = (await import(pathToFileURL(streamFile).href)) as {
      parseStream?: unknown;
    };
    if (typeof streamModule.parseStream !== 'function')
      throw new Error(`${streamFile} exports no parseStream function`);
    parseStream = streamModule.parseStream as CandidateParseStream;
    stream = { entry: streamFile, entrySha256: sha256(readFileSync(streamFile)) };
  }
  return {
    adapter: candidateAdapter(
      parse,
      typeof module.unparse === 'function' ? (module.unparse as CandidateUnparse) : undefined,
      parseStream,
    ),
    entry: file,
    entrySha256: sha256(readFileSync(file)),
    stream,
  };
}

/** CPUs this process may run on (Linux Cpus_allowed_list, e.g. "3" under taskset -c 3); null where unknown. */
export function cpusAllowed(): string | null {
  if (process.platform !== 'linux') return null;
  const status = readFileSync('/proc/self/status', 'utf8');
  return /^Cpus_allowed_list:\s*(\S+)$/m.exec(status)?.[1] ?? null;
}

function peaks() {
  return {
    workerMaxRssBytes: peakRssBytes(),
    peakRssMethod: PEAK_RSS_METHOD,
    // Diagnostic only on Linux, where it includes the parent's resident memory at spawn.
    ...(process.platform === 'linux'
      ? { diagnosticRusageMaxRssBytes: process.resourceUsage().maxRSS * 1024 }
      : {}),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      impl: { type: 'string' },
      case: { type: 'string' },
      mode: { type: 'string', default: 'check' },
      'input-file': { type: 'string' },
      samples: { type: 'string' },
      'min-sample-ms': { type: 'string' },
      'warmup-ms': { type: 'string' },
      'ops-per-sample': { type: 'string' },
      'rewarm-ops': { type: 'string' },
      method: { type: 'string', default: 'v1' },
      load: { type: 'string' },
      entry: { type: 'string' },
    },
  });
  const manifest = readManifest();
  const v2 = values.method === 'v2' ? readManifestV2() : null;
  const where = v2 && {
    node: process.version,
    cwd: process.cwd(),
    execArgv: process.execArgv,
    cpusAllowed: cpusAllowed(),
    padLength: (process.env[v2.setup.padEnv] ?? '').length,
  };
  if (v2 && values.mode === 'empty') {
    const empty = {
      mode: 'empty',
      process: where,
      rssBytes: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
      ...peaks(),
    };
    process.stdout.write(`${JSON.stringify(empty)}\n`);
    return;
  }
  if (v2 && values.load !== 'entry' && values.load !== 'adapter') {
    throw new Error('method v2 needs --load entry (with --entry <file>) or --load adapter');
  }
  // W1 cases and the S1 cases bench/manifest.json lacks live in manifest-v2.json.
  const spec =
    manifest.cases.find((c) => c.id === values.case) ??
    v2?.w1.cases.find((c) => c.id === values.case) ??
    v2?.s1.cases.find((c) => c.id === values.case);
  if (!values.impl || !spec)
    throw new Error(`Unknown --impl/--case: ${String(values.impl)} ${String(values.case)}`);
  if (values.mode === 'memory' && !spec.external && !values['input-file']) {
    throw new Error('memory mode needs --input-file so fixture generation cannot set the peak');
  }
  const measurement: Measurement = {
    ...manifest.measurement,
    ...(v2
      ? {
          samples: v2.measurement.samples,
          minSampleMs: v2.measurement.minSampleMs,
          warmupMs: v2.measurement.warmupMs,
          minWarmupOps: v2.measurement.minWarmupOps,
          rewarmMs: v2.measurement.rewarmMs,
        }
      : {}),
    ...(values.samples ? { samples: Number(values.samples) } : {}),
    ...(values['min-sample-ms'] ? { minSampleMs: Number(values['min-sample-ms']) } : {}),
    ...(values['warmup-ms'] ? { warmupMs: Number(values['warmup-ms']) } : {}),
    ...(values['ops-per-sample'] ? { opsPerSample: Number(values['ops-per-sample']) } : {}),
    ...(values['rewarm-ops'] ? { rewarmOps: Number(values['rewarm-ops']) } : {}),
    ...(spec.chunkBytes === undefined ? {} : { s1ChunkBytes: spec.chunkBytes }),
  };
  // The A/A arm and the A/B arms a and b are the candidate's bundle: its options are theirs.
  // An arm of the case's lane (manifest-v2 s1.arms, w1.arms) is the bundle with its own
  // options over the candidate's.
  const candidateCopies = v2 ? ['a', 'b', v2.aa.impl] : [];
  const arm = v2 ? armsOf(v2, spec.lane)[values.impl] : undefined;
  const options =
    arm === undefined
      ? optionsFor(spec, candidateCopies.includes(values.impl) ? manifest.candidate : values.impl)
      : { ...optionsFor(spec, manifest.candidate), ...arm };

  const importStart = performance.now();
  const loaded =
    v2 && values.load === 'entry'
      ? await loadEntry(values.entry ?? '', spec.lane, values.impl)
      : null;
  const adapter = loaded?.adapter ?? (await loadAdapter(values.impl));
  const importMs = performance.now() - importStart;
  const setupStart = performance.now();
  const input = loadInput(spec, manifest, values['input-file']);
  if (spec.lane === 'W1') input.w1 = await w1Input(spec, input, manifest.reference);
  const fixtureSetupMs = performance.now() - setupStart;
  const frozen = spec.external?.sha256 ?? spec.fixture?.sha256;
  if (frozen && frozen !== input.sha256) {
    throw new Error(`${spec.id}: input sha256 ${input.sha256} != manifest ${frozen}`);
  }

  const base = {
    impl: values.impl,
    case: spec.id,
    mode: values.mode,
    inputSha256: input.sha256,
    options,
  };
  let result: object;
  let rssBeforeParseBytes: number | null = null;
  if (values.mode === 'check') {
    result = await check(adapter, spec, input, manifest, options);
    if (v2 && 'status' in result && result.status === 'PASS') {
      const op = operation(adapter, spec.lane, input, measurement.s1ChunkBytes, options);
      result = { ...result, opMs: await probeOpMs(op, measurement) };
    }
  } else {
    input.rows = null;
    if (v2) {
      gc?.();
      rssBeforeParseBytes = process.memoryUsage().rss;
    }
    if (values.mode === 'time') {
      const { rewarmOps, ...timing } = await time(
        operation(adapter, spec.lane, input, measurement.s1ChunkBytes, options),
        measurement,
      );
      result = { measurement, ...timing, ...(v2 ? { rewarmOps } : {}) };
    } else if (values.mode === 'memory') {
      result = await measureMemory(
        memoryOperation(adapter, spec.lane, input, measurement.s1ChunkBytes, options),
      );
    } else if (values.mode === 'cold') {
      const op = operation(adapter, spec.lane, input, measurement.s1ChunkBytes, options);
      const parseStart = performance.now();
      const out = op();
      const sink = out instanceof Promise ? await out : out;
      const firstParseMs = performance.now() - parseStart;
      result = {
        workerReadyMs,
        importMs,
        fixtureSetupMs,
        firstParseMs,
        processStartToFirstParseEndMs: performance.now(),
        sink,
      };
    } else throw new Error(`Unknown --mode ${values.mode}`);
  }
  result = {
    ...result,
    ...peaks(),
    ...(v2
      ? {
          process: {
            ...where,
            entry: loaded?.entry ?? null,
            entrySha256: loaded?.entrySha256 ?? null,
            streamEntry: loaded?.stream?.entry ?? null,
            streamEntrySha256: loaded?.stream?.entrySha256 ?? null,
          },
          importMs,
          inputLoadMs: fixtureSetupMs,
          rssBeforeParseBytes,
          maxRssKiB: process.resourceUsage().maxRSS,
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify({ ...base, ...result })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
