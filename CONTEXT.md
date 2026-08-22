# QMDX

QMDX is a search companion for QMD that adds remote inference to QMD-backed search while preserving QMD as the indexing and local retrieval system.

## Language

**QMDX**:
A companion or extension that adds remote query expansion and reranking to searches over QMD-managed indexes.
_Avoid_: QMD replacement, QMD fork

**Relevance benchmark**:
A versioned set of real queries, graded document judgments, and ranking measures used to compare search pipelines on the second-brain corpus.
_Avoid_: Search impressions, example queries

**Headline query**:
A real information need included in the benchmark's primary aggregate comparison. A headline query must have at least one useful document in the corpus.
_Avoid_: Test prompt

**Robustness slice**:
Paraphrases and overlapping formulations reported separately from headline queries so one information need cannot dominate aggregate relevance.
_Avoid_: Duplicate queries

**Diagnostic slice**:
Queries kept outside the headline aggregate to investigate behavior such as genuine no-answer retrieval.
_Avoid_: Failed benchmark queries

**Relevance judgment**:
A blind, query-specific grade of how well a full document satisfies an information need: irrelevant, related, useful, or direct answer.
_Avoid_: Pipeline score

**Remote inference**:
Hosted model execution used by QMDX for query expansion or reranking.
_Avoid_: Cloud search
