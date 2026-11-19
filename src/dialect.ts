import { scanRows } from './parser.ts';
import type { Newline } from './types.ts';

/** Papa's candidates: comma, tab, pipe, semicolon, RS and US. */
export const DEFAULT_DELIMITERS: readonly string[] = [',', '\t', '|', ';', '\x1e', '\x1f'];

/**
 * Papa Parse 5.7.0's newline guess: in the first 1,048,576 UTF-16 units, with
 * every quote...quote span removed (an unpaired quote keeps the rest), "\n"
 * unless a "\r" comes first; then "\r\n" when at least half of the parts
 * between "\r"s start with "\n", else "\r". The quote is quoteChar || '"', as
 * Papa passes it.
 */
export function guessNewline(text: string, quoteChar: string): Newline {
  const sample = withoutQuoted(text.slice(0, 1_048_576), quoteChar || '"');
  const cr = sample.indexOf('\r');
  const lf = sample.indexOf('\n');
  if (cr === -1 || (lf !== -1 && lf < cr)) return '\n';
  // Papa splits at "\r": one part more than there are "\r", and a part starts
  // with "\n" exactly where "\r\n" occurs (the first part does not, as lf > cr).
  let parts = 1;
  let crlf = 0;
  for (let at = cr; at !== -1; at = sample.indexOf('\r', at + 1)) {
    parts++;
    if (sample.charCodeAt(at + 1) === 0x0a) crlf++;
  }
  return crlf >= parts / 2 ? '\r\n' : '\r';
}

/** Papa's text.replace(/quote([^]*?)quote/g, ''), without building a RegExp. */
export function withoutQuoted(text: string, quote: string): string {
  let kept = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(quote, from);
    if (open === -1) break;
    const close = text.indexOf(quote, open + quote.length);
    if (close === -1) break;
    kept += text.slice(from, open);
    from = close + quote.length;
  }
  return from === 0 ? text : kept + text.slice(from);
}

/**
 * Papa Parse 5.7.0's delimiter guess. Each candidate scans the first 10
 * records as Papa's per-candidate Parser does: default quote, the comment
 * marker, and lines counted for preview when the text has no '"'. Records
 * skipEmptyLines would remove are left out. The smallest sum of field-count
 * changes between records wins, ties go to the higher average and then to the
 * earlier candidate, and the average must exceed 1.99; undefined when no
 * candidate qualifies. comments is the option as given: Papa compares it with
 * each candidate before true becomes '#' and throws on a match. A null
 * candidate (csvloom/papa: a falsy value) is scanned as ',' and, when it wins,
 * is not a success.
 */
export function guessDelimiter(
  text: string,
  newline: Newline,
  skipEmptyLines: boolean | 'greedy',
  comments: string | boolean,
  candidates: readonly (string | null)[],
): string | undefined {
  const marker = comments === true ? '#' : comments === false ? '' : comments;
  // Without comments both of Papa's paths read the same 10 records.
  const fastMode = marker !== '' && text.indexOf('"') === -1;
  const greedy = skipEmptyLines === 'greedy';
  let found = false;
  let best: string | null = null;
  let bestDelta = 0;
  let bestAverage = 0;
  for (const candidate of candidates) {
    const delimiter = candidate ?? ',';
    if (comments === delimiter) throw new Error('Comment character same as delimiter');
    const { rows } = scanRows(text, {
      delimiter,
      newline,
      quoteChar: '"',
      escapeChar: '"',
      comments: marker,
      preview: 10,
      fastMode,
    });
    let delta = 0;
    let fields = 0;
    let counted = 0;
    let previous = -1;
    for (const row of rows) {
      if (skipEmptyLines !== false && isEmptyRecord(row, greedy)) continue;
      fields += row.length;
      counted++;
      if (previous !== -1) delta += Math.abs(row.length - previous);
      previous = row.length;
    }
    // NaN when every record was empty, which fails the test as in Papa.
    const average = fields / counted;
    if (
      average > 1.99 &&
      (!found || delta < bestDelta || (delta === bestDelta && average > bestAverage))
    ) {
      found = true;
      best = candidate;
      bestDelta = delta;
      bestAverage = average;
    }
  }
  return best ?? undefined;
}

/**
 * Papa's skipEmptyLines test, as written: a header name that is not a string
 * (csvloom/papa) is read by its length.
 */
export function isEmptyRecord(row: readonly unknown[], greedy: boolean): boolean {
  return greedy ? row.join('').trim() === '' : row.length === 1 && (row[0] as string).length === 0;
}
