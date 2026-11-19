import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new directory under the system temp directory, removed after the test file has run. */
export function scratchDir(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `csvloom-${name}-`)));
  dirs.push(dir);
  return dir;
}
