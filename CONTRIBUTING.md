# Contributing

Issues and pull requests are welcome; a pull request needs tests.

## Before you write code

- **A bug:** open an issue with the bug form. It asks for the input, the options, the entry (`csvloom`, `csvloom/papa` or `csvloom/stream`) and the runtime, because those four decide almost every answer.
- **A difference from Papa Parse 5.7.1** that [docs/compatibility.md](docs/compatibility.md) does not list is a bug. Report the input, the config and both outputs.
- **A feature:** open an issue first. The scope is small on purpose. Out of scope today ([docs/compatibility.md](docs/compatibility.md), "Exclusions"): Papa's `step`, `chunk` and `complete` callbacks, a worker mode, downloads, encodings other than UTF-8, XLSX, databases, and a schema language of its own.
- **A vulnerability:** [SECURITY.md](SECURITY.md), never an issue.

## Setup

- Node 22.23.4, 24.22.1, 26.12.1 or 26.13.1, exactly: `devEngines` in `package.json` refuses any other version. npm 11.19.1.
- `npm ci`
- `npm run check`: lint, formatting, type checks and the tests.
- `npm run test:package`: builds and packs the package, installs the tarball into fresh consumers (ESM, CommonJS, TypeScript, a browser bundle) and runs every example against it. It runs some checks on Node 22.23.4, 24.22.1 and 26.12.1 under `~/.nvm/versions/node/`, or on the Node binaries listed in `CSVLOOM_NODE_BINARIES` (paths separated by `:`) when that variable is set.

## What a change must keep

1. **The same output as Papa Parse 5.7.1,** except for the named exceptions. The differential tests and Papa's own suites stay green. A new intended difference needs a row in `docs/compatibility.md`, a reason and a test of its own.
2. **`parse` and `csvloom/papa` do not change for a feature.** Features are options of `parseDetailed` and `parseStream`.
3. **No runtime dependency. No `eval`, `new Function` or WebAssembly.** No Node built-in, timer or network call in `src/`. `npm run test:package` checks each.
4. **A test with every change,** written first and seen to fail. No test is removed or weakened to make a change pass.
5. **Examples are files.** A code block in `README.md`, `docs/migrating-from-papaparse.md` or `llms.txt` is a file of `examples/docs/` shown unchanged with its output, and `test/docs-examples.test.ts` fails otherwise. `docs/features.md` and `docs/streaming.md` follow the same rule with `examples/features/` and `examples/stream/`.
6. **No speed claim without the method.** A change to `src/parser.ts` or `src/parse.ts` is measured before it merges, with the method in [docs/benchmarks.md](docs/benchmarks.md), and the cases that got slower are reported beside the ones that got faster. A timing from a laptop is a hint, not a result.
7. **One topic per commit,** with a message that says what changed and why.

## License

Contributions are accepted under the MIT license of this repository. No sign-off and no contributor agreement are required.
