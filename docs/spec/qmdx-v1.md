# QMDX v1 implementation specification

## Status and scope

This document is the normative implementation handoff for QMDX v1.

QMDX is a companion CLI for QMD-managed indexes. It adds remote query
expansion and reranking while preserving QMD as the indexing and local
retrieval system.

QMDX v1 does not:

- manage QMD collections, updates, indexing, embeddings, or storage;
- invoke an external `qmd` executable;
- inspect or modify QMD's SQLite schema directly;
- provide local query generation or local reranking;
- promise full QMD CLI compatibility;
- expose a stable JavaScript or TypeScript library API; or
- support an unbounded remote-reranking candidate pool.

## Runtime and distribution

- Package name: `@gcapnias/qmdx`
- Executable: `qmdx`
- Source: TypeScript
- Published modules: native ESM
- Minimum runtime: Node.js 22
- Initial tested Node versions: Node.js 22 LTS and 24 LTS
- Unsupported runtimes: odd-numbered or non-LTS Node majors
- Untested newer even LTS majors: warn, do not hard-fail
- Release-blocking platform: Windows 11 x64
- Experimental platforms: Linux and macOS
- QMD integration: exact direct dependency on `@tobilu/qmd`
- Initial QMD pin: 2.8.3
- Reproducible install: committed `package-lock.json` and `npm ci`

Global installation, `npx @gcapnias/qmdx`, and project-local installation must
all expose the same `qmdx` executable.

A QMD SDK upgrade requires representative-index compatibility tests and at
least a QMDX minor release. A breaking CLI, JSON, or required-workflow change
requires a QMDX major release.

## Initial provider set

QMDX v1 must ship:

1. An OpenAI-compatible expansion adapter.
2. A Cohere reranking adapter.

The built-in expansion route defaults are:

```text
provider: openai
endpoint: https://api.openai.com/v1
model: gpt-4o-mini
```

The built-in reranking route defaults are:

```text
provider: cohere
endpoint: https://api.cohere.com
model: rerank-v4.0-pro
```

The OpenAI-compatible adapter may use another endpoint and model when the
selected route passes strict-schema, privacy, pricing, payload, and live
capability preflight. QMDX v1 is not required to ship OpenRouter-specific or
Jina-specific adapters.

Expansion and reranking routes are independently configured. They may use
different credentials and endpoints. QMDX performs no automatic cross-provider
failover.

## Configuration surface

### Config location

The configuration file is named `config.json` in the OS-standard QMDX user
configuration directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\qmdx\config.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/qmdx/config.json` |
| macOS | `~/Library/Application Support/qmdx/config.json` |

QMDX must not write credentials to this file.

The top-level configuration shape is:

```json
{
  "version": 1,
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "expansion": {
        "provider": "openai",
        "endpoint": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "credentialEnv": "OPENAI_API_KEY"
      },
      "reranking": {
        "provider": "cohere",
        "endpoint": "https://api.cohere.com",
        "model": "rerank-v4.0-pro",
        "credentialEnv": "COHERE_API_KEY"
      },
      "policy": {},
      "privacy": {}
    }
  }
}
```

`credentialEnv` is an environment-variable name, not a credential. Users may
choose another variable name. Implementations may add version-1 profile fields
only when their defaults preserve this specification.

Effective values resolve in this order:

1. Command-line option.
2. Environment variable.
3. Selected profile.
4. Built-in default.

### Commands

```text
qmdx setup --profile <name>
qmdx doctor --profile <name>
qmdx query <query> --profile <name>
```

`--profile` is optional when `defaultProfile` is configured.

`setup` performs interactive privacy approval and authenticated live route
checks. `doctor` repeats configuration, local-index, privacy, pricing, payload,
and live-capability diagnostics without running a user search.

`query` uses normal degradation behavior by default. `--require-remote` requires
both remote stages to return valid results from an eligible cache entry or a
successful provider request.

## Local index contract

QMD owns collection configuration, filesystem updates, indexing, embedding
generation, vector rebuilding, SQLite storage, BM25 retrieval, vector
retrieval, and reciprocal-rank fusion.

QMDX must use QMD's public SDK and QMD path helpers. It must open QMD with the
effective embedding model explicitly configured.

The required multilingual default is:

```text
hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

Changing the embedding profile requires a complete `qmd embed -f` rebuild.
Advanced overrides are permitted but forfeit QMDX's English/Greek multilingual
retrieval guarantee.

Before search, setup and doctor must use public SDK health information to:

1. Fail if the store cannot open.
2. Fail if there are no active documents.
3. Fail if the vector index is absent.
4. Fail if more than 10% of active documents need embedding for the effective
   model and fingerprint, including the case where every document needs it.
5. Warn with the count and percentage when at most 10% need embedding.
6. Run a fixed local-only `searchVector(..., { limit: 1 })` readiness probe.
7. Fail if the vector probe throws or cannot retrieve from an otherwise
   complete, non-empty index.

`daysStale` is diagnostic only. Passing preflight establishes current usability
with the exactly pinned SDK, not forward compatibility with another QMD
version.

## Search pipeline

```text
original query
  -> remote typed-query expansion
  -> QMD SDK local query embedding, BM25/vector retrieval, and RRF
  -> one unreranked QMD candidate pool
  -> remote reranking
  -> QMDX final ordering and result shaping
```

Expansion, retrieval/fusion, reranking, and shaping must remain independently
observable. The complete pipeline is the default.

## Query expansion

### Input

Every normal search attempts remote expansion. QMDX does not use QMD's
strong-signal shortcut.

The expansion provider receives only the original query. It must not receive
search intent, corpus content, retrieved documents, paths, or search history.

The original query must be non-empty and at most 2,048 Unicode characters.
Oversized input is rejected rather than truncated.

Expansion quality is guaranteed for English, Greek, and mixed English/Greek
queries. Other languages are accepted best-effort and are not degraded solely
because of language.

### Response

The route must support strict JSON Schema. Plain JSON mode and free-form parsing
are ineligible.

The response outcome is:

- `expanded`, with one or more generated queries; or
- `original_sufficient`, with no generated queries.

Each generated query has:

```json
{
  "type": "lex",
  "query": "query text",
  "language": "en",
  "purpose": "terminology"
}
```

Closed values:

| Type | Allowed purpose | Maximum length |
| --- | --- | ---: |
| `lex` | `terminology`, `translation` | 256 |
| `vec` | `semantic` | 512 |
| `hyde` | `hypothetical` | 1200 |

Allowed languages are `en`, `el`, and `und`. `und` is reserved for
language-neutral, identifier-heavy queries.

Generated output is limited to:

- two lexical variants;
- one vector rewrite; and
- one HyDE passage.

A HyDE passage is at most three compact, plausible note-like sentences. It
must not invent personal facts, citations, filenames, dates, or claims that the
user supplied information.

The route uses its lowest deterministic sampling settings. Provider, endpoint,
model, prompt, schema, and parameter versions are part of expansion identity.

### Validation and ordering

QMDX validates entries independently:

- normalize surrounding and internal whitespace;
- enforce type, purpose, language, count, and length rules;
- reject control characters;
- remove case-insensitive duplicates within a type; and
- remove generated copies of the corresponding original route.

The same text may survive across different query types.

If at least one generated entry survives, expansion succeeds with the valid
subset and reports discarded entries diagnostically. Partial valid expansion
is not retried.

QMDX submits the original lexical route before generated lexical routes and the
original vector route before generated vector and HyDE routes. Generated routes
are ordered as terminology lexical, translation lexical, vector, then HyDE.

QMD owns structured-search execution and fusion. QMD 2.8.3 executes lexical
lists before vector lists and gives double RRF weight to the first non-empty
list. QMDX accepts and measures this behavior; request order does not guarantee
original-query primacy.

When expansion degrades, retrieval continues with the original lexical and
vector routes. QMDX never fabricates local expansion.

## Retrieval and remote reranking

QMDX requests one fused QMD pool through the public SDK with local reranking
disabled:

```text
rerank: false
candidateLimit: 80
limit: 80
minScore: 0
explain: true
```

Search intent is passed to QMD because it participates in selected-chunk
choice.

The reranking query is:

```text
intent + "\n\n" + originalQuery
```

when intent exists, and the unchanged original query otherwise. Generated
queries are retrieval routes and are never part of the reranking query.

QMDX submits up to 80 QMD candidates in one Cohere request:

- preserve QMD fused order and RRF rank;
- keep every candidate as a distinct entry, including identical chunks;
- use an opaque request index paired with QMD's internal file identity;
- send only the exact non-empty QMD `bestChunk`;
- keep title, virtual path, context, complete body, and retrieval explanation
  local.

Route admission must validate the complete request: document count, each
selected chunk, aggregate context/token limits, and all-results output. QMDX
must not split the request, truncate chunks, accept silent provider truncation,
or fabricate scores.

For Cohere, QMDX must calculate a conservative token upper bound for every
selected chunk using the provider-documented counting method before sending the
request. When the API exposes `max_tokens_per_doc`, QMDX must set it high enough
for the largest admitted chunk and no higher than the route's validated maximum.
If QMDX cannot prove that every chunk fits without truncation, route admission
fails with `payload_limit_exceeded`; it must not rely on a response to reveal
silent truncation after the fact.

A valid response identifies every submitted candidate exactly once with a
finite provider-native score in `[0,1]`. Missing, duplicate, unknown, or invalid
entries invalidate the entire response.

Scores remain unchanged and request-local. QMDX must not normalize them or
compare them across models, requests, or searches.

Final score:

```text
finalScore = retrievalWeight * (1 / rrfRank)
           + (1 - retrievalWeight) * remoteScore
```

| QMD RRF rank | Retrieval weight |
| --- | ---: |
| 1-3 | 0.75 |
| 4-10 | 0.60 |
| 11+ | 0.40 |

This is the exact QMD 2.8.3 position-aware formula. QMDX deliberately does not
normalize `1 / rrfRank` to another retrieval scale. The resulting rank-band
behavior is inherited and must be evaluated by the acceptance benchmark rather
than silently replaced during implementation.

Worked examples:

| QMD RRF rank | Remote score | Calculation | Final score |
| ---: | ---: | --- | ---: |
| 1 | 0.00 | `0.75 * 1 + 0.25 * 0` | 0.7500 |
| 2 | 0.89 | `0.75 * 0.5 + 0.25 * 0.89` | 0.5975 |
| 4 | 0.89 | `0.60 * 0.25 + 0.40 * 0.89` | 0.5060 |
| 11 | 0.89 | `0.40 * (1 / 11) + 0.60 * 0.89` | 0.5704 |

Equal final scores are ordered by lower original QMD RRF rank, then QMD internal
file identity. No remote-score threshold removes candidates. The requested
output limit truncates the final ordered pool.

## Operational policy

### Preflight and privacy

Profiles contain a versioned privacy declaration covering endpoint and region,
stage-specific transmitted data, retention, training use, and reviewed policy
sources.

First interactive use requires approval. Non-interactive use requires an
approved current declaration.

An authenticated live check is valid for:

- seven days in normal use; or
- 24 hours for required-remote validation and acceptance runs.

Changing provider, endpoint, model, credential reference, declared capability,
reviewed pricing, or privacy declaration invalidates the check and approval.

Missing credentials, invalid profiles, stale required preflight, or absent
current privacy approval are configuration failures. QMDX transmits nothing
and does not return a local baseline.

### Cost and time

- Default hard query ceiling: US$0.05
- Default cumulative expansion budget: 8 seconds
- Default cumulative reranking budget: 12 seconds
- Hard end-to-end deadline: 30 seconds
- Maximum attempts per remote stage: two

Before every attempt, QMDX conservatively estimates worst-case billable cost
from the admitted payload and reviewed rate data. It must not send an attempt
that cannot fit the remaining stage or query budget.

Profiles may lower limits. Raising the 30-second deadline requires an explicit
command-line override and makes the run ineligible for the production
acceptance claim.

Retry once, when budgets permit, for:

- transport failure;
- attempt timeout;
- HTTP 408, 429, or 5xx;
- truncation; or
- invalid or incomplete provider response.

Use full-jitter backoff bounded by the remaining budgets. Honor `Retry-After`
only when it fits.

Do not retry authentication/authorization failure, billing/quota exhaustion,
unsupported capability, provider policy rejection, invalid local
configuration, or local payload/cost admission rejection.

### Caching and diagnostics

Persistent remote-response caching is disabled by default. A profile may enable
separate bounded expansion and reranking caches with TTL and size limits.
Acceptance measurements are uncached.

Cache identity includes stage inputs or hashes plus provider, endpoint, model,
prompt/schema, privacy declaration, and policy versions. Reranking identity
also includes ordered candidate identities and selected-chunk hashes.

Default persistent diagnostics are metadata-only. They may contain stage
status/reason, provider/model identity, provider request ID, candidate counts,
timing, retries, usage, cost, cache state, and declaration/policy versions.
They must not contain query text, intent, generated queries, selected chunks,
paths, credentials, headers, or provider response bodies.

Payload capture requires an explicit warned diagnostic mode, a user-selected
destination and retention, and owner-only permissions.

### Degradation

Normal mode returns usable degradation after a valid remote stage is
unavailable, fails, exhausts retries/time, or is blocked by request-specific
payload or cost admission.

- Expansion degradation uses original lexical/vector routes.
- Reranking degradation keeps QMD fused order.
- Both stages degrading yields the usable QMD baseline.

A result with successful remote reranking uses the blended score as its public
`score`. When reranking is degraded or disabled, the public `score` is QMD's
position score, `1 / qmdRrfRank`. In an explanation for that state,
`qmdPositionWeight` is `1`, `remoteRerankScore` is null, and `finalScore` equals
the public position score. Both score modes occupy `[0,1]`; the pipeline state
identifies which meaning applies.

A degraded result is successful only when local retrieval produced usable
results. Warnings, stage states, reasons, retries, timing, and cost metadata are
mandatory.

Required-remote mode fails when either remote stage does not return a valid
result from an eligible cache entry or provider request. Local retrieval
failure is always a local-retrieval failure, never remote degradation.

## CLI compatibility perimeter

The core command is:

```text
qmdx query <query>
```

QMDX v1 supports these QMD 2.8.3 query options:

| Option | QMDX behavior |
| --- | --- |
| `-n`, `--limit` | Final result count from 1 through 80 |
| `--min-score` | Filter the active pipeline's public `[0,1]` score: blended score after successful reranking, or `1 / qmdRrfRank` when reranking is degraded or disabled |
| `--full` | Include complete result body |
| `-c`, `--collection` | Preserve QMD collection filtering |
| `--intent` | Guide QMD chunk selection and remote reranking; never expansion |
| `--format` | Preserve supported human formats and add normative JSON envelopes |
| `--full-path` | Preserve QMD path presentation |
| `--line-numbers` | Preserve QMD line presentation |
| `--explain` | Add per-result retrieval and reranking provenance |
| Typed query documents | Preserve QMD 2.8.3 parsing and explicit retrieval routes |

QMDX additions:

| Option | Behavior |
| --- | --- |
| `--profile <name>` | Select a configured route profile |
| `--require-remote` | Fail unless both remote stages succeed |
| `--no-expand` | Diagnostic/benchmark mode using only explicit/original routes |
| `--no-rerank` | Diagnostic/benchmark mode returning QMD fused order |

`--no-expand` and `--no-rerank` runs are not production acceptance candidates.

QMDX v1 rejects `--all`, `--candidate-limit`, and every other QMD query option
not listed above. It must report an invocation error rather than silently ignore
or reinterpret an unsupported option.

Typed query documents retain their explicit routes. Their original plain query
is the only expansion input. A document without an original plain query is
valid only with `--no-expand`. Route count and generated-query limits still
apply.

## Machine-readable contract

### Streams and exits

| Exit | Meaning |
| ---: | --- |
| 0 | Completed, including zero results and normal degraded results |
| 2 | Invalid invocation or configuration |
| 3 | Local index or retrieval failure |
| 4 | Required remote inference failure |
| 5 | Unexpected internal failure |

With `--format json`:

- exit 0 writes one result envelope to stdout and leaves stderr empty;
- exits 2-5 write one error envelope to stderr and leave stdout empty.

Human output may use stderr for warnings. JSON warnings stay in the envelope.

### Result envelope

```json
{
  "schemaVersion": 1,
  "query": {
    "original": "search text",
    "intent": null,
    "collections": []
  },
  "pipeline": {
    "status": "ok",
    "expansion": {
      "status": "expanded",
      "reason": null,
      "generatedQueries": []
    },
    "retrieval": {
      "status": "ok",
      "reason": null,
      "candidateCount": 0,
      "engine": "qmd"
    },
    "reranking": {
      "status": "ok",
      "reason": null,
      "candidateCount": 0
    }
  },
  "results": [],
  "warnings": [],
  "timingMs": {
    "total": 0,
    "expansion": 0,
    "retrieval": 0,
    "reranking": 0,
    "overhead": 0
  }
}
```

Required pipeline values:

- overall: `ok`, `degraded`
- expansion: `expanded`, `original_sufficient`, `degraded`, `disabled`
- retrieval: `ok`
- reranking: `ok`, `degraded`, `disabled`

Each result contains these stable fields:

```json
{
  "rank": 1,
  "docid": "#a19c42",
  "score": 0.5975,
  "file": "qmd://notes/projects/qmdx.md",
  "title": "QMDX planning notes",
  "context": "Project decisions",
  "line": 37,
  "snippet": "matching text"
}
```

`context`, `line`, and `snippet` are nullable. `--full` adds `body`.
`--explain` adds:

```json
{
  "explanation": {
    "qmdRrfRank": 2,
    "qmdPositionWeight": 0.75,
    "remoteRerankScore": 0.89,
    "finalScore": 0.5975
  }
}
```

When reranking is degraded or disabled, the same explanation shape is:

```json
{
  "explanation": {
    "qmdRrfRank": 2,
    "qmdPositionWeight": 1,
    "remoteRerankScore": null,
    "finalScore": 0.5
  }
}
```

Warnings have:

```json
{
  "stage": "reranking",
  "code": "invalid_provider_response",
  "message": "Kept QMD fused order.",
  "retryable": true
}
```

Closed warning stages are `expansion` and `reranking`.

Closed stage reason/warning codes are:

- `transport_error`
- `timeout`
- `rate_limited`
- `provider_unavailable`
- `authentication_failed`
- `billing_or_quota_exhausted`
- `provider_policy_rejected`
- `unsupported_capability`
- `invalid_provider_response`
- `payload_limit_exceeded`
- `cost_budget_exceeded`
- `stage_budget_exceeded`
- `global_deadline_exceeded`

### Error envelope

```json
{
  "schemaVersion": 1,
  "error": {
    "category": "configuration",
    "code": "privacy_approval_required",
    "message": "Profile default requires current privacy approval.",
    "stage": null,
    "retryable": false
  },
  "warnings": [],
  "timingMs": {
    "total": 0
  }
}
```

Closed error categories are:

- `invocation`
- `configuration`
- `local_retrieval`
- `required_remote`
- `internal`

Closed error codes are:

- `invalid_invocation`
- `unsupported_option`
- `invalid_profile`
- `missing_credentials`
- `preflight_required`
- `privacy_approval_required`
- `local_index_unavailable`
- `local_index_incomplete`
- `vector_probe_failed`
- `required_remote_failed`
- `internal_error`

`stage` is `expansion`, `retrieval`, `reranking`, or null.

Version 1 fields may gain optional members in minor releases. Removing a field,
changing a field's meaning or type, adding a required field, or changing a
closed enum requires a new schema version and a QMDX major release.

## Acceptance

Freeze one production candidate before revealing relevance judgments:
providers, endpoints, models, prompts, schemas, candidate depth, score formula,
retry policy, and every outcome-affecting parameter.

Compare it with the usable QMD baseline using the same corpus snapshot, QMD
version, CPU embedding, local lexical/vector retrieval, fusion, candidate
depth, and final limit. The baseline uses only the original query and no
expansion or reranking.

### Relevance gate

- Primary metric: canonical-document nDCG@10
- Grade gains: 0, 1, 3, 7
- Average query deltas within each frozen topic family
- Equally weight the 16 topic families
- Require family-weighted mean improvement of at least +0.05
- Require a majority of topic families to improve
- Reject if more than 20% of eligible headline queries lose over 0.10
- Reject if a query whose baseline top 3 contains a grade-2/3 document has no
  grade-2/3 QMDX document in its top 10

Benchmark v1's 16 families are already frozen by its governance decision: one
two-query graph-engineering family, one four-query Claude Code family, and 14
singleton families. The benchmark manifest must reproduce those assignments
exactly; it does not determine a new family count at execution time.

Report Recall@10, MRR to the first grade-2/3 result, Success@3, robustness and
diagnostic slices, and a 95% topic-family bootstrap interval diagnostically.
They do not override the primary gate.

### Operational gates

All measurements use the named target workstation and record its hardware, OS,
power mode, QMD/QMDX versions, corpus/index hashes, provider region, and network
connection.

Latency:

- three uncached runs per headline query in randomized order;
- repeat the protocol in two time windows;
- median at most 8 seconds;
- p95 at most 15 seconds;
- every successful request at most 30 seconds.

Reliability:

- 200 uncached requests across headline queries and time windows;
- at least 99% complete successfully;
- no malformed or partial provider response is accepted;
- injected failures produce the declared degradation or explicit failure.

Cost:

- mean at most US$0.01;
- p95 at most US$0.02;
- every successful query at most US$0.05;
- include retry usage;
- do not use cache hits to pass.

Privacy:

- current provider terms and endpoint permit the workload;
- retention and training behavior are disclosed and approved;
- transport is encrypted;
- expansion sends only the original query;
- reranking sends only selected chunks and correlation identity;
- credentials, machine-local roots, unrelated document content, and hidden
  traces do not appear in requests or default diagnostics.

### Outcomes

- **Accept**: relevance and every operational/privacy gate pass.
- **Reject**: any hard gate fails, severe regression triggers, or aggregate
  relevance is zero or negative.
- **Inconclusive**: evidence is complete and positive but misses the relevance
  magnitude or majority-family rule, or required evidence cannot be completed
  for a reason that does not itself violate a gate.

An inconclusive candidate is not an improvement and must not be described as
one. Tuning after judgments are revealed requires a new benchmark version.

## Source decisions

- [Use remote expansion and reranking](../adr/0001-use-remote-expansion-and-reranking.md)
- [Use Qwen3 embedding as the multilingual default](../adr/0002-use-qwen3-embedding-as-multilingual-default.md)
- [Preserve QMD structured-search fusion semantics](../adr/0003-preserve-qmd-structured-search-fusion.md)
- [Use QMD-selected chunks for remote reranking](../adr/0004-use-qmd-selected-chunks-for-remote-reranking.md)
- [Preserve QMD query compatibility behind a QMDX contract](../adr/0005-preserve-qmd-query-compatibility.md)
- [Use guardrailed relevance acceptance](../adr/0006-use-guardrailed-relevance-acceptance.md)
- [Distribute a Node CLI with an embedded QMD SDK](../adr/0007-distribute-a-node-cli-with-an-embedded-qmd-sdk.md)
- [Freeze the minimal QMDX v1 public contract](../adr/0008-freeze-the-minimal-qmdx-v1-public-contract.md)
