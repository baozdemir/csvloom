import { DEFAULT_DELIMITERS, guessNewline } from './dialect.ts';
import { BAD_DELIMITERS } from './options.ts';
import { scanRows } from './parser.ts';
import type { Detection, DetectionCandidate, Newline } from './types.ts';

// The build's lib (es2022) has no TextDecoder; this is the part used here.
declare const TextDecoder: new (
  label: 'utf-8',
  options: { fatal: boolean; ignoreBOM: boolean },
) => { decode(input?: Uint8Array, options?: { stream?: boolean }): string };

/** Units of the text that detection reads. */
export const SAMPLE_UNITS = 65_536;
/** Bytes checked as UTF-8, and decoded: never fewer units than the sample. */
const UTF8_BYTES = 262_144;
const MAX_PREAMBLE_LINES = 20;
/** A longer cell is not tested against the three patterns. */
const MAX_VALUE_UNITS = 64;
const MIN_VALUE_SHARE = 1e-10;
const CR = 0x0d;
const LF = 0x0a;
const BREAKS: readonly Newline[] = ['\r\n', '\n', '\r'];

// The grouped alternative of NUMBER_CELL takes one separator and three digits per repetition and
// fails at one place, after which \d+ is tried once: a constant number of passes over the cell.
export const NUMBER_CELL =
  /^[+-]?(?:\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d+)(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?$/;
export const DATE_CELL =
  /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export const TIME_CELL = /^\d{1,2}:\d{2}(?::\d{2})?$/;

/**
 * The sample, for a text that has no BOM and no sep= line left: the text, or when it is longer
 * than SAMPLE_UNITS its first SAMPLE_UNITS units cut after their last "\r" or "\n" (uncut when
 * they hold none, except that a pair's high surrogate is not left at the end).
 */
export function sampleOf(text: string): string {
  if (text.length <= SAMPLE_UNITS) return text;
  const last = SAMPLE_UNITS - 1;
  const cut = Math.max(text.lastIndexOf('\n', last), text.lastIndexOf('\r', last));
  if (cut !== -1) return text.slice(0, cut + 1);
  const code = text.charCodeAt(last);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? last : SAMPLE_UNITS);
}

/** 'sep=' + one valid delimiter unit as the whole first line: that unit, else undefined. */
export function sepLineDelimiter(text: string, newline: string): string | undefined {
  if (text.length < 5 || !text.startsWith('sep=')) return undefined;
  const unit = text.charAt(4);
  if (BAD_DELIMITERS.includes(unit)) return undefined;
  return text.length === 5 || text.startsWith(newline, 5) ? unit : undefined;
}

/**
 * The leading free lines of sample for one quote: where they end and how many they are; 0 and 0
 * when nothing is skipped. A physical line ("\r\n", "\n" or "\r" ends it) is free when, with quote
 * toggling a quoted span, it holds none of delimiters outside quotes and does not end inside a
 * span. Nothing is skipped when more than MAX_PREAMBLE_LINES lines are free or no line follows
 * them.
 */
function preambleOf(
  sample: string,
  delimiters: readonly string[],
  quote: string,
): { end: number; lines: number } {
  const quoteCode = quote.length === 1 ? quote.charCodeAt(0) : -1;
  const length = sample.length;
  let at = 0;
  let lines = 0;
  while (at < length && lines <= MAX_PREAMBLE_LINES) {
    let quoted = false;
    let i = at;
    for (; i < length; i++) {
      const code = sample.charCodeAt(i);
      if (code === CR || code === LF) break;
      if (code === quoteCode) quoted = !quoted;
      else if (!quoted && delimiters.some((delimiter) => sample.startsWith(delimiter, i))) {
        return { end: at, lines };
      }
    }
    if (quoted) return { end: at, lines };
    // A free last line without a line break: the whole sample is free.
    if (i === length) break;
    at = i + (sample.charCodeAt(i) === CR && sample.charCodeAt(i + 1) === LF ? 2 : 1);
    lines++;
  }
  return { end: 0, lines: 0 };
}

const isValue = (trimmed: string) =>
  trimmed.length <= MAX_VALUE_UNITS &&
  (NUMBER_CELL.test(trimmed) || DATE_CELL.test(trimmed) || TIME_CELL.test(trimmed));

/** The records of table under one candidate, without the final [''] a closing line break adds. */
function read(
  table: string,
  delimiter: string,
  newline: Newline,
  quoteChar: string,
  escapeChar: string,
): string[][] {
  const { rows } = scanRows(table, {
    delimiter,
    newline,
    quoteChar,
    escapeChar,
    comments: '',
    preview: 0,
    fastMode: false,
  });
  const last = rows.at(-1);
  if (last?.length === 1 && last[0] === '') rows.pop();
  return rows;
}

/**
 * score = P × T. With N records and K distinct field counts L_k occurring N_k times,
 * P = (1/K) × Σ (N_k/N) × (L_k − 1)/L_k. T is the share of cells that, trimmed, are empty, match
 * one of the three patterns, or hold none of marks (the delimiters scored and both quotes); at
 * least MIN_VALUE_SHARE. columns is the most frequent field count, the larger on a tie.
 */
function scoreOf(rows: string[][], marks: readonly string[]): { score: number; columns: number } {
  const counts = new Map<number, number>();
  let cells = 0;
  let clean = 0;
  for (const row of rows) {
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    for (const cell of row) {
      const trimmed = cell.trim();
      cells++;
      if (trimmed === '' || isValue(trimmed) || !marks.some((mark) => trimmed.includes(mark))) {
        clean++;
      }
    }
  }
  let pattern = 0;
  let columns = 1;
  let most = 0;
  for (const [fields, records] of counts) {
    pattern += ((records / rows.length) * (fields - 1)) / fields;
    if (records > most || (records === most && fields > columns)) {
      most = records;
      columns = fields;
    }
  }
  if (counts.size > 0) pattern /= counts.size;
  return { score: pattern * Math.max(cells === 0 ? 0 : clean / cells, MIN_VALUE_SHARE), columns };
}

/** True when at least two records were read and every cell of the first is non-empty, distinct and no value. */
function headerGuess(rows: string[][]): boolean {
  const first = (rows[0] ?? []).map((cell) => cell.trim());
  return (
    rows.length >= 2 &&
    new Set(first).size === first.length &&
    first.every((cell) => cell !== '' && !isValue(cell))
  );
}

/**
 * The dialect of text (no BOM): a sep= line, then per quote candidate the preamble, then every
 * candidate scored on the sample after its preamble. fixed holds the options the caller gave
 * explicitly; a fixed delimiter or a sep= line leaves only that delimiter, which is then the one
 * a preamble line must not hold. start is an offset in text.
 *
 * Candidates, in tie order: each delimiter × '"' then "'" × the quote doubled then "\". "'" is
 * scored only when the sample holds one, and "\" only when the sample holds it before that
 * quote. The highest score wins; when every candidate reads one field per record, the first.
 * With whole, the text is the table: no sep= line is read and no preamble is looked for (detect
 * never sets it).
 */
export function detectDialect(
  text: string,
  candidates: readonly string[],
  fixed: Partial<Pick<Detection, 'delimiter' | 'newline' | 'quoteChar' | 'escapeChar'>> = {},
  whole = false,
): Detection {
  let sepDelimiter: string | undefined;
  let sepEnd = 0;
  for (const newline of whole ? [] : fixed.newline === undefined ? BREAKS : [fixed.newline]) {
    sepDelimiter = sepLineDelimiter(text, newline);
    if (sepDelimiter !== undefined) {
      sepEnd = Math.min(text.length, 5 + newline.length);
      break;
    }
  }
  const sample = sampleOf(sepEnd === 0 ? text : text.slice(sepEnd));
  const delimiters =
    fixed.delimiter !== undefined
      ? [fixed.delimiter]
      : sepDelimiter !== undefined
        ? [sepDelimiter]
        : candidates;
  const quotes =
    fixed.quoteChar !== undefined ? [fixed.quoteChar] : sample.includes("'") ? ['"', "'"] : ['"'];
  const marks = [...new Set([...delimiters, ...quotes, '"', "'"])].filter((mark) => mark !== '');
  const tables = quotes.map((quoteChar) => {
    const preamble = whole ? { end: 0, lines: 0 } : preambleOf(sample, delimiters, quoteChar);
    const table = sample.slice(preamble.end);
    const escapes =
      fixed.escapeChar !== undefined
        ? [fixed.escapeChar]
        : sample.includes(`\\${quoteChar}`)
          ? [quoteChar, '\\']
          : [quoteChar];
    return {
      quoteChar,
      preamble,
      table,
      escapes,
      newline: fixed.newline ?? guessNewline(table, quoteChar),
    };
  });

  const scored: DetectionCandidate[] = [];
  let best: (DetectionCandidate & { columns: number; rows: string[][] }) | undefined;
  let bestTable = tables[0];
  for (const delimiter of delimiters) {
    for (const candidate of tables) {
      const { quoteChar, table, newline } = candidate;
      for (const escapeChar of candidate.escapes) {
        const rows = read(table, delimiter, newline, quoteChar, escapeChar);
        const { score, columns } = scoreOf(rows, marks);
        scored.push({ delimiter, quoteChar, escapeChar, score });
        if (best === undefined || score > best.score) {
          best = { delimiter, quoteChar, escapeChar, score, columns, rows };
          bestTable = candidate;
        }
      }
    }
  }
  if (best === undefined || bestTable === undefined) {
    throw new TypeError('Expected at least one delimiter candidate');
  }
  const { delimiter, quoteChar, escapeChar, score, columns } = best;
  let { rows } = best;
  let { preamble, newline } = bestTable;
  // Nothing is skipped when no delimiter was found: the free lines are the one-column table.
  if (columns === 1 && preamble.end !== 0) {
    preamble = { end: 0, lines: 0 };
    newline = fixed.newline ?? guessNewline(sample, quoteChar);
    rows = read(sample, delimiter, newline, quoteChar, escapeChar);
  }
  const header = headerGuess(rows);
  return {
    delimiter,
    newline,
    quoteChar,
    escapeChar,
    header,
    start: sepEnd + preamble.end,
    preamble: sample.slice(0, preamble.end),
    preambleLines: preamble.lines,
    sepLine: sepDelimiter !== undefined,
    columns,
    score,
    // Stable: equal scores keep the candidate order.
    candidates: scored.sort((a, b) => b.score - a.score).slice(0, 5),
    config: { delimiter, newline, quoteChar, escapeChar, header },
  };
}

/**
 * Where bytes stop being UTF-8 (the offset where the bad sequence starts), or -1. With more, a
 * sequence that the end of bytes cuts is not an error: the input goes on.
 */
function invalidUtf8(bytes: Uint8Array, more: boolean): number {
  const length = bytes.length;
  let i = 0;
  while (i < length) {
    const lead = bytes[i] as number;
    if (lead < 0x80) {
      i++;
      continue;
    }
    // The second byte's range excludes overlong forms, surrogates and code points past U+10FFFF.
    let low = 0x80;
    let high = 0xbf;
    let need: number;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) low = 0xa0;
      else if (lead === 0xed) high = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) low = 0x90;
      else if (lead === 0xf4) high = 0x8f;
    } else return i;
    for (let k = 1; k <= need; k++) {
      if (i + k >= length) return more ? -1 : i;
      const next = bytes[i + k] as number;
      if (next < low || next > high) return i;
      low = 0x80;
      high = 0xbf;
    }
    i += need + 1;
  }
  return -1;
}

/** The UTF-8 length of text.slice(0, units), which ends at a code point. */
function utf8Length(text: string, units: number): number {
  let bytes = 0;
  for (let i = 0; i < units; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function detectText(text: string, candidates: readonly string[]): Detection {
  if (text.charCodeAt(0) !== 0xfeff) return detectDialect(text, candidates);
  const found = detectDialect(text.slice(1), candidates);
  found.start += 1;
  return found;
}

function detectBytes(bytes: Uint8Array, candidates: readonly string[]): Detection {
  const [b0, b1, b2] = bytes;
  let encoding: NonNullable<Detection['encoding']>;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) encoding = { name: 'utf-8', evidence: 'bom' };
  else if (b0 === 0xff && b1 === 0xfe) encoding = { name: 'utf-16le', evidence: 'bom' };
  else if (b0 === 0xfe && b1 === 0xff) encoding = { name: 'utf-16be', evidence: 'bom' };
  else {
    const invalidAt = invalidUtf8(bytes.subarray(0, UTF8_BYTES), bytes.length > UTF8_BYTES);
    encoding =
      invalidAt === -1
        ? { name: 'utf-8', evidence: 'valid' }
        : { name: 'unknown', evidence: 'invalid', invalidAt };
  }
  if (encoding.name !== 'utf-8') {
    // Reported, not decoded: the dialect fields are the defaults.
    const dialect = { delimiter: ',', newline: '\n', quoteChar: '"', escapeChar: '"' } as const;
    return {
      ...dialect,
      header: false,
      start: 0,
      preamble: '',
      preambleLines: 0,
      sepLine: false,
      columns: 1,
      score: 0,
      candidates: [],
      encoding,
      config: { ...dialect, header: false },
    };
  }
  // A BOM stays in the text as U+FEFF, three bytes either way; a sequence the window cuts is held back.
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(
    bytes.subarray(0, UTF8_BYTES),
    { stream: true },
  );
  const found = detectText(text, candidates);
  found.start = utf8Length(text, found.start);
  found.encoding = encoding;
  return found;
}

const invalid = (expected: string) =>
  new TypeError(`Detect option "delimitersToGuess" must be ${expected}`);

/**
 * Detects the dialect of a CSV text from its first 65,536 UTF-16 units: delimiter, newline, quote
 * and escape, a header guess, a sep= line, and the leading lines to skip (only lines without a
 * candidate delimiter outside quotes, at most 20, reported whole in preamble). For bytes it also
 * reports what the encoding looks like, and reads the dialect only when that is UTF-8.
 *
 * @example
 * ```ts
 * import { detect, parse } from 'csvloom';
 *
 * const text = 'sep=;\nid;name\n1;Ada\n';
 * const dialect = detect(text); // delimiter ';', sepLine true, header true, start 6
 * parse(text.slice(dialect.start), { ...dialect.config, skipEmptyLines: true }).data;
 * // [{ id: '1', name: 'Ada' }]
 * ```
 */
export function detect(
  input: string | Uint8Array,
  config?: { delimitersToGuess?: readonly string[] },
): Detection {
  const options: unknown = config;
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('Expected the detect config to be an object or undefined');
  }
  for (const key of Object.keys(config ?? {})) {
    if (key !== 'delimitersToGuess') throw new TypeError(`Unknown detect option "${key}"`);
  }
  const guesses: unknown = config?.delimitersToGuess;
  let candidates = DEFAULT_DELIMITERS;
  if (guesses !== undefined) {
    if (!Array.isArray(guesses) || guesses.length === 0) throw invalid('a non-empty array');
    // A copy, with holes read as undefined (and rejected).
    candidates = Array.from(guesses as unknown[], (candidate) => {
      if (
        typeof candidate !== 'string' ||
        candidate === '' ||
        BAD_DELIMITERS.includes(candidate) ||
        candidate.includes('\r') ||
        candidate.includes('\n')
      ) {
        throw invalid(
          'made of non-empty strings other than \'"\' and "\\ufeff", free of "\\r" and "\\n"',
        );
      }
      return candidate;
    });
  }
  if (typeof input === 'string') return detectText(input, candidates);
  if (input instanceof Uint8Array) return detectBytes(input, candidates);
  throw new TypeError('Expected a string or Uint8Array input');
}
