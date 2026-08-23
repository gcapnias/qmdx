# QMDX

QMDX is a search companion for QMD that adds remote inference to QMD-backed search while preserving QMD as the indexing and local retrieval system.

## Language

**QMDX**:
A companion or extension that adds remote query expansion and reranking to searches over QMD-managed indexes.
_Avoid_: QMD replacement, QMD fork

**Relevance benchmark**:
A versioned set of real queries, graded document judgments, and ranking measures used to compare search pipelines on the second-brain corpus.
_Avoid_: Search impressions, example queries

**Benchmark workload**:
The real search behavior a relevance benchmark represents and for which its conclusions are valid.
_Avoid_: Universal search quality

**Headline query**:
A real information need included in the benchmark's primary aggregate comparison. Its corpus answerability is established independently of candidate pipelines.
_Avoid_: Test prompt

**Query provenance**:
Evidence that benchmark wording comes from genuine search behavior rather than being reconstructed from a known document or desired result.
_Avoid_: Query description

**Corpus answerability**:
The independently established presence of at least one useful document for a query in the indexed corpus.
_Avoid_: Candidate success

**Robustness slice**:
Paraphrases and overlapping formulations reported separately from headline queries so one information need cannot dominate aggregate relevance.
_Avoid_: Duplicate queries

**Diagnostic slice**:
Queries kept outside the headline aggregate to investigate behavior such as genuine no-answer retrieval.
_Avoid_: Failed benchmark queries

**Relevance judgment**:
A blind, query-specific grade of how well a full document satisfies an information need: irrelevant, related, useful, or direct answer.
_Avoid_: Pipeline score

**Benchmark variant**:
An executable search-pipeline configuration included for comparison without implying that it is the chosen QMDX architecture.
_Avoid_: Final architecture

**Candidate depth**:
The number of locally retrieved documents available to a benchmark variant before reranking, distinct from the number of results presented or judged.
_Avoid_: Result limit, top-k output

**Frozen expansion**:
A validated set of typed lexical, vector, and hypothetical-document queries generated once for a headline query and reused across dependent benchmark variants.
_Avoid_: Live expansion

**Pure reranker order**:
A ranking determined only by a reranker's relevance scores, without incorporating QMD retrieval rank.
_Avoid_: Final QMDX ranking

**Blended order**:
A ranking that combines QMD retrieval rank with reranker relevance scores according to an explicit blending policy.
_Avoid_: Pure reranker order

**Judgment pool**:
The canonical, deduplicated union of documents retrieved by benchmark variants for blind relevance grading.
_Avoid_: Combined ranking

**Saturation audit**:
A deeper retrieval check used to determine whether the primary judgment pool omitted useful documents.
_Avoid_: Second benchmark

**Operational gate**:
A latency, cost, or privacy constraint that a relevant search pipeline must also satisfy to remain a viable QMDX choice.
_Avoid_: Relevance metric

**Remote inference**:
Hosted model execution used by QMDX for query expansion or reranking.
_Avoid_: Cloud search
