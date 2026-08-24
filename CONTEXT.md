# QMDX

QMDX is a search companion for QMD that adds remote inference to QMD-backed search while preserving QMD as the indexing and local retrieval system.

## Language

**QMDX**:
A companion or extension that adds remote query expansion and reranking to searches over QMD-managed indexes.
_Avoid_: QMD replacement, QMD fork

**Compatible core interface**:
The QMDX search interface that preserves QMD query syntax, option meanings, and result identity wherever remote inference does not require a deliberate difference.
_Avoid_: Drop-in replacement, Independent CLI

**Agent result envelope**:
A versioned machine-readable QMDX search response containing the query, pipeline-stage outcomes, QMD-compatible results, structured warnings, and timing.
_Avoid_: Bare result array, Diagnostic stderr

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
A latency, reliability, cost, or privacy constraint that a relevant search pipeline must also satisfy to remain a viable QMDX choice.
_Avoid_: Relevance metric

**Relevance gate**:
The primary acceptance test that requires an acceptance candidate to improve ranking quality over the usable QMD baseline without severe relevance regression.
_Avoid_: Operational gate, Diagnostic metric

**Severe relevance regression**:
A query-level loss that makes an acceptance candidate unsafe to approve despite an aggregate relevance gain, either by affecting too much of the benchmark workload or by losing an otherwise prominent useful result.
_Avoid_: Any negative query delta, Average relevance loss

**Usable QMD baseline**:
The workstation-eligible QMD comparison path that uses the original query, local lexical and vector retrieval, and QMD fusion without local query expansion or local reranking.
_Avoid_: Untouched stock QMD, QMDX without remote providers

**Acceptance candidate**:
One fully frozen production QMDX pipeline evaluated against the usable QMD baseline without tuning after relevance judgments are revealed.
_Avoid_: Benchmark variant, Mutable candidate

**Guardrailed relevance win**:
An acceptance result in which QMDX demonstrates a practically meaningful relevance improvement while independently satisfying every operational gate.
_Avoid_: Weighted score, Relevance-at-any-cost

**Acceptance outcome**:
The final classification of an acceptance candidate as accepted, rejected, or inconclusive under the frozen comparison rules. An inconclusive candidate is not an improvement.
_Avoid_: Benchmark score

**Remote inference**:
Hosted model execution used by QMDX for query expansion or reranking.
_Avoid_: Cloud search

**Remote route**:
The independently configured provider, endpoint, model, and credential reference used by one remote-inference stage. Expansion and reranking have separate routes, though both routes may use the same provider and credential.
_Avoid_: Shared provider requirement, Search pipeline

**Route profile**:
A named local configuration that selects the expansion and reranking remote routes and their non-secret operational settings. Command-line, environment, profile, and built-in values resolve in that precedence order.
_Avoid_: Credential store, Provider account

**Credential reference**:
A non-secret identifier in a route profile that QMDX resolves to a credential at invocation time. The initial reference mechanism names an environment variable; literal credentials are excluded from profiles, ordinary command-line values, logs, traces, and result envelopes.
_Avoid_: Stored credential, API-key flag

**Route preflight**:
The combination of static profile validation, an explicit authenticated live capability check with a short-lived non-secret result, and request-specific local admission checks. It establishes route eligibility without adding a separate remote probe to every search.
_Avoid_: Billable per-search probe, Best-effort request

**Privacy declaration**:
A versioned description of a route profile's endpoint and region, stage-specific transmitted data, retention and training terms, and reviewed policy sources. Interactive approval is required before first use; material route or policy changes invalidate approval, and non-interactive use fails closed without a current approval.
_Avoid_: Global consent, Documentation-only disclosure

**Query cost budget**:
The hard upper bound on estimated billable remote inference for one search, enforced before every attempt using a conservative reviewed rate card. Period budgets derived from a local usage ledger are advisory because they cannot observe all provider activity.
_Avoid_: Provider account budget, Retrospective cost report

**Stage budget**:
The cumulative time available to one remote-inference stage, including its attempts and backoff, within the search's hard end-to-end deadline.
_Avoid_: Per-attempt timeout, Latency target

**Required-remote search**:
A search mode in which both expansion and reranking must produce a valid result, from an eligible cache entry or a successful provider request, rather than returning a degraded search.
_Avoid_: Default search, Provider failover

**Sensitive diagnostic capture**:
An explicit, warned diagnostic artifact that may contain remote payload content at a user-selected protected destination. Default logs, traces, explanations, and result envelopes remain metadata-only.
_Avoid_: Default logging, Search explanation

**Dedicated remote reranker**:
A hosted multilingual ranking service that evaluates a batch of documents against one reranking query and returns one request-local relevance score per document. QMDX integrates it through a provider-neutral adapter and does not treat general-purpose listwise generation as an equivalent core reranking contract.
_Avoid_: General LLM ranking, Calibrated relevance probability

**Reranking query**:
The original query together with optional user-supplied search intent sent to the dedicated remote reranker. Generated queries are retrieval routes and are excluded from this input.
_Avoid_: Expansion query bundle, Inferred user profile

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

**Degraded search**:
A completed search in which a remote stage failed but QMDX returned usable QMD-derived results and exposed the failure as a structured warning.
_Avoid_: Successful remote pipeline, Silent fallback, Failed search

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

**Reranking candidate**:
One unique document from the QMD candidate pool submitted for remote relevance scoring while retaining its QMD retrieval identity and rank.
_Avoid_: Retrieval route, Canonical document

**Selected chunk**:
The query- and intent-sensitive excerpt that QMD chooses from a candidate body and returns even when local reranking is disabled.
_Avoid_: Complete document, Provider-generated summary

**Production reranking payload**:
The exact non-empty selected chunk sent as a reranking candidate's relevance text. The candidate's title, virtual path, context, complete body, and retrieval explanation remain local.
_Avoid_: Full-document payload, Benchmark reranking payload

**Benchmark reranking payload**:
An experimental title, virtual-path, and complete-body representation used to compare reranker behavior, distinct from the production reranking payload.
_Avoid_: Production reranking payload

**Reranking request**:
The single remote comparison set containing every reranking candidate as a distinct entry, including candidates whose selected chunks are identical.
_Avoid_: Independently scored batches, Deduplicated chunk set

**Provider route admission**:
The determination that a remote route can accept the complete reranking request and return one score per candidate without QMDX splitting or truncating it.
_Avoid_: Per-document size check, Runtime best effort

**QMD position-aware reranking formula**:
The final-score equation borrowed from QMD v2.8.3 and applied to a provider-native remote relevance score: retrieval contributes 0.75 at RRF ranks 1-3, 0.60 at ranks 4-10, and 0.40 thereafter. Sharing the equation does not make remote scores semantically equivalent to QMD's local reranker scores.
_Avoid_: Exact QMD reranking equivalence, Pure reranker order

**Remote relevance score**:
A finite provider-produced value in the inclusive range `[0,1]` that compares every reranking candidate within one logical request. It is request-local, is not batch-normalized by QMDX, and is not comparable across unrelated searches.
_Avoid_: Cross-query probability, Rank-derived score

**Valid reranking response**:
An all-or-nothing response that identifies every submitted candidate exactly once with a valid remote relevance score and contains no missing, duplicate, or unknown candidate identities.
_Avoid_: Partial ranking, Default-filled response

**Reranking request identity**:
The identity that maps one submitted reranking candidate to one returned remote relevance score while preserving the candidate's QMD file identity.
_Avoid_: Chunk-text identity, Abbreviated document ID

**Reranking trace**:
The retained provenance connecting a provider request, each QMD candidate and selected chunk, its remote relevance score, and the components of its final rank.
_Avoid_: User-facing explanation schema

**Search explanation**:
The user-facing account of a QMDX search outcome: a pipeline summary by default and, when explicitly requested, per-result retrieval and reranking details.
_Avoid_: Reranking trace, Provider rationale, Always-on diagnostics

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
