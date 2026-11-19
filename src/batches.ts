import { detectDialect, SAMPLE_UNITS, sepLineDelimiter } from './detect.ts';
import { guessDelimiter, guessNewline, isEmptyRecord } from './dialect.ts';
import { advance, positionsAt, recordStarts, START, type Before } from './locate.ts';
import type { Features, ParseOptions } from './options.ts';
import {
  EXTRA_FIELDS,
  fieldCountError,
  fieldTyper,
  headerFields,
  isPlain,
  recordTemplate,
  specialRecord,
  undetectableError,
  type FieldConverter,
} from './parse.ts';
import { scanRows, SEARCH, type ScanDialect, type ScanWindow } from './parser.ts';
import { RecordEnd } from './record-end.ts';
import { mixedNewline, repairRows } from './repair.ts';
import type {
  Detection,
  FieldCountError,
  HeaderRow,
  Newline,
  ParseBatch,
  ParseError,
  Position,
  QuoteError,
  Repair,
  RepairRule,
} from './types.ts';

export interface BatchLimits {
  /** Rows per batch; a positive safe integer. */
  batchSize: number;
  /** UTF-16 units; 0 means no limit. */
  maxRecordLength: number;
}

const CR_CODE = 0x0d;
const LF_CODE = 0x0a;
const QUOTE_CODE = 0x22;

/** The units a newline guess reads and a delimiter function gets. */
const WINDOW = 1_048_576;
/** The records guessDelimiter reads per candidate. */
const SAMPLE = 10;

/** The most repair entries one stream reports, as for one parse. */
const LOG_LIMIT = 10_000;
/** The records of one unit under repair: with five rules, at most LOG_LIMIT changes. */
const UNIT_RECORDS = LOG_LIMIT / 5;
/** A "sep=" line with the longest line break. */
const SEP_UNITS = 7;
/** What detectDialect reads: a "sep=" line, the sample, and one unit that says the text is longer. */
const SNIFF_UNITS = SEP_UNITS + SAMPLE_UNITS + 1;
const BREAKS: readonly Newline[] = ['\r\n', '\n', '\r'];
/** More units than a snippet shows of a line (120, and the two a surrogate pair at its cut needs). */
const PEEK_UNITS = 122;

// Where the builder is at the start of the text.
const SEP = -1; // holding the first line, which may be a "sep=" line
const SNIFF = 4; // holding the text detect reads, and the text the mixed-newline rule reads
const SKIP_GUESS = 0; // holding text to guess the newline of skipFirstNLines
const SKIP = 1; // dropping the skipped lines
const DETECT = 2; // holding the detection window
const RUN = 3; // the dialect is known

// Where a preview counted in lines is (fastMode: true).
const BEFORE = 0; // line `preview` has not started, or lines are not counted
const AT_LINE = 1; // it has; the text before it is being scanned
const LAST = 2; // one more record is read

const NO_ROW = (): void => undefined;

/**
 * The carried records in a row that must have ended in the text after their first before the
 * next one is scanned with its next text unread (see #accept). A stream starts as if they had.
 */
const STREAK = 4;

/**
 * The text at which a batch closes before it holds batchSize rows: the units read for it, from the
 * end of the batch before to the end of the record that gives it a row, less the line break that
 * ends each record read.
 */
export const BATCH_TEXT = 1_048_576;

const scanWindow = (limit: number): ScanWindow => ({
  cursor: 0,
  limit,
  final: false,
  nextDelimiter: SEARCH,
  nextNewline: SEARCH,
  nextQuote: SEARCH,
  end: -1,
  stop: 'end',
});

/** One delimiter candidate while the window is read: the records it has, counted by a RecordEnd. */
interface Sampler {
  /** The dialect guessDelimiter scans this candidate with. */
  dialect: ScanDialect;
  end: RecordEnd;
  records: number;
  /** The first units of the record or comment line being read, as many as the comment marker has. */
  head: string;
}

/** What one scanRows call read, with a feature set: its text, its records and their errors. */
interface Segment {
  text: string;
  rows: string[][];
  /** row counts the records of this call, index the units of text. */
  errors: QuoteError[];
  /** Where the last record read by then ends, as meta.cursor counts. */
  end: number;
  /** Its units less the line breaks that end its records: what it adds to a batch's text. */
  weight: number;
}

/** The text some rows were built from, kept to find where a row starts. */
interface Unit {
  /** The text, after the U+FEFF that precedes it on its first line. */
  text: string;
  /** 1 with that U+FEFF, else 0. */
  lead: number;
  before: Before;
  /** Where these rows of the unit (ascending) start in its text, the U+FEFF not counted. */
  startsOf: (rows: readonly number[]) => number[];
}

const noCounts = (): Record<RepairRule, number> => ({
  'pad-missing': 0,
  'drop-trailing-empty': 0,
  'trailing-empty-record': 0,
  'mixed-newline': 0,
  'unclosed-quote': 0,
});

/**
 * A copy of previewRows in src/detailed.ts, kept identical by a test: how many of count repaired
 * rows a scan of the repaired text returns under dialect.preview.
 */
function previewRows(
  text: string,
  dialect: ScanDialect,
  count: number,
  startsOf: (rows: readonly number[]) => number[],
): number {
  const { preview, newline } = dialect;
  if (!dialect.fastMode || dialect.comments === '') return Math.min(count, preview);
  const starts = startsOf(Array.from({ length: Math.min(count, preview + 1) }, (_, i) => i));
  let line = 0;
  let from = 0;
  for (const [i, start] of starts.entries()) {
    let breaks = 0;
    for (let at = text.indexOf(newline, from); at !== -1 && at < start;) {
      breaks++;
      at = text.indexOf(newline, at + newline.length);
    }
    line += i === 0 ? breaks : Math.max(breaks, 1);
    if (line >= preview) return i < preview ? i + 1 : i;
    from = start;
  }
  return count;
}

/** A copy of once in src/detailed.ts: transformHeader, called once per cell and index. */
function once(transformHeader: ParseOptions['transformHeader']): ParseOptions['transformHeader'] {
  if (transformHeader === undefined) return undefined;
  const seen: Array<{ cell: string; name: unknown }> = [];
  return (cell, index) => {
    const known = seen[index];
    if (known?.cell === cell) return known.name;
    const name = transformHeader(cell, index);
    seen[index] = { cell, name };
    return name;
  };
}

/**
 * Where the last of the candidates' SAMPLE-th records ends in text, as scanRows
 * reads them; -1 when a candidate has fewer records that line breaks end.
 */
function sampleEnd(text: string, samplers: readonly Sampler[]): number {
  let last = 0;
  for (const { dialect } of samplers) {
    const window = scanWindow(SAMPLE);
    scanRows(text, dialect, NO_ROW, window);
    if (window.stop !== 'limit') return -1;
    if (window.end > last) last = window.end;
  }
  return last;
}

/**
 * Turns the text of one input, given piece by piece, into batches. Synchronous.
 *
 * One text is scanned at a time, with scanRows in a window, so a full batch stops the scan in
 * its text. A record that the text does not end is carried as a list of parts: RecordEnd reads
 * each later text once, and when it finds the record's line break the parts are joined once and
 * scanned on their own. scanRows decides what a record is, so a wrong RecordEnd answer costs time,
 * never data.
 *
 * The start is parseWith's: one leading U+FEFF is removed, then the skipFirstNLines lines, then
 * the newline and the delimiter are detected on a window of the rest. Offsets count from the
 * first unit after the skipped lines.
 *
 * preview counts records, except with fastMode: true, where it counts lines: the builder finds
 * where line `preview` starts, scans the text before it, then reads one record more, kept only if
 * fewer than `preview` records came before.
 *
 * With a feature of DetailedConfig, each scanRows call gives a Segment whose records #build turns
 * into rows as parseFeatures does. With repair one record is read per call and the last records
 * are held back (see #drain), because the rules for the end of the input need the text before it.
 */
export class BatchBuilder {
  #options: ParseOptions;
  /** Until detection has run, its delimiter and newline are placeholders. */
  #dialect: ScanDialect;
  readonly #header: boolean;
  /** Records to read; 0 for no limit and when lines are counted. */
  readonly #preview: number;
  /** Lines to read with fastMode: true; 0 otherwise. */
  readonly #linePreview: number;
  readonly #size: number;
  readonly #max: number;
  #quoteCode: number;
  #recordEnd: RecordEnd;
  /** Makes rows of the records scanned; undefined when scanRows' own arrays are the rows. */
  readonly #emit: ((values: readonly string[]) => void) | undefined;
  /** Without #emit: the test of skipEmptyLines for a record that stays. */
  readonly #keep: ((row: readonly string[]) => boolean) | undefined;
  readonly #window = scanWindow(1);

  #phase: number;
  /** Whether a newline or a delimiter is detected, or the delimiter is a function. */
  #detects: boolean;
  /** The text held for a guess, in pieces, and its length. */
  #held: string[] = [];
  #heldLength = 0;
  /** The newline, once given or guessed; '' before. */
  #newline: Newline | '';
  #samplers: Sampler[] | undefined;
  #undetectable = false;
  /** Line breaks still to find: of the skip, then of a preview counted in lines. */
  #lines = 0;
  #lineBreak = '';
  /** True when the last text counted ended with the "\r" of a possible "\r\n". */
  #cr = false;
  #stage = BEFORE;
  /** The text after the start of line `preview`, until the text before it is scanned. */
  #beyond = '';
  /** In LAST: the record read is dropped, because `preview` records came before it. */
  #mute = false;

  /** The text being scanned, or the last one scanned; #base is the offset of its first unit. */
  #text = '';
  #base = 0;
  /** True while #text has units the scan has not passed. */
  #scanning = false;
  /** The text after a joined record, scanned when #text is used up; '' for none. */
  #rest = '';
  /** The carried record: its texts in order, their total length and the offset of its first unit. */
  #parts: string[] = [];
  #carried = 0;
  #carryBase = -1;
  /** The carried record is one part that #recordEnd has not read: it is scanned with the next text. */
  #fresh = false;
  /** The carried record was withheld before. */
  #again = false;
  /** The carried records in a row, up to now, that ended in the text after their first. */
  #streak = STREAK;
  /**
   * The text of the batch being filled, as BATCH_TEXT counts it: without repair, what the scan
   * has read for it; with repair, the weights of the rows built and not taken (see #build).
   */
  #spent = 0;
  /** What all scans have added to a batch's text, for the average record (see #scan). */
  #total = 0;
  /** The last call read a prefix of the text and withheld the record that crosses its end. */
  #crossed = false;

  #started = false;
  #ended = false;
  #finished = false;
  /** Records read, the header record and removed empty records included. */
  #records = 0;
  /** Where the last record read ends, its line break included. */
  #cursor = 0;

  #data: unknown[] = [];
  #quoteErrors: ParseError[] = [];
  #fieldErrors: FieldCountError[] = [];
  #rowOffset = 0;
  #fields: unknown[] | undefined;
  #renamedHeaders: Record<string, unknown> | null = null;

  // The features; nothing below is read or written without one.
  readonly #features: Features | null;
  /** positions or repair: #before counts the text let go. */
  readonly #locating: boolean;
  /** The repair rules still applied; undefined without repair. */
  readonly #rules: Set<RepairRule> | undefined;
  /** The mixed-newline rule has still to read the start of the text. */
  #mix = false;
  /** detect with skipFirstNLines given: the text after the lines is the table. */
  readonly #table: boolean;
  /** A "sep=" line was read here (detect reads its own). */
  #sepLine = false;
  #detected: Detection | undefined;
  /** The units of the input before the text held or scanned. */
  #shift = 0;
  /** What came before the next text to process, less #lead. */
  #before: Before = START;
  /** The U+FEFF, while it is on the line the next text starts on. */
  #lead = '';
  readonly #convert: FieldConverter | undefined;
  readonly #transformHeader: ParseOptions['transformHeader'];
  /** No record was named yet. */
  #first = true;
  /** The record width of the repair rules, once a record has fixed it. */
  #width: number | undefined;
  /** With repair: the segments read and not processed, and their records. */
  #pending: Segment[] = [];
  #pendingRows = 0;
  #pendingUnits = 0;
  #pendingWeight = 0;
  /**
   * With repair: where the last row built ends, as meta.cursor counts, and the units of the line
   * breaks that end records after it in the segments built (see #build).
   */
  #mark = 0;
  #breaks = 0;
  /** While no record has fixed the header: the records to wait for before the next attempt. */
  #probeAt = 0;
  /** The offset, as meta.cursor counts, and the record index of the next unit. */
  #unitBase = 0;
  #rowBase = 0;
  /** The rows of #data before #head are taken; the arrays below run parallel to #data. */
  #head = 0;
  /** With repair: where the record of each row ends, and the weight of each row (see #build). */
  #ends: number[] = [];
  #weights: number[] = [];
  /** With positions and a schema: the unit of each row and its index there. */
  readonly #spots: Array<{ unit: Unit; row: number }> | undefined;
  #taken: Array<{ unit: Unit; row: number }> = [];
  /** The changes not delivered: at is the offset of the record; kept: within the first LOG_LIMIT. */
  #repairs: Array<{ entry: Repair; at: number; kept: boolean }> = [];
  #logged = 0;
  /** Changes counted beyond the entries of their unit, for the next batch. */
  #extra = noCounts();
  /** The last record read is the empty one at the end of the input. */
  #finalRecord = false;
  /** repair cut the rows at preview. */
  #cut = false;
  /**
   * Without repair: the first segment, when it is an empty record at a "\n" that follows a "\r"
   * the start-up let go. Its place is on the line after that "\n", which the next segment holds,
   * so the two are built together.
   */
  #deferred: Segment | undefined;
  /**
   * preview ended the scan at such a record: the text after it, read until it holds the line the
   * snippet shows (a line break, the end of the input, or more units than a snippet has).
   */
  #peek: string | undefined;
  /** The input or preview has ended the scan: the rows left are delivered. */
  #closing: { truncated: boolean } | undefined;

  constructor(options: ParseOptions & { features?: Features | null }, limits: BatchLimits) {
    const { delimiter, newline, header, skipEmptyLines, transformHeader, transform } = options;
    const fast = options.fastMode === true;
    const given = typeof delimiter === 'string' && delimiter !== '';
    this.#options = options;
    this.#dialect = {
      delimiter: given ? delimiter : ',',
      newline: newline || '\n',
      // As bulk: with fastMode: true no quote opens a field.
      quoteChar: fast ? '' : options.quoteChar,
      escapeChar: options.escapeChar,
      comments: options.comments,
      // The builder counts preview itself: in records, or in lines.
      preview: 0,
      fastMode: false,
    };
    this.#header = header;
    this.#preview = fast ? 0 : options.preview;
    this.#linePreview = fast ? options.preview : 0;
    this.#size = limits.batchSize;
    this.#max = limits.maxRecordLength;
    this.#quoteCode = this.#dialect.quoteChar.length === 1 ? options.quoteChar.charCodeAt(0) : -1;
    this.#recordEnd = new RecordEnd(this.#dialect);
    this.#detects = !given || newline === '';
    this.#newline = newline;
    const features = options.features ?? null;
    this.#features = features;
    this.#locating = features !== null && (features.positions || features.repair !== null);
    this.#table = features?.detect === true && features.given.has('skipFirstNLines');
    this.#spots = features?.positions === true && features.schema !== null ? [] : undefined;
    if (features !== null && features.repair !== null) {
      const rules = new Set(features.repair);
      // As parseFeatures: mixed-newline only when no newline is given (and then only when the
      // text mixes two kinds, see #sniff); unclosed-quote not under preview.
      if (newline === '') this.#mix = rules.has('mixed-newline');
      else rules.delete('mixed-newline');
      if (options.preview > 0) rules.delete('unclosed-quote');
      this.#rules = rules;
    }
    this.#phase = this.#detects ? DETECT : RUN;
    // Under detect the detector reads the "sep=" line, unless skipFirstNLines is given: the line
    // is then read here, before the lines are skipped.
    if (features !== null && (features.detect ? this.#table : features.sepLine)) this.#phase = SEP;
    else this.#toSkip();

    // The rows are built as parseWith builds them, one batch at a time.
    const typed = fieldTyper(options.dynamicTyping);
    const convert: FieldConverter | undefined =
      transform === undefined
        ? typed
        : typed === undefined
          ? (field, value) => transform(value, field)
          : (field, value) => typed(field, transform(value, field));
    const greedy = skipEmptyLines === 'greedy';
    this.#convert = convert;
    // repairRows names record 0 to judge it, and #build names it again.
    this.#transformHeader = this.#rules === undefined ? transformHeader : once(transformHeader);
    if (features !== null) {
      // The rows come from scanRows as they are, and #build builds them.
      this.#keep = undefined;
      this.#emit = undefined;
      return;
    }
    if (!header) {
      this.#keep =
        convert === undefined && skipEmptyLines ? (row) => !isEmptyRecord(row, greedy) : undefined;
      this.#emit =
        convert === undefined
          ? undefined
          : (values) => {
              this.#records++;
              if (skipEmptyLines && isEmptyRecord(values, greedy)) return;
              this.#data.push(values.map((value, j) => convert(j, value)));
            };
      return;
    }
    this.#keep = undefined;
    let width = 0;
    let plain = true;
    let template: HeaderRow<unknown> | undefined;
    const setFields = (fields: unknown[]) => {
      this.#fields = fields;
      width = fields.length;
      plain = isPlain(fields, convert);
      template = plain ? recordTemplate(fields as string[]) : undefined;
    };
    const addRecord = (values: readonly string[]) => {
      const fields = this.#fields;
      if (fields === undefined) {
        const names = headerFields(values, transformHeader);
        this.#renamedHeaders = names.renamedHeaders;
        setFields(names.fields);
        return;
      }
      let record: HeaderRow<unknown>;
      if (plain) {
        const n = values.length < width ? values.length : width;
        if (template !== undefined && n === width) {
          record = { ...template };
          for (let j = 0; j < width; j++) record[(fields as string[])[j] ?? ''] = values[j] ?? '';
        } else {
          record = {};
          for (let j = 0; j < n; j++) record[(fields as string[])[j] ?? ''] = values[j] ?? '';
        }
        if (values.length > width) record[EXTRA_FIELDS] = values.slice(width);
      } else record = specialRecord(fields, values, convert);
      const data = this.#data;
      if (values.length !== width) {
        this.#fieldErrors.push(fieldCountError(width, values, this.#rowOffset + data.length));
      }
      data.push(record);
    };
    if (!skipEmptyLines) {
      this.#emit = (values) => {
        this.#records++;
        addRecord(values);
      };
      return;
    }
    // parseWith's removeEmpty: record 0 is renamed before empty records are
    // removed; the first record left is the header, a later one as it is.
    let first = true;
    this.#emit = (values) => {
      this.#records++;
      if (this.#fields !== undefined) {
        if (!isEmptyRecord(values, greedy)) addRecord(values);
        return;
      }
      let names: unknown[];
      if (first) {
        first = false;
        const renamed = headerFields(values, transformHeader);
        this.#renamedHeaders = renamed.renamedHeaders;
        names = renamed.fields;
      } else names = values.slice();
      if (!isEmptyRecord(names, greedy)) setFields(names);
    };
  }

  /** Adds the next piece of the text. Called only after take() returned undefined. '' is ignored. */
  push(text: string): void {
    if (text === '') return;
    if (!this.#started) {
      this.#started = true;
      if (text.charCodeAt(0) === 0xfeff) {
        if (this.#features !== null) {
          this.#shift = 1;
          if (this.#locating) this.#lead = '\ufeff';
        }
        if (text.length === 1) return;
        text = text.slice(1);
      }
    }
    if (this.#peek !== undefined) this.#peek += text;
    else if (this.#phase === RUN) this.#feed(text);
    else this.#start(text);
  }

  /** No more text will come. */
  end(): void {
    this.#ended = true;
  }

  /**
   * The next batch when the text held completes one, or the last batch (meta.done) after end() or
   * when preview is reached; undefined when more text is needed or the last batch was already
   * taken. Throws what a callback throws and the maxRecordLength RangeError.
   */
  take(): ParseBatch<unknown> | undefined {
    if (this.#finished) return undefined;
    try {
      return this.#fill();
    } catch (error) {
      // The batch being filled is dropped with the builder's state.
      this.#finished = true;
      throw error;
    }
  }

  /**
   * Where these rows of the batch take() returned last start in the input: ascending indices into
   * its data. Only with positions and a schema, for the places of the Schema errors; the builder
   * keeps the text of that batch's rows until the next take().
   */
  positionsOfRows(rows: readonly number[]): Position[] {
    const taken = this.#taken;
    const positions: Position[] = [];
    for (let i = 0; i < rows.length;) {
      const unit = taken[rows[i] ?? -1]?.unit;
      if (unit === undefined) throw new RangeError('Not a row of the last batch');
      const wanted: number[] = [];
      for (; i < rows.length && taken[rows[i] ?? -1]?.unit === unit; i++) {
        wanted.push(taken[rows[i] ?? -1]?.row ?? 0);
      }
      const starts = unit.startsOf(wanted).map((start) => start + unit.lead);
      for (const position of positionsAt(unit.text, starts, unit.before)) positions.push(position);
    }
    return positions;
  }

  #fill(): ParseBatch<unknown> | undefined {
    if (this.#features !== null) {
      if (this.#closing !== undefined) return this.#batch(true, false);
      if (this.#full()) return this.#batch(false, false);
      if (this.#peek !== undefined) return this.#peeked();
    }
    if (this.#phase !== RUN && !this.#startUp()) return undefined;
    const window = this.#window;
    const max = this.#max;
    for (;;) {
      // With repair, any segment can complete the records held back and fill the batch.
      if (this.#features !== null && this.#full()) return this.#batch(false, false);
      if (!this.#scanning) {
        if (this.#rest !== '') {
          const rest = this.#rest;
          this.#rest = '';
          this.#accept(rest);
          continue;
        }
        if (this.#stage === AT_LINE && this.#parts.length === 0) {
          // The text before line `preview` is scanned: one record more is read,
          // and dropped when `preview` records were read before it, as bulk does.
          this.#stage = LAST;
          this.#mute = this.#records === this.#linePreview;
          const beyond = this.#beyond;
          this.#beyond = '';
          if (beyond !== '') {
            this.#accept(beyond);
            continue;
          }
        }
        // At line `preview` a carry is left only by a RecordEnd that was late:
        // a line break ends the text, so the carry is scanned without waiting.
        if (!this.#ended && this.#stage !== AT_LINE) return undefined;
        // The input ended: the carried record ends here; with none, the last
        // text is scanned once more from its end, which gives the [''] record
        // after a final line break.
        if (this.#parts.length > 0) this.#scanCarry();
        else if (this.#text === '') return this.#batch(true, false);
        else this.#scanning = true;
      }
      // A call that read a prefix of the text and stopped at its end: the text goes on.
      if (this.#scan()) continue;
      if (window.stop === 'limit') {
        // Both ends are at a line break, so neither depends on what follows.
        if (this.#stage === LAST || this.#records === this.#preview) {
          const alone =
            this.#deferred ?? (this.#pending.length === 1 ? this.#pending[0] : undefined);
          if (this.#features === null || !this.#lineFeedFirst(alone))
            return this.#batch(true, true);
          // The place of that record is on the line after it, which preview did not read.
          this.#peek = this.#text.slice(window.cursor) + this.#rest + this.#beyond;
          return this.#peeked();
        }
        if (this.#full(true)) return this.#batch(false, false);
      } else if (window.stop === 'end') {
        this.#scanning = false;
        // Counted in lines, preview has ended the parse when the input ends a
        // record after line `preview`; not when comment lines end the input.
        if (window.final) return this.#batch(true, this.#stage === LAST && window.end !== -1);
      } else {
        const text = this.#text;
        const from = window.cursor;
        const length = text.length - from;
        const part = from === 0 ? text : text.slice(from);
        if (max > 0 && length > max && !this.#mayEnd(part)) throw this.#tooLong(this.#base + from);
        // Every withheld record is carried the same way, whatever text it is in.
        this.#scanning = false;
        const start = this.#base + from;
        // A record that starts where the last carried one did is that record, withheld again: the
        // scan with the text after its first has not ended it (see #accept).
        this.#again = start === this.#carryBase;
        if (this.#again) this.#streak = 0;
        this.#parts = [part];
        this.#carried = length;
        this.#carryBase = start;
        this.#fresh = this.#streak >= STREAK;
        if (!this.#fresh) this.#readCarry(part);
      }
    }
  }

  /**
   * Ends the parse that preview ended at a record whose line is in #peek (see #lineFeedFirst),
   * once that line is held as far as a snippet shows it; undefined while it is not.
   */
  #peeked(): ParseBatch<unknown> | undefined {
    const peek = this.#peek ?? '';
    const end = peek.search(/[\r\n]/);
    if (end === -1 && peek.length <= PEEK_UNITS && !this.#ended) return undefined;
    const segment = this.#deferred ?? this.#pending[0];
    if (segment !== undefined) segment.text += end === -1 ? peek : peek.slice(0, end);
    this.#peek = undefined;
    return this.#batch(true, true);
  }

  /** After the "sep=" line, or without one: the lines to skip, or what follows them. */
  #toSkip(): void {
    const { skipFirstNLines, newline } = this.#options;
    if (skipFirstNLines > 0) {
      this.#phase = newline === '' ? SKIP_GUESS : SKIP;
      this.#lines = skipFirstNLines;
      this.#lineBreak = newline;
    } else this.#afterSkip();
  }

  /** After the skipped lines: what the features read of the text, detection, or the scan. */
  #afterSkip(): void {
    if (this.#features?.detect === true || this.#mix) this.#phase = SNIFF;
    else if (this.#detects) this.#phase = DETECT;
    else this.#run();
  }

  /** Text that the start of the text lets go: it counts for offsets and positions. */
  #drop(text: string): void {
    this.#shift += text.length;
    if (!this.#locating) return;
    const lead = this.#lead;
    this.#lead = '';
    this.#before = advance(lead + text, lead.length + text.length, this.#before);
  }

  /** Text that a phase held, given to the phase that follows. */
  #replay(text: string): void {
    if (text === '') return;
    if (this.#phase === RUN) this.#feed(text);
    else this.#start(text);
  }

  /**
   * Reads the "sep=" line as sepLineEnd in src/detailed.ts does; it is let go and names the
   * delimiter unless one is given. False while the line is not held.
   */
  #sep(): boolean {
    if (this.#heldLength < SEP_UNITS && !this.#ended) return false;
    let text = this.#join();
    this.#held = [];
    this.#heldLength = 0;
    const options = this.#options;
    for (const end of options.newline === '' ? BREAKS : [options.newline]) {
      const delimiter = sepLineDelimiter(text, end);
      if (delimiter === undefined) continue;
      const length = Math.min(text.length, 5 + end.length);
      this.#drop(text.slice(0, length));
      text = text.slice(length);
      this.#sepLine = true;
      if (options.delimiter === '') {
        if (options.rawComments === delimiter) {
          throw new Error('Comment character same as delimiter');
        }
        this.#options = { ...options, delimiter };
        this.#dialect = { ...this.#dialect, delimiter };
        // With the newline given nothing is detected, so the dialect is complete here.
        this.#recordEnd = new RecordEnd(this.#dialect);
        this.#detects = options.newline === '';
      }
      break;
    }
    this.#toSkip();
    this.#replay(text);
    return true;
  }

  /**
   * What the features read of the start of the text, as parseFeatures does. detect: detectDialect
   * on the text held (a delimiter function gets the first WINDOW units); the preamble is let go.
   * mixed-newline: mixedNewline on the next WINDOW + 1 units. False while that text is not held.
   */
  #sniff(): boolean {
    const features = this.#features as Features;
    const options = this.#options;
    const ended = this.#ended;
    const fast = options.fastMode === true;
    if (features.detect && this.#detected === undefined) {
      const { delimiter } = options;
      const need = typeof delimiter === 'function' ? WINDOW : SNIFF_UNITS;
      if (this.#heldLength < need && !ended) return false;
      const text = this.#join();
      const fixed: Parameters<typeof detectDialect>[2] = {};
      const given =
        typeof delimiter === 'function'
          ? delimiter(text.length > WINDOW ? text.slice(0, WINDOW) : text)
          : delimiter || undefined;
      if (given !== undefined) fixed.delimiter = given;
      if (options.newline !== '') fixed.newline = options.newline;
      if (features.given.has('quoteChar')) fixed.quoteChar = options.quoteChar;
      if (features.given.has('escapeChar')) fixed.escapeChar = options.escapeChar;
      // The main entry's candidates are strings (null is csvloom/papa's).
      const candidates = options.delimitersToGuess as readonly string[];
      const detected = detectDialect(text, candidates, fixed, this.#table);
      const start = detected.start;
      detected.start += this.#shift;
      if (this.#sepLine) detected.sepLine = true;
      this.#detected = detected;
      if (start > 0) {
        this.#drop(text.slice(0, start));
        this.#held = [text.slice(start)];
        this.#heldLength -= start;
      }
    }
    const detected = this.#detected;
    if (this.#mix) {
      if (this.#heldLength <= WINDOW && !ended) return false;
      this.#mix = false;
      const mixed = mixedNewline(this.#join(), detected?.quoteChar ?? options.quoteChar);
      if (mixed === undefined) this.#rules?.delete('mixed-newline');
      else this.#newline = mixed;
    }
    if (detected === undefined) {
      this.#phase = DETECT;
      return this.#detect();
    }
    const { delimiter, quoteChar, escapeChar } = detected;
    if (options.rawComments === delimiter) throw new Error('Comment character same as delimiter');
    const text = this.#join();
    this.#held = [];
    this.#heldLength = 0;
    this.#dialect = {
      ...this.#dialect,
      delimiter,
      newline: this.#newline || detected.newline,
      quoteChar: fast ? '' : quoteChar,
      escapeChar,
    };
    this.#quoteCode = !fast && quoteChar.length === 1 ? quoteChar.charCodeAt(0) : -1;
    this.#recordEnd = new RecordEnd(this.#dialect);
    this.#run();
    if (text !== '') this.#feed(text);
    return true;
  }

  /** The dialect is known: the scan starts, and with it the count of a preview's lines. */
  #run(): void {
    this.#phase = RUN;
    this.#lines = this.#linePreview;
    this.#lineBreak = this.#dialect.newline;
  }

  /**
   * Counts #lines down over the line breaks of text, which follows the last
   * text counted: where the last of them ends, or -1 when text has too few. A
   * "\r\n" cut between two texts is one line break, as in the whole text.
   */
  #lineEnds(text: string): number {
    const newline = this.#lineBreak;
    let at = 0;
    if (this.#cr && text.charCodeAt(0) === LF_CODE) {
      at = 1;
      this.#lines--;
    }
    this.#cr = false;
    while (this.#lines > 0) {
      const found = text.indexOf(newline, at);
      if (found === -1) {
        this.#cr = newline === '\r\n' && text.charCodeAt(text.length - 1) === CR_CODE;
        return -1;
      }
      at = found + newline.length;
      this.#lines--;
    }
    return at;
  }

  /**
   * Takes text before the dialect is known. Skipped lines are dropped as they
   * come, quotes not considered (as bulk); the rest is held for a guess.
   */
  #start(text: string): void {
    if (this.#phase === SKIP) {
      const at = this.#lineEnds(text);
      if (this.#features !== null) this.#drop(at === -1 ? text : text.slice(0, at));
      if (at === -1) return;
      this.#afterSkip();
      if (at === text.length) return;
      this.#replay(text.slice(at));
      return;
    }
    this.#held.push(text);
    this.#heldLength += text.length;
    if (this.#samplers !== undefined) this.#sample(text);
  }

  /** The text held, as one piece. */
  #join(): string {
    const held = this.#held;
    if (held.length > 1) this.#held = [held.join('')];
    return this.#held[0] ?? '';
  }

  /** Goes on with the start of the text; false while it needs more text. */
  #startUp(): boolean {
    if (this.#phase === SEP && !this.#sep()) return false;
    if (this.#phase === SKIP_GUESS) {
      if (this.#heldLength < WINDOW && !this.#ended) return false;
      // As bulk: the skip guesses a newline of its own, in the text before it.
      const text = this.#join();
      this.#held = [];
      this.#heldLength = 0;
      this.#lineBreak = guessNewline(text, this.#options.quoteChar);
      this.#phase = SKIP;
      if (text !== '') this.#start(text);
    }
    if (this.#phase === SKIP) {
      if (!this.#ended) return false;
      // The text has fewer lines than asked: nothing is left of it.
      this.#afterSkip();
    }
    if (this.#phase === SNIFF) return this.#sniff();
    return this.#phase === RUN || this.#detect();
  }

  /**
   * Detects the newline and the delimiter as parseWith does, on a window: the shortest start of
   * the text that has WINDOW units and SAMPLE records per delimiter candidate, at most
   * WINDOW + SAMPLE x (D + 2) units with D = maxRecordLength or WINDOW, or all of an ended input.
   * The window depends on the text only, never on its pieces, because the guess tests its whole
   * argument for a quote. False while the window is not held.
   */
  #detect(): boolean {
    const options = this.#options;
    const { delimiter, rawComments } = options;
    const ended = this.#ended;
    let size = options.newline === '' || typeof delimiter === 'function' ? WINDOW : 0;
    if (this.#heldLength < size && !ended) return false;
    if (this.#newline === '') this.#newline = guessNewline(this.#join(), options.quoteChar);
    const newline = this.#newline;
    if (delimiter === '') {
      if (this.#samplers === undefined) {
        this.#samplers = options.delimitersToGuess.map((candidate) => {
          const dialect: ScanDialect = {
            delimiter: candidate ?? ',',
            newline,
            quoteChar: '"',
            escapeChar: '"',
            comments: options.comments,
            preview: 0,
            fastMode: false,
          };
          return { dialect, end: new RecordEnd(dialect), records: 0, head: '' };
        });
        for (const text of this.#held) this.#sample(text);
      }
      // Without maxRecordLength the window is bounded as if it were WINDOW; no record is rejected.
      const bound = WINDOW + SAMPLE * ((this.#max || WINDOW) + 2);
      const waiting = this.#samplers.some((sampler) => sampler.records < SAMPLE);
      if (waiting && this.#heldLength < bound && !ended) return false;
      const end = sampleEnd(this.#join(), this.#samplers);
      size = Math.min(end === -1 ? Infinity : Math.max(size, end), bound);
      if (this.#heldLength < size && !ended) return false;
    }
    const text = this.#join();
    const sample = text.length > size ? text.slice(0, size) : text;
    let found: string;
    if (typeof delimiter === 'function') found = delimiter(sample);
    else if (delimiter !== '') found = delimiter;
    else {
      const guess = guessDelimiter(
        sample,
        newline,
        options.skipEmptyLines,
        rawComments,
        options.delimitersToGuess,
      );
      this.#undetectable = guess === undefined;
      found = guess ?? ',';
    }
    if (rawComments === found) throw new Error('Comment character same as delimiter');
    this.#held = [];
    this.#heldLength = 0;
    this.#samplers = undefined;
    this.#dialect = { ...this.#dialect, delimiter: found, newline };
    this.#recordEnd = new RecordEnd(this.#dialect);
    this.#run();
    // maxRecordLength is checked from here on, the window included.
    if (text !== '') this.#feed(text);
    return true;
  }

  /** Reads the next text of the window for every candidate that has fewer than SAMPLE records. */
  #sample(text: string): void {
    const marker = this.#options.comments;
    for (const sampler of this.#samplers ?? []) {
      let from = 0;
      while (sampler.records < SAMPLE && from < text.length) {
        const rest = from === 0 ? text : text.slice(from);
        const missing = marker.length - sampler.head.length;
        if (missing > 0) sampler.head += rest.slice(0, missing);
        const end = sampler.end.feed(rest);
        if (end === -1) break;
        // A comment line, by scanRows' test, is not a record.
        const { head } = sampler;
        if (marker === '' || head.charCodeAt(0) === QUOTE_CODE || !head.startsWith(marker)) {
          sampler.records++;
        }
        sampler.head = '';
        sampler.end.reset();
        from += end;
      }
    }
  }

  /**
   * Takes text for the scan. With a preview counted in lines, the text from
   * the start of line `preview` on waits in #beyond while the text before it
   * is scanned.
   */
  #feed(text: string): void {
    if (this.#lines > 0) {
      const at = this.#lineEnds(text);
      if (at !== -1) {
        this.#stage = AT_LINE;
        this.#beyond = text.slice(at);
        text = text.slice(0, at);
      }
    }
    this.#accept(text);
  }

  /** Starts the RecordEnd on the first part of the carried record. */
  #readCarry(part: string): void {
    this.#recordEnd.reset();
    // scanRows found no end in it; a reader that did starts again.
    if (this.#recordEnd.feed(part) !== -1) this.#recordEnd.reset();
  }

  /**
   * Takes the next text of the input: the carried record's next part, or the text to scan.
   *
   * While carried records end in the text after their first, a newly withheld record is joined
   * with the whole next text and scanned with it, skipping the RecordEnd. When one does not end
   * there, the RecordEnd reads it and every carried record after it, until STREAK in a row have
   * ended in the text after their first. A long record is thus scanned and joined at most once
   * more than the RecordEnd alone needs, never once per text. The join is bounded by 2 x WINDOW
   * units and by maxRecordLength.
   */
  #accept(text: string): void {
    if (this.#parts.length === 0) {
      this.#setText(text, this.#base + this.#text.length);
      return;
    }
    if (this.#fresh) {
      const joined = this.#carried + text.length;
      if (joined <= 2 * WINDOW && (this.#max === 0 || joined <= this.#max)) {
        this.#parts.push(text);
        this.#scanCarry();
        return;
      }
      this.#fresh = false;
      this.#readCarry(this.#parts[0] ?? '');
    }
    const end = this.#recordEnd.feed(text);
    // The text after the record's first: it ends here, or the run of such records does.
    if (this.#parts.length === 1 && !this.#again) this.#streak = end === -1 ? 0 : this.#streak + 1;
    if (end === -1) {
      this.#parts.push(text);
      this.#carried += text.length;
      // Scanned before it is rejected, so that a late RecordEnd rejects nothing.
      if (this.#max > 0 && this.#carried > this.#max) this.#scanCarry();
      return;
    }
    if (end < text.length) {
      this.#parts.push(text.slice(0, end));
      this.#rest = text.slice(end);
    } else this.#parts.push(text);
    this.#scanCarry();
  }

  /** Joins the carried record, once, and makes it the text to scan. */
  #scanCarry(): void {
    const parts = this.#parts;
    this.#parts = [];
    this.#fresh = false;
    this.#setText(parts.length === 1 ? (parts[0] ?? '') : parts.join(''), this.#carryBase);
  }

  #setText(text: string, base: number): void {
    const window = this.#window;
    this.#text = text;
    this.#base = base;
    this.#scanning = true;
    window.cursor = 0;
    window.nextDelimiter = SEARCH;
    window.nextNewline = SEARCH;
    window.nextQuote = SEARCH;
  }

  /**
   * One scanRows call on #text: its rows and errors go to the batch being filled. True when the
   * call read a prefix of the text and stopped at its end: the scan goes on in the text.
   *
   * Without repair, BATCH_TEXT is enforced here: #spent counts what each call adds (its units
   * less the line breaks that end its records). When the rest of the text exceeds what the batch
   * may still take, the call reads either one record, or, while records are short, the prefix
   * that ends where the allowance does; the record crossing that prefix's end is read alone by
   * the next call. Either choice gives the same batches.
   */
  #scan(): boolean {
    const text = this.#text;
    const window = this.#window;
    const max = this.#max;
    const base = this.#base;
    const before = this.#records;
    // With a deferred segment, one row of the batch is already read.
    const missing =
      this.#deferred === undefined
        ? this.#size - this.#data.length
        : Math.max(1, this.#size - this.#data.length - 1);
    // Only a text longer than maxRecordLength can hold a record that is: it is scanned one
    // record per call, which gives each record's length.
    const single = max > 0 && text.length > max;
    const last = this.#stage === LAST;
    window.limit =
      single || last || this.#rules !== undefined
        ? 1
        : this.#preview === 0
          ? missing
          : Math.min(missing, this.#preview - before);
    // The text before line `preview` ends with a line break that is not the input's end.
    window.final = this.#ended && this.#rest === '' && this.#stage !== AT_LINE;
    const from = window.cursor;
    const crossed = this.#crossed;
    this.#crossed = false;
    const allowance = BATCH_TEXT - this.#spent;
    let input = text;
    let searches: readonly number[] | undefined;
    if (window.limit > 1 && text.length - from > allowance) {
      // The average record so far picks the cheaper of a prefix and one-record calls.
      const average = this.#total / this.#records;
      if (crossed || allowance <= 0 || average * average >= 256 * allowance) window.limit = 1;
      else {
        const cut = from + allowance;
        input = text.slice(0, cut);
        window.final = false;
        // Move the window's search positions into the prefix: a match that does not end before
        // cut is not in it. cut + 1 is how scanRows marks "no quote".
        const { delimiter, newline } = this.#dialect;
        searches = [window.nextDelimiter, window.nextNewline, window.nextQuote];
        if (window.nextDelimiter >= 0 && window.nextDelimiter + delimiter.length > cut) {
          window.nextDelimiter = -1;
        }
        if (window.nextNewline >= 0 && window.nextNewline + newline.length > cut) {
          window.nextNewline = -1;
        }
        if (window.nextQuote >= cut) window.nextQuote = cut + 1;
      }
    }
    if (single && this.#dialect.comments !== '') window.cursor = this.#commentLines(window.cursor);
    const start = window.cursor;
    const emit = last && this.#mute ? NO_ROW : this.#emit;
    const { rows, errors } = scanRows(input, this.#dialect, emit, window);
    if (searches !== undefined) this.#unprefix(input.length, searches);
    // The records read, and what the call adds to the batch's text: the last record of a call
    // that the input's end ended has no line break.
    const read = emit === undefined ? rows.length : this.#records - before;
    const breaks =
      window.final && window.stop === 'end' && window.end === text.length ? read - 1 : read;
    const units = window.cursor - from - this.#dialect.newline.length * breaks;
    this.#total += units;
    if (this.#rules === undefined) this.#spent += units;
    if (this.#features !== null) {
      this.#records += rows.length;
      if (window.end !== -1) this.#cursor = base + window.end;
      this.#segment(text.slice(from, window.cursor), rows, errors, from, units);
    } else if (emit === undefined) {
      this.#records += rows.length;
      const keep = this.#keep;
      if (keep === undefined && this.#data.length === 0) this.#data = rows;
      else for (const row of rows) if (keep === undefined || keep(row)) this.#data.push(row);
    }
    if (this.#features === null) {
      for (const error of errors) {
        error.row += before;
        error.index += base;
        this.#quoteErrors.push(error);
      }
    }
    const inside = searches !== undefined && window.stop !== 'limit';
    if (inside) this.#crossed = window.stop === 'tail';
    if (window.end === -1) return inside;
    this.#cursor = base + window.end;
    // 'limit' follows a line break, which is not counted; otherwise the input ended the record.
    const lineBreak = window.stop === 'limit' ? this.#dialect.newline.length : 0;
    if (single && window.end - lineBreak - start > max) throw this.#tooLong(base + start);
    return inside;
  }

  /**
   * Moves the window's search positions back from a prefix of #text that ended at cut, from
   * `before` the call: a search that found nothing in the prefix goes on in the text after it,
   * where a delimiter or a line break of several units may start before cut.
   */
  #unprefix(cut: number, before: readonly number[]): void {
    const text = this.#text;
    const window = this.#window;
    const { delimiter, newline, quoteChar } = this.#dialect;
    const [delimiterAt = SEARCH, newlineAt = SEARCH, quoteAt = SEARCH] = before;
    const beyond = (at: number, was: number, what: string) =>
      at !== -1
        ? at
        : was === -1 || was + what.length > cut
          ? was
          : text.indexOf(what, cut - what.length + 1);
    window.nextDelimiter = beyond(window.nextDelimiter, delimiterAt, delimiter);
    window.nextNewline = beyond(window.nextNewline, newlineAt, newline);
    // The prefix's "no quote" is cut + 1, as scanRows marks it.
    if (window.nextQuote === cut + 1) {
      const at =
        quoteAt >= cut ? quoteAt : this.#quoteCode === -1 ? -1 : text.indexOf(quoteChar, cut);
      window.nextQuote = at === -1 ? text.length + 1 : at;
    }
  }

  /**
   * Where the record after the comment lines at cursor starts, as scanRows skips them, or where
   * the comment line starts that no line break ends. scanRows does not report their lengths, so a
   * comment line longer than maxRecordLength is rejected here.
   */
  #commentLines(cursor: number): number {
    const text = this.#text;
    const { comments, newline } = this.#dialect;
    while (text.charCodeAt(cursor) !== this.#quoteCode && text.startsWith(comments, cursor)) {
      const end = text.indexOf(newline, cursor);
      if (end === -1 && !this.#window.final) break;
      if ((end === -1 ? text.length : end) - cursor > this.#max) {
        throw this.#tooLong(this.#base + cursor);
      }
      if (end === -1) break;
      cursor = end + newline.length;
    }
    return cursor;
  }

  /**
   * Whether a withheld record of more than maxRecordLength units can still be within it: only one
   * of maxRecordLength + 1 units whose last unit is the "\r" of a "\r\n" that ends it. scanRows
   * decides, on a copy with the "\n" added.
   */
  #mayEnd(part: string): boolean {
    if (
      part.length !== this.#max + 1 ||
      this.#dialect.newline !== '\r\n' ||
      part.charCodeAt(part.length - 1) !== CR_CODE
    ) {
      return false;
    }
    const window = scanWindow(1);
    scanRows(part + '\n', this.#dialect, undefined, window);
    return window.stop !== 'tail' && window.cursor === part.length + 1;
  }

  #tooLong(offset: number): RangeError {
    return new RangeError(
      `Record at offset ${String(offset)} is longer than maxRecordLength (${String(this.#max)})`,
    );
  }

  /** What one scanRows call read from `from` on, with a feature set, and its weight (see #scan). */
  #segment(
    text: string,
    rows: string[][],
    errors: QuoteError[],
    from: number,
    weight: number,
  ): void {
    if (text === '' && rows.length === 0) return;
    for (const error of errors) error.index -= from;
    const last = rows.at(-1);
    if (last !== undefined) {
      const { stop, final } = this.#window;
      this.#finalRecord = stop === 'end' && final && last.length === 1 && last[0] === '';
    }
    const segment: Segment = { text, rows, errors, end: this.#cursor, weight };
    if (this.#rules === undefined) {
      const deferred = this.#deferred;
      if (deferred !== undefined) {
        this.#deferred = undefined;
        this.#build([deferred, segment], false, false);
      } else if (this.#lineFeedFirst(segment)) this.#deferred = segment;
      else this.#build([segment], false, false);
      return;
    }
    this.#pending.push(segment);
    this.#pendingRows += rows.length;
    this.#pendingUnits += text.length;
    this.#pendingWeight += weight;
    this.#drain();
  }

  /**
   * Whether segment is the first of the text and only a "\n" after a "\r" let go before it (a
   * skip that ended inside a "\r\n"): its record's snippet is then on the next line.
   */
  #lineFeedFirst(segment: Segment | undefined): boolean {
    return (
      this.#locating &&
      this.#unitBase === 0 &&
      this.#lead === '' &&
      this.#before.afterCR &&
      segment?.text === '\n'
    );
  }

  /**
   * With repair: processes the records read, except the last ones, as one unit when they fill the
   * batch or can bring its text to BATCH_TEXT. The records held back are the fewest at the end
   * that hold a record and more units than a line break, since the end-of-input rules read the
   * record before the last. While no header record is found, the records are processed again
   * from record 0 at twice as many each time. When #whole(), all records read are one unit.
   */
  #drain(): void {
    if (this.#whole() || this.#full()) return;
    const missing = this.#size - (this.#data.length - this.#head);
    const { keep, rows, units, weight } = this.#heldBack();
    const ready = this.#pendingRows - rows;
    // Whether the text since the last row built, up to the records held back, reaches BATCH_TEXT.
    const after = this.#unitBase - this.#mark - this.#breaks;
    const heavy = this.#spent + after + this.#pendingWeight - weight >= BATCH_TEXT;
    // One record more when the first is only a "\n" after a "\r": see #lineFeedFirst.
    const wanted = this.#lineFeedFirst(this.#pending[0]) ? missing + 1 : missing;
    // With maxRecordLength, the records held while no header record is found count against it.
    const over =
      this.#max > 0 &&
      this.#header &&
      this.#fields === undefined &&
      this.#pendingUnits - units > this.#max;
    if (!over && ready < Math.max(heavy ? 1 : wanted, this.#probeAt)) return;
    if (this.#buildBefore(keep)) {
      this.#pendingRows = rows;
      this.#pendingUnits = units;
      this.#pendingWeight = weight;
      this.#probeAt = 0;
    } else if (over) throw this.#tooLong(this.#unitBase);
    else this.#probeAt = 2 * ready;
  }

  /** repair with preview where a record can be split: #build must see every record read. */
  #whole(): boolean {
    return this.#options.preview > 0 && this.#rules?.has('mixed-newline') === true;
  }

  /** The records held back: the index in #pending of the first, their rows, units and weight. */
  #heldBack(): { keep: number; rows: number; units: number; weight: number } {
    const pending = this.#pending;
    let keep = pending.length;
    let rows = 0;
    let units = 0;
    let weight = 0;
    while (keep > 0 && (rows === 0 || units <= 2)) {
      const segment = pending[--keep];
      rows += segment?.rows.length ?? 0;
      units += segment?.text.length ?? 0;
      weight += segment?.weight ?? 0;
    }
    return { keep, rows, units, weight };
  }

  /**
   * The rows queued fill the batch: batchSize of them, or, once #spent has reached BATCH_TEXT,
   * those up to the record that brought it there (without repair, the record a call has just
   * ended with: atRecord). A batch holds at least one row.
   */
  #full(atRecord = false): boolean {
    const queued = this.#data.length - this.#head;
    if (queued >= this.#size) return true;
    return queued > 0 && (atRecord || this.#rules !== undefined) && this.#spent >= BATCH_TEXT;
  }

  /**
   * Builds and removes the segments of #pending before index keep; false, with nothing changed,
   * when they have not fixed the header. They are built UNIT_RECORDS at a time, so that repairRows
   * logs every change of a unit; only while no header record is found are they one unit.
   */
  #buildBefore(keep: number): boolean {
    const pending = this.#pending;
    if (this.#header && this.#fields === undefined) {
      if (!this.#build(pending.slice(0, keep), false, false)) return false;
    } else {
      for (let from = 0; from < keep; from += UNIT_RECORDS) {
        this.#build(pending.slice(from, Math.min(keep, from + UNIT_RECORDS)), false, false);
      }
    }
    this.#pending = pending.slice(keep);
    return true;
  }

  /**
   * Builds the rows of one unit (segments that follow the text processed before) with
   * parseFeatures' steps from the scan on: repair, the cut at preview, the records, and
   * positions. final: the unit ends the input, or the scan that preview ended (truncated). False,
   * with nothing changed, when the unit has not fixed the header that #drain waits for.
   */
  #build(segments: readonly Segment[], final: boolean, truncated: boolean): boolean {
    const features = this.#features as Features;
    const rules = this.#rules;
    const options = this.#options;
    const dialect = this.#dialect;
    const header = this.#header;
    const { skipEmptyLines } = options;
    const greedy = skipEmptyLines === 'greedy';
    const convert = this.#convert;
    const [only] = segments;
    let text = only?.text ?? '';
    let rows = only?.rows ?? [];
    let errors = only?.errors ?? [];
    /** With repair: where each record of the unit ends. */
    const recordEnds: number[] = [];
    if (rules !== undefined || segments.length > 1) {
      // Copies: the unit may be processed again, and repairRows changes what it is given.
      const parts: string[] = [];
      let length = 0;
      rows = [];
      errors = [];
      for (const segment of segments) {
        for (const error of segment.errors) {
          errors.push({ ...error, row: error.row + rows.length, index: error.index + length });
        }
        for (const row of segment.rows) {
          rows.push(row);
          recordEnds.push(segment.end);
        }
        parts.push(segment.text);
        length += segment.text.length;
      }
      text = parts.join('');
    }
    const scanned = rows.length;
    const repaired =
      rules === undefined
        ? undefined
        : repairRows({
            text,
            dialect,
            rows,
            errors,
            width: this.#width,
            header,
            transformHeader: this.#transformHeader,
            skipEmptyLines,
            rules,
            // A scan that preview ended has read the input's last record only when that record
            // is the empty one at its end.
            atEnd: final && (!truncated || this.#finalRecord),
            before: START,
          });
    const records = rows.length;
    let cut = false;
    if (repaired !== undefined && options.preview > 0 && rows.length > scanned) {
      const counted = { ...dialect, preview: options.preview, fastMode: options.fastMode === true };
      const keep = previewRows(text, counted, rows.length, repaired.startsOf);
      if (keep < rows.length) {
        rows.length = keep;
        cut = true;
      }
    }

    const data = this.#data;
    /** The rows built before this unit, and for each row built here the index in rows of its record. */
    const base = this.#rowOffset + data.length - this.#head;
    const origin: number[] = [];
    const fieldErrors: FieldCountError[] = [];
    const first = this.#first;
    const renamed = this.#renamedHeaders;
    const probing = header && this.#fields === undefined;
    for (const [k, values] of rows.entries()) {
      const fields = this.#fields;
      if (header && fields === undefined) {
        // Record 0 is named before it is tested; the first record left is the header, a later
        // one as it is.
        let names: unknown[] = values;
        if (this.#first) {
          this.#first = false;
          const named = headerFields(values, this.#transformHeader);
          this.#renamedHeaders = named.renamedHeaders;
          names = named.fields;
        }
        if (skipEmptyLines && isEmptyRecord(names, greedy)) continue;
        this.#fields = names;
        this.#width = names.length;
        continue;
      }
      if (skipEmptyLines && isEmptyRecord(values, greedy)) continue;
      origin.push(k);
      if (fields === undefined) {
        this.#width ??= values.length;
        data.push(convert === undefined ? values : values.map((value, j) => convert(j, value)));
        continue;
      }
      if (values.length !== fields.length) {
        fieldErrors.push(fieldCountError(fields.length, values, base + origin.length - 1));
      }
      data.push(specialRecord(fields, values, convert));
    }
    if (probing && rules !== undefined && !final && this.#fields === undefined) {
      this.#first = first;
      this.#renamedHeaders = renamed;
      return false;
    }
    if (cut) this.#cut = true;

    const lead = this.#lead;
    const shown = lead === '' ? text : lead + text;
    const before = this.#before;
    // The record after a final line break has no text of its own in a unit that is only that record.
    const startsOf = (wanted: readonly number[]): number[] =>
      text === ''
        ? wanted.map(() => 0)
        : (repaired?.startsOf(wanted) ?? recordStarts(text, dialect, wanted));
    const entries = repaired?.entries ?? [];
    const marks = entries.map((entry) => this.#unitBase + entry.offset);
    const places: Array<{ at: number; target: object }> = [];
    if (features.positions) {
      for (const error of errors) places.push({ at: error.index - 1, target: error });
      if (fieldErrors.length > 0) {
        const starts = startsOf(fieldErrors.map((error) => origin[error.row - base] ?? 0));
        fieldErrors.forEach((error, j) => places.push({ at: starts[j] ?? 0, target: error }));
      }
    }
    for (const entry of entries) places.push({ at: entry.offset, target: entry });
    if (places.length > 0) {
      places.sort((a, b) => a.at - b.at);
      const positions = positionsAt(
        shown,
        places.map(({ at }) => at + lead.length),
        before,
      );
      places.forEach(({ target }, i) => Object.assign(target, positions[i]));
    }
    for (const error of errors) {
      error.row += this.#rowBase;
      error.index += this.#unitBase;
      this.#quoteErrors.push(error);
    }
    for (const error of fieldErrors) this.#fieldErrors.push(error);
    if (repaired !== undefined) {
      const extra = this.#extra;
      for (const rule of Object.keys(extra) as RepairRule[]) extra[rule] += repaired.counts[rule];
      entries.forEach((entry, j) => {
        if (entry.row >= 0) entry.row += base;
        extra[entry.rule]--;
        this.#repairs.push({ entry, at: marks[j] ?? 0, kept: this.#logged++ < LOG_LIMIT });
      });
      if (origin.length > 0) {
        if (repaired.counts['mixed-newline'] === 0 && repaired.counts['unclosed-quote'] === 0) {
          // Row k is record k.
          for (const k of origin) this.#ends.push(recordEnds[k] ?? this.#cursor);
        } else {
          // A split or reread record gave several rows: each ends where the next one starts, the
          // last where the record (the segment it starts in) ends.
          const wanted = [...new Set(origin.flatMap((k) => [k, k + 1]))].filter(
            (k) => k < rows.length,
          );
          const starts = repaired.startsOf(wanted);
          const startOf = new Map(wanted.map((k, j) => [k, starts[j] ?? 0]));
          let s = 0;
          let textEnd = segments[0]?.text.length ?? 0;
          for (const k of origin) {
            const start = startOf.get(k) ?? 0;
            while (s < segments.length - 1 && start >= textEnd) {
              textEnd += segments[++s]?.text.length ?? 0;
            }
            const next = startOf.get(k + 1);
            this.#ends.push(
              next !== undefined && next < textEnd
                ? this.#unitBase + next
                : (segments[s]?.end ?? this.#cursor),
            );
          }
        }
      }
      // Each row weighs the text from the end of the row before to its own end, less the line
      // breaks that end records there; text that gives no row counts for the next row built.
      let at = this.#unitBase;
      let s = 0;
      let breaks = this.#breaks;
      for (const end of this.#ends.slice(this.#ends.length - origin.length)) {
        for (; s < segments.length && at + (segments[s]?.text.length ?? 0) <= end; s++) {
          const length = segments[s]?.text.length ?? 0;
          at += length;
          breaks += length - (segments[s]?.weight ?? 0);
        }
        const weight = end - this.#mark - breaks;
        this.#weights.push(weight);
        this.#spent += weight;
        this.#mark = end;
        breaks = 0;
      }
      for (; s < segments.length; s++) {
        breaks += (segments[s]?.text.length ?? 0) - (segments[s]?.weight ?? 0);
      }
      this.#breaks = breaks;
    }
    // Two segments built together without repair: each holds the records of one call.
    if (repaired === undefined && recordEnds.length > 0) {
      for (const k of origin) this.#ends.push(recordEnds[k] ?? this.#cursor);
    }
    const spots = this.#spots;
    if (spots !== undefined && origin.length > 0) {
      const unit: Unit = { text: shown, lead: lead.length, before, startsOf };
      for (const row of origin) spots.push({ unit, row });
    }
    if (this.#locating) {
      this.#before = advance(shown, shown.length, before);
      this.#lead = '';
    }
    this.#unitBase += text.length;
    this.#rowBase += records;
    return true;
  }

  /**
   * The next batch with a feature set: batchSize of the rows built, or the rows left when the
   * scan has ended. It gets the errors and the repairs of the records up to its cursor: a Quotes
   * error by its index, a repair by where its record starts, a FieldMismatch error by its row.
   * Changes beyond the entries repairRows gives for a unit are counted in the batch after it.
   */
  #featureBatch(done: boolean, truncated: boolean): ParseBatch<unknown> {
    if (done && this.#closing === undefined) {
      this.#closing = { truncated };
      if (this.#pending.length > 0) {
        // The records before those held back are built as in #drain; the rest ends the input.
        // Not when the first record needs the one after it (see #lineFeedFirst).
        const { keep } = this.#heldBack();
        if (keep > 0 && !this.#whole() && !(keep < 2 && this.#lineFeedFirst(this.#pending[0]))) {
          this.#buildBefore(keep);
        }
        const pending = this.#pending;
        this.#pending = [];
        this.#build(pending, true, truncated);
      }
      const deferred = this.#deferred;
      this.#deferred = undefined;
      // The scan ended at preview with the segment alone: the line after it was not read.
      if (deferred !== undefined) this.#build([deferred], true, truncated);
    }
    const closing = this.#closing;
    const head = this.#head;
    const queued = this.#data.length - head;
    const size = this.#size;
    let count = Math.min(queued, size);
    if (this.#rules === undefined) this.#spent = 0;
    else {
      // With repair, also up to the first row whose weight brings the text to BATCH_TEXT.
      const weights = this.#weights;
      let text = 0;
      for (let i = 0; i < count; i++) {
        text += weights[head + i] ?? 0;
        if (text >= BATCH_TEXT) {
          count = i + 1;
          break;
        }
      }
      this.#spent -= text;
    }
    const last = closing !== undefined && count === queued;
    const whole = head === 0 && queued === count;
    const data = whole ? this.#data : this.#data.slice(head, head + count);
    const rules = this.#rules;
    const cursor =
      // Without an end of its own, the last row is the last record read.
      last ? this.#cursor : (this.#ends[head + count - 1] ?? this.#cursor);

    const quotes = this.#quoteErrors;
    let taken = 0;
    while (taken < quotes.length && (last || (quotes[taken] as QuoteError).index <= cursor))
      taken++;
    const errors: ParseError[] = quotes.splice(0, taken);
    if (this.#undetectable) {
      this.#undetectable = false;
      errors.push(undetectableError());
    }
    const fieldErrors = this.#fieldErrors;
    const rowEnd = this.#rowOffset + count;
    taken = 0;
    while (taken < fieldErrors.length && (last || (fieldErrors[taken]?.row ?? 0) < rowEnd)) taken++;
    for (const error of fieldErrors.splice(0, taken)) errors.push(error);

    const { delimiter, newline } = this.#dialect;
    const detected = this.#detected;
    const batch: ParseBatch<unknown> = {
      data,
      errors,
      meta: {
        delimiter,
        linebreak: newline,
        ...(this.#header ? { fields: (this.#fields ?? []).slice() as string[] } : {}),
        renamedHeaders: this.#renamedHeaders as Record<string, string> | null,
        rowOffset: this.#rowOffset,
        cursor,
        truncated: last && (closing.truncated || this.#cut),
        done: last,
        ...(detected === undefined ? {} : { detected }),
        ...(this.#sepLine || detected?.sepLine === true ? { sepLine: true as const } : {}),
      },
    };
    if (rules !== undefined) {
      const repairs: Repair[] = [];
      const counts = this.#extra;
      this.#extra = noCounts();
      const waiting = this.#repairs;
      taken = 0;
      for (; taken < waiting.length; taken++) {
        const change = waiting[taken];
        if (change === undefined || (!last && change.at >= cursor)) break;
        counts[change.entry.rule]++;
        if (change.kept) repairs.push(change.entry);
      }
      waiting.splice(0, taken);
      batch.repairs = repairs;
      batch.repairCounts = counts;
    }
    this.#rowOffset += count;
    const spots = this.#spots;
    if (spots !== undefined) this.#taken = spots.slice(head, head + count);
    const next = head + count;
    if (next === this.#data.length) {
      // Not emptied in place: the batch may hold the array itself.
      this.#data = [];
      this.#ends = [];
      this.#weights = [];
      if (spots !== undefined) spots.length = 0;
      this.#head = 0;
    } else if (next >= 4096 && 2 * next >= this.#data.length) {
      this.#data.splice(0, next);
      this.#ends.splice(0, next);
      this.#weights.splice(0, next);
      spots?.splice(0, next);
      this.#head = 0;
    } else this.#head = next;
    this.#finished = last;
    return batch;
  }

  /** The batch being filled, as the next batch; the builder starts a new one. */
  #batch(done: boolean, truncated: boolean): ParseBatch<unknown> {
    if (this.#features !== null) return this.#featureBatch(done, truncated);
    const errors = this.#quoteErrors;
    // Bulk's place for it: after the Quotes errors, in the first batch here.
    if (this.#undetectable) {
      this.#undetectable = false;
      errors.push(undetectableError());
    }
    for (const error of this.#fieldErrors) errors.push(error);
    const data = this.#data;
    this.#spent = 0;
    const { delimiter, newline } = this.#dialect;
    const batch: ParseBatch<unknown> = {
      data,
      errors,
      meta: {
        delimiter,
        linebreak: newline,
        // A copy: the builder goes on reading its own array for later rows.
        ...(this.#header ? { fields: (this.#fields ?? []).slice() as string[] } : {}),
        renamedHeaders: this.#renamedHeaders as Record<string, string> | null,
        rowOffset: this.#rowOffset,
        cursor: this.#cursor,
        truncated,
        done,
      },
    };
    this.#rowOffset += data.length;
    this.#data = [];
    this.#quoteErrors = [];
    this.#fieldErrors = [];
    this.#finished = done;
    return batch;
  }
}
