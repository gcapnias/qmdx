# QMD SDK upgrade policy

QMDX integrates with QMD exclusively through the public `@tobilu/qmd` SDK. The normative
rule comes from the QMDX v1 specification ("Runtime and distribution"):

> A QMD SDK upgrade requires representative-index compatibility tests and at least a
> QMDX minor release. A breaking CLI, JSON, or required-workflow change requires a QMDX
> major release.

## Why an exact pin

Preflight, embedding-coverage, and readiness guarantees are established against exactly
one SDK version. "Passing preflight establishes current usability with the exactly pinned
SDK, not forward compatibility with another QMD version." The pin therefore lives in two
places that must move together:

1. `package.json` → `dependencies["@tobilu/qmd"]` (exact version, no range).
2. `scripts/sdk-policy.json` → `pinnedVersion`.

## Upgrade procedure

1. Change the pin in both files above to the new exact SDK version (one commit/PR).
2. Run the full suite (`npm test`), which includes:
   - the representative-index installation and upgrade regression tests through public
     SDK behavior (`test/packaged-cli.smoke.test.ts`), and
   - the child-process CLI contract suites.
3. Release at least a QMDX **minor** version.
4. If the new SDK changes the CLI compatibility perimeter, the JSON envelope contract, or
   any required workflow, release a QMDX **major** version instead.

## Enforcement

`scripts/check-package.mjs` fails when the declared dependency is not the exact policy
version, when direct dependencies stop being exact pins, or when the lockfile drifts from
`package.json`. It runs as part of `npm test` and CI.

Representing an upgrade without representative-index evidence is not permitted; if a
compatibility gap cannot be closed, keep the previous pin and file the gap against the
upgrade ticket.
