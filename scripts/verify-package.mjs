// npm run test:package: builds and packs csvloom, installs the tarball into
// fresh consumers under work/pack-check/<run>/<name>/ and prints one PASS or
// FAIL line per check. Exits non-zero on any FAIL.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import ts from 'typescript';

const root = process.cwd();
const run = (command, args, cwd = root) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`${[command, ...args].join(' ')} failed:\n${error.stdout}${error.stderr}`, {
      cause: error,
    });
  }
};
const say = (line) => process.stdout.write(`${line}\n`);
// The Node binaries of checks 3, 12 and 15: CSVLOOM_NODE_BINARIES (paths separated by ':') when
// it is set, as on CI, which has no ~/.nvm; otherwise the three nvm installs.
const binaries = process.env.CSVLOOM_NODE_BINARIES;
const nodes = binaries
  ? binaries.split(':')
  : ['22.23.4', '24.22.1', '26.13.1'].map((version) =>
      join(homedir(), '.nvm/versions/node', `v${version}`, 'bin/node'),
    );
const onNodes = binaries ? 'the CSVLOOM_NODE_BINARIES Nodes' : 'Node 22.23.4, 24.22.1 and 26.13.1';
const eachNode = (body) =>
  nodes.map((node) => {
    if (!existsSync(node)) throw new Error(`BLOCKED: ${node} is missing`);
    body(node);
    return run(node, ['--version']).trim();
  });
// Names no module that csvloom/stream reaches may contain, in its browser bundle and in src/;
// /\bBuffer\b/ does not match ArrayBuffer.
const NODE_TIMER_NETWORK = [
  ...['require(', 'node:', 'process.', /\bBuffer\b/],
  ...['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame'],
  ...['requestIdleCallback', 'scheduler', 'MessageChannel'],
  ...['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'],
];
// /\bFunction\(/ does not match isFunction(.
const CODE_GENERATION = ['new Function', /\bFunction\(/, 'eval(', 'WebAssembly'];
const found = (text, names) =>
  names
    .filter((name) => (typeof name === 'string' ? text.includes(name) : name.test(text)))
    .map(String);
let failed = false;
const check = async (id, title, body) => {
  try {
    const detail = await body();
    say(`PASS ${id} ${title}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failed = true;
    say(`FAIL ${id} ${title}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

run('npm', ['run', 'build']);
const packDir = join(root, 'work/pack-check');
mkdirSync(packDir, { recursive: true });
const [pack] = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json']));
const tgz = join(packDir, pack.filename);

await check('pack', 'file list is package.json, dist/** and README/LICENSE if present', () => {
  const expected = [
    'package.json',
    ...readdirSync('dist').map((file) => `dist/${file}`),
    ...readdirSync(root).filter((file) => /^(readme|license|licence)(\..*)?$/i.test(file)),
  ].sort();
  const actual = pack.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`got ${actual.join(', ')}; expected ${expected.join(', ')}`);
  return `${pack.filename}, ${actual.length} files, ${pack.size} bytes packed`;
});

// TypeScript 6.0.3 resolves a relative .ts specifier in a declaration file, so
// no consumer check below would catch one that build.mjs failed to rewrite.
await check(
  'decl',
  'relative specifiers end in .js in dist/*.d.ts and .cjs in dist/*.d.cts',
  () => {
    const files = readdirSync('dist').filter((file) => /\.d\.c?ts$/.test(file));
    let count = 0;
    for (const file of files) {
      const extension = file.endsWith('.d.cts') ? '.cjs' : '.js';
      for (const [, specifier] of readFileSync(join('dist', file), 'utf8').matchAll(
        /['"](\.\.?\/[^'"]*)['"]/g,
      )) {
        count++;
        if (!specifier.endsWith(extension)) throw new Error(`${file}: ${specifier}`);
      }
    }
    if (count === 0) throw new Error('no relative specifier found');
    return `${files.length} declaration files, ${count} relative specifiers`;
  },
);

const runDir = join(packDir, new Date().toISOString().replace(/[:.]/g, '-'));
const consumer = (name, files) => {
  const dir = join(runDir, name);
  mkdirSync(dir, { recursive: true });
  run('npm', ['init', '-y'], dir);
  run('npm', ['install', '--offline', '--no-audit', '--no-fund', tgz], dir);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};

const assertions = String.raw`
const rows = [['a', 'b'], ['1', '2']];
assert.deepEqual(parse('a,b\n1,2').data, rows);
assert.equal(unparse([['a', 'b']]), 'a,b');
assert.deepEqual(Papa.parse('a,b\n1,2').data, rows);
assert.deepEqual(Object.keys(root).sort(), ['UnsupportedFeatureError', 'detect', 'excel', 'excelSemicolon', 'formatError', 'parse', 'parseDetailed', 'unparse']);
assert.throws(() => parse('a', { worker: true }), UnsupportedFeatureError);
// Each entry bundles its own core, so error.name is the cross-entry check.
assert.throws(
  () => Papa.parse(1),
  (error) => error.name === 'UnsupportedFeatureError' && !(error instanceof UnsupportedFeatureError),
);
// "4 ok": the default import (ESM) and require (CJS) give the frozen Papa object with its seven
// members only, and its parse returns what papaparse 5.7.1 returns.
assert.ok(Object.isFrozen(Papa));
assert.deepEqual(Reflect.ownKeys(Papa).sort(), [
  'BAD_DELIMITERS', 'BYTE_ORDER_MARK', 'RECORD_SEP', 'UNIT_SEP', 'UnsupportedFeatureError', 'parse', 'unparse',
]);
assert.deepEqual(Papa.parse('a,b'), ${JSON.stringify(createRequire(import.meta.url)('papaparse').parse('a,b'))});
`;
// csvloom/stream: one run-time export; a BOM and a character split across two chunks through three source kinds,
// the last as the string T (decoded with the BOM kept); header, dynamicTyping and transform in one
// parse (the CSP check runs this script too); and each entry has its own UnsupportedFeatureError.
const streamAssertions = String.raw`
assert.deepEqual(Object.keys(stream), ['parseStream']);
assert.equal(stream.parseStream, parseStream);
const e2 = [Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xc3), Uint8Array.of(0xa9, 0x0a, 0x31, 0x2c, 0x32)];
const e2Rows = [['a', '\u00e9'], ['1', '2']];
const streamRows = async (source, config) => {
  const rows = [];
  for await (const batch of parseStream(source, config)) rows.push(...batch.data);
  return rows;
};
assert.deepEqual(await streamRows((async function* () { yield* e2; })()), e2Rows);
const web = new ReadableStream({
  start(controller) {
    for (const chunk of e2) controller.enqueue(chunk);
    controller.close();
  },
});
assert.deepEqual(await streamRows(web), e2Rows);
const e2Text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.of(...e2[0], ...e2[1]));
assert.equal(e2Text.charCodeAt(0), 0xfeff);
assert.deepEqual(await streamRows(e2Text), e2Rows);
assert.deepEqual(
  await streamRows(['a,b\n1,', ' 2'], { header: true, dynamicTyping: true, transform: (value) => value.trim() }),
  [{ a: 1, b: 2 }],
);
assert.throws(
  () => parseStream('a', { worker: true }),
  (error) => error.name === 'UnsupportedFeatureError' && !(error instanceof UnsupportedFeatureError),
);
`;
const esm = consumer('esm', {
  'esm.mjs': `import assert from 'node:assert/strict';
import * as root from 'csvloom';
import { parse, unparse, UnsupportedFeatureError } from 'csvloom';
import Papa from 'csvloom/papa';
import * as papaNamespace from 'csvloom/papa';
import { parse as papaParse } from 'csvloom/papa';
import * as stream from 'csvloom/stream';
import { parseStream } from 'csvloom/stream';
${assertions}
assert.equal(papaNamespace.default, Papa);
assert.equal(papaParse, Papa.parse);
assert.deepEqual(Object.keys(papaNamespace), [
  'BAD_DELIMITERS', 'BYTE_ORDER_MARK', 'RECORD_SEP', 'UNIT_SEP', 'UnsupportedFeatureError', 'default', 'parse', 'unparse',
]);
${streamAssertions}`,
});
const cjs = consumer('cjs', {
  'cjs.cjs': `const assert = require('node:assert/strict');
const { parse, unparse } = require('csvloom');
const Papa = require('csvloom/papa');
Papa.parse('a,b\\n1,2');
const root = require('csvloom');
const { UnsupportedFeatureError } = root;
${assertions}
{
  const { parse, unparse } = require('csvloom/papa');
  assert.equal(parse, Papa.parse);
  assert.deepEqual(parse('a,b\\n1,2').data, rows);
  assert.equal(unparse([['a', 'b']]), 'a,b');
}
const stream = require('csvloom/stream');
const { parseStream } = stream;
// A promise that never settles would let the process exit 0: the last line proves the end.
(async () => {
${streamAssertions}
})().then(() => process.stdout.write('cjs.cjs done\\n'));`,
});
const runEsm = (node, flags = []) => run(node, [...flags, 'esm.mjs'], esm);
const runCjs = (node) => {
  const printed = run(node, ['cjs.cjs'], cjs);
  if (printed !== 'cjs.cjs done\n') throw new Error(`cjs.cjs printed ${JSON.stringify(printed)}`);
};
await check(1, 'ESM consumer (esm.mjs)', () => {
  runEsm(process.execPath);
  return `node ${process.version}`;
});
await check(2, 'CJS consumer (cjs.cjs)', () => {
  runCjs(process.execPath);
  return `node ${process.version}`;
});
await check(3, `checks 1 and 2 on ${onNodes}`, () =>
  eachNode((node) => {
    runEsm(node);
    runCjs(node);
  }).join(', '),
);

const tsFiles = (module, moduleResolution, options) => ({
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      module,
      moduleResolution,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: false,
      noEmit: true,
      ...options,
    },
    files: ['main.mts', 'main.cts'],
  }),
  'main.mts': String.raw`import { parse, unparse, UnsupportedFeatureError } from 'csvloom';
import { detect, excel, excelSemicolon, formatError, parseDetailed } from 'csvloom';
import type { HeaderRow, ParseResult, StandardSchemaV1 } from 'csvloom';
import Papa from 'csvloom/papa';
import * as PapaModule from 'csvloom/papa';
import type { ParseConfig as PapaConfig, ParseError as PapaError, ParseMeta as PapaMeta } from 'csvloom/papa';
import type { ParseResult as PapaResult, UnparseConfig as PapaUnparseConfig } from 'csvloom/papa';
import { parseStream } from 'csvloom/stream';
import type { BatchIterator, ParseBatch, StreamConfig, StreamMeta, StreamSource } from 'csvloom/stream';

parse('a,b\n1,2').data satisfies string[][];
parse('a\n1', { header: true }).data satisfies HeaderRow<string>[];
parse('a\n1', { header: true }) satisfies ParseResult<HeaderRow<string>>;
unparse([['a', 'b']]) satisfies string;
new UnsupportedFeatureError('worker') satisfies Error;
// csvloom/papa under @types/papaparse's type names: as named exports, on the default import and
// on the namespace import. Same is true only for identical types.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
interface Row { name: string }
const untyped = Papa.parse('a,b\n1,2');
true satisfies Same<typeof untyped, PapaResult<unknown>>;
true satisfies Same<typeof untyped.data, unknown[]>;
Papa.parse<Row>('name\nAda', { header: true }).data satisfies Row[];
PapaModule.parse<Row>('name\nAda', { header: true }).data satisfies Row[];
const annotated: Papa.ParseResult<Row> = Papa.parse('name\nAda', { header: true });
true satisfies Same<typeof annotated.data, Row[]>;
annotated.errors satisfies PapaError[];
annotated.errors[0]?.row satisfies number | undefined;
annotated.meta satisfies PapaMeta;
annotated.meta.fields satisfies string[] | undefined;
true satisfies Same<Papa.ParseResult<Row>, PapaResult<Row>>;
true satisfies Same<PapaModule.ParseResult<Row>, PapaResult<Row>>;
true satisfies Same<Papa.ParseError, PapaError>;
true satisfies Same<Papa.ParseMeta, PapaMeta>;
({ header: true, worker: false }) satisfies PapaConfig<Row>;
({ header: true }) satisfies Papa.ParseConfig;
({ quotes: true }) satisfies PapaUnparseConfig;
({ quotes: true }) satisfies Papa.UnparseConfig;
// @ts-expect-error -- step is not supported: it is typed as its inactive value
Papa.parse<Row>('a', { step: () => undefined });
// @ts-expect-error -- unknown key
parse('a', { delimitr: ',' });

const source: StreamSource = ['a,b\n1,2'];
const config = { batchSize: 2, maxRecordLength: 1_048_576 } satisfies StreamConfig;
parseStream(source, config) satisfies BatchIterator<string[]>;
parseStream([Uint8Array.of(97)], { header: true }) satisfies BatchIterator<HeaderRow<string>>;
parseStream(source).next() satisfies Promise<IteratorResult<ParseBatch<string[]>, undefined>>;
declare const meta: StreamMeta;
meta.rowOffset satisfies number;
// @ts-expect-error -- unknown key
parseStream(source, { batchsize: 2 });
const age: StandardSchemaV1<unknown, { age: number }> = {
  '~standard': { version: 1, vendor: 'consumer', validate: (value) => ({ value: { age: Number(value) } }) },
};
const detailed = parseDetailed('age\n5', { header: true, schema: age, positions: true, repair: true });
detailed.data satisfies { age: number }[];
detailed.errors.map((error) => formatError(error)) satisfies string[];
detect('a;b\n1;2').delimiter satisfies string;
detect(new Uint8Array([0x61])).encoding?.name satisfies string | undefined;
unparse([['=1']], excel) satisfies string;
unparse([['=1']], { ...excelSemicolon, sepLine: true }) satisfies string;
`,
  'main.cts': String.raw`import csv = require('csvloom');
import Papa = require('csvloom/papa');
import PapaDefault from 'csvloom/papa';
import { parse as papaParse, UnsupportedFeatureError as PapaError } from 'csvloom/papa';
import type { ParseResult as PapaResult } from 'csvloom/papa';
import type { HeaderRow, ParseResult } from 'csvloom';
import stream = require('csvloom/stream');
import type { BatchIterator, StreamConfig } from 'csvloom/stream';

csv.parse('a,b\n1,2').data satisfies string[][];
csv.parse('a\n1', { header: true }).data satisfies HeaderRow<string>[];
csv.parse('a\n1', { header: true }) satisfies ParseResult<HeaderRow<string>>;
csv.unparse([['a', 'b']]) satisfies string;
// csvloom/papa under @types/papaparse's type names: through require, the default import and
// the named imports. Same is true only for identical types.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
interface Row { name: string }
const viaRequire = Papa.parse('a,b\n1,2');
const viaDefault = PapaDefault.parse('a,b\n1,2');
const viaNamed = papaParse('a,b\n1,2');
true satisfies Same<typeof viaRequire, PapaResult<unknown>>;
true satisfies Same<typeof viaDefault, PapaResult<unknown>>;
true satisfies Same<typeof viaNamed, PapaResult<unknown>>;
Papa.parse<Row>('name\nAda', { header: true }).data satisfies Row[];
PapaDefault.parse<Row>('name\nAda', { header: true }).data satisfies Row[];
papaParse<Row>('name\nAda', { header: true }).data satisfies Row[];
const annotated: Papa.ParseResult<Row> = PapaDefault.parse('name\nAda', { header: true });
true satisfies Same<typeof annotated.data, Row[]>;
annotated.errors satisfies PapaDefault.ParseError[];
annotated.errors[0]?.row satisfies number | undefined;
annotated.meta.fields satisfies string[] | undefined;
true satisfies Same<Papa.ParseResult<Row>, PapaResult<Row>>;
true satisfies Same<PapaDefault.ParseResult<Row>, PapaResult<Row>>;
({ header: true, worker: false }) satisfies Papa.ParseConfig<Row>;
({ header: true }) satisfies PapaDefault.ParseConfig;
({ quotes: true }) satisfies Papa.UnparseConfig;
// @ts-expect-error -- step is not supported: it is typed as its inactive value
Papa.parse<Row>('a', { step: () => undefined });
new PapaError('worker') satisfies PapaError;
// @ts-expect-error -- require('csvloom/papa') is the Papa object, which has no default member
Papa.default;
new csv.UnsupportedFeatureError('worker') satisfies Error;
// @ts-expect-error -- unknown key
csv.parse('a', { delimitr: ',' });

stream.parseStream(['a,b\n1,2'], { batchSize: 2 } satisfies StreamConfig) satisfies BatchIterator<string[]>;
stream.parseStream('a\n1', { header: true }) satisfies stream.BatchIterator<HeaderRow<string>>;
// @ts-expect-error -- unknown key
stream.parseStream('a', { batchsize: 2 });
const age: csv.StandardSchemaV1<unknown, { age: number }> = {
  '~standard': { version: 1, vendor: 'consumer', validate: (value) => ({ value: { age: Number(value) } }) },
};
const detailed = csv.parseDetailed('age\n5', { header: true, schema: age, positions: true, repair: true });
detailed.data satisfies { age: number }[];
detailed.errors.map((error) => csv.formatError(error)) satisfies string[];
csv.detect('a;b\n1;2').delimiter satisfies string;
csv.detect(new Uint8Array([0x61])).encoding?.name satisfies string | undefined;
csv.unparse([['=1']], csv.excel) satisfies string;
csv.unparse([['=1']], { ...csv.excelSemicolon, sepLine: true }) satisfies string;
`,
});
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const typescriptConsumer =
  (name, module, moduleResolution, options = {}) =>
  () => {
    const dir = consumer(name, tsFiles(module, moduleResolution, options));
    const listed = run(process.execPath, [tsc, '-p', dir, '--listFiles']);
    // The .mts side must load .d.ts files only and the .cts side .d.cts files
    // only, so both flavours list the same modules.
    const dist = `${join(dir, 'node_modules/csvloom/dist')}/`;
    const loaded = listed.split('\n').filter((line) => line.startsWith(dist));
    const modules = (suffix) =>
      loaded
        .filter((line) => line.endsWith(suffix))
        .map((line) => line.slice(dist.length, -suffix.length))
        .sort();
    const esm = modules('.d.ts');
    const all = ['index', 'papa', 'stream'].every((entry) => esm.includes(entry));
    if (!all || esm.join() !== modules('.d.cts').join())
      throw new Error(`loaded ${loaded.map((line) => line.slice(dist.length)).join(', ')}`);
    let detail = `module ${module}, moduleResolution ${moduleResolution}`;
    if (options.lib) {
      // The consumer's lib and types are all it gets: no DOM and no @types file.
      const foreign = listed.split('\n').filter((line) => /\/lib\.dom|\/@types\//.test(line));
      if (foreign.length > 0) throw new Error(`loaded ${foreign.join(', ')}`);
      detail += `, lib ${options.lib.join()}, types [], no lib.dom or @types file loaded`;
    }
    return `${detail}; ${esm.join(', ')} loaded as .d.ts and .d.cts`;
  };
await check(
  4,
  'TypeScript NodeNext consumer (.mts and .cts)',
  typescriptConsumer('ts-nodenext', 'nodenext', 'nodenext'),
);
await check(
  5,
  'TypeScript bundler consumer (.mts and .cts)',
  typescriptConsumer('ts-bundler', 'preserve', 'bundler'),
);
await check(6, 'browser bundles with esbuild', async () => {
  const dir = consumer('browser', {
    'root.mjs': "export * from 'csvloom';\n",
    'papa.mjs': "export * from 'csvloom/papa';\nexport { default } from 'csvloom/papa';\n",
    'stream.mjs': "export * from 'csvloom/stream';\n",
    'bare.mjs': "import 'csvloom';\n",
    'bare-stream.mjs': "import 'csvloom/stream';\n",
    'parse-only.mjs': "import { parse } from 'csvloom';\nexport default parse;\n",
  });
  const bundle = async (entry) => {
    const result = await build({
      entryPoints: [join(dir, entry)],
      absWorkingDir: dir,
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    return {
      text: result.outputFiles[0].text,
      warnings: result.warnings.map((warning) => warning.id),
    };
  };
  const details = [];
  for (const entry of ['root.mjs', 'papa.mjs', 'stream.mjs']) {
    const { text } = await bundle(entry);
    const names = found(text, NODE_TIMER_NETWORK);
    if (names.length > 0) throw new Error(`${entry} bundle contains ${names.join(', ')}`);
    details.push(`${entry} ${text.length} chars`);
  }
  for (const [entry, specifier] of [
    ['bare.mjs', 'csvloom'],
    ['bare-stream.mjs', 'csvloom/stream'],
  ]) {
    const bare = await bundle(entry);
    if (bare.text.trim() !== '') throw new Error(`import '${specifier}' alone kept:\n${bare.text}`);
    details.push(`${entry} empty (warnings: ${bare.warnings.join(', ') || 'none'})`);
  }
  const parseOnly = await bundle('parse-only.mjs');
  if (parseOnly.text.includes('parseStream'))
    throw new Error("import { parse } from 'csvloom' pulled in parseStream");
  details.push(`parse-only.mjs ${parseOnly.text.length} chars, no parseStream`);
  return details.join(', ');
});

const plain = consumer('globals', {});
await check(7, 'importing all three entries prints nothing and adds no globalThis key', () => {
  const script = `const before = new Set(Reflect.ownKeys(globalThis));
await import('csvloom');
await import('csvloom/papa');
await import('csvloom/stream');
const added = Reflect.ownKeys(globalThis).filter((key) => !before.has(key));
if (added.length > 0) throw new Error('globalThis gained ' + added.map(String).join(', '));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: plain,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.stdout !== '' || result.stderr !== '')
    throw new Error(
      `exit ${result.status}, stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`,
    );
  return `exit 0, empty stdout and stderr, node ${process.version}`;
});

await check(
  8,
  'TypeScript consumer with lib es2022 and types [] (.mts and .cts)',
  typescriptConsumer('ts-es2022', 'nodenext', 'nodenext', { lib: ['es2022'], types: [] }),
);
await check(9, 'TypeScript consumer with lib esnext and dom: await using, Response body', () => {
  const dir = consumer('ts-dom', {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'esnext',
        lib: ['esnext', 'dom'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ['main.mts'],
    }),
    'main.mts': `import { parseStream } from 'csvloom/stream';

declare const response: Response;
{
  await using batches = parseStream(new Blob([]).stream());
  for await (const batch of batches) batch.data satisfies string[][];
}
parseStream(response.body!);
// @ts-expect-error -- Response['body'] may be null
parseStream(response.body);
`,
  });
  const listed = run(process.execPath, [tsc, '-p', dir, '--listFiles']);
  const declaration = join(dir, 'node_modules/csvloom/dist/stream.d.ts');
  if (!listed.split('\n').includes(declaration)) throw new Error(`${declaration} not loaded`);
  return 'exactOptionalPropertyTypes, dist/stream.d.ts loaded';
});
await check(10, 'no declare global or interface SymbolConstructor in dist/*.d.ts, *.d.cts', () => {
  const files = readdirSync('dist').filter((file) => /\.d\.c?ts$/.test(file));
  const hits = files.filter((file) =>
    /declare global|interface SymbolConstructor/.test(readFileSync(join('dist', file), 'utf8')),
  );
  if (hits.length > 0) throw new Error(hits.join(', '));
  return `${files.length} declaration files`;
});

await check(
  11,
  'CSP: no code generation in dist/ or src/, no Node, timer or network name in src/',
  () => {
    const hits = [];
    const count = {};
    for (const [dir, names] of [
      ['dist', CODE_GENERATION],
      ['src', [...CODE_GENERATION, ...NODE_TIMER_NETWORK]],
    ]) {
      const files = readdirSync(dir);
      count[dir] = files.length;
      for (const file of files) {
        const inFile = found(readFileSync(join(dir, file), 'utf8'), names);
        if (inFile.length > 0) hits.push(`${dir}/${file}: ${inFile.join(', ')}`);
      }
    }
    if (hits.length > 0) throw new Error(hits.join('; '));
    return `${count.dist} files in dist/, ${count.src} in src/, comments included`;
  },
);
await check(
  12,
  `CSP: esm.mjs under --disallow-code-generation-from-strings, ${onNodes}`,
  () =>
    eachNode((node) => {
      // The control: under the flag, new Function must throw, or this check would prove nothing.
      const control = spawnSync(
        node,
        ['--disallow-code-generation-from-strings', '-e', "new Function('')"],
        { encoding: 'utf8' },
      );
      if (control.status === 0 || !control.stderr.includes('EvalError'))
        throw new Error(`${node}: new Function('') ran under the flag`);
      runEsm(node, ['--disallow-code-generation-from-strings']);
    }).join(', ') + "; control new Function('') throws EvalError on each",
);

await check(13, 'sizes within 10% of scripts/size-baseline.json', () => {
  const baselineFile = join(root, 'scripts/size-baseline.json');
  const baseline = existsSync(baselineFile)
    ? JSON.parse(readFileSync(baselineFile, 'utf8')).bytes
    : {};
  const measured = { 'csvloom.tgz': { packed: pack.size } };
  for (const file of readdirSync('dist')
    .filter((name) => /\.c?js$/.test(name))
    .sort()) {
    const bytes = readFileSync(join('dist', file));
    measured[`dist/${file}`] = { raw: bytes.length, gzip: gzipSync(bytes).length };
  }
  const problems = [];
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(measured)])) {
    if (!measured[name] || !baseline[name]) {
      problems.push(`${name}: ${measured[name] ? 'no baseline' : 'missing'}`);
      continue;
    }
    for (const [kind, before] of Object.entries(baseline[name]))
      if (!(measured[name][kind] <= before * 1.1))
        problems.push(`${name} ${kind} ${measured[name][kind]} over ${before} + 10%`);
  }
  const numbers = Object.entries(measured)
    .map(([name, sizes]) => `${name} ${Object.values(sizes).join('/')}`)
    .join(', ');
  if (problems.length > 0) throw new Error(`${problems.join('; ')} (measured: ${numbers})`);
  return `DIAGNOSTIC, bytes raw/gzip (tarball packed): ${numbers}`;
});
await check(14, 'import cost: median of 30 cold node -e runs per entry', () => {
  const scripts = {
    'node -e "" (control)': '',
    ...Object.fromEntries(
      ['csvloom', 'csvloom/papa', 'csvloom/stream'].map((entry) => [entry, `import('${entry}')`]),
    ),
  };
  const times = Object.fromEntries(Object.keys(scripts).map((label) => [label, []]));
  // Interleaved rounds, so a drift of the machine reaches every entry alike.
  for (let round = 0; round < 30; round++)
    for (const [label, script] of Object.entries(scripts)) {
      const start = performance.now();
      const result = spawnSync(process.execPath, ['-e', script], { cwd: plain });
      times[label].push(performance.now() - start);
      if (result.status !== 0) throw new Error(`${label}: exit ${result.status}`);
    }
  const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return (sorted[14] + sorted[15]) / 2;
  };
  const medians = Object.entries(times).map(
    ([label, values]) => `${label} ${median(values).toFixed(1)} ms`,
  );
  return `DIAGNOSTIC, indication only, node ${process.version}: ${medians.join(', ')}`;
});

await check(
  15,
  `examples/stream, examples/features and examples/docs: each *.mjs prints its *.txt, ${onNodes}`,
  () => {
    const skipped = [];
    let count = 0;
    let versions = [];
    for (const folder of ['stream', 'features', 'docs']) {
      const source = join(root, 'examples', folder);
      const files = readdirSync(source);
      const dir = consumer(
        `examples-${folder}`,
        Object.fromEntries(files.map((file) => [file, readFileSync(join(source, file), 'utf8')])),
      );
      const examples = files.filter((file) => file.endsWith('.mjs'));
      count += examples.length;
      versions = eachNode((node) => {
        const version = run(node, ['--version']).trim();
        for (const example of examples) {
          if (example.includes('await-using') && version.startsWith('v22.')) {
            skipped.push(`${example} on Node 22 (no await using syntax)`);
            continue;
          }
          const expected = readFileSync(join(source, example.replace(/\.mjs$/, '.txt')), 'utf8');
          const result = spawnSync(node, [example], { cwd: dir, encoding: 'utf8' });
          if (result.status !== 0 || result.stderr !== '' || result.stdout !== expected)
            throw new Error(
              `${node} ${folder}/${example}: exit ${result.status}, stderr ${JSON.stringify(result.stderr)}, stdout ${JSON.stringify(result.stdout)}`,
            );
        }
      });
    }
    return `${count} examples on ${versions.join(', ')}; skipped: ${skipped.join(', ') || 'none'}`;
  },
);

await check(
  16,
  'dist/ imports no package: every import, export-from and require is relative',
  () => {
    const files = readdirSync('dist');
    let count = 0;
    for (const file of files) {
      const text = readFileSync(join('dist', file), 'utf8');
      if (/from\s*['"]@standard-schema/.test(text))
        throw new Error(`${file} imports @standard-schema`);
      const found = ts.preProcessFile(text, true, true);
      const outside = [
        ...found.importedFiles.map((ref) => ref.fileName).filter((name) => !name.startsWith('.')),
        ...found.typeReferenceDirectives.map((ref) => `types=${ref.fileName}`),
        ...found.libReferenceDirectives.map((ref) => `lib=${ref.fileName}`),
      ];
      if (outside.length > 0) throw new Error(`${file}: ${outside.join(', ')}`);
      count += found.importedFiles.length;
    }
    return `${files.length} files, ${count} relative specifiers, no other`;
  },
);

// Strings of the feature sources, which csvloom/papa never loads: repair.ts, schema.ts, detect.ts, locate.ts
// (formatError's " at line " and ", column "; "(row " also matches code csvloom/papa needs),
// options.ts, detailed.ts, and unparse.ts's presets.
const FEATURE_MARKERS = [
  'pad-missing',
  'InvalidRow',
  'sep=',
  'preamble',
  ' at line ',
  'column ',
  'snippet',
  'resolveDetailedConfig',
  'parseDetailed',
  'excelSemicolon',
];
// Those csvloom/stream bundles: the strings of repair.ts, schema.ts,
// detect.ts, locate.ts's positions and options.ts. formatError, parseDetailed and the presets are
// root exports only, so " at line ", "parseDetailed" and "excelSemicolon" are not asked of it, and
// "column " is left out because it also matches ordinary code there.
const STREAM_MARKERS = [
  'pad-missing',
  'InvalidRow',
  'sep=',
  'preamble',
  'snippet',
  'resolveDetailedConfig',
];
const markersIn = (text) => FEATURE_MARKERS.filter((marker) => text.includes(marker));
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const measure = (data) => ({
  raw: data.length,
  gzip: gzipSync(data, { level: 9 }).length,
  sha: sha(data),
});

await check(
  17,
  'feature markers: dist/papa.js and .cjs hold none, dist/index.js each, dist/stream.js and .cjs those of the modules the stream uses',
  () => {
    for (const file of ['papa.js', 'papa.cjs']) {
      const found = markersIn(readFileSync(join('dist', file), 'utf8'));
      if (found.length > 0) throw new Error(`dist/${file} contains ${found.join(', ')}`);
    }
    const index = readFileSync('dist/index.js', 'utf8');
    const missing = FEATURE_MARKERS.filter((marker) => !index.includes(marker));
    if (missing.length > 0) throw new Error(`dist/index.js lacks ${missing.join(', ')}`);
    for (const file of ['stream.js', 'stream.cjs']) {
      const text = readFileSync(join('dist', file), 'utf8');
      const absent = STREAM_MARKERS.filter((marker) => !text.includes(marker));
      if (absent.length > 0) throw new Error(`dist/${file} lacks ${absent.join(', ')}`);
    }
    const hashes = ['papa.js', 'papa.cjs'].map((file) => sha(readFileSync(join('dist', file))));
    return `${FEATURE_MARKERS.length} markers, ${STREAM_MARKERS.length} of them asked of the stream; sha256 papa.js ${hashes[0]}, papa.cjs ${hashes[1]} (before the feature modules: 45ff00b902d2b71e, 47e9112ba4d42c91)`;
  },
);

// The same measures of the build before the feature modules existed, by this check (esbuild
// 0.28.2, node 24.22.1's zlib).
const BEFORE_FEATURES = {
  'import { parse }': { raw: 34283, gzip: 8561, sha: 'b9c5a35131a523b2' },
  'import { parse } minified': { raw: 15493, gzip: 5840, sha: '2b63abd744c29c85' },
  'dist/index.js': { raw: 44141, gzip: 10656, sha: '1b3f45fa588de4d8' },
  'dist/index.cjs': { raw: 45105, gzip: 11004, sha: '23bc1e6954877789' },
};
await check(18, 'a bundle of import { parse } holds no feature marker; sizes', async () => {
  const dir = consumer('plain', {
    'plain.mjs': "import { parse } from 'csvloom';\nconsole.log(parse('a,b'));\n",
  });
  const sizes = {};
  for (const minify of [false, true]) {
    const result = await build({
      entryPoints: [join(dir, 'plain.mjs')],
      absWorkingDir: dir,
      bundle: true,
      platform: 'browser',
      format: 'esm',
      minify,
      write: false,
      logLevel: 'silent',
    });
    const [output] = result.outputFiles;
    const found = markersIn(output.text);
    if (found.length > 0) throw new Error(`the bundle contains ${found.join(', ')}`);
    sizes[minify ? 'import { parse } minified' : 'import { parse }'] = measure(output.contents);
  }
  for (const file of ['index.js', 'index.cjs'])
    sizes[`dist/${file}`] = measure(readFileSync(join('dist', file)));
  const lines = Object.entries(sizes).map(([label, now]) => {
    const then = BEFORE_FEATURES[label];
    const growth = (key) => `${(((now[key] - then[key]) / then[key]) * 100).toFixed(2)}%`;
    const same = now.sha === then.sha ? ', byte-identical' : '';
    return `${label} ${now.raw} B, gzip ${now.gzip} B, sha256 ${now.sha} (before the feature modules: ${then.raw} B, gzip ${then.gzip} B; ${growth('raw')}, gzip ${growth('gzip')}${same})`;
  });
  return `${lines.join('; ')}; node ${process.version}`;
});

// The declarations csvloom/papa reaches, cut by name from dist/types and dist/options with
// their doc comments.
const papaDeclarations = (ext) => {
  const read = (path) =>
    ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const nameOf = (statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0].name.text
      : statement.name?.text;
  const declarations = new Map();
  for (const file of ['types', 'options']) {
    const source = read(`dist/${file}.${ext}`);
    for (const statement of source.statements) {
      const name = nameOf(statement);
      if (name !== undefined) declarations.set(name, { file: `${file}.d.ts`, statement, source });
    }
  }
  const references = (node) => {
    const names = [];
    const visit = (child) => {
      if (ts.isIdentifier(child) && declarations.has(child.text)) names.push(child.text);
      ts.forEachChild(child, visit);
    };
    visit(node);
    return names;
  };
  // The seed: what dist/papa imports, plus HeaderRow and ParseResult so that the main entry's
  // result types stay in the cut. dist/papa has type names of its own that dist/types also
  // declares (ParseResult, ParseConfig, ...): reading every identifier would follow those.
  const reached = new Set();
  const todo = read(`dist/papa.${ext}`)
    .statements.filter(ts.isImportDeclaration)
    .flatMap((statement) => statement.importClause.namedBindings.elements)
    .map((element) => (element.propertyName ?? element.name).text)
    .concat('HeaderRow', 'ParseResult');
  while (todo.length > 0) {
    const name = todo.shift();
    if (reached.has(name)) continue;
    reached.add(name);
    todo.push(...references(declarations.get(name).statement));
  }
  return [...reached]
    .sort()
    .map((name) => {
      const { file, statement, source } = declarations.get(name);
      const text = source.text.slice(statement.getFullStart(), statement.end).replace(/^\n+/, '');
      return `// ==== ${file} ${name}\n${text}\n`;
    })
    .join('');
};
await check(19, '/papa declarations equal test/types/papa-frozen-decls.txt', () => {
  const frozen = readFileSync('test/types/papa-frozen-decls.txt', 'utf8');
  const expected = frozen.slice(frozen.indexOf('// ==== papa.d.ts (whole file)\n'));
  const declarations = papaDeclarations('d.ts');
  if (papaDeclarations('d.cts') !== declarations)
    throw new Error('the d.cts declarations differ from the d.ts ones');
  const actual = [
    `// ==== papa.d.ts (whole file)\n${readFileSync('dist/papa.d.ts', 'utf8')}`,
    `// ==== papa.d.cts (whole file)\n${readFileSync('dist/papa.d.cts', 'utf8')}`,
    declarations,
  ].join('');
  if (actual !== expected) {
    const lines = [actual.split('\n'), expected.split('\n')];
    const at = lines[0].findIndex((line, index) => line !== lines[1][index]);
    throw new Error(
      `line ${at + 1}: ${JSON.stringify(lines[0][at])}, frozen ${JSON.stringify(lines[1][at])}`,
    );
  }
  return `${actual.split('\n').length} lines, no difference`;
});

say(`consumers in ${runDir}`);
process.exitCode = failed ? 1 : 0;
