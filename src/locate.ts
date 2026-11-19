import { scanRows, type ScanDialect } from './parser.ts';
import type { Located, ParseError, Position, SchemaError } from './types.ts';

const CR = 0x0d;
const LF = 0x0a;
const MIN_WINDOW = 256;
const SNIPPET = 120;
const ignore = () => undefined;

/**
 * Start offsets in text of the records with these 0-based ordinals (ascending; records as scanRows
 * emits them, comment lines not counted); -1 for an ordinal past the last record.
 *
 * Each lookup scans a window of w units from the last start found, with preview set to the records
 * still to pass; a truncated scan's cursor is the one the whole text gives. Otherwise w doubles
 * until the window reaches the end of the text. The next lookup starts at half the w that worked,
 * so the units scanned stay below 6 × text.length + 256 × ordinals.length.
 */
export function recordStarts(
  text: string,
  dialect: ScanDialect,
  ordinals: readonly number[],
): number[] {
  // Ordinal 0 needs no scan, and preview 0 would mean no limit.
  let from = text === '' ? -1 : afterComments(text, 0, dialect);
  let at = 0;
  let w = MIN_WINDOW;
  return ordinals.map((ordinal) => {
    if (from === -1 || ordinal <= at) return from;
    const lookup: ScanDialect = { ...dialect, preview: ordinal - at, fastMode: false };
    at = ordinal;
    for (;;) {
      const scan = scanRows(text.slice(from, from + w), lookup, ignore);
      if (scan.truncated) {
        from = afterComments(text, from + scan.cursor, dialect);
        w = Math.max(MIN_WINDOW, w / 2);
        return from;
      }
      if (from + w >= text.length) {
        from = -1;
        return from;
      }
      w *= 2;
    }
  });
}

/**
 * A copy of parser.ts's private skipComments: where the record after the comment lines at cursor
 * starts, or -1 when they run to the end of the text. A quote opens a field even where the marker
 * starts with it.
 */
function afterComments(text: string, cursor: number, dialect: ScanDialect): number {
  const { comments, newline, quoteChar } = dialect;
  if (comments === '') return cursor;
  const quoteCode = quoteChar.length === 1 ? quoteChar.charCodeAt(0) : -1;
  while (text.charCodeAt(cursor) !== quoteCode && text.startsWith(comments, cursor)) {
    const end = text.indexOf(newline, cursor);
    if (end === -1) return -1;
    cursor = end + newline.length;
  }
  return cursor;
}

/** What came before text in the input: units, line breaks, units since the last one, and whether the last unit was "\r". */
export interface Before {
  offset: number;
  line: number;
  column: number;
  afterCR: boolean;
}

export const START: Before = { offset: 0, line: 0, column: 0, afterCR: false };

/**
 * Positions of ascending offsets in text, in one forward pass; offsets and lines are shifted by
 * before. A "\n" right after "\r" ends no second line, so an offset at that "\n" is at column 1 of
 * the line after the "\r", as is the unit after it.
 */
export function positionsAt(
  text: string,
  offsets: readonly number[],
  before: Before = START,
): Position[] {
  let line = before.line;
  // Negative while the line started before text.
  let lineStart = -before.column;
  let afterCR = before.afterCR;
  let i = 0;
  let shownStart = Number.NaN;
  let shown = '';
  return offsets.map((offset) => {
    for (; i < offset; i++) {
      const code = text.charCodeAt(i);
      if (code === CR || code === LF) {
        if (code === CR || !afterCR) line++;
        lineStart = i + 1;
      }
      afterCR = code === CR;
    }
    if (lineStart !== shownStart) {
      shownStart = lineStart;
      shown = lineText(text, lineStart, before.afterCR);
    }
    const column = offset - lineStart + 1;
    return {
      line: line + 1,
      column,
      offset: before.offset + offset,
      snippet: cut(shown, column - 1),
    };
  });
}

/** The text of the line that starts at start (before text when negative), without its line break. */
function lineText(text: string, start: number, afterCR: boolean): string {
  let from = Math.max(0, start);
  // The "\n" of a "\r\n" that ended the line before.
  if (text.charCodeAt(from) === LF && (from === 0 ? afterCR : text.charCodeAt(from - 1) === CR)) {
    from++;
  }
  let end = from;
  while (end < text.length && text.charCodeAt(end) !== CR && text.charCodeAt(end) !== LF) end++;
  return text.slice(from, end);
}

/** The line, or the SNIPPET units from 60 before at, cut with "…" and never inside a surrogate pair. */
function cut(line: string, at: number): string {
  if (line.length <= SNIPPET) return line;
  let start = Math.max(0, at - SNIPPET / 2);
  let end = Math.min(line.length, start + SNIPPET);
  if (start > 0 && isLow(line.charCodeAt(start)) && isHigh(line.charCodeAt(start - 1))) start++;
  if (end < line.length && isHigh(line.charCodeAt(end - 1)) && isLow(line.charCodeAt(end))) end--;
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

const isHigh = (code: number) => (code & 0xfc00) === 0xd800;
const isLow = (code: number) => (code & 0xfc00) === 0xdc00;

/** before for the text that follows the first length units of text. */
export function advance(text: string, length: number, before: Before = START): Before {
  let { line, column, afterCR } = before;
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    if (code === CR || code === LF) {
      if (code === CR || !afterCR) line++;
      column = 0;
    } else column++;
    afterCR = code === CR;
  }
  return { offset: before.offset + length, line, column, afterCR };
}

/**
 * The error as text: its message and code, then, with a position, the line with a caret under the
 * unit at offset:
 *
 *     <message> [<code>] at line <line>, column <column> (row <row>, offset <offset>)
 *       <line> | <snippet>
 *              | <spaces>^
 *
 * Without a position: "<message> [<code>] (row <row>)", or "<message> [<code>]" without a row. A
 * snippet that starts with "…" past column 61 was cut on the left, 60 units before offset; a line
 * that itself starts with "…" there, or a surrogate pair at the cut, moves the caret.
 * @see parseDetailed
 */
export function formatError(error: Located<ParseError | SchemaError>): string {
  const { message, code, line, column, offset, snippet } = error;
  const row = 'row' in error ? error.row : undefined;
  const head = `${message} [${code}]`;
  if (line === undefined || column === undefined || offset === undefined || snippet === undefined) {
    return row === undefined ? head : `${head} (row ${String(row)})`;
  }
  const where = `${row === undefined ? '' : `row ${String(row)}, `}offset ${String(offset)}`;
  const number = String(line);
  const caret = column > SNIPPET / 2 + 1 && snippet.startsWith('…') ? SNIPPET / 2 + 1 : column - 1;
  return (
    `${head} at line ${number}, column ${String(column)} (${where})\n` +
    `  ${number} | ${snippet}\n` +
    `${' '.repeat(number.length + 2)} | ${' '.repeat(caret)}^`
  );
}
