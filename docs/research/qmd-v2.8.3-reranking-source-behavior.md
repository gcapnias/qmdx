# QMD v2.8.3 Reranking Source Behavior

> Source audit for **Specify QMDX reranking behavior**  
> Source: `tobi/qmd` commit `dbfd0b4736aeaf761d1a16ca8e424f071df8feb9` (v2.8.3)  
> Researched: 2026-08-23

## Conclusions

- QMD applies `candidateLimit` to the RRF-fused pool before reranking and applies the final
  `limit` afterward.
- QMD does not rerank full documents. It chunks each candidate body locally, selects one best
  chunk, and submits only that chunk text to the reranker.
- The reranker receives the search query with optional intent prepended.
- QMD truncates reranker text locally to fit its context budget and processes candidates in
  batches of roughly ten documents.
- QMD blends reranker score with an RRF-position score; it does not use pure reranker order.

## Candidate pool and limits

Both search paths slice the fused result list to `candidateLimit` before chunk selection and
reranking. Final deduplication and `limit` are applied after reranking.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5582-L5588`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5738-L5743`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5972-L5978`

RRF merges candidates by file identity, and the final result list deduplicates by file again.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L4585-L4627`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5738-L5743`

## Reranking query

Hybrid search passes the original query. Structured search derives a primary query from the first
lexical query, otherwise the first vector query, otherwise the first available search query.
The LLM layer prepends optional intent as `intent`, two newlines, then the query.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5677-L5679`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5982-L5986`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L6071-L6073`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/llm.ts#L4533-L4535`

## Candidate content

QMD chunks each candidate's complete body, selects the best chunk using keyword and intent
overlap, and sends only that chunk text to the reranker. The returned result still contains the
complete body.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5590-L5617`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5668-L5679`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5718-L5729`

When local reranking is disabled, both structured and hybrid search still perform this chunk
selection and return meaningful `bestChunk`, `bestChunkPos`, and `context` fields. QMDX can
therefore call the public `createStore().search()` API with `rerank: false` and consume QMD's
selected chunk without invoking the local reranker or copying private selection logic.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5960-L6055`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5582-L5655`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts#L120-L170`

The reranker also deduplicates identical effective chunk text after truncation.

Source:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/llm.ts#L1745-L1759`

## Context limits

QMD reserves 512 tokens plus the query tokens from the rerank context budget. It truncates each
document through a tokenizer round trip before scoring and groups candidates into rerank contexts
of roughly ten documents. If no rerank contexts can be formed, it assigns a fallback score of
`0.5`.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/llm.ts#L1699-L1743`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/llm.ts#L1761-L1779`

## Score combination

QMD's RRF contribution is `weight / (60 + rank + 1)`, with list weights and top-rank bonuses
applied during fusion. After reranking, the final score is:

```text
rrfWeight * (1 / rrfRank) + (1 - rrfWeight) * rerankScore
```

The retrieval weight is `0.75` for ranks 1-3, `0.60` for ranks 4-10, and `0.40` thereafter.
Results are sorted by the blended score without an explicit secondary tie-breaker.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L4585-L4627`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L4632-L4691`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5687-L5716`

## Explanation data

QMD explanation data includes lexical and vector scores and an RRF trace containing rank,
position score, weight, bonuses, total score, and per-list contributions. Reranked results also
include the reranker score and blended score.

Sources:

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L4632-L4691`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5702-L5729`

## Implications for QMDX

- A default candidate depth of 80 follows QMD's real pre-rerank limiting model when QMDX requests
  `candidateLimit: 80`.
- Sending full documents would deliberately diverge from QMD's best-chunk reranking behavior even
  though the public SDK exposes QMD's selected chunk with local reranking disabled.
- Requiring provider-native whole-document chunking would replace QMD's local chunk selection and
  local truncation semantics unnecessarily.
- Pure remote-score ordering would deliberately diverge from QMD's position-aware blend.
