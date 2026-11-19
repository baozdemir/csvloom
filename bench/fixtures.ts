import { createHash } from 'node:crypto';
import type { Dialect, Row } from './lanes.ts';

// Deterministic synthetic CSV. The generator knows every field it writes, so
// expected output is independent of any parser, including the reference.

export const FAMILIES = [
  'simple',
  'quote-heavy',
  'multiline',
  'wide',
  'unicode',
  'long-field',
] as const;
export type Family = (typeof FAMILIES)[number];

export interface FixtureSpec {
  family: Family;
  seed: number;
  targetBytes: number;
}

export interface Fixture {
  csv: string;
  /** Header row first. */
  rows: Row[];
  dialect: Dialect;
  bytes: number;
  columns: number;
  sha256: string;
}

type Random = () => number;

// mulberry32: small, fast and stable across runtimes.
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (random: Random, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const word = (random: Random, min = 3, max = 10) => {
  let out = '';
  for (let i = int(random, min, max); i > 0; i--) out += LOWER.charAt(Math.floor(random() * 26));
  return out;
};
const words = (random: Random, count: number, separators: readonly string[] = [' ']) => {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(word(random), pick(random, separators));
  return parts.join('').trimEnd();
};
const amount = (random: Random) =>
  `${String(int(random, 0, 99999))}.${String(int(random, 0, 99)).padStart(2, '0')}`;

const UNICODE_TEXT = [
  'İstanbul',
  'ıspanak',
  'Iğdır',
  'şeftali',
  'ÇĞİÖŞÜ',
  '東京都',
  '北京市',
  'ソウル',
  '서울특별시',
  'Москва',
  'Київ',
  'القاهرة',
  'עברית',
  'Ελλάδα',
  'नमस्ते',
  'தமிழ்',
  'ไทย',
  'café',
  'café',
  'ñ',
  'Å̊',
  '😀',
  '👩🏽‍💻',
  '🇹🇷',
  '👨‍👩‍👧‍👦',
  '🧪🧬',
  '∑∫√∞',
  '½ ¾ ⅞',
];

interface FamilyShape {
  dialect: Dialect;
  header: Row;
  row: (random: Random, index: number) => Row;
  /** Quote even fields that do not need it, with this probability. */
  extraQuoting: number;
}

const COMMA_LF: Dialect = { delimiter: ',', quote: '"', newline: '\n' };
const COMMA_CRLF: Dialect = { delimiter: ',', quote: '"', newline: '\r\n' };
const WIDE_COLUMNS = 256;

const SHAPES: Record<Family, FamilyShape> = {
  simple: {
    dialect: COMMA_LF,
    header: ['id', 'name', 'city', 'code', 'amount', 'qty', 'flag', 'note'],
    extraQuoting: 0,
    row: (r, i) => [
      String(i),
      word(r, 3, 12),
      word(r, 4, 9),
      word(r, 2, 4).toUpperCase(),
      amount(r),
      String(int(r, 0, 500)),
      r() < 0.5 ? 'Y' : 'N',
      words(r, int(r, 0, 4)),
    ],
  },
  'quote-heavy': {
    dialect: COMMA_CRLF,
    header: ['id', 'customer', 'address', 'comment', 'amount', 'tags', 'status', 'quote'],
    extraQuoting: 0.5,
    row: (r, i) => [
      String(i),
      `${word(r)}, ${word(r)}`,
      `${String(int(r, 1, 999))} ${word(r)} St, ${word(r)}`,
      words(r, int(r, 1, 6), [' ', ', ', ' "', '" ', '""']),
      amount(r),
      words(r, int(r, 0, 3), [',']),
      r() < 0.2 ? '' : pick(r, ['open', 'closed', 'on hold']),
      `"${words(r, int(r, 1, 3))}"`,
    ],
  },
  multiline: {
    dialect: COMMA_LF,
    header: ['id', 'title', 'body', 'author', 'notes', 'score'],
    extraQuoting: 0,
    row: (r, i) => [
      String(i),
      words(r, int(r, 1, 4)),
      words(r, int(r, 2, 12), [' ', ' ', '\n', '\r\n', ', ', '"']),
      word(r),
      r() < 0.3 ? words(r, int(r, 1, 5), ['\n', '\n\n', ' ']) : '',
      String(int(r, 0, 100)),
    ],
  },
  wide: {
    dialect: COMMA_LF,
    header: Array.from({ length: WIDE_COLUMNS }, (_, c) => `c${String(c)}`),
    extraQuoting: 0,
    row: (r) =>
      Array.from({ length: WIDE_COLUMNS }, () => (r() < 0.2 ? '' : String(int(r, 0, 99999)))),
  },
  unicode: {
    dialect: COMMA_LF,
    header: ['kimlik', 'şehir', '名前', 'описание', 'emoji', 'ünvan', 'not', 'değer'],
    extraQuoting: 0,
    row: (r, i) => [
      String(i),
      pick(r, UNICODE_TEXT),
      `${pick(r, UNICODE_TEXT)} ${pick(r, UNICODE_TEXT)}`,
      `${pick(r, UNICODE_TEXT)}, ${word(r)}`,
      pick(r, UNICODE_TEXT.slice(-8)),
      `${pick(r, UNICODE_TEXT)}"${pick(r, UNICODE_TEXT)}`,
      r() < 0.3 ? `${pick(r, UNICODE_TEXT)}\n${pick(r, UNICODE_TEXT)}` : '',
      amount(r),
    ],
  },
  'long-field': {
    dialect: COMMA_LF,
    header: ['id', 'title', 'body', 'checksum'],
    extraQuoting: 0,
    row: (r, i) => {
      const targetLength = int(r, 8 * 1024, 64 * 1024);
      let body = '';
      while (body.length < targetLength) body += `${words(r, 16, [' ', ' ', ', ', '"', '\n'])}\n`;
      return [String(i), words(r, 3), body, word(r, 8, 8)];
    },
  },
};

export function familyFormat(family: Family): { header: Row; dialect: Dialect } {
  return { header: SHAPES[family].header, dialect: SHAPES[family].dialect };
}

function encodeField(field: string, dialect: Dialect, forceQuote: boolean): string {
  const { quote, delimiter } = dialect;
  const needsQuote =
    forceQuote ||
    field.includes(quote) ||
    field.includes(delimiter) ||
    field.includes('\n') ||
    field.includes('\r');
  return needsQuote ? quote + field.split(quote).join(quote + quote) + quote : field;
}

function encodeRow(row: Row, shape: FamilyShape, random: Random): string {
  return row
    .map((field) =>
      encodeField(field, shape.dialect, shape.extraQuoting > 0 && random() < shape.extraQuoting),
    )
    .join(shape.dialect.delimiter);
}

/**
 * Appends records until the UTF-8 size reaches targetBytes. Every record,
 * including the last, ends with the family's line ending.
 */
export function generateFixture(spec: FixtureSpec): Fixture {
  const shape = SHAPES[spec.family];
  const random = mulberry32(spec.seed);
  const rows: Row[] = [shape.header];
  const lines: string[] = [encodeRow(shape.header, shape, random)];
  const newlineBytes = shape.dialect.newline.length;
  let bytes = Buffer.byteLength(lines[0] ?? '') + newlineBytes;
  while (bytes < spec.targetBytes) {
    const row = shape.row(random, rows.length);
    const line = encodeRow(row, shape, random);
    rows.push(row);
    lines.push(line);
    bytes += Buffer.byteLength(line) + newlineBytes;
  }
  const csv = lines.join(shape.dialect.newline) + shape.dialect.newline;
  return {
    csv,
    rows,
    dialect: shape.dialect,
    bytes,
    columns: shape.header.length,
    sha256: createHash('sha256').update(csv).digest('hex'),
  };
}
