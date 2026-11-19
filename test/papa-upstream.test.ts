import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

// Runs Papa Parse's own 5.7.1 test cases against the pinned npm package.
// The upstream file is written for Mocha: tests may take a `done` callback
// and call `this.timeout()`. Vitest supports neither, so adapt them here.

type MochaDone = (error?: unknown) => void;
type MochaTest = (this: MochaContext, done: MochaDone) => unknown;
interface MochaContext {
  timeout(ms: number): void;
}

// Upstream skips its own browser-only cases (XMLHttpRequest, File, Worker) in Node.
const mochaContext: MochaContext = { timeout: () => undefined };

function runMochaTest(fn: MochaTest): unknown {
  if (fn.length === 0) {
    return fn.call(mochaContext, () => undefined);
  }
  return new Promise<void>((resolve, reject) => {
    fn.call(mochaContext, (error?: unknown) => {
      if (error === undefined) resolve();
      else
        reject(
          error instanceof Error ? error : new Error('done() got a non-Error', { cause: error }),
        );
    });
  });
}

const mochaIt = Object.assign(
  (name: string, fn: MochaTest) => {
    it(name, () => runMochaTest(fn));
  },
  {
    skip: (name: string) => {
      it.skip(name, () => undefined);
    },
  },
);

Object.assign(globalThis, { describe, it: mochaIt });
createRequire(import.meta.url)('./upstream/papaparse-5.7.1/tests/test-cases.js');
