import { isEmptyRecord, withoutQuoted } from './dialect.ts';
import { positionsAt, recordStarts, type Before } from './locate.ts';
import { scanRows, type ScanDialect } from './parser.ts';
import type { QuoteError, Repair, RepairRule } from './types.ts';

export interface RepairInput {
  /** The text that was scanned. */
  text: string;
  /** The dialect it was scanned with (preview 0). */
  dialect: ScanDialect;
  /** scanRows(text, dialect).rows; repaired in place. */
  rows: string[][];
  /** The scan's errors; a repaired MissingQuotes is removed, and row and index of the rest are re-based to the repaired rows and to text. */
  errors: QuoteError[];
  /**
   * The record width when the caller already knows it (stream: after the first batch), and then
   * the rows hold no header record; undefined: from the rows.
   */
  width: number | undefined;
  /**
   * With width undefined, the header record is the first record skipEmptyLines keeps, record 0
   * judged by its names as parseWith judges it.
   */
  header: boolean;
  /** The transformHeader option, called for each cell of record 0 when skipEmptyLines judges it. */
  transformHeader?: ((header: string, index: number) => unknown) | undefined;
  skipEmptyLines: boolean | 'greedy';
  /**
   * mixed-newline is applied as given: the caller includes it only when mixedNewline found two
   * kinds of line break and no newline was given, and scanned with the newline it returned.
   */
  rules: ReadonlySet<RepairRule>;
  /** false in the stream before the source has ended: trailing-empty-record and unclosed-quote wait. */
  atEnd: boolean;
  /** For the log's positions. */
  before: Before;
}

const LOG_LIMIT = 10_000;
const BEFORE_UNITS = 256;
const QUOTE_REPAIRS = 100;
const NEWLINE_SAMPLE = 1_048_576;
/** The order the rules run in, which is also the log's order for one record. */
const RANK: Readonly<Record<RepairRule, number>> = {
  'unclosed-quote': 0,
  'mixed-newline': 1,
  'trailing-empty-record': 2,
  'drop-trailing-empty': 3,
  'pad-missing': 4,
};

/** A logged change: the scan record it changed (an index into rows after unclosed-quote) and its fields after the change. */
interface Change {
  rule: RepairRule;
  record: number;
  after: string[][];
}

/**
 * Where one scan of text started: the caller's at 0, then one at the line break after each line
 * unclosed-quote read again, whose first record (the empty one that line break ends) is skipped.
 */
interface Segment {
  at: number;
  first: number;
  skipped: number;
}

/**
 * entries: the log in input order, the first 10,000 changes only; counts: every change, per
 * rule. Repair.row counts repaired rows from 0 (the caller adds its row base); -1 for a removed
 * record and for the header record.
 *
 * A change is one record changed by one rule. Its span is the record's raw text without its line
 * break, so when two rules change one record (or the pieces of a record mixed-newline split), both
 * entries have the same span and the later one holds the record as it ends; trailing-empty-record's
 * span is the final line break (see finalStart). Spans never overlap otherwise.
 */
export function repairRows(input: RepairInput): {
  entries: Repair[];
  counts: Record<RepairRule, number>;
  /**
   * Where in text these repaired rows (ascending indices into rows) start: the start of the
   * record a row came from, and for a later piece of a record mixed-newline split, the unit
   * after the "\r" that ends the piece before it.
   */
  startsOf: (rows: readonly number[]) => number[];
} {
  const { text, dialect, rows, errors, rules, header, skipEmptyLines } = input;
  const { newline } = dialect;
  const greedy = skipEmptyLines === 'greedy';
  const counts: Record<RepairRule, number> = {
    'pad-missing': 0,
    'drop-trailing-empty': 0,
    'trailing-empty-record': 0,
    'mixed-newline': 0,
    'unclosed-quote': 0,
  };
  // Each rule logs its changes in record order, so the first LOG_LIMIT of each hold the first
  // LOG_LIMIT of all.
  const changes: Change[] = [];
  const log = (rule: RepairRule, record: number, after: () => string[][]) => {
    if (counts[rule]++ < LOG_LIMIT) changes.push({ rule, record, after: after() });
  };
  const segments: Segment[] = [{ at: 0, first: 0, skipped: 0 }];
  const repaired = new Map<number, readonly [number, number]>();

  /** Start offsets of these scan records (ascending), -1 past the last. */
  const startsOf = (ordinals: readonly number[]): number[] => {
    const starts: number[] = [];
    let j = 0;
    segments.forEach(({ at, first, skipped }, s) => {
      const end = segments[s + 1]?.first ?? Infinity;
      const local: number[] = [];
      for (; j < ordinals.length && (ordinals[j] ?? 0) < end; j++) {
        local.push((ordinals[j] ?? 0) - first + skipped);
      }
      if (local.length === 0) return;
      for (const start of recordStarts(text.slice(at), dialect, local)) {
        starts.push(start === -1 ? -1 : at + start);
      }
    });
    return starts;
  };

  /** Start and end (where its line break starts) of these scan records (ascending). */
  const spansOf = (records: readonly number[]): (readonly [number, number])[] => {
    const starts = startsOf(records.flatMap((k) => [k, k + 1]));
    return records.map((k, j) => {
      const known = repaired.get(k);
      if (known !== undefined) return known;
      const start = starts[2 * j] ?? 0;
      const next = starts[2 * j + 1] ?? -1;
      const limit = next === -1 ? text.length : next;
      if (dialect.comments === '') return [start, next === -1 ? limit : next - newline.length];
      // Comment lines can lie between the record and the next: scan the record alone.
      const plain = { ...dialect, comments: '' };
      const after = recordStarts(text.slice(start, limit), plain, [1])[0] ?? -1;
      return [start, after === -1 ? limit : start + after - newline.length];
    });
  };

  if (input.atEnd && rules.has('unclosed-quote')) {
    // The scan ended in a quoted field that never closes. Its line is read again with quotes as
    // ordinary characters (the fields before it stay as scanned) and the scan resumes after it.
    for (let count = 0; count < QUOTE_REPAIRS; count++) {
      const missing = errors.at(-1);
      if (missing?.code !== 'MissingQuotes') break;
      const k = rows.length - 1;
      const segment = segments.at(-1) ?? { at: 0, first: 0, skipped: 0 };
      const ordinal = k - segment.first + segment.skipped;
      const start = segment.at + (recordStarts(text.slice(segment.at), dialect, [ordinal])[0] ?? 0);
      const quote = missing.index - 1;
      let end = text.indexOf(newline, quote);
      if (end === -1) end = text.length;
      const ordinary = { ...dialect, quoteChar: '', comments: '' };
      const line = scanRows(text.slice(quote, end), ordinary).rows[0] ?? [];
      const fields = [...(rows[k] ?? []).slice(0, -1), ...line];
      rows[k] = fields;
      // Every error raised inside the field has the index of its opening quote.
      while (errors.at(-1)?.index === missing.index) errors.pop();
      repaired.set(k, [start, end]);
      log('unclosed-quote', k, () => [fields.slice()]);
      if (end === text.length) break;
      // Scanned from the line break, so that a line break that ends the text still gives the
      // final [''] record; the empty record before it is skipped.
      const rest = scanRows(text.slice(end), dialect);
      // Its rows count the skipped record, so its row r is k + r here.
      for (const error of rest.errors) {
        errors.push({ ...error, row: k + error.row, index: end + error.index });
      }
      segments.push({ at: end, first: k + 1, skipped: 1 });
      for (let j = 1; j < rest.rows.length; j++) rows.push(rest.rows[j] ?? []);
    }
  }

  // Scan records that mixed-newline split, by index; flattened into rows once all are known.
  const splits = new Map<number, string[][]>();
  if (rules.has('mixed-newline')) {
    const candidates: number[] = [];
    rows.forEach((row, k) => {
      if (row.some((field) => field.includes('\r'))) candidates.push(k);
    });
    const spans = candidates.length === 0 ? [] : spansOf(candidates);
    const lines = { ...dialect, newline: '\r' as const, comments: '' };
    candidates.forEach((k, j) => {
      const [start, end] = spans[j] ?? [0, 0];
      const raw = text.slice(start, end);
      const scan = scanRows(raw, lines);
      const parts = scan.rows;
      const last = parts.at(-1);
      // A "\r" that ends the record (before its line break, or at the end of the text) is removed.
      const removed = raw.endsWith('\r') && last?.length === 1 && last[0] === '';
      if (removed) parts.pop();
      const fields = rows[k] ?? [];
      const was = fields.join(dialect.delimiter);
      const now = parts.map((part) => part.join(dialect.delimiter)).join('\r');
      // Only "\r"s outside quotes may become record ends or go: a re-reading that differs in
      // anything else, or raises a quote error, changes nothing.
      if (scan.errors.length > 0 || (now !== was && !(removed && `${now}\r` === was))) return;
      if (parts.length === 1 && now === was) return;
      log('mixed-newline', k, () => parts.map((part) => part.slice()));
      if (parts.length === 1) rows[k] = parts[0] ?? [];
      else splits.set(k, parts);
    });
  }
  // owner[i]: the scan record row i came from, when a record was split.
  let owner: number[] | undefined;
  if (splits.size > 0) {
    const flat: string[][] = [];
    owner = [];
    // firstRow[k]: the first row scan record k became.
    const firstRow: number[] = [];
    rows.forEach((row, k) => {
      firstRow.push(flat.length);
      for (const piece of splits.get(k) ?? [row]) {
        flat.push(piece);
        owner?.push(k);
      }
    });
    rows.length = 0;
    for (const row of flat) rows.push(row);
    // An error's row is the number of records before its own, which a split has changed. The
    // record of an error is never split itself.
    for (const error of errors) error.row = firstRow[error.row] ?? error.row;
  }
  const ownerOf = (i: number) => (owner === undefined ? i : (owner[i] ?? -1));

  // A text that is one line break holds two empty records and no other text; without the line
  // break it would hold none, so neither is removed.
  if (input.atEnd && rules.has('trailing-empty-record') && text.length > newline.length) {
    const last = rows.at(-1);
    if (last?.length === 1 && last[0] === '' && text.endsWith(newline)) {
      const k = ownerOf(rows.length - 1);
      rows.pop();
      log('trailing-empty-record', k, () => []);
    }
  }

  let width = input.width;
  // The first data row: after the header record when the rows hold it; Infinity when none exists.
  let firstData = 0;
  if (width === undefined) {
    firstData = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? [];
      const empty =
        skipEmptyLines !== false &&
        (i === 0 && header
          ? emptyHeader(row, greedy, input.transformHeader)
          : isEmptyRecord(row, greedy));
      if (empty) continue;
      width = row.length;
      firstData = header ? i + 1 : i;
      break;
    }
  }
  const isData = (i: number, row: readonly string[]) =>
    i >= firstData && !(skipEmptyLines !== false && isEmptyRecord(row, greedy));

  /** Applies change to every data row; logs once per scan record, with all its rows after the rule. */
  const widthRule = (rule: RepairRule, change: (row: string[]) => boolean) => {
    let from = 0;
    let changed = false;
    for (let i = 0; i <= rows.length; i++) {
      if (i === rows.length || ownerOf(i) !== ownerOf(from)) {
        const to = i;
        if (changed) log(rule, ownerOf(from), () => rows.slice(from, to).map((row) => row.slice()));
        from = i;
        changed = false;
      }
      const row = rows[i];
      if (row !== undefined && isData(i, row) && change(row)) changed = true;
    }
  };
  if (width !== undefined) {
    const w = width;
    if (rules.has('drop-trailing-empty')) {
      widthRule('drop-trailing-empty', (row) => {
        if (row.length <= w) return false;
        for (let j = w; j < row.length; j++) if (row[j] !== '') return false;
        row.length = w;
        return true;
      });
    }
    if (rules.has('pad-missing')) {
      widthRule('pad-missing', (row) => {
        if (row.length >= w) return false;
        while (row.length < w) row.push('');
        return true;
      });
    }
  }

  changes.sort((a, b) => a.record - b.record || RANK[a.rule] - RANK[b.rule]);
  if (changes.length > LOG_LIMIT) changes.length = LOG_LIMIT;
  const final = (rule: RepairRule) => rule === 'trailing-empty-record';
  const logged = [...new Set(changes.flatMap(({ rule, record }) => (final(rule) ? [] : [record])))];
  const loggedSpans = spansOf(logged);
  const spanOf = new Map(logged.map((k, j) => [k, loggedSpans[j] ?? ([0, 0] as const)]));
  const lineBreak = text.length - newline.length;
  /**
   * Where trailing-empty-record's span starts: at the final line break, or at the whitespace
   * before it when that whitespace only closed the quoted last field of record k - 1, which it no
   * longer would at the end of the text. Not when record k - 1 is logged: its span holds that
   * whitespace and replaces it.
   */
  const finalStart = (k: number): number => {
    const kept = text.slice(0, lineBreak).trimEnd();
    const { quoteChar } = dialect;
    if (k === 0 || spanOf.has(k - 1) || kept.length === lineBreak || quoteChar === '') {
      return lineBreak;
    }
    if (!kept.endsWith(quoteChar)) return lineBreak;
    const [start, end] = spansOf([k - 1])[0] ?? [0, 0];
    const row = rows.at(-1) ?? [];
    const again = scanRows(text.slice(start, kept.length), dialect).rows;
    const [only] = again;
    const same =
      again.length === 1 &&
      only?.length === row.length &&
      only.every((field, j) => field === row[j]);
    return end === lineBreak && same ? kept.length : lineBreak;
  };
  const spans = changes.map(({ rule, record }) =>
    final(rule)
      ? ([finalStart(record), text.length] as const)
      : (spanOf.get(record) ?? ([0, 0] as const)),
  );
  const positions = positionsAt(
    text,
    spans.map(([start]) => start),
    input.before,
  );
  // Repair.row: the first data row the record became, over the rows as repaired.
  let i = 0;
  let data = 0;
  const entries = changes.map(({ rule, record, after }, j): Repair => {
    let row = -1;
    if (!final(rule)) {
      for (; i < rows.length && ownerOf(i) < record; i++) if (isData(i, rows[i] ?? [])) data++;
      for (let r = i; r < rows.length && ownerOf(r) === record; r++) {
        if (isData(r, rows[r] ?? [])) {
          row = data;
          break;
        }
      }
    }
    const [start, end] = spans[j] ?? [0, 0];
    const { line, column, offset, snippet } = positions[j] ?? {
      line: 0,
      column: 0,
      offset: 0,
      snippet: '',
    };
    return {
      rule,
      row,
      line,
      column,
      offset,
      snippet,
      length: end - start,
      before: text.slice(start, beforeEnd(text, start, end)),
      after,
    };
  });
  const rowStarts = (indices: readonly number[]): number[] => {
    const records = [...new Set(indices.map(ownerOf))];
    const found = spansOf(records);
    const lines = { ...dialect, newline: '\r' as const, comments: '' };
    const starts: number[] = [];
    let j = 0;
    records.forEach((k, r) => {
      const [start, end] = found[r] ?? [0, 0];
      // The first row the record became, then which of its pieces each asked row is.
      let first = indices[j] ?? 0;
      while (ownerOf(first - 1) === k) first--;
      const pieces: number[] = [];
      for (; j < indices.length && ownerOf(indices[j] ?? 0) === k; j++) {
        pieces.push((indices[j] ?? 0) - first);
      }
      // Only a split record has a piece after its first; the scan that split it finds it again.
      const within = pieces.some((piece) => piece > 0)
        ? recordStarts(text.slice(start, end), lines, pieces)
        : pieces;
      for (const at of within) starts.push(start + at);
    });
    return starts;
  };
  return { entries, counts, startsOf: rowStarts };
}

/** Where Repair.before ends: 256 units into the span, or 255 where 256 would split a surrogate pair. */
function beforeEnd(text: string, start: number, end: number): number {
  const cut = Math.min(end, start + BEFORE_UNITS);
  const splits =
    cut < end &&
    (text.charCodeAt(cut - 1) & 0xfc00) === 0xd800 &&
    (text.charCodeAt(cut) & 0xfc00) === 0xdc00;
  return splits ? cut - 1 : cut;
}

/**
 * parseWith's test of record 0 under skipEmptyLines with header: one leading U+FEFF is removed
 * from each cell, which then goes through transformHeader, and a repeated name is renamed with a
 * suffix, so a record with a repeated name is never empty.
 */
function emptyHeader(
  cells: readonly string[],
  greedy: boolean,
  transformHeader: RepairInput['transformHeader'],
): boolean {
  const names = cells.map((cell, i) => {
    const name = cell.charCodeAt(0) === 0xfeff ? cell.slice(1) : cell;
    return transformHeader === undefined ? name : transformHeader(name, i);
  });
  return isEmptyRecord(names, greedy) && new Set(names).size === names.length;
}

/**
 * Whether the first 1,048,576 units, quoted spans removed, hold two kinds of line break, and the
 * newline the scan must then use.
 */
export function mixedNewline(text: string, quoteChar: string): '\n' | '\r\n' | undefined {
  const quote = quoteChar || '"';
  let sample = withoutQuoted(text.slice(0, NEWLINE_SAMPLE), quote);
  // withoutQuoted keeps the rest after a quote that does not close in the sample (such as a
  // quoted cell the limit cuts); its line breaks may be inside quotes, so they are not counted.
  const open = sample.indexOf(quote);
  if (open !== -1) sample = sample.slice(0, open);
  // A "\r" that ends the sample is half of a "\r\n" when the text goes on with "\n".
  else if (sample.endsWith('\r') && text.charCodeAt(NEWLINE_SAMPLE) === 0x0a) sample += '\n';
  const lf = /(?<!\r)\n/.test(sample);
  const kinds = Number(lf) + Number(sample.includes('\r\n')) + Number(/\r(?!\n)/.test(sample));
  return kinds < 2 ? undefined : lf ? '\n' : '\r\n';
}
