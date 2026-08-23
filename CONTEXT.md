# QMDX

QMDX is a search companion for QMD that adds remote inference to QMD-backed search while preserving QMD as the indexing and local retrieval system.

## Language

**QMDX**:
A companion or extension that adds remote query expansion and reranking to searches over QMD-managed indexes.
_Avoid_: QMD replacement, QMD fork

**Relevance benchmark**:
A versioned set of real queries, graded document judgments, and ranking measures used to compare search pipelines on the second-brain corpus.
_Avoid_: Search impressions, example queries

**Benchmark manifest**:
The content-addressed freeze of the corpus snapshot, query provenance, slice and topic assignments, answerability anchors, canonicalization rules, judgment rubric, variant definitions, and randomization seed. Outcome-affecting changes after execution begins require a new benchmark version.
_Avoid_: Mutable benchmark configuration

**Benchmark workload**:
The real search behavior a relevance benchmark represents and for which its conclusions are valid.
_Avoid_: Universal search quality

**Headline query**:
A real information need included in the benchmark's primary aggregate comparison. Its corpus answerability is established independently of candidate pipelines.
_Avoid_: Test prompt

**Intent statement**:
A short pre-pool explanation shown with the original query during judgment that records the sought outcome, relevant context, and satisfaction criteria without naming an answerability anchor or expected document.
_Avoid_: Rewritten query

**Query provenance**:
Evidence that benchmark wording comes from genuine search behavior rather than being reconstructed from a known document or desired result.
_Avoid_: Query description

**Provenance ledger**:
A benchmark record completed before the manifest freeze that preserves each query's original wording, approximate date and context, and either contemporaneous evidence or an owner attestation that it reflects genuine search behavior.
_Avoid_: Relevant-document rationale

**Corpus answerability**:
The independently established presence of at least one useful document for a query in the indexed corpus.
_Avoid_: Candidate success

**Answerability anchor**:
A canonical document frozen before candidate pooling as evidence that a headline query has a useful answer in the corpus, withheld from tuning until all candidate runs are frozen, then injected into the blind judgment package whether or not a pipeline retrieved it.
_Avoid_: Expected top result, Gold ranking

**Robustness slice**:
Paraphrases and overlapping formulations reported separately from headline queries so one information need cannot dominate aggregate relevance.
_Avoid_: Duplicate queries

**Topic family**:
A single pre-run grouping assigned to each headline query from its wording and provenance alone, used for cluster-aware reporting without consulting retrieved documents, grades, or pipeline behavior.
_Avoid_: Result cluster

**Diagnostic slice**:
Queries kept outside the headline aggregate to investigate behavior such as genuine no-answer retrieval.
_Avoid_: Failed benchmark queries

**Slice assignment**:
A query's frozen benchmark-v1 classification as headline, robustness, or diagnostic; findings are reported in place and can change classification only in a new benchmark version.
_Avoid_: Post-result filtering

**Eligibility failure**:
A disclosed violation of a pre-registered headline condition discovered after the manifest freeze, such as unsupported provenance or no pooled canonical document reaching grade 2 after an anchor mismatch. The query keeps its original slice assignment, is excluded from the primary aggregate, and remains visible diagnostically until a new benchmark version.
_Avoid_: Post-result relabeling

**Relevance judgment**:
A blind, query-specific full-document grade: 0 is irrelevant, unusable, or misleading; 1 is topically related without materially answering; 2 materially helps but is incomplete, indirect, or requires synthesis; 3 directly satisfies the central information need with sufficient specific substance. A document answering only one part of a multi-part query scores at most 2.
_Avoid_: Pipeline score

**Authoritative judge**:
The second-brain owner whose understanding of the original information need determines the final relevance grade; reviewers may flag ambiguity, but the owner adjudicates it against the frozen rubric.
_Avoid_: Majority voter

**Rubric reviewer**:
An independent reviewer who sees the same blind package without retrieval provenance and informs but does not replace the authoritative judge. Calibration requires a human reviewer; a privacy-approved local review process may instead be used for the concealed consistency sample.
_Avoid_: Co-owner of relevance

**Judgment calibration**:
A two-stage blind exercise used to resolve category-boundary disagreements and freeze the 0-3 rubric before bulk grading; calibration pairs are regraded after the rubric is frozen.
_Avoid_: Production grading

**Judgment adjudication**:
The authoritative judge's blind resolution of repeated, reviewer-flagged, or answerability-conflicting grades under the frozen rubric, preserving the original grade and a reason for any change.
_Avoid_: Second vote

**Blind judgment package**:
An opaque, randomized presentation of a canonical document's searchable title, normalized collection-relative virtual path, and complete normalized Markdown body that hides machine-specific paths, retrieval provenance, alias count, anchor status, and repeat status until adjudication is frozen.
_Avoid_: Anonymous document

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

**Canonical document**:
The judgment identity shared by files with identical normalized Markdown content or, after review blind to pipeline identity, near-duplicate versions whose differences cannot change relevance for any frozen query. The most complete source-faithful version is the blind display representative; original paths, hashes, and merge rationale remain available for audit. Near-duplicate review is separated from the authoritative judge where feasible, and any owner pre-exposure is disclosed.
_Avoid_: Topic cluster

**Canonical ranking**:
A pipeline ranking in which document aliases are collapsed to their best rank and lower results backfill the list to the required number of unique canonical documents.
_Avoid_: Deduplicated pool only

**Saturation audit**:
A pre-registered blind check for useful documents omitted by the top-10 judgment pool. A seeded round-robin samples up to 20 unseen canonical documents per query across co-primary ranking views from rank 11 through each view's available depth, capped at 50. A grade 2 or 3 triggers at most 50 additional documents for that query, allocated round-robin across triggered queries within the global grading budget; residual unjudged documents remain explicit.
_Avoid_: Second benchmark

**Grading budget**:
The hard benchmark-v1 limit of 1,500 authoritative-judge presentations across calibration, primary grading, concealed repeats, adjudication, and saturation. It reserves 90 presentations for calibration, 400 for the initial saturation sample, and 150 for required adjudication before optional saturation escalation; projected primary work and its 20% repeats must fit the remainder. Excess projected work triggers deterministic trimming of the remote-factorial cell with the greatest marginal unique-pair burden, with frozen-seed tie-breaking. If required adjudication exhausts its reserve, the benchmark stops incomplete.
_Avoid_: Unbounded judgment pool

**Operational gate**:
A latency, cost, or privacy constraint that a relevant search pipeline must also satisfy to remain a viable QMDX choice.
_Avoid_: Relevance metric

**Remote inference**:
Hosted model execution used by QMDX for query expansion or reranking.
_Avoid_: Cloud search

**Original query**:
The exact search text supplied by the user, distinct from any generated query. It supplies the original lexical and vector retrieval routes.
_Avoid_: Generated query, Rewritten query

**Search intent**:
An optional user-supplied clarification of the desired search outcome. It guides chunk selection and reranking but is excluded from remote query expansion, and is distinct from the benchmark's intent statement.
_Avoid_: Search history, Inferred user profile

**Expansion input**:
The original query sent to remote query expansion. It excludes search intent, corpus content, retrieved documents, paths, and search history.
_Avoid_: Expansion context

**Cross-language lexical variant**:
A generated lexical query expressed in a different language from the original query to recover documents across a language boundary.
_Avoid_: Mandatory bilingual expansion

**Generated query**:
A provider-produced typed query that adds a retrieval route alongside the routes derived from the original query.
_Avoid_: Original query, Unbounded expansion

**Retrieval route**:
A typed query directed to lexical or vector retrieval that contributes one ranked result list to QMD's fusion.
_Avoid_: Final ranking, Search pipeline

**Expansion provenance**:
Machine-readable metadata attached to a generated query: its language and its purpose as terminology, translation, semantic rewriting, or hypothetical-document retrieval.
_Avoid_: Free-form model rationale

**Degraded expansion**:
A search state in which remote expansion did not produce usable generated queries and retrieval continues with the original lexical and vector routes while exposing a stable failure reason.
_Avoid_: Successful expansion, Silent fallback

**Original-sufficient expansion**:
A successful remote-expansion outcome declaring that no generated query would usefully improve the original lexical and vector routes.
_Avoid_: Degraded expansion, Empty invalid response

**Partial expansion**:
A successful expansion for which QMDX retains the valid generated queries and reports other generated entries discarded by local validation.
_Avoid_: Degraded expansion

**Adaptive query mix**:
The selection of generated query types according to the original query's shape. Exact-identifier queries favor lexical variants, while descriptive or conceptual queries may add semantic and hypothetical-document queries.
_Avoid_: Fixed query template

**Target workstation**:
The workstation on which QMD and QMDX must deliver acceptable interactive search behavior.
_Avoid_: Development machine, Benchmark machine

**Local retrieval**:
QMD-managed BM25 and vector candidate retrieval against an existing local index, including the query embedding needed for vector search.
_Avoid_: Local inference

**QMDX search pipeline**:
The ordered search flow in which remote query expansion produces typed queries, QMD performs local retrieval and reciprocal-rank fusion, remote reranking evaluates the fused candidate pool, and QMDX shapes the final results.
_Avoid_: QMD replacement pipeline

**QMD candidate pool**:
The single reciprocal-rank-fused, locally retrieved set returned by QMD with local reranking disabled and passed by QMDX to remote reranking.
_Avoid_: Final results, Separate query results

**Index lifecycle**:
QMD-owned collection updates, document indexing, embedding generation, and vector rebuilding. QMDX consumes the resulting configured index but does not replace its maintenance workflow.
_Avoid_: QMDX indexing

**Multilingual embedding profile**:
The required local embedding configuration for QMDX-managed indexes that provides the project's multilingual vector-retrieval guarantee. An overridden profile remains usable but falls outside that guarantee and requires a complete vector rebuild.
_Avoid_: Remote embedding, Optional multilingual mode

**Local generation and reranking**:
On-device query expansion or candidate reranking with generative or reranker models.
_Avoid_: Local retrieval

**Workstation-eligible pipeline**:
A search pipeline that meets the target workstation's hardware and interactive-latency constraints.
_Avoid_: Hardware-independent pipeline
