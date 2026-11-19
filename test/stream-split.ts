import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { mulberry32 } from '../bench/fixtures.ts';
import { BATCH_TEXT, BatchBuilder } from '../src/batches.ts';
import { parseDetailed } from '../src/detailed.ts';
import { guessDelimiter, guessNewline } from '../src/dialect.ts';
import { resolveParseConfig } from '../src/options.ts';
import { parse, undetectableError } from '../src/parse.ts';
import { lineStart, scanRows, SEARCH, type ScanWindow } from '../src/parser.ts';
import { parseStream } from '../src/stream.ts';
import type {
  DetailedConfig,
  FeatureResult,
  ParseBatch,
  ParseConfig,
  ParseError,
  ParseResult,
  Repair,
  RepairRule,
  SchemaError,
  StreamConfig,
  StreamSource,
} from '../src/types.ts';
import { DIALECTS, difference, OVERLAYS, recorded, records, soup } from './differential.ts';

// Shared by the stream tests: feeds a text to a BatchBuilder, or to parseStream
// through each source kind, in pieces and compares the batches with bulk parse.
// Let T be the source's text and C the config without the three stream options.
// For a source that ends normally, except as S1-S7 (docs/compatibility.md) say:
// (a) the batches' data, concatenated, equal parse(T, C).data under the equality
// of test/differential.ts; (b) the last batch's meta without rowOffset and done
// equals parse(T, C).meta without aborted; (c) the batches' errors, concatenated
// and stably grouped as Quotes, Delimiter, FieldMismatch, equal parse(T, C).errors;
// (d) each batch depends only on T, C and batchSize, never on where the chunks
// split T, on the source kind, or on the decode window. Rules (a)-(c) are checked
// here; rule (d) is the caller's: the batch lists of all splits of one text are equal.

/** Feeds `pieces` to a BatchBuilder and returns its batches, or the error it threw with the batches before it. */
export function buildBatches(
  pieces: readonly string[],
  config: ParseConfig & { batchSize?: number; maxRecordLength?: number },
): { batches: ParseBatch<unknown>[]; thrown?: unknown } {
  const { batchSize = 1024, maxRecordLength = 0, ...parseConfig } = config;
  const batches: ParseBatch<unknown>[] = [];
  try {
    const builder = new BatchBuilder(resolveParseConfig(parseConfig, 'main'), {
      batchSize,
      maxRecordLength,
    });
    const take = () => {
      for (let batch = builder.take(); batch !== undefined; batch = builder.take()) {
        batches.push(batch);
      }
    };
    for (const piece of pieces) {
      builder.push(piece);
      take();
    }
    builder.end();
    take();
  } catch (thrown) {
    return { batches, thrown };
  }
  return { batches };
}

/** Every way to cut `text` once, plus one unit per piece, plus `count` seeded random cuts into 3 to 6 pieces. */
export function splits(text: string, random: () => number, count: number): string[][] {
  return cuts(text, random, count);
}

/** splits() for bytes: every single byte cut, one byte per chunk, and `count` seeded random cuts. */
export function byteSplits(bytes: Uint8Array, random: () => number, count: number): Uint8Array[][] {
  return cuts(bytes, random, count);
}

function cuts<T extends string | Uint8Array>(whole: T, random: () => number, count: number): T[][] {
  const part = (from: number, to?: number) => whole.slice(from, to) as T;
  const list: T[][] = [];
  for (let k = 1; k < whole.length; k++) list.push([part(0, k), part(k)]);
  list.push(Array.from({ length: whole.length }, (_, i) => part(i, i + 1)));
  for (let n = 0; n < count; n++) {
    // Cuts may coincide or lie at either end, which gives empty pieces.
    const at = Array.from({ length: 2 + Math.floor(random() * 4) }, () =>
      Math.floor(random() * (whole.length + 1)),
    ).sort((a, b) => a - b);
    list.push([0, ...at].map((cut, i, all) => part(cut, all[i + 1])));
  }
  return list;
}

/** Runs parseStream to the end: its batches, or what it threw (at the call or from next()) with the batches before it. */
export async function collect(
  source: StreamSource,
  config: StreamConfig = {},
): Promise<{ batches: ParseBatch<unknown>[]; thrown?: unknown }> {
  const batches: ParseBatch<unknown>[] = [];
  try {
    // Typed for a config without a schema; checkFeatures reads the Schema errors of one with it.
    for await (const batch of parseStream(source, config))
      batches.push(batch as ParseBatch<unknown>);
  } catch (thrown) {
    return { batches, thrown };
  }
  return { batches };
}

type Chunk = string | Uint8Array;

/**
 * The source kinds that chunks can be given as: an array (a sync iterable), an
 * async generator, a Node Readable (object mode for strings; bytes as Readable.from makes them,
 * which may merge chunks) and a Web ReadableStream.
 */
export const SOURCES = {
  array: (chunks: readonly Chunk[]) => [...chunks] as StreamSource,
  'async generator': (chunks: readonly Chunk[]) =>
    (async function* () {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    })() as StreamSource,
  'Node Readable': (chunks: readonly Chunk[]) =>
    Readable.from(chunks, { objectMode: typeof chunks[0] === 'string' }),
  ReadableStream: (chunks: readonly Chunk[]) =>
    new ReadableStream<Chunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
} satisfies Record<string, (chunks: readonly Chunk[]) => StreamSource>;

export type SourceKind = keyof typeof SOURCES;
export const SOURCE_KINDS = Object.keys(SOURCES) as SourceKind[];

const ERROR_ORDER: ReadonlyArray<ParseError['type']> = ['Quotes', 'Delimiter', 'FieldMismatch'];

const without = (object: object, ...keys: string[]) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/**
 * S2 (docs/compatibility.md), worked out from its wording and bulk's functions alone: the delimiter the stream
 * detects when that can differ from bulk's, else null. It can differ only when the delimiter is
 * detected with comments on, the detection window (the shortest text after the BOM and the
 * skipped lines that holds 1,048,576 units when the newline is detected and, per candidate, 10
 * records that line breaks end) is shorter than the text, and the window has no '"' while the text
 * after it has one. undefined: the window gives no delimiter (',' with UndetectableDelimiter).
 * For a config that bulk parses without throwing.
 */
export function s2Delimiter(text: string, config: ParseConfig): string | null | undefined {
  const options = resolveParseConfig(config, 'main');
  const { comments, quoteChar, delimitersToGuess } = options;
  if (options.delimiter !== '' || comments === '') return null;
  let left = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (options.skipFirstNLines > 0) {
    const lines = options.newline || guessNewline(left, quoteChar);
    const start = lineStart(left, options.skipFirstNLines, lines);
    left = start === -1 ? '' : left.slice(start);
  }
  const newline = options.newline || guessNewline(left, quoteChar);
  let size = options.newline === '' ? 1_048_576 : 0;
  for (const candidate of delimitersToGuess) {
    const window: ScanWindow = {
      cursor: 0,
      limit: 10,
      final: false,
      nextDelimiter: SEARCH,
      nextNewline: SEARCH,
      nextQuote: SEARCH,
      end: -1,
      stop: 'end',
    };
    const dialect = { newline, quoteChar: '"', escapeChar: '"', comments, preview: 0 };
    scanRows(left, { ...dialect, delimiter: candidate ?? ',', fastMode: false }, undefined, window);
    if (window.stop !== 'limit') return null;
    size = Math.max(size, window.end);
  }
  if (size >= left.length || left.slice(0, size).includes('"') || !left.includes('"')) return null;
  return guessDelimiter(
    left.slice(0, size),
    newline,
    options.skipEmptyLines,
    options.rawComments,
    delimitersToGuess,
  );
}

// The reference made last: every split of one text is compared with the same one.
let made: { text: string; config: ParseConfig; result: ParseResult<unknown> } | undefined;

/** Bulk parse as the stream's reference: S1 (fastMode: false for a preview with fastMode omitted) and S2. */
function reference(text: string, config: ParseConfig): ParseResult<unknown> {
  if (made?.text !== text || made.config !== config) {
    made = { text, config, result: bulkReference(text, config) };
  }
  return made.result;
}

function bulkReference(text: string, config: ParseConfig): ParseResult<unknown> {
  const counted = (config.preview ?? 0) > 0 && config.fastMode === undefined;
  const base = counted ? { ...config, fastMode: false } : config;
  const delimiter = s2Delimiter(text, config);
  if (delimiter === null) return parse(text, base);
  const result: ParseResult<unknown> = parse(text, { ...base, delimiter: delimiter ?? ',' });
  if (delimiter === undefined) {
    // Bulk's place for it: after the Quotes errors, before the FieldMismatch errors.
    const at = result.errors.findIndex((error) => error.type === 'FieldMismatch');
    result.errors.splice(at === -1 ? result.errors.length : at, 0, undetectableError());
  }
  return result;
}

/**
 * Whether a batch that is not the last holds the rows it must: batchSize, or fewer, at least one,
 * when its text reached BATCH_TEXT (src/batches.ts). That text is at most the units since the
 * batch before, its cursor less that batch's, so these must reach the bound.
 */
const holds = (rows: number, units: number, batchSize: number) =>
  rows === batchSize || (rows > 0 && rows < batchSize && units >= BATCH_TEXT);

/**
 * Rules (a)-(c) above: null, or the first difference between the batches and parse(text, config).
 * S1 and S2 are applied here: with preview > 0 and fastMode omitted, the reference is parse with
 * fastMode: false; where s2Delimiter gives the window's delimiter, the reference is parse with it.
 */
export function streamDifference(
  batches: readonly ParseBatch<unknown>[],
  text: string,
  config: ParseConfig,
  batchSize: number,
): string | null {
  const expected = reference(text, config);
  const last = batches.at(-1);
  if (last === undefined) return 'no batch';
  let rows = 0;
  let cursor = 0;
  for (const [i, { data, meta }] of batches.entries()) {
    const n = String(i);
    const isLast = i === batches.length - 1;
    if (meta.done !== isLast) return `done of batch ${n}`;
    if (meta.rowOffset !== rows) return `rowOffset of batch ${n}`;
    if (isLast ? data.length > batchSize : !holds(data.length, meta.cursor - cursor, batchSize)) {
      return `size of batch ${n}`;
    }
    if (!isLast && meta.truncated) return `truncated of batch ${n}`;
    // delimiter, linebreak, fields and renamedHeaders are the same in every batch.
    const fixed = (m: object) => without(m, 'rowOffset', 'cursor', 'truncated', 'done');
    if (!isDeepStrictEqual(fixed(meta), fixed(last.meta))) return `fixed meta of batch ${n}`;
    rows += data.length;
    cursor = meta.cursor;
  }
  const errors = batches.flatMap((batch) => batch.errors);
  return difference(
    {
      data: batches.flatMap((batch) => batch.data),
      errors: ERROR_ORDER.flatMap((type) => errors.filter((error) => error.type === type)),
      meta: without(last.meta, 'rowOffset', 'done'),
    },
    {
      data: expected.data,
      errors: expected.errors,
      meta: without(expected.meta, 'aborted'),
    },
  );
}

const message = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

/** What checkSplits or checkStream found for one text: the first failure, and what it covered. */
export interface SplitCheck {
  failure: { what: string; pieces: readonly Chunk[]; kind?: SourceKind } | null;
  /** Runs: the whole text and every element of splits() (checkStream: every chunk list and source kind). */
  splits: number;
  /** Batches of the first run. */
  batches: number;
  /** Bulk rejects the input. */
  throwing: boolean;
  /** Runs that delivered batches before a throw (S6). */
  early: number;
  /** S2 applies: the reference is bulk with the window's delimiter. */
  s2: boolean;
}

/**
 * The judge of the runs of one text: rules (a)-(c) with S1 and S2 (streamDifference), rule (d)
 * (every run equals the first one), the calls of the config's callbacks in order, and the message
 * of what is thrown (S6: batches may come before it).
 */
function judge(text: string, config: ParseConfig, batchSize: number) {
  const bulk = (referenceConfig: ParseConfig) => {
    const record = recorded(referenceConfig);
    try {
      parse(text, record.config);
      return { calls: record.calls, thrown: null };
    } catch (thrown) {
      return { calls: record.calls, thrown: message(thrown) };
    }
  };
  const counted = (config.preview ?? 0) > 0 && config.fastMode === undefined;
  const base = counted ? { ...config, fastMode: false } : config;
  let expected = bulk(base);
  const check: SplitCheck = {
    failure: null,
    splits: 0,
    batches: 0,
    throwing: expected.thrown !== null,
    early: 0,
    s2: false,
  };
  if (!check.throwing) {
    const delimiter = s2Delimiter(text, config);
    if (delimiter !== null) {
      check.s2 = true;
      expected = bulk({ ...base, delimiter: delimiter ?? ',' });
    }
  }
  const fail = (what: string, pieces: readonly Chunk[], kind?: SourceKind) => {
    check.failure ??= kind === undefined ? { what, pieces } : { what, pieces, kind };
  };
  let whole: ParseBatch<unknown>[] | undefined;
  /** Judges one run: its pieces, the callback calls it made, its batches and what it threw. */
  const run = (
    pieces: readonly Chunk[],
    calls: unknown[][],
    { batches, thrown }: { batches: ParseBatch<unknown>[]; thrown?: unknown },
    kind?: SourceKind,
  ) => {
    check.splits++;
    if (whole === undefined) {
      whole = batches;
      check.batches = batches.length;
    }
    const got = thrown === undefined ? null : message(thrown);
    if (got !== expected.thrown) fail(`throws ${String(got)}`, pieces, kind);
    if (!isDeepStrictEqual(calls, expected.calls)) fail('callback calls', pieces, kind);
    if (!same(batches, whole)) fail('rule (d)', pieces, kind);
    if (check.throwing) {
      if (batches.length > 0) check.early++;
      return;
    }
    const diff = streamDifference(batches, text, config, batchSize);
    if (diff !== null) fail(diff, pieces, kind);
  };
  return { check, run, fail, whole: () => whole };
}

const same = (a: readonly ParseBatch<unknown>[], b: readonly ParseBatch<unknown>[]) =>
  a.length === b.length && a.every((batch, i) => difference(batch, b[i]) === null);

/**
 * The batches of `text`, whole, at every element of splits(text, random, count) and with end()
 * before the first take(), against bulk: rules (a)-(c) with S1 and S2 (streamDifference), rule (d)
 * (every run equals the whole one), the calls of the config's callbacks in order, and the message
 * of what is thrown (S6: batches may come before it).
 */
export function checkSplits(
  text: string,
  config: ParseConfig,
  batchSize: number,
  random: () => number,
  count: number,
): SplitCheck {
  const { check, run, fail, whole } = judge(text, config, batchSize);
  for (const pieces of [[text], ...splits(text, random, count)]) {
    const record = recorded(config);
    run(pieces, record.calls, buildBatches(pieces, { ...record.config, batchSize }));
  }
  const first = whole();
  if (!check.throwing && first !== undefined) {
    const builder = new BatchBuilder(resolveParseConfig(config, 'main'), {
      batchSize,
      maxRecordLength: 0,
    });
    const early: ParseBatch<unknown>[] = [];
    builder.push(text);
    builder.end();
    for (let b = builder.take(); b !== undefined; b = builder.take()) early.push(b);
    if (!same(early, first)) fail('end() before the first take()', [text]);
  }
  return check;
}

/**
 * checkSplits through parseStream: each chunk list in `runs` (string chunks of `text`, or byte
 * chunks whose UTF-8 decoding with ignoreBOM is `text`) as each source kind in `kinds`, against
 * bulk on `text` with the same rules. Rule (d) holds across the chunk lists and the source kinds.
 */
export async function checkStream(
  text: string,
  config: ParseConfig,
  batchSize: number,
  runs: ReadonlyArray<readonly Chunk[]>,
  kinds: readonly SourceKind[] = SOURCE_KINDS,
): Promise<SplitCheck> {
  const { check, run } = judge(text, config, batchSize);
  for (const chunks of runs) {
    for (const kind of kinds) {
      const record = recorded(config);
      run(
        chunks,
        record.calls,
        await collect(SOURCES[kind](chunks), { ...record.config, batchSize }),
        kind,
      );
    }
  }
  return check;
}

// The same judge for a stream with features, against parseDetailed.

/** The fuzz of test/differential.ts as it draws: 0 to 3 of all OVERLAYS per pair, one soup and one record input. */
export function drawn(
  seed: number,
  perDialect: number,
): Array<{ input: string; config: ParseConfig; overlays: readonly number[] }> {
  const random = mulberry32(seed);
  const list: Array<{ input: string; config: ParseConfig; overlays: readonly number[] }> = [];
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

type FeatureBatch = ParseBatch<unknown, ParseError | SchemaError>;
type Reference = FeatureResult<unknown, ParseError | SchemaError>;

const FEATURE_ERROR_ORDER = [...ERROR_ORDER, 'Schema'] as const;
const RULES: readonly RepairRule[] = [
  'pad-missing',
  'drop-trailing-empty',
  'trailing-empty-record',
  'mixed-newline',
  'unclosed-quote',
];

/**
 * parseDetailed as the reference of a stream with features, with S1 and S2 as bulkReference
 * applies them. S2 cannot apply under detect or after a "sep=" line was read: neither guesses
 * the delimiter.
 */
export function featureReference(
  text: string,
  config: DetailedConfig,
): Reference & { s2: boolean } {
  const counted = (config.preview ?? 0) > 0 && config.fastMode === undefined;
  const base = counted ? { ...config, fastMode: false } : config;
  const result: Reference = parseDetailed(text, base);
  if (config.detect === true || result.meta.sepLine === true) return { ...result, s2: false };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parse keys are what is left
  const { detect, positions, repair, schema, sepLine, ...plain } = config;
  const delimiter = s2Delimiter(text, plain);
  if (delimiter === null) return { ...result, s2: false };
  const windowed: Reference = parseDetailed(text, { ...base, delimiter: delimiter ?? ',' });
  if (delimiter === undefined) {
    const at = windowed.errors.findIndex(
      (error) => error.type === 'FieldMismatch' || error.type === 'Schema',
    );
    windowed.errors.splice(at === -1 ? windowed.errors.length : at, 0, undetectableError());
  }
  return { ...windowed, s2: true };
}

/**
 * Rules (a)-(c) for a stream with features: null, or the first difference between the batches
 * and `expected` (featureReference). Grouping and row numbers follow S4, S8 and S10: without a
 * schema every batch but the last has batchSize rows; with one, batchSize rows as built
 * (rowOffset steps by them) of which data holds the valid ones; in either case fewer when the
 * batch's text reached BATCH_TEXT (holds); row of a FieldMismatch or Schema error and of a
 * repair lies in its batch; the concatenated repairs and the summed repairCounts are bulk's; a
 * batch has the repair keys exactly when bulk's result has.
 */
export function featureDifference(
  batches: readonly FeatureBatch[],
  expected: Reference,
  config: DetailedConfig,
  batchSize: number,
): string | null {
  const last = batches.at(-1);
  if (last === undefined) return 'no batch';
  const validated = config.schema !== undefined;
  const repairing = expected.repairs !== undefined;
  const keys = repairing
    ? ['data', 'errors', 'meta', 'repairs', 'repairCounts']
    : ['data', 'errors', 'meta'];
  const counts = Object.fromEntries(RULES.map((rule) => [rule, 0])) as Record<RepairRule, number>;
  const repairs: Repair[] = [];
  let cursor = 0;
  for (const [i, batch] of batches.entries()) {
    const { data, errors, meta } = batch;
    const n = String(i);
    const isLast = i === batches.length - 1;
    // Where the rows as built of this batch end: the next batch's rowOffset (S10).
    const end = isLast ? meta.rowOffset + batchSize : (batches[i + 1]?.meta.rowOffset ?? 0);
    if (!isDeepStrictEqual(Object.keys(batch), keys)) return `keys of batch ${n}`;
    if (meta.done !== isLast) return `done of batch ${n}`;
    if (i === 0 && meta.rowOffset !== 0) return `rowOffset of batch ${n}`;
    if (!isLast && !holds(end - meta.rowOffset, meta.cursor - cursor, batchSize)) {
      return `rowOffset of batch ${String(i + 1)}`;
    }
    const built = end - meta.rowOffset;
    if (validated || isLast ? data.length > built : data.length !== built) {
      return `size of batch ${n}`;
    }
    if (!isLast && meta.truncated) return `truncated of batch ${n}`;
    const fixed = (m: object) => without(m, 'rowOffset', 'cursor', 'truncated', 'done');
    if (!isDeepStrictEqual(fixed(meta), fixed(last.meta))) return `fixed meta of batch ${n}`;
    cursor = meta.cursor;
    const inBatch = (row: number) => row >= meta.rowOffset && row < end;
    for (const error of errors) {
      if ((error.type === 'FieldMismatch' || error.type === 'Schema') && !inBatch(error.row)) {
        return `row of a ${error.type} error of batch ${n}`;
      }
    }
    if (repairing) {
      if (batch.repairs === undefined || batch.repairCounts === undefined) return `repairs of ${n}`;
      // A repair that names a row is in the batch of that row, or, when repair cut the rows at
      // preview, names a row that no batch has.
      for (const repair of batch.repairs) {
        if (repair.row >= 0 && !inBatch(repair.row) && !(isLast && repair.row >= meta.rowOffset)) {
          return `row of a repair of batch ${n}`;
        }
        repairs.push(repair);
      }
      for (const rule of RULES) counts[rule] += batch.repairCounts[rule];
    }
  }
  if (repairing) {
    if (!isDeepStrictEqual(repairs, expected.repairs)) return 'repairs';
    if (!isDeepStrictEqual(counts, expected.repairCounts)) return 'repairCounts';
  }
  const errors = batches.flatMap((batch) => batch.errors);
  const invalid = new Set(
    expected.errors.flatMap((error) => (error.type === 'Schema' ? [error.row] : [])),
  ).size;
  // The rows as built: every one is in data or is the row of a Schema error.
  const built = expected.data.length + invalid;
  if (built < last.meta.rowOffset || built > last.meta.rowOffset + batchSize) return 'rows built';
  return difference(
    {
      data: batches.flatMap((batch) => batch.data),
      errors: FEATURE_ERROR_ORDER.flatMap((type) => errors.filter((error) => error.type === type)),
      meta: without(last.meta, 'rowOffset', 'done'),
    },
    {
      data: expected.data,
      errors: expected.errors,
      meta: without(expected.meta, 'aborted'),
    },
  );
}

/**
 * checkStream for a config with features: each chunk list in `runs` as each source kind in
 * `kinds`, against parseDetailed on `text` (featureDifference), with rule (d) across the runs
 * (the whole batches, repairs included), the calls of the config's callbacks in order and the
 * message of what is thrown. `config` holds no stream key; a schema in it must be synchronous.
 */
export async function checkFeatures(
  text: string,
  config: DetailedConfig,
  batchSize: number,
  runs: ReadonlyArray<readonly Chunk[]>,
  kinds: readonly SourceKind[] = ['array'],
): Promise<SplitCheck> {
  const bulk = (): {
    calls: unknown[][];
    thrown: string | null;
    result?: Reference;
    s2: boolean;
  } => {
    const record = recorded(config);
    try {
      const { s2, ...result } = featureReference(text, { ...config, ...record.config });
      return { calls: record.calls, thrown: null, result, s2 };
    } catch (thrown) {
      return { calls: record.calls, thrown: message(thrown), s2: false };
    }
  };
  const expected = bulk();
  const check: SplitCheck = {
    failure: null,
    splits: 0,
    batches: 0,
    throwing: expected.thrown !== null,
    early: 0,
    s2: expected.s2,
  };
  let whole: FeatureBatch[] | undefined;
  for (const chunks of runs) {
    for (const kind of kinds) {
      const record = recorded(config);
      const fail = (what: string) => {
        check.failure ??= { what, pieces: chunks, kind };
      };
      const run = await collect(SOURCES[kind](chunks), {
        ...config,
        ...record.config,
        batchSize,
      });
      const batches = run.batches as FeatureBatch[];
      check.splits++;
      if (whole === undefined) {
        whole = batches;
        check.batches = batches.length;
      }
      const got = run.thrown === undefined ? null : message(run.thrown);
      if (got !== expected.thrown) fail(`throws ${String(got)}`);
      // Under S2 the reference parsed twice, so its calls are not those of one parse.
      if (!expected.s2 && !isDeepStrictEqual(record.calls, expected.calls)) fail('callback calls');
      if (!isDeepStrictEqual(batches, whole)) fail('rule (d)');
      if (expected.result === undefined) {
        if (batches.length > 0) check.early++;
        continue;
      }
      const diff = featureDifference(batches, expected.result, config, batchSize);
      if (diff !== null) fail(diff);
    }
  }
  return check;
}
