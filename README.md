# QMDX

QMDX (`@gcapnias/qmdx`) is a companion CLI for [QMD](https://github.com/tobilu/qmd)-managed
indexes. It adds remote query expansion and remote reranking on top of QMD's local
retrieval and fusion. QMD remains the indexing and local retrieval system; QMDX does not
manage collections, indexing, embeddings, or storage.

## Install

Global install, one-off execution through `npx`, and project-local installation all expose
the same `qmdx` executable and the same behavior:

```sh
npm install -g @gcapnias/qmdx   # global
npx @gcapnias/qmdx --help       # one-off execution
npm install @gcapnias/qmdx      # project-local
```

Commands:

```text
qmdx setup [--profile <name>]
qmdx doctor [--profile <name>]
qmdx query <query> [options]
```

Run `qmdx --help` for the full option surface.

## Runtime support policy

- Native ESM package; TypeScript source compiled to JavaScript for distribution.
- Minimum runtime: Node.js 22.
- Tested runtimes: Node.js 22 LTS and 24 LTS (both are covered by the test matrix).
- Odd-numbered and other non-LTS majors are rejected at startup with exit code 2.
- Untested newer even LTS majors (for example a future Node 26 LTS) print a warning to
  stderr and continue.

## Platform support

| Platform | Support |
| --- | --- |
| Windows 11 x64 | Release-blocking. Every release must pass the full test suite here. |
| Linux | Experimental. Known caveats around native modules; not release-blocking. |
| macOS | Experimental. Not release-blocking. |

The CI matrix runs Windows for every supported Node major as a required job; Linux and
macOS jobs are marked experimental.

## Reproducible install

The QMD SDK (`@tobilu/qmd`) is an exact-pinned direct dependency, all direct dependencies
are exactly pinned, and `package-lock.json` is committed. Always install with:

```sh
npm ci
```

`scripts/check-package.mjs` (run as part of `npm test`) guards this contract: exact pins,
lockfile sync, the SDK pin against `scripts/sdk-policy.json`, and the native-module
`allowScripts` entries.

## No stable library API

This package promises **no stable JavaScript or TypeScript library API**. The only stable
public contract is the `qmdx` executable itself — its commands, options, exit codes, and
the JSON result/error envelopes it writes. No `exports` field is published; anything you
import from inside the package may change or disappear in any release.

## QMD SDK upgrade policy

QMDX pins an exact QMD SDK version because preflight guarantees hold only for the pinned
SDK. Upgrading `@tobilu/qmd` requires representative-index compatibility tests to pass and
at least a QMDX minor release. A breaking CLI, JSON envelope, or required-workflow change
requires a QMDX major release. See
[`docs/policy/sdk-upgrade-policy.md`](docs/policy/sdk-upgrade-policy.md) and
[`scripts/sdk-policy.json`](scripts/sdk-policy.json).
