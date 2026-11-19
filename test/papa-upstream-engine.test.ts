import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import * as chai from 'chai';
import { describe, expect, it } from 'vitest';
import Papa from '../src/papa.ts';

// Runs Papa Parse 5.7.1's own "Parse Tests" and "Unparse Tests", with their own
// assertions, against csvloom/papa: the vendored test-cases.js is compiled in
// this realm with require('../papaparse.js') resolved to src/papa.ts's default
// export. The other suites and the tests below are not registered; each is
// named with the excluded feature (D3) or exception that excludes it, and the lists
// are checked against what the file declares.

const EXCLUDED_SUITES: Readonly<Record<string, string>> = {
  'Core Parser Tests': 'excluded: the internal Papa.Parser class',
  'Parse Async Tests': 'excluded: worker, download, File input and the complete callback',
  'Custom Tests': 'excluded: step, chunk, complete and error callbacks, pause, abort, download',
  'Browser Tests': 'excluded: workers in a browser (upstream skips the suite outside one)',
};
const EXCLUDED_TESTS: Readonly<Record<string, string>> = {
  'downloadTimeout is coerced to a number when parsable':
    'excluded (D3): downloadTimeout throws UnsupportedFeatureError',
};

type SuiteBody = () => void;
type TestBody = () => unknown;
const declaredSuites: string[] = [];
const excludedTests: string[] = [];
/** Tests registered per suite. */
const registered: Record<string, number> = {};
let suite = '';

const shimDescribe = Object.assign(
  (name: string, body: SuiteBody) => {
    declaredSuites.push(name);
    if (name in EXCLUDED_SUITES) return;
    describe(name, () => {
      suite = name;
      registered[name] = 0;
      body();
    });
  },
  { skip: (name: string) => declaredSuites.push(name) },
);
const register = (name: string, body: TestBody, skip: boolean) => {
  if (name in EXCLUDED_TESTS) excludedTests.push(name);
  else {
    registered[suite] = (registered[suite] ?? 0) + 1;
    (skip ? it.skip : it)(name, body);
  }
};
const shimIt = Object.assign(
  (name: string, body: TestBody) => {
    register(name, body, false);
  },
  {
    skip: (name: string, body: TestBody) => {
      register(name, body, true);
    },
  },
);

const require = createRequire(import.meta.url);
const file = require.resolve('./upstream/papaparse-5.7.1/tests/test-cases.js');
const upstreamRequire = (id: string): unknown => {
  if (id === 'chai') return chai;
  if (id === '../papaparse.js') return Papa;
  throw new Error(`unexpected require ${id}`);
};
const upstreamModule = { exports: {} };
const params = ['require', 'module', 'exports', 'describe', 'it'];
const run = compileFunction(readFileSync(file, 'utf8'), params, { filename: file }) as (
  ...args: unknown[]
) => void;
run(upstreamRequire, upstreamModule, upstreamModule.exports, shimDescribe, shimIt);

describe('upstream suites and exclusions', () => {
  it('runs Parse Tests and Unparse Tests; every other suite and excluded test is named', () => {
    expect(declaredSuites).toStrictEqual([
      'Core Parser Tests',
      'Parse Tests',
      'Parse Async Tests',
      'Unparse Tests',
      'Custom Tests',
      'Browser Tests',
    ]);
    expect(declaredSuites.filter((name) => name in EXCLUDED_SUITES)).toStrictEqual(
      Object.keys(EXCLUDED_SUITES),
    );
    expect(excludedTests).toStrictEqual(Object.keys(EXCLUDED_TESTS));
    // The 98 PARSE_TESTS and 3 custom tests, minus the exclusion; the 55 UNPARSE_TESTS.
    // "downloadTimeout throws when set to a value not parsable by parseInt"
    // runs and passes: D3's UnsupportedFeatureError names downloadTimeout.
    expect(registered).toStrictEqual({ 'Parse Tests': 100, 'Unparse Tests': 64 });
  });
});
