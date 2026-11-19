// Runs the examples of examples/stream, examples/features and examples/docs against the packed
// package with another JavaScript runtime, and checks that each one exits 0, writes nothing to
// stderr and prints exactly its .txt file. Run `npm run build` first.
// Usage: node scripts/examples-on.mjs <runtime> [runtime arguments...]
//   node scripts/examples-on.mjs deno run --allow-all
//   node scripts/examples-on.mjs bun
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const [runtime, ...runtimeArgs] = process.argv.slice(2);
if (!runtime)
  throw new Error('usage: node scripts/examples-on.mjs <runtime> [runtime arguments...]');

const root = process.cwd();
// On Windows npm is npm.cmd, which Node starts only through a shell.
const shell = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'csvloom-examples-'));
try {
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], {
    encoding: 'utf8',
    shell,
  });
  const tarball = join(work, packed.trim().split('\n').at(-1));
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], {
    cwd: work,
    shell,
  });

  const version = spawnSync(runtime, ['--version'], { encoding: 'utf8', shell })
    .stdout.trim()
    .split('\n')[0];
  const failures = [];
  let count = 0;
  for (const folder of ['stream', 'features', 'docs']) {
    const source = join(root, 'examples', folder);
    const dir = join(work, folder);
    cpSync(source, dir, { recursive: true });
    for (const example of readdirSync(source).filter((file) => file.endsWith('.mjs'))) {
      count++;
      const expected = readFileSync(join(source, example.replace(/\.mjs$/, '.txt')), 'utf8');
      const result = spawnSync(runtime, [...runtimeArgs, example], { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0 || result.stderr !== '' || result.stdout !== expected)
        failures.push(
          `${folder}/${example}: exit ${result.status}, stderr ${JSON.stringify(result.stderr)}, stdout ${JSON.stringify(result.stdout)}`,
        );
    }
  }
  if (failures.length > 0) {
    process.stderr.write(
      `${failures.length} of ${count} examples failed on ${runtime} ${version}:\n`,
    );
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${count} examples print their .txt on ${runtime} ${version}\n`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
