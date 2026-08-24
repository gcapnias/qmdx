# QMD SDK-Visible Index Compatibility Checks

> Research for **Verify SDK-visible QMD index compatibility checks**  
> Source: `tobi/qmd` commit `dbfd0b4736aeaf761d1a16ca8e424f071df8feb9` (v2.8.3)  
> Researched: 2026-08-24

## Conclusions

- QMDX can preflight an index through the public `QMDStore.getStatus()` and
  `QMDStore.getIndexHealth()` methods without invoking the QMD CLI or reading SQLite.
- Those methods use the store's configured embedding model. Although their public wrappers
  pass no model argument, the bound internal methods fall back to
  `store.llm.embedModelName`, which `createStore()` initializes from `config.models.embed`.
- `needsEmbedding` is model- and embedding-fingerprint-aware. It counts active documents
  without a complete embedding set for the configured model and current chunking fingerprint.
- The public SDK does not expose the existing vector table's dimensions, the model that
  produced it, or the database schema version. It therefore cannot prove full schema or
  vector-dimension compatibility before retrieval.
- QMDX should fail preflight when the store cannot open, no active documents exist, the
  vector index is absent, or more than 10% of active documents need embedding for the
  configured model. It should warn and continue at 10% or less partial coverage.
- `hasVectorIndex` alone can falsely pass when the `vectors_vec` schema remains but sqlite-vec
  did not load. QMDX setup/doctor must therefore run a non-remote vector probe and fail if it
  throws or cannot retrieve from an otherwise complete, non-empty index.

## Public preflight surface

QMD v2.8.3 exports `QMDStore`, `IndexStatus`, and `IndexHealthInfo` from its package entry
point. The relevant methods are:

```typescript
interface QMDStore {
  getStatus(): Promise<IndexStatus>;
  getIndexHealth(): Promise<IndexHealthInfo>;
}

type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};

type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};
```

`createStore()` attaches a per-store `LlamaCpp` instance configured with
`config.models.embed`. The public health wrappers call the bound internal health methods,
whose default model is `store.llm.embedModelName` before falling back to QMD's built-in
default. Consequently, a QMDX store opened with its Qwen3 embedding configuration receives
Qwen3-specific `needsEmbedding` counts from the public methods.

Sources:

- [`src/index.ts`, public store interface and health wrappers](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts#L228-L317)
- [`src/index.ts`, configured LLM attachment and wrappers](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts#L361-L391)
- [`src/index.ts`, public health delegation](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts#L544-L547)
- [`src/store.ts`, bound model-aware health methods](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L2235-L2244)

## What each signal proves

| Signal | Meaning | Limit |
| --- | --- | --- |
| `totalDocuments` / `totalDocs` | Count of active indexed documents | Does not prove that collection files are current |
| `needsEmbedding` | Active documents missing complete embeddings for the configured model and current embedding fingerprint | Does not identify the model or dimensions of stale vectors |
| `hasVectorIndex` | The `vectors_vec` table exists | Does not prove its dimensions match the configured model |
| `collections` | Indexed collection counts and last document update | Does not validate every configured collection path |
| `daysStale` | Age of the most recently modified active document | Is not the age of the last index or embedding run |

The embedding fingerprint includes the model identifier plus query/document formatting and
chunking parameters. `getHashesNeedingEmbedding()` joins active documents only to complete
vector rows matching that model and fingerprint. This makes `needsEmbedding` the public
SDK's strongest model-compatibility signal.

Sources:

- [`src/store.ts`, status and health types](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L2501-L2546)
- [`src/store.ts`, model/fingerprint-aware missing-embedding count](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L2520-L2539)
- [`src/store.ts`, status implementation](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5167-L5210)

## What the public SDK cannot establish

QMDX cannot inspect these facts before retrieval through the high-level public health API:

- the `PRAGMA user_version` value or whether a database was last written by a newer QMD;
- the dimensions declared by the existing `vectors_vec` table;
- the model identifier associated with existing vector rows;
- whether a present vector table can accept embeddings from the configured model.

QMD detects a vector-dimension mismatch when it ensures the vector table for an embedding
operation, but no non-mutating public health method exposes that check. `createStore()` applies
additive migrations and skips its FTS migration whenever the stored schema version is already
at least the SDK's version. A successfully opened store therefore provides no affirmative
schema-version compatibility proof.

The vector table can also remain visible in `sqlite_master` when sqlite-vec is unavailable in
the current process. QMD's own cleanup path documents that touching such a table can throw
`no such module: vec0`. This means `hasVectorIndex === true` is not sufficient to prove that
vector retrieval is executable.

Sources:

- [`src/store.ts`, vector-table dimension validation](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L1460-L1485)
- [`src/store.ts`, schema-version migration gate](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L956-L968)
- [`src/store.ts`, persisted vector table with unavailable sqlite-vec](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L2742-L2760)

## Failure and warning policy

QMDX's local retrieval contract requires QMD's lexical and vector retrieval. Remote-stage
degradation may return a usable local baseline, but a missing or wholly incompatible local
vector index is a local-retrieval failure rather than remote degradation.

| Preflight result | QMDX behavior |
| --- | --- |
| `createStore()` throws | Fail with a local-index compatibility error preserving the QMD cause |
| `totalDocuments === 0` | Fail: there is no usable local corpus |
| `hasVectorIndex === false` | Fail: the required vector retrieval path is unavailable |
| `needsEmbedding / totalDocuments > 0.10` | Fail: configured-model vector coverage is too incomplete for the required hybrid retrieval contract |
| `0 < needsEmbedding / totalDocuments <= 0.10` | Warn with the affected count and percentage, then continue with explicitly partial vector coverage |
| `needsEmbedding === 0` and `hasVectorIndex === true` | Pass the health-value portion of preflight; setup/doctor must still pass the vector probe |
| Setup/doctor vector probe throws or returns no result from an otherwise complete, non-empty index | Fail with a local vector-runtime compatibility error |

The warning and failure text should direct the user to QMD's authoritative embedding workflow,
normally `qmd embed -f` after adopting or changing QMDX's required embedding profile. QMDX must
not repair or mutate the index itself.

QMDX must always open the store with `config.models.embed` set to the effective QMDX embedding
profile. DB-only mode or an omitted model would make the SDK fall back to QMD's built-in default
and invalidate the model-specific preflight.

The setup/doctor probe should call the public `searchVector()` method with a fixed local probe
query and `limit: 1`, discard the result content, and send nothing remotely. It validates model
loading, sqlite-vec availability, vector dimensions, and executable vector retrieval. Normal
searches rely on the last successful setup/doctor result but still classify any later vector
failure as a local-retrieval failure.

`daysStale` should be exposed diagnostically but should not independently trigger a compatibility
warning: it measures document modification age, not index currency.

## Residual risk and upgrade guard

Passing this preflight means only that the pinned SDK can open the store, reports acceptable
configured-model coverage, and completed the setup/doctor vector probe. It does not prove
forward schema compatibility.

Legacy same-model embeddings with an empty fingerprint can be reported as wholly stale even
though QMD has an internal fingerprint-adoption path. QMDX deliberately keeps the conservative
failure because that adoption mechanism is not exposed through the high-level public SDK.
QMD also documents repair scenarios where metadata rows and vector-table rows can become
desynchronized; the required vector probe is the guard against falsely accepting such an index.

The remaining schema risk is bounded by QMDX's exact QMD pin and the existing requirement that
QMD SDK upgrades pass compatibility and representative-index regression tests before release.

No additional product decision is required. The advanced `store.internal` property is not needed
for v2.8.3 preflight because the high-level public methods already inherit the configured model.

## Primary sources

- [`@tobilu/qmd` v2.8.3 package metadata](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/package.json)
- [`src/index.ts`](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts)
- [`src/store.ts`](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts)
- [Use remote expansion and reranking](../adr/0001-use-remote-expansion-and-reranking.md)
- [Use Qwen3 embedding as the multilingual default](../adr/0002-use-qwen3-embedding-as-multilingual-default.md)
- [Distribute a Node CLI with an embedded QMD SDK](../adr/0007-distribute-a-node-cli-with-an-embedded-qmd-sdk.md)
