// npm run build: dist/ with ESM (.js) and CJS (.cjs) bundles per entry, plus
// declarations for both (.d.ts with .js specifiers, .d.cts with .cjs ones).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

const options = {
  entryPoints: ['src/index.ts', 'src/papa.ts', 'src/stream.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
};
await build({ ...options, format: 'esm' });
await build({ ...options, format: 'cjs', outExtension: { '.js': '.cjs' } });
// require('csvloom/papa') returns the frozen Papa object itself, as
// require('papaparse') returns Papa; the main entry keeps esbuild's namespace.
appendFileSync('dist/papa.cjs', 'module.exports = module.exports.default;\n');

execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    ...['-p', 'tsconfig.build.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly'],
    ...['--outDir', 'dist', '--rootDir', 'src'],
  ],
  { stdio: 'inherit' },
);

const relativeTs = /(['"])(\.\.?\/[^'"]+)\.ts\1/g;
for (const name of readdirSync('dist').filter((file) => file.endsWith('.d.ts'))) {
  const text = readFileSync(`dist/${name}`, 'utf8');
  writeFileSync(`dist/${name}`, text.replace(relativeTs, '$1$2.js$1'));
  writeFileSync(
    `dist/${name.replace(/\.d\.ts$/, '.d.cts')}`,
    text.replace(relativeTs, '$1$2.cjs$1'),
  );
}

// require('csvloom/papa') has no default member (see the CJS build above), so
// dist/papa.d.cts keeps only the named exports: the seven members and the type names. The
// default export's constant and the namespace of types merged with it go.
const papaCts = readFileSync('dist/papa.d.cts', 'utf8');
const papaDefault =
  /\n(\/\*\*[^\n]*\*\/\n)?declare const Papa: [^]*\nexport \{ Papa as default \};\n$/;
if (!papaDefault.test(papaCts)) throw new Error('dist/papa.d.cts: default export not found');
writeFileSync('dist/papa.d.cts', papaCts.replace(papaDefault, '\n'));
