import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as chai from 'chai';
import Papa from 'papaparse';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDetailed } from '../src/detailed.ts';
import { parse } from '../src/parse.ts';
import type { Newline, ParseConfig } from '../src/types.ts';
import {
  compare,
  difference,
  DIALECTS,
  fuzz,
  isDelimiter,
  isNewline,
  mainParse,
  papaParse,
  type Case,
  type EngineParse,
} from './differential.ts';
import { PARSE_FIXTURES, type ParseFixture } from './fixtures/groups.ts';

// Differential tests: each csvloom entry against Papa Parse 5.7.1, run live
// on the same input with the same config (comparison rules in
// test/differential.ts), thrown messages compared exactly.

const DIALECT_KEYS = [
  'delimiter',
  'newline',
  'header',
  'quoteChar',
  'escapeChar',
  'comments',
  'skipEmptyLines',
  'preview',
  'skipFirstNLines',
  'fastMode',
  'delimitersToGuess',
  'transformHeader',
  'dynamicTyping',
  'transform',
];
const isComments = (value: unknown): value is boolean | string =>
  typeof value === 'boolean' ||
  (typeof value === 'string' && value !== '"' && value !== '\ufeff' && !/[\r\n]/.test(value));
const isSkip = (value: unknown): value is boolean | 'greedy' =>
  typeof value === 'boolean' || value === 'greedy';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// '' and an omitted value mean automatic in both libraries.
const isDelimiterOption = (value: unknown): value is string | ((input: string) => string) =>
  value === '' || typeof value === 'function' || isDelimiter(value);
const isNewlineOption = (value: unknown): value is '' | Newline => value === '' || isNewline(value);
const isGuessList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isDelimiter);
const isHeaderTransform = (value: unknown): value is (header: string, index: number) => string =>
  typeof value === 'function';
const isTransform = (value: unknown): value is (value: string, field: string | number) => unknown =>
  typeof value === 'function';
const isTyping = (value: unknown): value is NonNullable<ParseConfig['dynamicTyping']> =>
  typeof value === 'boolean' ||
  typeof value === 'function' ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((typed) => typeof typed === 'boolean'));
interface PapaOptions {
  delimiter?: unknown;
  newline?: unknown;
  header?: unknown;
  quoteChar?: unknown;
  escapeChar?: unknown;
  comments?: unknown;
  skipEmptyLines?: unknown;
  preview?: unknown;
  skipFirstNLines?: unknown;
  fastMode?: unknown;
  delimitersToGuess?: unknown;
  transformHeader?: unknown;
  dynamicTyping?: unknown;
  transform?: unknown;
}
// Option values the main entry accepts (D2-k, P3-a, P3-b, P3-c).
const valuesOk = (config: PapaOptions) =>
  (config.delimiter === undefined || isDelimiterOption(config.delimiter)) &&
  (config.newline === undefined || isNewlineOption(config.newline)) &&
  (config.delimitersToGuess === undefined || isGuessList(config.delimitersToGuess)) &&
  (config.quoteChar === undefined ||
    (typeof config.quoteChar === 'string' && config.quoteChar.length === 1)) &&
  (config.escapeChar === undefined || typeof config.escapeChar === 'string') &&
  (config.comments === undefined || isComments(config.comments)) &&
  (config.skipEmptyLines === undefined || isSkip(config.skipEmptyLines)) &&
  (config.preview === undefined || isCount(config.preview)) &&
  (config.skipFirstNLines === undefined || isCount(config.skipFirstNLines)) &&
  (config.fastMode === undefined || typeof config.fastMode === 'boolean') &&
  (config.transformHeader === undefined || isHeaderTransform(config.transformHeader)) &&
  (config.dynamicTyping === undefined || isTyping(config.dynamicTyping)) &&
  (config.transform === undefined || isTransform(config.transform));

/** The main-entry config for a Papa config whose values pass valuesOk. */
function mainConfig(config: PapaOptions): ParseConfig {
  const { delimiter, newline, delimitersToGuess, transformHeader, dynamicTyping, transform } =
    config;
  const { quoteChar, escapeChar, comments, skipEmptyLines, preview, skipFirstNLines, fastMode } =
    config;
  return {
    ...(isDelimiterOption(delimiter) ? { delimiter } : {}),
    ...(isNewlineOption(newline) ? { newline } : {}),
    ...(isGuessList(delimitersToGuess) ? { delimitersToGuess } : {}),
    header: config.header === true,
    ...(typeof quoteChar === 'string' ? { quoteChar } : {}),
    ...(typeof escapeChar === 'string' ? { escapeChar } : {}),
    ...(isComments(comments) ? { comments } : {}),
    ...(isSkip(skipEmptyLines) ? { skipEmptyLines } : {}),
    ...(isCount(preview) ? { preview } : {}),
    ...(isCount(skipFirstNLines) ? { skipFirstNLines } : {}),
    ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
    ...(isHeaderTransform(transformHeader) ? { transformHeader } : {}),
    ...(isTyping(dynamicTyping) ? { dynamicTyping } : {}),
    ...(isTransform(transform) ? { transform } : {}),
  };
}

const LF = { delimiter: ',', newline: '\n' } as const;

interface Entry {
  run: EngineParse;
  /** The config the entry gets for a Papa config, or null when it rejects one of its values. */
  configFor: (config: PapaOptions) => ParseConfig | null;
  /** Upstream cases the entry rejects with a TypeError naming the option. */
  rejected: Readonly<Record<string, string>>;
  /** Upstream cases compared. */
  cases: number;
}
const ENTRIES: ReadonlyArray<readonly [string, Entry]> = [
  [
    'main entry',
    {
      run: mainParse,
      configFor: (config) => (valuesOk(config) ? mainConfig(config) : null),
      // Values Papa reads silently that the main entry rejects:
      // comments other than a boolean or a string, a delimiter containing a
      // line break (D2-k, P3-c), a negative skipFirstNLines.
      rejected: {
        'Bad comments value specified': 'comments',
        'Bad delimiter (\\n)': 'delimiter',
        'Skip First N number of lines , with header false and skipFirstNLines as negative value':
          'skipFirstNLines',
      },
      cases: 158,
    },
  ],
  // Papa's coercions: every config is passed as given.
  [
    'csvloom/papa',
    { run: papaParse, configFor: (config) => config as ParseConfig, rejected: {}, cases: 161 },
  ],
];

beforeEach(() => {
  // Papa logs duplicate headers; csvloom does not (exception D2-b).
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return () => {
    vi.restoreAllMocks();
  };
});

describe('comparator', () => {
  it('detects a changed value, key order, error and meta', () => {
    const base = parse('a,b\n1,2', { delimiter: ',', newline: '\n', header: true });
    const clone = () => structuredClone(base);
    expect(difference(clone(), base)).toBeNull();
    const value = clone();
    value.data[0] = { a: '1', b: '3' };
    expect(difference(value, base)).toBe('data');
    const order = clone();
    order.data[0] = { b: '2', a: '1' };
    expect(difference(order, base)).toBe('key order of record 0');
    const errors = clone();
    errors.errors.push({
      type: 'FieldMismatch',
      code: 'TooFewFields',
      message: '',
      row: 0,
    });
    expect(difference(errors, base)).toBe('errors');
    const meta = clone();
    meta.meta.cursor++;
    expect(difference(meta, base)).toBe('meta');
  });

  it('compares Dates by getTime(), two invalid Dates equal, on every Node', () => {
    const result = (...dates: Date[]) => ({ ...parse('a', LF), data: [dates, { a: dates }] });
    const invalid = () => new Date(Number.NaN);
    expect(difference(result(invalid(), new Date(0)), result(invalid(), new Date(0)))).toBeNull();
    expect(difference(result(invalid()), result(new Date(0)))).toBe('data');
    expect(difference(result(new Date(1)), result(new Date(0)))).toBe('data');
    expect(difference(result(invalid()), result(invalid(), invalid()))).toBe('data');
    const extra = Object.assign([invalid()], { x: 1 });
    expect(difference(result(...extra), { ...result(), data: [extra, { a: [invalid()] }] })).toBe(
      'data',
    );
  });
});

describe.each(ENTRIES)('%s', (_name, entry) => {
  const { run } = entry;

  describe('grouped fixtures', () => {
    const supported = (config: Papa.ParseConfig<unknown>) =>
      Object.keys(config).every((key) => DIALECT_KEYS.includes(key)) &&
      entry.configFor(config) !== null;
    // A reentrant fixture's transform starts another parse with csvloom itself
    // (in both libraries' transforms) and checks that parse's result.
    const inner = { delimiter: ';', newline: '\n', dynamicTyping: true } as const;
    const configFor = (f: ParseFixture): ParseConfig => {
      const config = entry.configFor(f.config) ?? {};
      if (!f.reentrant) return config;
      const fresh = parse('x;y\n1;2', inner);
      return {
        ...config,
        transform: (value) => {
          expect(parse('x;y\n1;2', inner)).toStrictEqual(fresh);
          return value;
        },
      };
    };

    it('excludes no fixture: each config is one the entry accepts', () => {
      const excluded = PARSE_FIXTURES.filter((f) => !supported(f.config)).map(
        (f) => `${f.group}/${f.id}`,
      );
      expect(excluded).toStrictEqual([]);
    });

    it.each(PARSE_FIXTURES.map((f) => [`${f.group}/${f.id}`, f] as const))('%s', (_name, f) => {
      expect(compare({ input: f.input, config: configFor(f) }, run)).toBeNull();
    });
  });

  describe('header names with special meaning in JavaScript or Papa', () => {
    it.each([
      '__parsed_extra,b\nx,y,z',
      'a,__parsed_extra\n1,2,3,4\n5',
      '__parsed_extra,__parsed_extra\n1,2,3',
      'constructor,prototype,toString,hasOwnProperty,valueOf\n1,2,3,4,5',
      '10,2,-1,1.5,01\na,b,c,d,e',
      ',,\n1,2,3',
      'a,a_1,a,a,a_3,a,b,b_2,b\n1',
      `${['a', ...Array.from({ length: 40 }, (_, i) => `a_${String(i * 2)}`), ...Array<string>(40).fill('a')].join(',')}\n1`,
    ])('%j', (input) => {
      expect(
        compare({ input, config: { delimiter: ',', newline: '\n', header: true } }, run),
      ).toBeNull();
    });

    it('compares typed columns named like prototype members without headers (D2-d)', () => {
      const input = 'constructor,prototype,toString,hasOwnProperty,valueOf,b\n1,2,3,4,5,6';
      const config = { delimiter: ',', newline: '\n', header: true } as const;
      expect(compare({ input, config: { ...config, dynamicTyping: true } }, run)).toBe('D2-d');
      expect(compare({ input, config: { ...config, dynamicTyping: () => true } }, run)).toBe(
        'D2-d',
      );
      // Papa reads an own map key as asked.
      const map = { constructor: true, toString: true };
      expect(compare({ input, config: { ...config, dynamicTyping: map } }, run)).toBeNull();
    });

    it('finds the exceptions in names that transformHeader returns, with other options', () => {
      const config = {
        ...LF,
        header: true,
        transformHeader: (h: string) => h.toLowerCase(),
        transform: (v: string) => `${v}0`,
        skipEmptyLines: true,
        preview: 2,
      } as const;
      const input = 'Constructor,B\n\n1,2\n3,4\n5,6';
      expect(compare({ input, config: { ...config, dynamicTyping: true } }, run)).toBe('D2-d');
      expect(compare({ input, config: { ...config, dynamicTyping: () => true } }, run)).toBe(
        'D2-d',
      );
      // D2-c is found first.
      const proto = '__PROTO__,constructor\n1,2';
      expect(compare({ input: proto, config: { ...config, dynamicTyping: true } }, run)).toBe(
        'D2-c',
      );
    });
  });

  describe('Papa Parse 5.7.1 upstream test inputs', () => {
    interface UpstreamTest {
      description: string;
      input: unknown;
      config?: Record<string, unknown>;
      disabled?: boolean;
    }
    // The vendored upstream file declares its cases as top-level vars; evaluating it
    // with no-op describe/it exposes them without running its assertions.
    const require = createRequire(import.meta.url);
    const file = require.resolve('./upstream/papaparse-5.7.1/tests/test-cases.js');
    const sandbox: Record<string, unknown> = {
      module: { exports: {} },
      require: (id: string) => {
        if (id === 'chai') return chai;
        if (id === '../papaparse.js') return Papa;
        throw new Error(`unexpected require ${id}`);
      },
      describe: Object.assign(() => undefined, { skip: () => undefined }),
      it: Object.assign(() => undefined, { skip: () => undefined }),
    };
    runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
    const all = [
      ...(sandbox.CORE_PARSER_TESTS as UpstreamTest[]),
      ...(sandbox.PARSE_TESTS as UpstreamTest[]),
      ...(sandbox.PARSE_ASYNC_TESTS as UpstreamTest[]),
    ];

    // The excluded options (D3), which both entries reject with
    // UnsupportedFeatureError.
    const EXCLUDED_OPTIONS = new Set([
      'worker',
      'download',
      'step',
      'chunk',
      'complete',
      'error',
      'beforeFirstChunk',
      'chunkSize',
      'encoding',
      'downloadRequestHeaders',
      'downloadRequestBody',
      'withCredentials',
      'downloadTimeout',
    ]);

    const cases: Array<[string, Case]> = [];
    const rejected: Array<[string, string, Record<string, unknown>]> = [];
    // Not compared: the excluded options and non-string inputs each case uses.
    const excluded: Array<[string, string[]]> = [];
    for (const test of all) {
      const config = test.config ?? {};
      const features = Object.keys(config).filter((key) => EXCLUDED_OPTIONS.has(key));
      const accepted = entry.configFor(config);
      if (typeof test.input !== 'string') {
        excluded.push([test.description, ['non-string input', ...features]]);
      } else if (features.length > 0) excluded.push([test.description, features]);
      else if (Object.keys(config).every((key) => DIALECT_KEYS.includes(key)) && accepted) {
        cases.push([test.description, { input: test.input, config: accepted }]);
      } else rejected.push([test.description, test.input, config]);
    }

    const EXCLUDED_COUNT = 7;

    it('found the upstream cases', () => {
      expect(all).toHaveLength(168);
      expect(cases).toHaveLength(entry.cases);
      expect(rejected.map(([name]) => name)).toStrictEqual(Object.keys(entry.rejected));
      expect(excluded).toHaveLength(EXCLUDED_COUNT);
      expect(excluded).toStrictEqual([
        ['Simple worker', ['worker']],
        ['Simple download', ['download']],
        ['Simple download + worker', ['worker', 'download']],
        // File inputs (false where File is unavailable, as here).
        ['Simple file', ['non-string input']],
        ['Simple file + worker', ['non-string input', 'worker']],
        ['File with a few regular and lots of empty lines', ['non-string input']],
        [
          'File with a few regular and lots of empty lines + worker',
          ['non-string input', 'worker'],
        ],
      ]);
    });

    if (rejected.length > 0) {
      it.each(rejected)('%s: rejected by the main entry', (name, input, config) => {
        const call = () => parse(input, config);
        expect(call).toThrow(TypeError);
        expect(call).toThrow(`"${String(entry.rejected[name])}"`);
      });
    }

    it.each(cases)('%s', (_name, c) => {
      const result = compare(c, run);
      // The one upstream __proto__ case is exception D2-c.
      if (c.input.startsWith('__proto__')) expect(result).toBe('D2-c');
      else expect(result).toBeNull();
    });
  });

  describe('CSV Spectrum 2.0.0 inputs (header: true)', () => {
    const dir = createRequire(import.meta.url)
      .resolve('csv-spectrum/package.json')
      .replace(/package\.json$/, '');
    const names = readdirSync(`${dir}csvs`)
      .filter((f) => f.endsWith('.csv'))
      .map((f) => f.slice(0, -4))
      .sort();

    it.each(names)('%s', (name) => {
      const input = new TextDecoder().decode(readFileSync(`${dir}csvs/${name}.csv`));
      expect(compare({ input, config: { delimiter: ',', header: true } }, run)).toBeNull();
    });
  });

  describe('seeded differential fuzzing', () => {
    const SEED = 20261026;
    const PER_DIALECT = 500;

    // About 2 s alone; test files running at the same time can push it past Vitest's 5 s default.
    it(`matches Papa on ${String(DIALECTS.length * PER_DIALECT * 2)} generated inputs (seed ${String(SEED)})`, () => {
      const summary = fuzz(SEED, PER_DIALECT, undefined, run);
      expect(summary.failures).toStrictEqual([]);
    }, 60_000);
  });

  describe('header cells and the BOM', () => {
    it('a header cell starting with U+FEFF loses it, as in Papa', () => {
      const input = 'a,\ufeffb\n1,2';
      const config = { delimiter: ',', newline: '\n', header: true } as const;
      expect(difference(run(input, config), Papa.parse(input, { ...config }))).toBeNull();
    });
  });
});

describe('csvloom/papa ignores the feature keys', () => {
  const KEYS: Readonly<Record<string, unknown>> = {
    detect: true,
    positions: true,
    repair: true,
    sepLine: true,
    schema: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('csvloom/papa called the schema');
        },
      },
    },
  };
  const outcome = (run: () => unknown) => {
    try {
      return { value: run() };
    } catch (error) {
      return { thrown: String(error) };
    }
  };

  it.each(Object.keys(KEYS))(
    '%s: every grouped fixture parses as without the key, and as in Papa Parse',
    (key) => {
      const withKey: typeof papaParse = (input, config) =>
        papaParse(input, { ...config, [key]: KEYS[key] });
      for (const f of PARSE_FIXTURES) {
        const config = f.config as ParseConfig;
        const name = `${f.group}/${f.id}`;
        expect([name, compare({ input: f.input, config }, withKey)]).toStrictEqual([name, null]);
        const without = outcome(() => papaParse(f.input, config));
        const actual = outcome(() => withKey(f.input, config));
        if ('thrown' in without || 'thrown' in actual) {
          expect([name, actual]).toStrictEqual([name, without]);
        } else expect([name, difference(actual.value, without.value)]).toStrictEqual([name, null]);
      }
    },
  );

  it('ignores detect on inputs where honouring it would change the result', () => {
    // A ';' file with decimal commas that the guess reads as ',', and a preamble.
    for (const input of ['x;y\n1,2;3\n4,5;6\n7;8\n', 'Report 2026\n\nid;name\n1;x\n']) {
      const reference = Papa.parse(input);
      const honoured = parseDetailed(input, { detect: true });
      expect(honoured.data).not.toStrictEqual(reference.data);
      expect(difference(papaParse(input, { detect: true } as ParseConfig), reference)).toBeNull();
    }
  });

  it('reads a sep= line and an unclosed quote as Papa Parse does, whatever the keys say', () => {
    const all = KEYS as ParseConfig;
    for (const input of [
      'sep=;\na;b\n1;2',
      'a,b,c\n1,2\n',
      'a,"b\n1,2\n3,4',
      'a,b\r\n1,2\n3,4\r\n',
    ]) {
      const reference = Papa.parse(input);
      expect(difference(papaParse(input, all), reference)).toBeNull();
      expect(Object.keys(papaParse(input, all))).toStrictEqual(['data', 'errors', 'meta']);
    }
  });
});
