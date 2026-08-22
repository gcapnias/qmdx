# Remote Inference Options for QMDX

> Research for **Compare remote inference options for QMDX**  
> Researched: 2026-08-22  
> Scope: Hosted APIs for English and Greek query expansion and document reranking.

## Conclusions

- Use strict JSON Schema output for query expansion. JSON-object mode only guarantees valid JSON,
  not the required typed-query shape.
- OpenAI-compatible APIs are a practical expansion seam; OpenRouter lowers model and provider
  lock-in but provider capabilities and retention policies still vary.
- Prefer a dedicated reranker for the primary pipeline. Cohere and Jina expose more meaningful
  ranking scores and handle larger candidate sets more reliably than a general LLM.
- The prior recommendation of Cohere `rerank-multilingual-v3.0` is obsolete. Current candidates
  include Cohere `rerank-v4.0-pro` or `rerank-v3.5`.
- LLM listwise reranking is credible for a small candidate set, but its rank-derived scores are
  positional rather than calibrated relevance probabilities.

## QMDX remote-inference seams

QMDX can delegate two stages while retaining QMD's local index:

1. A hosted model generates `lex`, `vec`, and `hyde` typed queries.
2. QMD runs local BM25, vector retrieval, and RRF with local reranking disabled.
3. A hosted reranker receives the candidate query and selected document content.

## Query expansion

### OpenAI direct

`gpt-4o-mini` is a low-cost multilingual option with a 128K input context and strict structured
outputs. A typical expansion request is inexpensive relative to reranking because it sends only
the query, intent, instructions, and a small generated object.

Use strict schema output:

```typescript
response_format: {
  type: "json_schema",
  json_schema: {
    name: "qmdx_expansion",
    strict: true,
    schema: expansionSchema,
  },
}
```

Do not rely solely on:

```typescript
response_format: { type: "json_object" }
```

That mode ensures syntactically valid JSON but does not guarantee a `queries` property or valid
`lex`/`vec`/`hyde` entries.

### OpenRouter

OpenRouter offers an OpenAI-compatible endpoint across many providers and models. QMDX can keep
the expansion interface provider-neutral by making base URL, model slug, and API key configurable.

Important caveats:

- strict structured-output enforcement depends on the selected downstream provider;
- QMDX should request providers that advertise structured-output support;
- retention and training policies remain provider-specific even when routing through OpenRouter;
- model fallback can change behavior unless the user pins a provider or model route.

## Specialized rerank APIs

### Cohere

Current multilingual choices include:

| Model | Notes |
| --- | --- |
| `rerank-v4.0-pro` | Current quality-oriented multilingual model; large context and candidate limits |
| `rerank-v4.0-fast` | Lower-latency v4 option |
| `rerank-v3.5` | Older current multilingual option with a smaller context |
| `rerank-multilingual-v3.0` | Deprecated in March 2025 |

The API accepts a query and document list and returns a relevance score in `[0, 1]` for each
selected result. Scores are useful within one request, but should not be treated as comparable
across unrelated queries.

Published characteristics at research time:

- v4 context up to roughly 32K tokens per document, with automatic chunking;
- up to 10,000 documents per request;
- production rate limits around 1,000 requests per minute;
- pricing around $2.50 per 1,000 searches, subject to document-length billing rules.

Cohere requires a dedicated client or HTTP integration and introduces provider-specific request,
billing, and privacy behavior.

### Jina

`jina-reranker-v3.5` is a multilingual listwise reranker aimed at long documents:

- approximately 131K-token context;
- a single-pass listwise architecture;
- token-based pricing reported around $0.05 per million input tokens;
- plain HTTP API integration;
- scores reflect comparison within the submitted candidate batch.

It is attractive for long Markdown notes because it can avoid aggressive pre-truncation, but its
API and score behavior are still provider-specific.

## General LLM reranking

A general model can receive a compact candidate list and return ordered IDs:

```json
{ "ranked_ids": [2, 0, 4, 1, 3] }
```

Use strict JSON Schema for this response. This approach:

- reuses the expansion provider and credentials;
- handles English and Greek;
- is reasonable for roughly 20 candidates or fewer;
- becomes slower and less stable as the candidate list grows;
- does not produce calibrated relevance probabilities.

A score such as `1 - rank / candidateCount` is only a display-friendly positional value. QMDX
must not label or compare it as though it were a Cohere or Jina relevance score.

## Comparison

| Option | Main use | EN/EL | Structured guarantee | Document context | Score meaning | Lock-in |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI `gpt-4o-mini` | Expansion | Strong | Strict JSON Schema | 128K generation context | N/A | Moderate |
| OpenRouter | Expansion | Model-dependent | Provider-dependent | Model-dependent | N/A | Low |
| Cohere `rerank-v4.0-pro` | Reranking | 100+ languages | API schema | About 32K/doc | Request-local relevance | High |
| Jina `jina-reranker-v3.5` | Reranking | 100+ languages | API schema | About 131K | Batch-relative relevance | High |
| General LLM | Small-set reranking | Adequate | Strict JSON Schema | Model-dependent | Ordered positions | Low |

## Candidate configurations

### One-provider integration

Use an OpenAI-compatible model for expansion and listwise reranking. This minimizes integration
surface but should cap the candidate set and describe scores as ranks, not probabilities.

### Quality-oriented

Use OpenAI or OpenRouter for expansion and Cohere `rerank-v4.0-pro` for reranking. This provides
a dedicated multilingual reranker and request-local relevance scores.

### Long-document and token-cost oriented

Use OpenAI or OpenRouter for expansion and Jina `jina-reranker-v3.5` for reranking. This favors
large notes and token-proportional pricing.

The benchmark must decide among these configurations; published model claims are not a substitute
for measuring the second-brain corpus.

## Audit of the prior chat

Corrections:

1. Cohere `rerank-multilingual-v3.0` is deprecated; do not make it the QMDX default.
2. JSON-object response mode does not enforce the expansion schema; use strict JSON Schema.
3. LLM rank-derived scores are positional only, not calibrated relevance scores.
4. Dedicated-reranker latency claims in the chat are optimistic for every model and batch size.
5. Provider privacy and retention cannot be inferred from API compatibility; QMDX must expose the
   selected provider and data boundary.

The QMD SDK and result types referenced in the chat are verified separately in
[QMD Integration Seams and Search Semantics](./qmd-integration-seams-and-search-semantics.md).

## Primary sources

- `https://developers.openai.com/api/docs/models/gpt-4o-mini`
- `https://developers.openai.com/api/docs/guides/structured-outputs`
- `https://openrouter.ai/docs/api-reference/overview`
- `https://openrouter.ai/docs/features/structured-outputs`
- `https://openrouter.ai/docs/guides/privacy/data-collection`
- `https://docs.cohere.com/v2/docs/rerank`
- `https://docs.cohere.com/docs/reranking-best-practices`
- `https://docs.cohere.com/docs/rate-limits`
- `https://docs.jina.ai/reranker/`
- `https://jina.ai/reranker/`
