# Papa Parse 5.7.1 upstream test cases

`tests/test-cases.js` and `LICENSE` are unmodified copies from
https://github.com/mholt/PapaParse at tag `5.7.1`
(commit `af9cc5f41d4bb5307f06bbf1380216bf18651b49`, whose parent
`ce8723fa19e5f80f0169d83d68c5e134deb9d9fa` is the npm package's `gitHead`; the
npm tarball holds the same bytes). Papa Parse is MIT licensed,
Copyright (c) 2015 Matthew Holt; see `LICENSE`.

SHA256 of `tests/test-cases.js`:
`37f1f0ae8f5bcbfc4e1b6d022fdae04b9499de33ac4aba72945ad5f26e3bc6d8`

Harness additions (not upstream files):

- `package.json` marks this folder as CommonJS so the upstream file loads as written.
- `papaparse.js` points the upstream `require('../papaparse.js')` at the pinned npm package.
- `test/papa-upstream.test.ts` runs the file under Vitest, adapting Mocha's `done` callbacks.
