# Use guardrailed relevance acceptance

QMDX will accept a frozen production candidate only when it demonstrates a practically meaningful relevance improvement over the usable QMD baseline, avoids severe query-level regressions, and independently passes latency, reliability, cost, and fail-closed privacy gates on the target workstation. The comparison uses the workstation-eligible original-query QMD path rather than untouched stock QMD because local expansion and reranking are not viable deployment alternatives on that hardware.

This guardrailed relevance win replaces both a weighted scorecard, which could trade away privacy or interactive behavior, and a strict statistical-significance requirement, which the frozen 20-query screening benchmark is not powered to satisfy. Borderline positive evidence remains inconclusive rather than being presented as improvement, and tuning after judgments are revealed requires a new benchmark version.
