# Use remote expansion and reranking

QMDX will preserve QMD's local indexing, BM25/vector retrieval, and query embedding, but it will use remote inference for query expansion and reranking. On the target workstation, QMD 2.8.3 could not allocate the required GPU contexts, while CPU reranking of 40 candidates took about 1 hour 45 minutes for one query; implementing local generation or reranking would therefore optimize for hardware other than the workstation where QMDX must deliver interactive search.

The original pre-implementation benchmark is replaced by post-implementation measurement of the workstation-eligible pipeline against the usable QMD baseline. Moving all retrieval online, requiring different local hardware, and retaining the multi-day local benchmark were rejected because they either abandon QMD's useful local index or fail the deployment constraint.
