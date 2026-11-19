import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

// Each examples/features/<name>.mjs runs in a fresh node with default flags and must print exactly
// <name>.txt. Its imports of 'csvloom' and 'csvloom/stream' are pointed at src/index.ts and
// src/stream.ts, so no build is needed; the run against the packed package belongs to the examples
// check of npm run test:package.
const dir = new URL('../examples/features/', import.meta.url);
const entries = {
  "from 'csvloom';": new URL('../src/index.ts', import.meta.url).href,
  "from 'csvloom/stream';": new URL('../src/stream.ts', import.meta.url).href,
};
const examples = readdirSync(dir)
  .filter((file) => file.endsWith('.mjs'))
  .sort();

describe('examples/features', () => {
  it('holds the seven examples, each with its expected output', () => {
    expect(examples).toStrictEqual([
      'detect.mjs',
      'excel-export.mjs',
      'injection.mjs',
      'positions.mjs',
      'repair.mjs',
      'schema-stream.mjs',
      'schema.mjs',
    ]);
  });

  it.each(examples)('%s prints its .txt', (file) => {
    const source = readFileSync(new URL(file, dir), 'utf8');
    let pointed = source;
    for (const [specifier, entry] of Object.entries(entries))
      pointed = pointed.replaceAll(specifier, `from '${entry}';`);
    // Every import of the package was pointed at src/: at least one, and none is left by name.
    expect(pointed).not.toBe(source);
    expect(pointed).not.toContain("'csvloom");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', pointed], {
      encoding: 'utf8',
      env,
    });
    expect({ status: child.status, stderr: child.stderr, stdout: child.stdout }).toStrictEqual({
      status: 0,
      stderr: '',
      stdout: readFileSync(new URL(file.replace(/\.mjs$/, '.txt'), dir), 'utf8'),
    });
  });

  it.each(examples)('docs/features.md shows %s and its output unchanged', (file) => {
    const page = readFileSync(new URL('../docs/features.md', import.meta.url), 'utf8');
    const fenced = (language: string, text: string) => `\`\`\`${language}\n${text}\`\`\`\n`;
    expect(page).toContain(fenced('js', readFileSync(new URL(file, dir), 'utf8')));
    const output = readFileSync(new URL(file.replace(/\.mjs$/, '.txt'), dir), 'utf8');
    expect(page).toContain(fenced('text', output));
  });
});
