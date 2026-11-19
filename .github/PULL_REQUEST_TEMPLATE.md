<!-- What changes, and why. One topic per pull request. -->

## Checks

- [ ] `npm run check` passes on Node 22.23.4, 24.22.1, 26.12.1 or 26.13.1 (say which).
- [ ] A test fails without this change and passes with it.
- [ ] Output of `parse`, `unparse` and `csvloom/papa` is unchanged, or the difference has a row in `docs/compatibility.md` and a test of its own.
- [ ] No new dependency, and no `eval`, `new Function` or WebAssembly.
- [ ] If `src/parser.ts` or `src/parse.ts` changed: measured with the method in `docs/benchmarks.md`, slower cases reported too.
- [ ] If a document changed: its code blocks are files under `examples/`, shown unchanged.
