# Security policy

## Reporting a vulnerability

Report it privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: "Report a vulnerability" under the repository's [Security tab](https://github.com/baozdemir/csvloom/security).

A useful report holds the version, the runtime and its version, the smallest input and options that show the problem, what you expected and what happened. A proof of concept helps. Please do not test against systems that are not yours.

A report is acknowledged within 7 days, and a fix or a plan follows within 30 days.

## Supported versions

The first version is 0.1.0. Before 1.0.0, security fixes go into the latest release, and there is no long-term support line.

## What counts

In scope:

- An input or an option value that makes `parse`, `parseDetailed`, `parseStream` or `unparse` hang, crash the process, or use time or memory far out of proportion to the input, beyond the limits documented below.
- Prototype pollution or code execution through an input or an option value.
- A value that `unparse` of the main entry should escape under its documented rule and does not.
- The published package: its contents, how it is built and how it is released.

Documented limits, which are not vulnerabilities by themselves:

- **`maxRecordLength` has no default.** Without it `parseStream` holds a record of any length, up to the engine's string limit, and `parse` takes the whole text as one string by design. For input you do not trust, set `maxRecordLength` and give `delimiter` and `newline` ([docs/streaming.md](docs/streaming.md), recipe 4).
- **Formula escaping is a mitigation, not a guarantee.** It is on by default in the main entry's `unparse` and off by default in `csvloom/papa`, as in Papa Parse. OWASP notes that the leading `'` is not reliable in Microsoft Excel once the file is saved and opened again.
- **`repair` can cost many scans.** Each line its `unclosed-quote` rule reads again is followed by a new scan of the rest of the input, up to 100 times ([docs/features.md](docs/features.md)).
- **Your callbacks are your code.** `transform`, `transformHeader`, a `dynamicTyping` or `delimiter` function and a `schema` run as given.
- **Cells are untrusted data.** csvloom returns them as they are. Escaping for HTML, SQL, a shell or a prompt is the caller's.

## What the library does

- No `eval`, `new Function` or WebAssembly, in the source or in the built files; the packed package is run under `node --disallow-code-generation-from-strings` (`npm run test:package`, checks 11 and 12).
- No runtime dependency. No network call, timer or Node built-in in the library code.
- A header named `__proto__` becomes an ordinary property of the row; nothing is written to a prototype.
- Releases are published from GitHub Actions through npm trusted publishing, staged and approved with 2FA, with provenance, and without a long-lived token.
