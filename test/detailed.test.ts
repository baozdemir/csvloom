import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as detailedModule from '../src/detailed.ts';
import { parseDetailed } from '../src/detailed.ts';
import * as detectModule from '../src/detect.ts';
import { guessNewline } from '../src/dialect.ts';
import * as locateModule from '../src/locate.ts';
import {
  resolveDetailedConfig,
  resolveParseConfig,
  UnsupportedFeatureError,
} from '../src/options.ts';
import { parse } from '../src/parse.ts';
import { scanRows, type ScanDialect } from '../src/parser.ts';
import * as repairModule from '../src/repair.ts';
import * as schemaModule from '../src/schema.ts';
import type { DetailedConfig, ParseConfig, StandardSchemaV1 } from '../src/types.ts';
import { difference, fuzz, mainParse, type Case } from './differential.ts';
import { PARSE_FIXTURES } from './fixtures/groups.ts';

// Spies that keep each module's own code, so that calls into the feature modules can be counted.
vi.mock(import('../src/detailed.ts'), { spy: true });
vi.mock(import('../src/detect.ts'), { spy: true });
vi.mock(import('../src/locate.ts'), { spy: true });
vi.mock(import('../src/repair.ts'), { spy: true });
vi.mock(import('../src/schema.ts'), { spy: true });

beforeEach(() => {
  // Papa, the reference of the fuzz harness, logs duplicate headers.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.clearAllMocks();
});

const passThrough: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};
const RULES = [
  'pad-missing',
  'drop-trailing-empty',
  'trailing-empty-record',
  'mixed-newline',
  'unclosed-quote',
] as const;
/** The five feature keys of parseDetailed and parseStream, each with a value that sets it. */
const FEATURE_VALUES: Readonly<Record<string, unknown>> = {
  detect: true,
  positions: true,
  repair: true,
  schema: passThrough,
  sepLine: true,
};
const POSITION_KEYS = ['line', 'column', 'offset', 'snippet'] as const;

const outcome = (run: () => unknown): { value: unknown } | { thrown: string } => {
  try {
    return { value: run() };
  } catch (error) {
    return { thrown: `${(error as Error).name}: ${(error as Error).message}` };
  }
};
/** parseDetailed with a config built at run time. */
const detailed = (input: string, config?: object) => parseDetailed(input, config as DetailedConfig);

/** Every input and config the seeded fuzz of test/differential.ts gives its entry. */
function fuzzCases(seed: number, perDialect: number): Case[] {
  const cases: Case[] = [];
  fuzz(seed, perDialect, undefined, (input, config) => {
    cases.push({ input, config });
    return mainParse(input, config);
  });
  return cases;
}

describe('resolveDetailedConfig', () => {
  const features = (config: unknown) => resolveDetailedConfig(config).features;

  it.each([
    ['detect', 'yes', 'Parse option "detect" must be a boolean'],
    ['detect', 0, 'Parse option "detect" must be a boolean'],
    ['detect', null, 'Parse option "detect" must be a boolean'],
    ['positions', 'yes', 'Parse option "positions" must be a boolean'],
    ['positions', 1, 'Parse option "positions" must be a boolean'],
    ['positions', null, 'Parse option "positions" must be a boolean'],
    ['sepLine', 'yes', 'Parse option "sepLine" must be a boolean'],
    ['sepLine', 0, 'Parse option "sepLine" must be a boolean'],
    ['repair', 'all', 'Parse option "repair" must be a boolean or an array of rule names'],
    ['repair', 5, 'Parse option "repair" must be a boolean or an array of rule names'],
    ['repair', null, 'Parse option "repair" must be a boolean or an array of rule names'],
    [
      'repair',
      ['pad-missing', 'nope'],
      'Parse option "repair" must be a boolean or an array of rule names',
    ],
    ['repair', [1], 'Parse option "repair" must be a boolean or an array of rule names'],
    ['schema', {}, 'Parse option "schema" must be a Standard Schema v1 object'],
    ['schema', null, 'Parse option "schema" must be a Standard Schema v1 object'],
    ['schema', true, 'Parse option "schema" must be a Standard Schema v1 object'],
    [
      'schema',
      { '~standard': { version: 2, vendor: 'x', validate: () => ({ value: 1 }) } },
      'Parse option "schema" must be a Standard Schema v1 object',
    ],
  ])('%s: %j throws a TypeError', (key, value, message) => {
    const error = outcome(() => detailed('a', { [key]: value }));
    expect(error).toStrictEqual({ thrown: `TypeError: ${message}` });
  });

  it('throws for an unknown key and for a config that is no plain object, as parse does', () => {
    for (const config of [{ nope: 1 }, [], 'x', null, 5]) {
      const expected = outcome(() => parse('a', config as ParseConfig));
      expect(expected).toHaveProperty('thrown');
      expect(outcome(() => detailed('a', config as object))).toStrictEqual(expected);
      if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
      expect(outcome(() => detailed('a', { ...config, positions: true }))).toStrictEqual(expected);
    }
  });

  it('accepts detect, which parse rejects, and needs a candidate for it', () => {
    for (const detect of [true, false]) {
      expect(outcome(() => parse('a', { detect } as ParseConfig))).toStrictEqual({
        thrown: 'TypeError: Unknown parse option "detect"',
      });
      expect(outcome(() => detailed('a', { detect }))).toHaveProperty('value');
    }
    const empty =
      'TypeError: Parse option "delimitersToGuess" must be a non-empty array with detect';
    expect(outcome(() => detailed('a', { detect: true, delimitersToGuess: [] }))).toStrictEqual({
      thrown: empty,
    });
    // Even when a delimiter is given: the rule depends on the config only.
    expect(
      outcome(() => detailed('a', { detect: true, delimiter: ';', delimitersToGuess: [] })),
    ).toStrictEqual({ thrown: empty });
    // A ParseConfig value outside its type is reported first.
    expect(outcome(() => detailed('a', { detect: 'yes', delimitersToGuess: 5 }))).toStrictEqual({
      thrown: 'TypeError: Parse option "delimitersToGuess" must be an array',
    });
    // Without detect an empty list is what parse makes of it.
    expect(detailed('a', { delimitersToGuess: [], positions: true }).errors).toStrictEqual(
      parse('a', { delimitersToGuess: [] }).errors,
    );
  });

  it('throws for a D3 key and for a ParseConfig value outside its type, as parse does', () => {
    const configs: object[] = [
      { worker: true },
      { step: () => undefined },
      { encoding: 'latin1' },
      { worker: 'yes' },
      { delimiter: '"' },
      { newline: 'x' },
      { header: 'yes' },
      { preview: -1 },
      { comments: ',', delimiter: ',' },
    ];
    for (const config of configs) {
      const expected = outcome(() => parse('a', config));
      expect(expected).toHaveProperty('thrown');
      expect(outcome(() => detailed('a', { ...config, positions: true }))).toStrictEqual(expected);
      expect(outcome(() => detailed('a', config))).toStrictEqual(expected);
    }
    expect(() => detailed('a', { worker: true, repair: true })).toThrow(UnsupportedFeatureError);
  });

  it('throws for an input that is not a string, as parse does', () => {
    for (const input of [null, undefined, 5, {}, 1]) {
      const expected = outcome(() => parse(input as string));
      expect(outcome(() => detailed(input as string, { positions: true }))).toStrictEqual(expected);
    }
  });

  it('gives features null when each key is false, undefined or an empty rule list', () => {
    const off: unknown[] = [
      undefined,
      {},
      { positions: false },
      { sepLine: false },
      { detect: false },
      { detect: undefined },
      { repair: false },
      { repair: [] },
      { schema: undefined },
      { positions: undefined, repair: undefined, sepLine: undefined },
      {
        detect: false,
        positions: false,
        repair: [],
        schema: undefined,
        sepLine: false,
        header: true,
      },
    ];
    for (const config of off) expect(features(config)).toBeNull();
  });

  it('gives each feature as set, and the keys the caller gave', () => {
    expect(features({ positions: true })).toStrictEqual({
      detect: false,
      positions: true,
      repair: null,
      schema: null,
      sepLine: false,
      given: new Set(),
    });
    expect(features({ repair: true })?.repair).toStrictEqual(new Set(RULES));
    expect(
      features({ repair: ['pad-missing', 'pad-missing', 'mixed-newline'] })?.repair,
    ).toStrictEqual(new Set(['pad-missing', 'mixed-newline']));
    expect(features({ schema: passThrough })?.schema).toBe(passThrough);
    expect(features({ sepLine: true })?.sepLine).toBe(true);
    expect(features({ detect: true })).toStrictEqual({
      detect: true,
      positions: false,
      repair: null,
      schema: null,
      sepLine: false,
      given: new Set(),
    });
    expect(
      features({
        positions: true,
        delimiter: ',',
        newline: undefined,
        quoteChar: '"',
        skipFirstNLines: 0,
        header: true,
      })?.given,
    ).toStrictEqual(new Set(['delimiter', 'quoteChar', 'skipFirstNLines']));
    expect(features({ sepLine: true, newline: '\n', escapeChar: '\\' })?.given).toStrictEqual(
      new Set(['newline', 'escapeChar']),
    );
  });

  it('resolves every other key as resolveParseConfig does for the main entry', () => {
    const config = { header: true, preview: 2, comments: true, skipEmptyLines: 'greedy' } as const;
    const { features: set, ...rest } = resolveDetailedConfig({ ...config, positions: true });
    expect(set).not.toBeNull();
    expect(rest).toStrictEqual(resolveParseConfig(config, 'main'));
  });

  it('does not read a feature key from the config again after resolving it', () => {
    const config = { repair: ['pad-missing'] };
    const { features: set } = resolveDetailedConfig(config);
    config.repair.push('unclosed-quote');
    expect(set?.repair).toStrictEqual(new Set(['pad-missing']));
  });
});

describe('parse is untouched by the features', () => {
  it.each(Object.entries(FEATURE_VALUES))(
    'parse still rejects %s as an unknown option',
    (key, value) => {
      for (const v of [value, false]) {
        const error = outcome(() => parse('a,b', { [key]: v } as ParseConfig));
        expect(error).toStrictEqual({ thrown: `TypeError: Unknown parse option "${key}"` });
      }
    },
  );

  const featureSpies = () =>
    [detailedModule, detectModule, locateModule, repairModule, schemaModule]
      .flatMap((module) => Object.values(module) as unknown[])
      .filter((value) => vi.isMockFunction(value));
  const calls = () => featureSpies().reduce((sum, spy) => sum + spy.mock.calls.length, 0);

  it('the spies count the calls a feature parse makes', () => {
    // The exported functions of src/detailed.ts and the feature modules: parseDetailed; recordStarts, positionsAt,
    // advance and formatError; repairRows and mixedNewline; isStandardSchema, validateRow,
    // validateRowSync and rowResult.
    expect(featureSpies().length).toBeGreaterThanOrEqual(14);
    // src/detect.ts is counted too: sampleOf, sepLineDelimiter, detectDialect and detect.
    for (const spied of [detectModule.detect, detectModule.detectDialect, detectModule.sampleOf]) {
      expect(vi.isMockFunction(spied)).toBe(true);
    }
    detectModule.detect('a;b\n1;2\n');
    expect(vi.mocked(detectModule.detect)).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    detailed('a,b\n1\n', { header: true, positions: true, repair: true, schema: passThrough });
    expect(vi.mocked(detailedModule.parseDetailed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairModule.repairRows)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairModule.mixedNewline)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(schemaModule.validateRowSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(locateModule.positionsAt)).toHaveBeenCalled();
    expect(calls()).toBeGreaterThanOrEqual(5);
  });

  it('parse makes no call into src/detailed.ts or a feature module: the grouped fixtures and 18,000 fuzz inputs', () => {
    let parsed = 0;
    for (const fixture of PARSE_FIXTURES) {
      outcome(() => parse(fixture.input, fixture.config as ParseConfig));
      parsed++;
    }
    // fuzz runs parse (mainParse) on every generated input.
    const summary = fuzz(0x5eed06, 500);
    expect(summary.failures).toStrictEqual([]);
    expect(parsed + summary.cases).toBeGreaterThanOrEqual(18_000 + PARSE_FIXTURES.length);
    expect(calls()).toBe(0);
  }, 120_000);

  it('parseDetailed without a feature key makes no call into a feature module either', () => {
    detailed('a,b\n1\n', { header: true, positions: false, repair: [], detect: false });
    expect(vi.mocked(detailedModule.parseDetailed)).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(1);
  });
});

/** Line and column of offset in input by one regular expression, sharing no code with src/locate.ts. */
function oracle(input: string, offset: number) {
  const breaks = [...input.slice(0, offset).matchAll(/\r\n|\r|\n/g)];
  const last = breaks.at(-1);
  const lineStart = last === undefined ? 0 : last.index + last[0].length;
  return { line: breaks.length + 1, column: offset - lineStart + 1, lineStart };
}

/**
 * Units of input before the text that is scanned: one U+FEFF, then skipFirstNLines lines, cut as
 * Papa Parse cuts them (split at the newline, drop, join), which shares no code with skipLines.
 */
function scannedFrom(input: string, config: ParseConfig): number {
  const text = input.startsWith('\ufeff') ? input.slice(1) : input;
  const count = config.skipFirstNLines ?? 0;
  if (count === 0) return input.length - text.length;
  const newline = config.newline || guessNewline(text, config.quoteChar ?? '"');
  return input.length - text.split(newline).slice(count).join(newline).length;
}

const withoutPositions = (result: { errors: object[] }) => ({
  ...result,
  errors: result.errors.map((error) =>
    Object.fromEntries(
      Object.entries(error).filter(([key]) => !(POSITION_KEYS as readonly string[]).includes(key)),
    ),
  ),
});

describe('the two paths agree', () => {
  const SEED = 20261111;
  const PER_DIALECT = 500;

  it('parseDetailed without a feature key returns what parse returns, key for key', () => {
    const off = [
      undefined,
      {},
      { positions: false, repair: [], sepLine: false, schema: undefined },
      { detect: false },
      { detect: false, positions: false, repair: [], sepLine: false, schema: undefined },
    ];
    for (const { input, config } of fuzzCases(SEED, 60)) {
      const expected = outcome(() => parse(input, config));
      for (const features of off) {
        const actual = outcome(() => detailed(input, { ...config, ...features }));
        if ('thrown' in expected || 'thrown' in actual) {
          expect(actual).toStrictEqual(expected);
          continue;
        }
        expect(Object.keys(actual.value as object)).toStrictEqual(['data', 'errors', 'meta']);
        expect(difference(actual.value, expected.value)).toBeNull();
      }
    }
    expect(detailed('a,b\n1,2\n')).toStrictEqual(parse('a,b\n1,2\n'));
    expect(detailed('a,b\n1\n', { header: true })).toStrictEqual(
      parse('a,b\n1\n', { header: true }),
    );
    // About 0.5 s alone; test files running at the same time pushed it past Vitest's 5 s default.
  }, 60_000);

  it(`positions: true (and a schema that passes every row, or detect: false) changes nothing but the four position keys: ${String(18 * PER_DIALECT * 2)} fuzz inputs (seed ${String(SEED)})`, () => {
    const failures: unknown[] = [];
    const seen = { cases: 0, thrown: 0, errors: 0, located: 0 };
    const fail = (fault: string, { input, config }: Case) => {
      if (failures.length < 5) failures.push({ fault, input, config });
    };
    for (const c of fuzzCases(SEED, PER_DIALECT)) {
      const { input, config } = c;
      seen.cases++;
      const expected = outcome(() => parse(input, config));
      for (const features of [
        { positions: true },
        { positions: true, schema: passThrough },
        { positions: true, detect: false },
      ]) {
        const actual = outcome(() => detailed(input, { ...config, ...features }));
        if ('thrown' in expected || 'thrown' in actual) {
          seen.thrown++;
          if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('throws', c);
          continue;
        }
        const result = actual.value as { errors: Array<Record<string, unknown>> };
        if (Object.keys(result).join() !== 'data,errors,meta') fail('result keys', c);
        const diff = difference(withoutPositions(result), expected.value);
        if (diff !== null) fail(diff, c);
        for (const error of result.errors) {
          seen.errors++;
          const located = POSITION_KEYS.filter((key) => key in error).length;
          if (located !== (error['type'] === 'Delimiter' ? 0 : 4)) fail('position keys', c);
          if (located === 4) seen.located++;
          const keys = Object.keys(error);
          if (located === 4 && keys.slice(-4).join() !== POSITION_KEYS.join()) fail('key order', c);
        }
      }
    }
    expect(failures).toStrictEqual([]);
    expect(seen.cases).toBeGreaterThanOrEqual(18 * PER_DIALECT * 2);
    expect(seen.thrown).toBeGreaterThan(100);
    expect(seen.located).toBeGreaterThan(5_000);
  }, 120_000);

  it('parseDetailed with positions equals Papa Parse as parse does, callbacks called alike', () => {
    // The harness compares data, errors, meta and the order and arguments of every callback call.
    const summary = fuzz(SEED + 1, 250, undefined, (input, config) => {
      const result = detailed(input, { ...config, positions: true });
      return withoutPositions(result) as unknown as ReturnType<typeof mainParse>;
    });
    expect(summary.cases).toBe(18 * 250 * 2);
    expect(summary.failures).toStrictEqual([]);
  }, 120_000);
});

describe('positions point at the place', () => {
  const isEmpty = (row: readonly string[], greedy: boolean) =>
    greedy ? row.join('').trim() === '' : row.length === 1 && row[0] === '';

  it('for every error of every seeded fuzz input: the opening quote, the erroring record, and the line and column of the oracle', () => {
    const failures: unknown[] = [];
    const seen = { quotes: 0, mismatch: 0, shifted: 0, bom: 0, finalRecord: 0, crlf: 0 };
    for (const { input, config } of fuzzCases(20261112, 500)) {
      const attempt = outcome(() => detailed(input, { ...config, positions: true }));
      if ('thrown' in attempt) continue;
      const result = attempt.value as ReturnType<typeof parse> & {
        errors: Array<Record<string, unknown>>;
      };
      const fail = (fault: string, error: unknown) => {
        if (failures.length < 5) failures.push({ fault, error, input, config });
      };
      const shift = scannedFrom(input, config);
      const quoteChar = config.quoteChar ?? '"';
      const dialect: ScanDialect = {
        delimiter: result.meta.delimiter,
        newline: result.meta.linebreak,
        quoteChar: config.fastMode === true ? '' : quoteChar,
        escapeChar: config.escapeChar ?? quoteChar,
        comments: config.comments === true ? '#' : config.comments || '',
        preview: 0,
        fastMode: false,
      };
      // Every record of the scan, and of those the ones that became the rows of data: the last
      // data.length records that skipEmptyLines keeps.
      let records: string[][] = [];
      if (config.header) {
        const all: ParseConfig = {
          ...config,
          // The delimiter the parse used: a guess would depend on skipEmptyLines.
          delimiter: result.meta.delimiter,
          header: false,
          skipEmptyLines: false,
          dynamicTyping: false,
          preview: config.preview ? config.preview + 1 : 0,
        };
        delete all.transform;
        delete all.transformHeader;
        const kept = (parse(input, all).data as string[][]).filter(
          (row) => !config.skipEmptyLines || !isEmpty(row, config.skipEmptyLines === 'greedy'),
        );
        records = kept.slice(kept.length - result.data.length);
      }
      for (const error of result.errors) {
        if (error['type'] === 'Delimiter') continue;
        const offset = error['offset'] as number;
        const { line, column, lineStart } = oracle(input, offset);
        if (error['line'] !== line || error['column'] !== column) fail('line or column', error);
        // The "\n" of a "\r\n" that an offset can sit on belongs to the line after it.
        const afterCR = input[lineStart] === '\n' && input[lineStart - 1] === '\r';
        const lineText = /^[^\r\n]*/.exec(input.slice(lineStart + Number(afterCR)))?.[0] ?? '';
        if (lineText.length <= 120 && error['snippet'] !== lineText) fail('snippet', error);
        if (shift > 0) seen.shifted++;
        if (input.startsWith('\ufeff')) seen.bom++;
        if (input.slice(0, offset).includes('\r\n')) seen.crlf++;
        if (error['type'] === 'Quotes') {
          seen.quotes++;
          if (!input.startsWith(quoteChar, offset)) fail('not at a quote', error);
          if (offset !== shift + error['index'] - 1) fail('not the opening quote', error);
        } else {
          seen.mismatch++;
          const expected = records[error['row']];
          const [first = ['']] = scanRows(input.slice(offset), dialect).rows;
          if (offset === input.length) seen.finalRecord++;
          if (JSON.stringify(first) !== JSON.stringify(expected)) fail('not the record', error);
        }
      }
    }
    expect(failures).toStrictEqual([]);
    expect(seen.quotes).toBeGreaterThan(1_000);
    expect(seen.mismatch).toBeGreaterThan(1_000);
    expect(seen.shifted).toBeGreaterThan(200);
    expect(seen.bom).toBeGreaterThan(20);
    expect(seen.finalRecord).toBeGreaterThan(100);
    expect(seen.crlf).toBeGreaterThan(200);
  }, 120_000);
});

describe('the helpers copied from src/parse.ts', () => {
  /** The text of each top-level function, constant and type alias of a source file, by name. */
  function declarations(file: string): Map<string, string> {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found = new Map<string, string>();
    for (const statement of source.statements) {
      const names = ts.isFunctionDeclaration(statement)
        ? [statement.name?.text]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.map((d) => d.name.getText(source))
          : ts.isTypeAliasDeclaration(statement)
            ? [statement.name.text]
            : [];
      for (const name of names) {
        if (name !== undefined) found.set(name, statement.getText(source).replace(/^export /, ''));
      }
    }
    return found;
  }

  it('are the text of their originals, so parse and parseDetailed build records by the same rules', () => {
    const original = declarations('parse.ts');
    const copy = declarations('detailed.ts');
    const copied = [
      'EXTRA_FIELDS',
      'FieldTyper',
      'FieldConverter',
      'skipLines',
      'undetectableError',
      'toKey',
      'specialRecord',
      'fieldTyper',
      'FLOAT',
      'ISO_DATE',
      'typedValue',
      'headerFields',
      'fieldCountError',
    ];
    for (const name of copied) {
      expect(original.get(name)?.length).toBeGreaterThan(20);
      expect([name, copy.get(name)]).toStrictEqual([name, original.get(name)]);
    }
    // MAX_FLOAT is the same number, written out so that a bundler can drop it when unused.
    expect(original.get('MAX_FLOAT')).toBe('const MAX_FLOAT = 2 ** 53;');
    expect(copy.get('MAX_FLOAT')).toBe('const MAX_FLOAT = 9007199254740992;');
    expect(9007199254740992).toBe(2 ** 53);
    // Nothing else of src/detailed.ts repeats a declaration of src/parse.ts.
    const shared = [...copy.keys()].filter((name) => original.has(name));
    expect(shared.sort()).toStrictEqual([...copied, 'MAX_FLOAT'].sort());
  });

  it('build the records parse builds where the fuzz does not reach: numbers at the float limit, and header names with a meaning in JavaScript', () => {
    const cases: Array<[string, ParseConfig]> = [
      [
        'n\n9007199254740991\n9007199254740992\n-9007199254740991\n-9007199254740992\n9007199254740993\n1e400\n',
        { dynamicTyping: true },
      ],
      [
        'n\n9007199254740991\n9007199254740992\n-9007199254740992\n',
        { header: true, dynamicTyping: true },
      ],
      ['__proto__,a,__parsed_extra,constructor,toString,a\n1,2,3,4,5,6,7\n8\n', { header: true }],
      [
        '__proto__,a,__parsed_extra,constructor,toString,a\n1,2,3,4,5,6,7\n8\n',
        { header: true, dynamicTyping: true },
      ],
      [
        '__proto__,2,1,hasOwnProperty\n1,2,3,4\n',
        { header: true, transform: (value: string) => `<${value}>` },
      ],
      [
        'a,b\n1,2\n',
        { header: true, transformHeader: (name: string) => (name === 'a' ? '__proto__' : name) },
      ],
      // Plain names, for which parse clones a template and parseDetailed assigns field by field:
      // members of Object.prototype, and names that are array indices or look like them.
      [
        'constructor,toString,hasOwnProperty,0,1,00,4294967295\n1,2,3,4,5,6,7\n8,9\n1,2,3,4,5,6,7,8,9\n',
        { header: true },
      ],
      ['b,1,4294967295,0,00,a,valueOf\n1,2,3,4,5,6,7\n\n8\n', { header: true }],
      ['constructor\n1\n', { header: true }],
      ['toString,hasOwnProperty\n1,2\n3\n', { header: true, skipEmptyLines: true }],
      ['0\n1\n', { header: true }],
      ['1,0\n1,2\n', { header: true }],
      ['00,0\n1,2\n', { header: true }],
      ['4294967295,4294967294\n1,2\n', { header: true }],
    ];
    for (const [input, config] of cases) {
      const expected = parse(input, { delimiter: ',', ...config });
      const actual = detailed(input, { delimiter: ',', ...config, positions: true });
      expect(difference(withoutPositions(actual as { errors: object[] }), expected)).toBeNull();
      const rows = actual.data as object[];
      (expected.data as object[]).forEach((row, i) => {
        expect(Object.getOwnPropertyNames(rows[i])).toStrictEqual(Object.getOwnPropertyNames(row));
        // As entries: a record may have an own "__proto__" key.
        expect(Object.entries(Object.getOwnPropertyDescriptors(rows[i] ?? {}))).toStrictEqual(
          Object.entries(Object.getOwnPropertyDescriptors(row)),
        );
        expect(Object.getPrototypeOf(rows[i])).toBe(Object.getPrototypeOf(row));
      });
    }
    const [proto] = detailed('__proto__,a\n1,2', { header: true, delimiter: ',', positions: true })
      .data as Array<Record<string, unknown>>;
    expect(Object.hasOwn(proto ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(
      (
        detailed('n\n9007199254740991\n9007199254740992', { dynamicTyping: true, positions: true })
          .data as unknown[][]
      ).flat(),
    ).toStrictEqual(['n', 9007199254740991, '9007199254740992']);
  });
});
