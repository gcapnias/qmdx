# QMD Integration Seams and Search Semantics

> Research for **Verify QMD integration seams and search semantics**  
> Source: `tobi/qmd` commit `dbfd0b4736aeaf761d1a16ca8e424f071df8feb9` (v2.8.3)  
> Researched: 2026-08-22

## Conclusions

- `@tobilu/qmd` v2.8.3 is a public npm package.
- The QMD CLI and MCP server consume the same exported SDK; retrieval logic is not reimplemented in either shell.
- Supplying `SearchOptions.queries` bypasses local query expansion.
- Setting `rerank: false` bypasses the local reranker while retaining the RRF candidate pool.
- `explain: true` returns score traces suitable for diagnosing retrieval and reranking.
- QMDX can therefore remain a companion: remote expansion and reranking can wrap QMD's local index and retrieval SDK.

## Public integration surface

The package exports `createStore`, search types, and path helpers through `src/index.ts`.
The CLI in `src/cli/qmd.ts` and MCP server in `src/mcp/server.ts` create a store and delegate
operations to it.

```sh
npm install @tobilu/qmd
```

QMD v2.8.3 requires Node.js 22 or later.

## Typed query behavior

Supplying pre-expanded typed queries routes directly to structured search:

```typescript
const results = await store.search({
  queries: [
    { type: "lex", query: "authentication token JWT" },
    { type: "vec", query: "user session verification and token decoding" },
    {
      type: "hyde",
      query: "The system verifies a JWT signature, issuer, audience, and expiry.",
    },
  ],
  intent: "JWT middleware in Node.js",
});
```

| Query type | Retrieval backend |
| --- | --- |
| `lex` | FTS5/BM25 |
| `vec` | Vector search |
| `hyde` | Vector search |
| Plain `query` | Expansion followed by lexical and vector retrieval |

For a plain query, QMD has a strong-signal shortcut: expansion is skipped when the top initial
BM25 score is at least `0.85` and its gap over the second result is at least `0.15`. Supplying
`SearchOptions.intent` disables that shortcut. In v2.8.3, `ExpandQueryOptions.intent` itself is
deprecated and ignored; intent belongs on `SearchOptions`.

## External reranking seam

```typescript
const candidates = await store.search({
  query: "search term",
  rerank: false,
  candidateLimit: 80,
  limit: 80,
  explain: true,
});
```

With `rerank: false`:

- node-llama-cpp reranking is not invoked;
- candidates remain in RRF order;
- the result score is `1 / rrfRank`;
- `candidateLimit` still controls the candidate pool and defaults to 40.

CLI equivalents are `--no-rerank` and `--candidate-limit`.

## Returned scoring data

`HybridQueryResult` includes the virtual and display paths, title, body, best matching chunk,
chunk position, score, context, document ID, and an optional explanation.

When `explain: true`, the explanation includes:

- lexical and vector scores;
- RRF rank, position score, weight, bonuses, total, and per-list contributions;
- reranker score;
- final blended score.

The position-aware blend in v2.8.3 is:

| RRF rank | Retrieval weight | Reranker weight |
| --- | ---: | ---: |
| 1-3 | 0.75 | 0.25 |
| 4-10 | 0.60 | 0.40 |
| 11+ | 0.40 | 0.60 |

The blend is:

```text
blendedScore = retrievalWeight * (1 / rrfRank)
             + rerankerWeight * rerankScore
```

RRF contributions use `weight / (60 + rank + 1)`. Original-query result lists receive weight
`2.0`; expansion-derived lists receive `1.0`. QMD also applies small top-rank bonuses.

## Paths and compatibility risks

| Resource | Default |
| --- | --- |
| Global config | `~/.config/qmd/index.yml` |
| Global database | `~/.cache/qmd/index.sqlite` |
| Project config | `.qmd/index.yaml` or `.qmd/index.yml` |
| Project database | `.qmd/index.sqlite` |

Environment-specific XDG and QMD overrides are supported by QMD's path helpers. QMDX should use
those helpers instead of hard-coding `./.qmd/index.sqlite`.

Key risks:

1. Changing the embedding model invalidates existing vectors and requires `qmd embed -f`.
2. QMD tracks schema changes through SQLite `PRAGMA user_version`; opening a newer index may run
   migrations.
3. QMD's FTS normalization and schema are implementation details that a companion should not
   manipulate directly.
4. The SDK is public, but QMDX should pin and test supported QMD versions because the exported
   API can evolve.

The v2.8.3 default model URIs use the canonical `hf:` form:

```text
hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf
```

## Audit of the prior chat

Confirmed:

- the public SDK and shared CLI/MCP architecture;
- typed queries bypass local expansion;
- `rerank: false` preserves an RRF candidate pool;
- the default candidate limit of 40;
- the position-aware blending weights;
- public `ExpandedQuery` and `HybridQueryResult` types.

Corrections:

1. Use QMD path helpers or `getDefaultDbPath()` rather than assuming `./.qmd/index.sqlite`.
2. The SDK method behind `qmd vsearch` is `searchVector()`, not `vsearch()`.
3. `ExpandQueryOptions.intent` is deprecated and ignored in v2.8.3. Pass intent to `search()`;
   it affects chunk selection and reranking, not expansion.
4. `explain: true` attaches trace data to results; it is not an expansion-time logging hook.
5. Prefer QMD's canonical `hf:` model URI syntax over `hf://`.

## Primary sources

- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/package.json`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/index.ts`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/cli/qmd.ts`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/mcp/server.ts`
- `https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/llm.ts`
- `https://registry.npmjs.org/@tobilu/qmd/latest`
