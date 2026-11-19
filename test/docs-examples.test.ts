import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The code blocks of README.md, the migration guide and llms.txt are the files of examples/docs/,
// shown unchanged with the output each prints. Here every file runs in a fresh node with default
// flags, its imports of the package pointed at src/, so no build is needed; check 15 of
// npm run test:package runs the same files against the packed package.
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const names = readdirSync(new URL('examples/docs/', root))
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => file.slice(0, -'.mjs'.length))
  .sort();
const source = (name: string) => read(`examples/docs/${name}.mjs`);
const output = (name: string) => read(`examples/docs/${name}.txt`);
const entries = {
  "from 'csvloom';": 'src/index.ts',
  "from 'csvloom/papa';": 'src/papa.ts',
  "from 'csvloom/stream';": 'src/stream.ts',
};

const run = (code: string) => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env,
  });
  return { status: child.status, stderr: child.stderr, stdout: child.stdout };
};

const documents = ['README.md', 'docs/migrating-from-papaparse.md', 'llms.txt'];
// The one shell block a document may hold.
const INSTALL = ['npm install csvloom\n'];
const blocksOf = (text: string) =>
  [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((match) => ({
    language: match[1] ?? '',
    body: match[2] ?? '',
  }));

describe('examples/docs', () => {
  it('holds the twelve examples', () => {
    expect(names).toStrictEqual([
      'detailed',
      'detect',
      'excel',
      'from-file',
      'main-entry',
      'papa',
      'positions',
      'quick-start',
      'repair',
      'schema',
      'stream',
      'unsupported',
    ]);
  });

  it.each(names)('%s.mjs prints its .txt', (name) => {
    let pointed = source(name);
    for (const [specifier, file] of Object.entries(entries))
      pointed = pointed.replaceAll(specifier, `from '${new URL(file, root).href}';`);
    expect(pointed).not.toContain("from 'csvloom");
    expect(run(pointed)).toStrictEqual({ status: 0, stderr: '', stdout: output(name) });
  });

  it.each(names)('%s.mjs is shown by a document', (name) => {
    const shown = `\`\`\`js\n${source(name)}\`\`\`\n`;
    expect(documents.filter((path) => read(path).includes(shown))).not.toStrictEqual([]);
  });

  // The migration guide's first claim: for a synchronous parse or unparse of a string, the import
  // is the only change. The same file, importing the pinned Papa Parse itself, prints the same.
  it('papa.mjs prints the same output when it imports papaparse 5.7.1', () => {
    expect(JSON.parse(read('node_modules/papaparse/package.json'))).toHaveProperty(
      'version',
      '5.7.1',
    );
    const swapped = source('papa').replace("from 'csvloom/papa';", "from 'papaparse';");
    expect(swapped).not.toContain("from 'csvloom");
    expect(run(swapped)).toStrictEqual({ status: 0, stderr: '', stdout: output('papa') });
  });
});

describe('the documents that show the examples', () => {
  it.each(documents)('%s: every code block is an example, followed by its output', (path) => {
    const text = read(path);
    const blocks = blocksOf(text);
    // No fence escapes the pattern above (an indented one, or one that is never closed).
    const fenceLines = text.split('\n').filter((line) => line.trimStart().startsWith('```'));
    expect(fenceLines.length).toBe(2 * blocks.length);
    blocks.forEach((block, index) => {
      if (block.language === 'js') {
        const name = names.find((candidate) => source(candidate) === block.body);
        expect(name, `a js block that is no file of examples/docs:\n${block.body}`).toBeDefined();
        expect(blocks[index + 1]).toStrictEqual({ language: 'text', body: output(name ?? '') });
      } else if (block.language === 'text') {
        expect(blocks[index - 1]?.language).toBe('js');
      } else {
        expect(block.language).toBe('sh');
        expect(INSTALL).toContain(block.body);
      }
    });
  });

  // A tripwire, not a proof: outside the marked block of published numbers and outside the code
  // blocks, no figure that reads as a speed ratio ("1.231", "3x", "3 ×"), and no placeholder for a
  // measurement.
  it.each(documents)('%s: performance figures stand only in its marked results blocks', (path) => {
    const prose = read(path)
      .replace(/<!-- published-results:start -->[\s\S]*?<!-- published-results:end -->/g, '')
      .replace(/^```\w*\n[\s\S]*?^```$/gm, '');
    const ratio = /(?<![\d.,])\d\.\d{2,3}(?![\d.])|\b\d+(?:\.\d+)?\s?[x×](?!\w)/g;
    expect(prose.match(ratio) ?? []).toStrictEqual([]);
    expect(read(path)).not.toContain('[PENDING:');
  });
});
