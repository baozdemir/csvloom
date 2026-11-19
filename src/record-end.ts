import { SEARCH, type ScanDialect } from './parser.ts';

// Where the reader is in the record.
const LINE = 0; // the record's start, where a comment line may start
const FIELD = 1; // a field's start
const RAW = 2; // an unquoted field, which runs to the first delimiter or newline
const COMMENT = 3; // a comment line, which runs to the first newline
const QUOTED = 4; // a quoted field, up to the next quote
const SPACES = 5; // after a quote that is neither doubled nor escaped

// \s is exactly the set String.prototype.trim removes, which scanRows allows
// between a closing quote and the delimiter or newline.
const SPACE_RUN = /\s*/y;

/**
 * Finds where one record that spans several texts ends, reading each unit once.
 *
 * It applies scanRows' rules to the record's texts in order. Between calls it
 * keeps its state, the unit before the next text, and the last few units of a
 * text in which a delimiter, newline or comment marker may start; these are
 * read again in front of the next text. It makes no fields: scanRows rescans
 * the record it finds.
 */
export class RecordEnd {
  readonly #delimiter: string;
  readonly #newline: string;
  readonly #comments: string;
  readonly #quoteChar: string;
  /** -1 when quoteChar never opens a field. */
  readonly #quoteCode: number;
  readonly #doubles: boolean;
  /** -1 when no quote is data because of the unit before it. */
  readonly #escapeCode: number;
  /** The most units one decision reads from where it starts. */
  readonly #ahead: number;
  #state = LINE;
  /** In SPACES: the position is the unit right after the quote. */
  #first = false;
  /** The end of the last text, read again in front of the next one. */
  #held = '';
  /** The unit before the next text and #held; NaN at the record's start. */
  #before = NaN;
  // Cached search results as in scanRows, within one call. The delimiter is searched only up to
  // the newline found: one that starts before a line break ends before it.
  #nextDelimiter = SEARCH;
  #nextNewline = SEARCH;

  /** Uses delimiter, newline, quoteChar, escapeChar and comments; preview and fastMode are ignored. */
  constructor(dialect: ScanDialect) {
    const { delimiter, newline, quoteChar, escapeChar, comments } = dialect;
    this.#delimiter = delimiter;
    this.#newline = newline;
    this.#comments = comments;
    this.#quoteChar = quoteChar;
    this.#quoteCode = quoteChar.length === 1 ? quoteChar.charCodeAt(0) : -1;
    this.#doubles = escapeChar === quoteChar;
    this.#escapeCode = !this.#doubles && escapeChar.length === 1 ? escapeChar.charCodeAt(0) : -1;
    this.#ahead = Math.max(delimiter.length, newline.length, comments.length);
  }

  /** Starts at a record start. */
  reset(): void {
    this.#state = LINE;
    this.#first = false;
    this.#held = '';
    this.#before = NaN;
  }

  /**
   * Reads the next text of the record. Returns the offset in `text` just after the line break that
   * ends the record (or the comment line) that started at reset(), or -1 when it continues past
   * `text`. After a result other than -1, reset() comes before the next feed().
   */
  feed(text: string): number {
    const held = this.#held;
    if (held === '') return this.#read(text, 0);
    // The held units with enough of the text to decide each of them; then
    // the rest of the text in place, from where that left off.
    const ahead = this.#ahead;
    this.#held = '';
    const end = this.#read(held + text.slice(0, ahead), 0);
    if (end !== -1) return end - held.length;
    if (text.length <= ahead) return -1;
    const from = ahead - this.#held.length;
    this.#held = '';
    return this.#read(text, from);
  }

  /** Reads s from i on: the offset in s just after the line break that ends the record, or -1 after keeping what the next text needs. */
  #read(s: string, i: number): number {
    const length = s.length;
    const delimiter = this.#delimiter;
    const newline = this.#newline;
    const quoteCode = this.#quoteCode;
    let state = this.#state;
    let first = this.#first;
    this.#nextDelimiter = SEARCH;
    this.#nextNewline = SEARCH;
    read: for (;;) {
      switch (state) {
        case LINE: {
          const comments = this.#comments;
          state = FIELD;
          if (comments === '' || s.charCodeAt(i) === quoteCode) continue;
          if (s.startsWith(comments, i)) state = COMMENT;
          else if (length - i < comments.length && comments.startsWith(s.slice(i))) {
            state = LINE;
            break read;
          }
          continue;
        }
        case FIELD:
          if (i === length) break read;
          if (s.charCodeAt(i) === quoteCode) {
            i++;
            state = QUOTED;
          } else state = RAW;
          continue;
        case RAW: {
          const match = this.#next(s, i);
          if (match === -1) {
            const partial = this.#partial(s, i);
            i = partial === -1 ? length : partial;
            break read;
          }
          if (match === this.#nextNewline) return match + newline.length;
          i = match + delimiter.length;
          state = FIELD;
          continue;
        }
        case COMMENT: {
          if (this.#nextNewline !== -1 && this.#nextNewline < i) {
            this.#nextNewline = s.indexOf(newline, i);
          }
          if (this.#nextNewline !== -1) return this.#nextNewline + newline.length;
          const partial = prefixAt(s, i, newline);
          i = partial === -1 ? length : partial;
          break read;
        }
        case QUOTED: {
          const quote = s.indexOf(this.#quoteChar, i);
          if (quote === -1) {
            i = length;
            break read;
          }
          i = quote + 1;
          if ((quote === 0 ? this.#before : s.charCodeAt(quote - 1)) !== this.#escapeCode) {
            state = SPACES;
            first = true;
          }
          continue;
        }
        case SPACES: {
          if (i === length) break read;
          if (first && this.#doubles && s.charCodeAt(i) === quoteCode) {
            i++;
            state = QUOTED;
            continue;
          }
          // The quote closes the field at the first delimiter or newline
          // after it when only whitespace comes before that.
          const match = this.#next(s, i);
          SPACE_RUN.lastIndex = i;
          SPACE_RUN.test(match === -1 ? s : s.slice(0, match));
          const run = SPACE_RUN.lastIndex;
          if (run === match) {
            if (match === this.#nextNewline) return match + newline.length;
            i = match + delimiter.length;
            state = FIELD;
            continue;
          }
          if (match === -1) {
            const partial = this.#partial(s, i);
            const stop = partial !== -1 && partial <= run ? partial : run === length ? run : -1;
            if (stop !== -1) {
              first &&= stop === i;
              i = stop;
              break read;
            }
          }
          // The quote is malformed. scanRows searches on two units after it; a quote in the
          // whitespace before run would be malformed too, so the search resumes at run.
          i = first && run === i ? run + 1 : run;
          state = QUOTED;
          continue;
        }
      }
    }
    this.#held = s.slice(i);
    if (i !== 0) this.#before = s.charCodeAt(i - 1);
    this.#state = state;
    this.#first = first;
    return -1;
  }

  /** The first delimiter or newline at or after i that lies whole in s, or -1. */
  #next(s: string, i: number): number {
    if (this.#nextNewline !== -1 && this.#nextNewline < i) {
      this.#nextNewline = s.indexOf(this.#newline, i);
      if (this.#nextDelimiter === -1) this.#nextDelimiter = SEARCH;
    }
    const newline = this.#nextNewline;
    if (this.#nextDelimiter !== -1 && this.#nextDelimiter < i) {
      this.#nextDelimiter = (newline === -1 ? s : s.slice(0, newline)).indexOf(this.#delimiter, i);
    }
    const delimiter = this.#nextDelimiter;
    return delimiter === -1 ? newline : delimiter;
  }

  /**
   * Where s ends with a delimiter or newline cut short, at or after i, or -1.
   * At most one of the two can be cut: a delimiter holds no "\r" or "\n".
   */
  #partial(s: string, i: number): number {
    return Math.max(prefixAt(s, i, this.#delimiter), prefixAt(s, i, this.#newline));
  }
}

/** The first offset at or after from at which s ends with a proper prefix of pattern, or -1. */
function prefixAt(s: string, from: number, pattern: string): number {
  for (let at = Math.max(from, s.length - pattern.length + 1); at < s.length; at++) {
    if (pattern.startsWith(s.slice(at))) return at;
  }
  return -1;
}
