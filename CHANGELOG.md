# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0.0 a minor version may change behavior, and such changes are listed under **Breaking**.

## [0.1.0] - 2026-11-19

The first release.

### Added

- **`csvloom`:** `parse(text, config)` and `unparse(data, config)` for strings, with the options Papa Parse 5.7.1 has for them and the same results, errors and `meta`. Unknown options and values of the wrong type throw a `TypeError` that names them. Row types follow the config.
- **`csvloom/papa`:** the same parser behind Papa's own reading of a config, for code written for Papa Parse: `import Papa from 'csvloom/papa'`, or `require('csvloom/papa')`. Its TypeScript types carry the names of `@types/papaparse` (`ParseResult`, `ParseConfig`, `ParseError`, `ParseMeta`, `UnparseConfig`) and a generic `parse<T>`, so typed code written for Papa Parse compiles after the import change; the exceptions are in [docs/compatibility.md](docs/compatibility.md).
- **`csvloom/stream`:** `parseStream(source, config)`, an async iterator of row batches over strings, `Uint8Array` chunks, Web streams, Node streams and iterables, with `batchSize`, `maxRecordLength`, `signal` and `await using`.
- **`parseDetailed`** with five options, each off by default: `detect` (dialect detection, also as the function `detect`), `positions` (line, column, offset and snippet on errors, printed by `formatError`), `repair` (five rules, every change logged), `schema` (row validation through a Standard Schema v1 object) and `sepLine`.
- **`unparse`:** `bom`, `sepLine`, and the presets `excel` and `excelSemicolon`.
- ESM and CommonJS builds with type declarations for both. No runtime dependency.

### Differences from Papa Parse 5.7.1 to know before upgrading code

- `unparse` in the main entry escapes formula-like values by default (`escapeFormulae: false` turns it off). `csvloom/papa` keeps Papa's default, off.
- Papa's callbacks, worker mode, downloads, `encoding` and non-string inputs throw `UnsupportedFeatureError` in both entries.
- Every other intended difference is listed by id in [docs/compatibility.md](docs/compatibility.md); the migration is in [docs/migrating-from-papaparse.md](docs/migrating-from-papaparse.md).

[0.1.0]: https://github.com/baozdemir/csvloom/releases/tag/v0.1.0
