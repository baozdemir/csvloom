import type { Newline, QuoteError } from './types.ts';

export interface ScanResult {
  rows: string[][];
  errors: QuoteError[];
  /**
   * UTF-16 offset where the last record read and its line break end: the
   * input length unless comment lines end the input or preview ends the scan.
   */
  cursor: number;
  /** True when preview ended the scan. */
  truncated: boolean;
}

/**
 * A non-empty delimiter without "\r" or "\n"; quoteChar and escapeChar as in
 * ParseConfig; comments is the comment marker, or '' for none.
 */
export interface ScanDialect {
  delimiter: string;
  newline: Newline;
  quoteChar: string;
  escapeChar: string;
  comments: string;
  /** Records to read, a header record included; 0 means no limit. */
  preview: number;
  /**
   * Count preview by lines, as Papa's split path does; only for input in which
   * no quoted field opens, so that every line is one record or comment.
   */
  fastMode: boolean;
}

/** A cached search position that has not been searched yet. */
export const SEARCH = -2;

/** One call's part of a scan that is spread over several calls and texts. The caller reuses one object. */
export interface ScanWindow {
  /** In: where the scan starts, always a record start. Out: where the next call starts. */
  cursor: number;
  /** In: the most records to read in this call; at least 1. */
  limit: number;
  /** In: true when the input ends with this text, so the last record ends as in bulk; false withholds a record that no line break ends. */
  final: boolean;
  /** In and out: scanRows' cached search positions; SEARCH before the first call on a text. */
  nextDelimiter: number;
  nextNewline: number;
  nextQuote: number;
  /** Out: where the last record read in this call ends, line break included; -1 when it read none. */
  end: number;
  /** Out: why the call returned. */
  stop: 'limit' | 'tail' | 'end';
}

const LF_CODE = 0x0a;

/**
 * Splits CSV text into records of string fields. The scan follows Papa Parse
 * 5.7.0's core loop so malformed input produces the same records and errors:
 *
 * - A quote opens a quoted field only as the field's first character; anywhere
 *   else it is data. A quoteChar that is not one UTF-16 unit never opens one.
 * - A quoted field closes at a quote followed by the delimiter or the newline,
 *   optionally after whitespace that is then dropped. A quote followed by
 *   anything else is recorded as InvalidQuotes and the field stays open.
 * - When escapeChar is quoteChar, a doubled quote is one quote of data.
 *   Otherwise a quote right after escapeChar is data, and each escapeChar +
 *   quoteChar pair in the closed field becomes quoteChar. A quote that ends the
 *   input closes the field even after escapeChar.
 * - Without a closing quote, the rest of the input is one raw field
 *   (MissingQuotes); escaped quotes in it are kept as written.
 * - A line break that ends the input still starts one more record, [''].
 * - At the start of a record, unless a quote opens a field there, a line that
 *   starts with the comment marker is skipped with its line break; a comment
 *   line that ends the input ends the scan without a record.
 * - preview ends the scan as Papa's two paths do. Without fastMode: after the
 *   record that brings the count to preview, if a line break ends it. With
 *   fastMode: after the first record on line `preview` or later, comment lines
 *   counted, even at the end of the input; that record is dropped when preview
 *   records were already read.
 *
 * With emit, each record is passed to emit instead of being collected in rows,
 * which stays empty. The array passed is reused for the next record.
 *
 * With window, the call is one step of a scan that the caller spreads over
 * several calls and texts. dialect.preview must be 0 and dialect.fastMode
 * false: the caller counts records itself. The scan starts at window.cursor,
 * a record start, and returns in window.stop why it stopped:
 *
 * - 'limit': window.limit records were read. window.cursor is window.end; the
 *   comment lines after the last record are not skipped yet.
 * - 'tail', only when window.final is false: the text ended inside a record
 *   or a comment line, which is withheld: nothing of it was emitted and its
 *   Quotes errors are dropped. window.cursor is where it starts; comment lines
 *   before it are consumed. Withheld are: an unquoted last field that reaches
 *   the end of the text (also an empty one after a delimiter); a quoted field
 *   with no closing quote in the text, or whose closing quote is the text's
 *   last unit; a comment line with no line break in the text.
 * - 'end': the text was consumed and window.cursor is its length. With
 *   window.final the last record ended as at the end of the input, and the
 *   result's cursor is bulk's. Without it, the text ended at a record start;
 *   the [''] record after a final line break is made only by a final call. An
 *   empty text has no record in either case.
 *
 * A Quotes error's row counts the records read in this call and its index is
 * an offset in input; the caller rebases both. The cached search positions are
 * returned for the next call on the same text.
 */
export function scanRows(
  input: string,
  dialect: ScanDialect,
  emit?: (row: readonly string[]) => void,
  window?: ScanWindow,
): ScanResult {
  const rows: string[][] = [];
  const errors: QuoteError[] = [];
  const inputLength = input.length;
  if (inputLength === 0) {
    if (window !== undefined) {
      window.cursor = 0;
      window.end = -1;
      window.stop = 'end';
    }
    return { rows, errors, cursor: 0, truncated: false };
  }

  const { delimiter, newline, quoteChar, escapeChar, comments } = dialect;
  const delimiterLength = delimiter.length;
  const delimiterCode = delimiter.charCodeAt(0);
  const newlineLength = newline.length;
  const newlineCode = newline.charCodeAt(0);
  // -1 matches no character code: such a quote, double or escape never occurs.
  const quoteCode = quoteChar.length === 1 ? quoteChar.charCodeAt(0) : -1;
  const doubles = escapeChar === quoteChar;
  const doubleCode = doubles ? quoteCode : -1;
  const escapeCode = !doubles && escapeChar.length === 1 ? escapeChar.charCodeAt(0) : -1;
  // Replaced by quoteChar in each closed quoted field; '' when quotes double.
  const escaped = doubles ? '' : escapeChar + quoteChar;
  // Gates afterRecord, so a parse without these features does no extra work per record.
  const recordEnd = comments !== '' || dialect.preview !== 0 || window !== undefined;
  // A record that no line break ends is not read: more text may follow.
  const withhold = window !== undefined && !window.final;
  // With fastMode, where line `preview` starts; -1 when there is no such line or preview is 0.
  const lineStop =
    dialect.fastMode && dialect.preview !== 0 ? lineStart(input, dialect.preview, newline) : -1;
  // Preallocated at the previous record's width so wide records do not grow field by field.
  let row: string[] = [];
  let count = 0;
  // Records passed to emit; without emit, rows.length counts them.
  let emitted = 0;
  let cursor = 0;
  // Cached search results: -1 or the first match at or after where they were searched from.
  let nextDelimiter: number;
  let nextNewline: number;
  // Until the scan passes the first quote, the per-field quote test is one comparison instead of
  // a charCodeAt. After it, charCodeAt is never called at the input's end: an out-of-bounds read
  // deoptimizes the scan in V8.
  const NO_QUOTE = inputLength + 1;
  let nextQuote: number;
  // Seeding these from SEARCH or the window here would make V8 compile every parse's positions as
  // values of unknown range, so a bulk parse starts them from the searches alone.
  if (window === undefined) {
    nextDelimiter = input.indexOf(delimiter);
    nextNewline = input.indexOf(newline);
    nextQuote = quoteCode === -1 ? -1 : input.indexOf(quoteChar);
    if (nextQuote === -1) nextQuote = NO_QUOTE;
  } else {
    ({ cursor, nextDelimiter, nextNewline, nextQuote } = window);
    if (nextDelimiter === SEARCH) nextDelimiter = input.indexOf(delimiter, cursor);
    if (nextNewline === SEARCH) nextNewline = input.indexOf(newline, cursor);
    if (nextQuote === SEARCH) {
      nextQuote = quoteCode === -1 ? -1 : input.indexOf(quoteChar, cursor);
      if (nextQuote === -1) nextQuote = NO_QUOTE;
    }
    window.nextQuote = nextQuote;
    window.end = -1;
  }
  const from = cursor;
  if (comments !== '') {
    cursor =
      window === undefined
        ? skipComments(input, cursor, comments, newline, quoteCode)
        : windowComments(input, cursor, dialect, quoteCode, window);
    if (cursor === -1) {
      return window === undefined
        ? { rows, errors, cursor: 0, truncated: false }
        : closeWindow(
            window,
            rows,
            errors,
            0,
            -1,
            false,
            from,
            nextDelimiter,
            nextNewline,
            inputLength,
          );
    }
  }
  // The afterRecord result that ended the scan; 0 when the input ended it.
  let ended = 0;
  // True when the scan ended inside a record that is withheld.
  let withheld = false;

  scan: for (;;) {
    if (
      nextQuote <= cursor &&
      (nextQuote === cursor || (cursor !== inputLength && input.charCodeAt(cursor) === quoteCode))
    ) {
      let quote = cursor;
      cursor++;
      let value = '';
      let segment = cursor;
      for (;;) {
        quote = input.indexOf(quoteChar, quote + 1);
        if (quote === -1) {
          if (withhold) {
            withheld = true;
            break scan;
          }
          errors.push({
            type: 'Quotes',
            code: 'MissingQuotes',
            message: 'Quoted field unterminated',
            row: emit === undefined ? rows.length : emitted,
            index: cursor,
          });
          row[count++] = input.slice(cursor);
          if (emit === undefined) rows.push(endRecord(row, count));
          else emit(endRecord(row, count));
          break scan;
        }
        if (quote === inputLength - 1) {
          if (withhold) {
            withheld = true;
            break scan;
          }
          row[count++] = fieldValue(input, value, segment, quote, escaped, quoteChar);
          if (emit === undefined) rows.push(endRecord(row, count));
          else emit(endRecord(row, count));
          break scan;
        }
        const next = input.charCodeAt(quote + 1);
        if (next === doubleCode) {
          value += input.slice(segment, quote + 1);
          quote++;
          segment = quote + 1;
          continue;
        }
        if (escapeCode !== -1 && input.charCodeAt(quote - 1) === escapeCode) continue;
        if (
          next === delimiterCode &&
          (delimiterLength === 1 || input.startsWith(delimiter, quote + 1))
        ) {
          row[count++] = fieldValue(input, value, segment, quote, escaped, quoteChar);
          cursor = quote + 1 + delimiterLength;
          break;
        }
        if (
          next === newlineCode &&
          (newlineLength === 1 || input.charCodeAt(quote + 2) === LF_CODE)
        ) {
          row[count++] = fieldValue(input, value, segment, quote, escaped, quoteChar);
          if (emit === undefined) {
            rows.push(endRecord(row, count));
            row = new Array<string>(count);
          } else {
            emit(endRecord(row, count));
            emitted++;
          }
          count = 0;
          cursor = quote + 1 + newlineLength;
          if (recordEnd) {
            const start = afterRecord(
              input,
              cursor,
              rows.length + emitted,
              dialect,
              quoteCode,
              lineStop,
              window,
            );
            if (start < 0) {
              ended = start;
              break scan;
            }
            cursor = start;
          }
          break;
        }
        // Searched again only when passed, so a run of malformed quotes
        // costs linear time in total.
        if (nextDelimiter !== -1 && nextDelimiter <= quote) {
          nextDelimiter = input.indexOf(delimiter, quote + 1);
        }
        if (nextNewline !== -1 && nextNewline <= quote) {
          nextNewline = input.indexOf(newline, quote + 1);
        }
        const end = closingSpaces(input, quote, delimiter, newline, nextDelimiter, nextNewline);
        if (end !== -1) {
          row[count++] = fieldValue(input, value, segment, quote, escaped, quoteChar);
          if (input.charCodeAt(end) === delimiterCode) cursor = end + delimiterLength;
          else {
            if (emit === undefined) {
              rows.push(endRecord(row, count));
              row = new Array<string>(count);
            } else {
              emit(endRecord(row, count));
              emitted++;
            }
            count = 0;
            cursor = end + newlineLength;
            if (recordEnd) {
              const start = afterRecord(
                input,
                cursor,
                rows.length + emitted,
                dialect,
                quoteCode,
                lineStop,
                window,
              );
              if (start < 0) {
                ended = start;
                break scan;
              }
              cursor = start;
            }
          }
          break;
        }
        errors.push({
          type: 'Quotes',
          code: 'InvalidQuotes',
          message: 'Trailing quote on quoted field is malformed',
          row: emit === undefined ? rows.length : emitted,
          index: cursor,
        });
        // Papa resumes the closing-quote search two characters on, even past a quote.
        quote++;
      }
      continue;
    }

    if (nextDelimiter !== -1 && nextDelimiter < cursor) {
      nextDelimiter = input.indexOf(delimiter, cursor);
    }
    if (nextNewline !== -1 && nextNewline < cursor) nextNewline = input.indexOf(newline, cursor);
    // A run of unquoted fields ended by delimiters, with the next field's quote test made once
    // here. Only the cached line break can go stale (a multi-unit delimiter can end past it).
    while (nextDelimiter !== -1 && (nextDelimiter < nextNewline || nextNewline === -1)) {
      row[count++] = input.slice(cursor, nextDelimiter);
      cursor = nextDelimiter + delimiterLength;
      if (
        nextQuote <= cursor &&
        (nextQuote === cursor || (cursor !== inputLength && input.charCodeAt(cursor) === quoteCode))
      ) {
        continue scan;
      }
      nextDelimiter = input.indexOf(delimiter, cursor);
      if (nextNewline !== -1 && nextNewline < cursor) nextNewline = input.indexOf(newline, cursor);
    }
    if (nextNewline !== -1) {
      row[count++] = input.slice(cursor, nextNewline);
      if (emit === undefined) {
        rows.push(endRecord(row, count));
        row = new Array<string>(count);
      } else {
        emit(endRecord(row, count));
        emitted++;
      }
      count = 0;
      cursor = nextNewline + newlineLength;
      if (recordEnd) {
        const start = afterRecord(
          input,
          cursor,
          rows.length + emitted,
          dialect,
          quoteCode,
          lineStop,
          window,
        );
        if (start < 0) {
          ended = start;
          break scan;
        }
        cursor = start;
      }
      nextNewline = input.indexOf(newline, cursor);
      continue;
    }
    if (withhold) {
      // At a record start at the end of the text there is nothing to withhold.
      withheld = count !== 0 || cursor !== inputLength;
      break;
    }
    row[count++] = input.slice(cursor);
    if (emit === undefined) rows.push(endRecord(row, count));
    else emit(endRecord(row, count));
    break;
  }

  if (window !== undefined) {
    return closeWindow(
      window,
      rows,
      errors,
      rows.length + emitted,
      ended,
      withheld,
      cursor,
      nextDelimiter,
      nextNewline,
      inputLength,
    );
  }
  let truncated = ended < -1;
  if (ended === 0) {
    cursor = inputLength;
    // lineStop is -1 whenever a quoted field can end the input.
    truncated = lineStop !== -1;
  } else if (truncated) cursor = -2 - ended;
  return { rows, errors, cursor, truncated };
}

/**
 * Ends a call that has a window: sets what the window returns and makes the
 * result. records counts the records read, ended and withheld are the scan's,
 * and cursor is where the last record's line break ends when afterRecord
 * ended the scan, or the call's start when it read no record.
 *
 * A record that a line break ends inside the text scans as it does in the whole
 * input, so only the record no line break ends can differ, and it is withheld
 * whole.
 */
function closeWindow(
  window: ScanWindow,
  rows: string[][],
  errors: QuoteError[],
  records: number,
  ended: number,
  withheld: boolean,
  cursor: number,
  nextDelimiter: number,
  nextNewline: number,
  inputLength: number,
): ScanResult {
  window.nextDelimiter = nextDelimiter;
  window.nextNewline = nextNewline;
  if (ended < -1) {
    // The limit, which afterRecord reports as it reports preview.
    window.stop = 'limit';
    window.cursor = cursor;
  } else if (withheld || (ended === -1 && !window.final)) {
    window.stop = 'tail';
    while (errors.at(-1)?.row === records) errors.pop();
    // Both were searched from inside the withheld record.
    window.nextDelimiter = SEARCH;
    window.nextNewline = SEARCH;
    cursor = window.cursor;
  } else {
    window.stop = 'end';
    window.cursor = inputLength;
    if (ended === 0) {
      cursor = inputLength;
      // The end of the input ended a record, the [''] after a final line break included.
      if (window.final) window.end = inputLength;
    }
  }
  return { rows, errors, cursor, truncated: false };
}

/**
 * The work after a record that ends in a line break, when there are comments,
 * a preview limit or a window; cursor is where the line break ends and records
 * counts the records read. Returns where the next record starts, or, when the
 * scan ends here, -1 if preview did not end it (comment lines run to the end
 * of the input) and otherwise -2 minus the cursor at which preview ended it:
 * - Papa's full path: when records reaches preview;
 * - its split path (fastMode): after a record on line `preview` or later,
 *   whose line break ends after lineStop; when records reaches preview first,
 *   Papa reads the next line that is not a comment and drops its record.
 * With a window, its limit takes the place of preview in the full path, and
 * the window gets the record's end and the next record's start.
 */
function afterRecord(
  input: string,
  cursor: number,
  records: number,
  dialect: ScanDialect,
  quoteCode: number,
  lineStop: number,
  window: ScanWindow | undefined,
): number {
  const { comments, newline } = dialect;
  if (window !== undefined) {
    window.end = cursor;
    if (records === window.limit) return -2 - cursor;
    if (comments !== '') return windowComments(input, cursor, dialect, quoteCode, window);
    window.cursor = cursor;
    return cursor;
  }
  if (lineStop !== -1 && cursor > lineStop) return -2 - cursor;
  if (records === dialect.preview) {
    if (!dialect.fastMode) return -2 - cursor;
    const start =
      comments === '' ? cursor : skipComments(input, cursor, comments, newline, quoteCode);
    if (start === -1) return -1;
    const end = input.indexOf(newline, start);
    return -2 - (end === -1 ? input.length : end + newline.length);
  }
  return comments === '' ? cursor : skipComments(input, cursor, comments, newline, quoteCode);
}

/** Where line `line` starts, counting from 0 and splitting at newline; -1 when there are fewer lines. */
export function lineStart(input: string, line: number, newline: string): number {
  let start = 0;
  for (let i = 0; i < line; i++) {
    const end = input.indexOf(newline, start);
    if (end === -1) return -1;
    start = end + newline.length;
  }
  return start;
}

/**
 * Where the record after the comment lines at cursor starts, or -1 when they
 * run to the end of the input. A quote opens a field even where the marker
 * starts with it: Papa tests for the quote first.
 */
function skipComments(
  input: string,
  cursor: number,
  comments: string,
  newline: string,
  quoteCode: number,
): number {
  while (input.charCodeAt(cursor) !== quoteCode && input.startsWith(comments, cursor)) {
    const end = input.indexOf(newline, cursor);
    if (end === -1) return -1;
    cursor = end + newline.length;
  }
  return cursor;
}

/**
 * skipComments for a window, which gets the result as its cursor. When the
 * comment lines run to the end of the text, the cursor is where the last of
 * them starts: no line break ends that line, so it is withheld unless the
 * input ends here.
 */
function windowComments(
  input: string,
  cursor: number,
  dialect: ScanDialect,
  quoteCode: number,
  window: ScanWindow,
): number {
  const { newline } = dialect;
  const start = skipComments(input, cursor, dialect.comments, newline, quoteCode);
  if (start !== -1) window.cursor = start;
  else {
    const last = input.lastIndexOf(newline);
    window.cursor = last < cursor ? cursor : last + newline.length;
  }
  return start;
}

/**
 * Papa's rule for whitespace after a closing quote, for a quote that is not
 * doubled or escaped and not directly followed by the delimiter or the
 * newline. Returns where the delimiter or newline that closes the field
 * starts, or -1 when the quote is malformed. nextDelimiter and nextNewline are
 * the first matches after the quote, or -1. Papa measures the whitespace up to
 * whichever of the two comes first; with a newline but no later delimiter it
 * uses -1 (Math.min), meaning no whitespace, for the delimiter check.
 */
function closingSpaces(
  input: string,
  quote: number,
  delimiter: string,
  newline: string,
  nextDelimiter: number,
  nextNewline: number,
): number {
  const fieldEnd = nextNewline === -1 ? nextDelimiter : Math.min(nextDelimiter, nextNewline);
  const delimiterAt = quote + 1 + spacesBefore(input, quote, fieldEnd);
  if (input.startsWith(delimiter, delimiterAt)) return delimiterAt;
  const newlineAt = quote + 1 + spacesBefore(input, quote, nextNewline);
  if (input.startsWith(newline, newlineAt)) return newlineAt;
  return -1;
}

// \s is exactly what String.prototype.trim removes. Unlike a trim() test, the anchored match
// stops at the first non-whitespace unit, so repeated malformed quotes stay linear.
const WHITESPACE_ONLY = /^\s+$/;

/** Length of the text between a quote and end when it is whitespace only, else 0. */
function spacesBefore(input: string, quote: number, end: number): number {
  return end > quote + 1 && WHITESPACE_ONLY.test(input.slice(quote + 1, end)) ? end - quote - 1 : 0;
}

function endRecord(row: string[], count: number): string[] {
  if (row.length !== count) row.length = count;
  return row;
}

// value is the field up to and including the first quote of its last doubled
// quote, or '' when it has none; the rest of the field runs from segment to end.
// escaped is escapeChar + quoteChar when quotes do not double (value is then
// always ''), else ''.
const fieldValue = (
  input: string,
  value: string,
  segment: number,
  end: number,
  escaped: string,
  quoteChar: string,
) => {
  if (value !== '') return value + input.slice(segment, end);
  return escaped === ''
    ? input.slice(segment, end)
    : input.slice(segment, end).replaceAll(escaped, quoteChar);
};
