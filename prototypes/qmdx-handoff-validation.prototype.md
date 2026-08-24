# QMDX handoff validation prototype

> THROWAWAY PROTOTYPE
>
> Question: Do the resolved wayfinding decisions form a faithful,
> implementation-ready QMDX v1 handoff?

## Initial finding

The product, pipeline, operational policy, and acceptance rules were clear, but
the decisions were distributed across tracker comments, ADRs, `CONTEXT.md`, and
prototype branches. Four public-contract gaps prevented approval as a single
implementation handoff.

## Human-reviewed gaps

### Initial provider support

Options considered:

- OpenAI-compatible expansion plus Cohere reranking.
- OpenAI-compatible expansion plus both Cohere and Jina reranking.
- Provider-neutral contracts with concrete adapters delegated to
  implementation.

Decision:

QMDX v1 ships an OpenAI-compatible expansion adapter defaulting to
`gpt-4o-mini` and a Cohere reranking adapter defaulting to
`rerank-v4.0-pro`.

### Configuration surface

Options considered:

- Freeze the OS-standard config path and public setup, doctor, profile, and
  strict-mode commands.
- Freeze only command names and delegate the file format and location.
- Delegate all names and files to implementation.

Decision:

QMDX v1 uses `config.json` in the OS-standard QMDX user configuration
directory. The public surface is:

```text
qmdx setup --profile <name>
qmdx doctor --profile <name>
qmdx query <query> --profile <name>
```

`--require-remote` selects strict execution. Normal execution permits declared
degradation. Profiles contain credential environment-variable references, not
literal credentials.

### JSON and error contract

Options considered:

- Make the accepted CLI prototype's schema, streams, and numeric exits
  normative.
- Freeze only the high-level envelope shape.
- Delegate the exact machine contract to implementation.

Decision:

Schema version 1 has result-envelope fields `schemaVersion`, `query`,
`pipeline`, `results`, `warnings`, and `timingMs`. Failures use a versioned
error envelope. Closed status, warning, reason, error-category, and error-code
enums are part of the contract.

Exit codes are:

| Exit | Meaning |
| ---: | --- |
| 0 | Completed, including zero results and normal degradation |
| 2 | Invocation or configuration failure |
| 3 | Local index or retrieval failure |
| 4 | Required remote inference failure |
| 5 | Unexpected internal failure |

JSON completions write one envelope to stdout. JSON failures write one error
envelope to stderr and leave stdout empty.

### QMD compatibility perimeter

Options considered:

- Freeze an explicit supported QMD 2.8.3 subset and reject the rest.
- Treat `--all` as all candidates in the fixed pool.
- Delegate the exact compatibility audit and mappings.

Decision:

QMDX v1 supports:

- `-n`, `--limit`
- `--min-score`
- `--full`
- `-c`, `--collection`
- `--intent`
- `--format`
- `--full-path`
- `--line-numbers`
- `--explain`
- QMD 2.8.3 typed query documents

QMDX adds `--profile`, `--require-remote`, `--no-expand`, and `--no-rerank`.
It rejects `--all`, `--candidate-limit`, and every unlisted QMD query option.

## Verdict

With these four decisions folded into one normative document, the shortened
remote-only QMDX handoff faithfully represents the resolved route and contains
enough public behavior and acceptance detail for implementation to begin
without another product decision.

The validated decision belongs on the main development branch. This prototype
branch remains only as the primary source for the human review that settled the
final gaps.
