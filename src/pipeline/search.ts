import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import {
  buildResultEnvelope,
  type EnvelopeWarning,
  type GeneratedQueryDocument,
  type ResultEnvelope,
  type SearchResultItem,
} from "../core/envelope.js";
import { internalError } from "../core/errors.js";
import type { ReasonCode } from "../core/enums.js";
import type { EffectiveProfile } from "../config/resolve.js";
import { fetchCandidatePool } from "../qmd/retrieval.js";
import { findProjectIndex } from "../qmd/paths.js";
import { openProjectStore } from "../qmd/store.js";
import {
  DEGRADED_POSITION_WEIGHT,
  qmdPositionScore,
  round6,
} from "./score.js";
import {
  runExpansionStage,
  type ExpansionDeps,
} from "../expand/stage.js";
import type { ExpandTransport } from "../expand/openai.js";
import { localIndexUnavailableError } from "../core/errors.js";

export interface QueryRequest {
  /** Exact user-supplied query text, reflected verbatim in the envelope. */
  originalQuery: string;
  /** Plain-query expansion input; null for typed documents without one. */
  plainQuery: string | null;
  /** Explicit typed retrieval routes from a query document. */
  routes: ExpandedQuery[];
  intent: string | null;
  collections: string[];
  limit: number;
  minScore: number | null;
  full: boolean;
  explain: boolean;
  noExpand: boolean;
  noRerank: boolean;
}

export interface QueryOutcome {
  envelope: ResultEnvelope;
  /** QMD display path per result, aligned with envelope.results indexes. */
  resultPaths: string[];
}

export interface SearchDeps extends ExpansionDeps {
  clock?: Clock;
  /**
   * The admitted effective profile from search-time route admission
   * (`admitRemoteRoutes`). `null` means no profile is configured and the
   * remote stages degrade with the stable unconfigured-route warnings;
   * leaving it undefined is treated the same as null by this module.
   */
  effectiveProfile?: EffectiveProfile | null;
  /** Test seam: replaces QMD local retrieval entirely. */
  fetchPool?: (
    request: QueryRequest,
  ) => Promise<HybridQueryResult[]>;
}

export type { ExpandTransport };

interface StageTimingCollector {
  expansionMs: number;
  retrievalMs: number;
  rerankingMs: number;
}

const UNCONFIGURED_ROUTE_CODE: ReasonCode = "provider_unavailable";

export async function runQuery(
  request: QueryRequest,
  deps: SearchDeps = {},
): Promise<QueryOutcome> {
  const clock = deps.clock ?? systemClock;
  const warnings: EnvelopeWarning[] = [];
  const startedAt = clock.nowMs();
  const timing = { expansionMs: 0, retrievalMs: 0, rerankingMs: 0 };

  const expansion = await expansionStage(request, warnings, timing, clock, deps);
  const retrieval = await retrievalStage(
    request,
    expansion.generatedQueries,
    expansion.usedRemoteRoute,
    warnings,
    timing,
    clock,
    deps,
  );
  const reranking = rerankingStage(retrieval.pool.length, request, warnings);

  const shaped = shapeResults(
    retrieval.pool,
    request,
    reranking.remoteRerankScores,
  );

  const totalMs = clock.nowMs() - startedAt;
  const stageSum = timing.expansionMs + timing.retrievalMs + timing.rerankingMs;

  const envelope = buildResultEnvelope({
    query: {
      original: request.originalQuery,
      intent: request.intent,
      collections: request.collections,
    },
    pipeline: {
      status: overallStatus(expansion.status, reranking.report.status),
      expansion: {
        status: expansion.status,
        reason: expansion.reason,
        generatedQueries: expansion.generatedQueries,
      },
      retrieval: {
        status: "ok",
        reason: null,
        candidateCount: retrieval.pool.length,
        engine: "qmd",
      },
      reranking: {
        status: reranking.report.status,
        reason: reranking.report.reason,
        candidateCount: retrieval.pool.length,
      },
    },
    results: shaped.results,
    warnings,
    timingMs: {
      total: totalMs,
      expansion: timing.expansionMs,
      retrieval: timing.retrievalMs,
      reranking: timing.rerankingMs,
      overhead: Math.max(0, round6(totalMs - stageSum)),
    },
  });

  return { envelope, resultPaths: shaped.paths };
}

interface ExpansionStageReport {
  status: "expanded" | "original_sufficient" | "degraded" | "disabled";
  reason: ReasonCode | null;
  generatedQueries: GeneratedQueryDocument[];
  /** True when a configured remote expansion route drove this stage. */
  usedRemoteRoute: boolean;
}

async function expansionStage(
  request: QueryRequest,
  warnings: EnvelopeWarning[],
  timing: StageTimingCollector,
  clock: Clock,
  deps: SearchDeps,
): Promise<ExpansionStageReport> {
  const stageStart = clock.nowMs();
  try {
    if (request.noExpand || request.plainQuery === null) {
      // `--no-expand` deterministically disables the stage; typed documents
      // without a plain query have no sanctioned expansion input.
      return {
        status: "disabled",
        reason: null,
        generatedQueries: [],
        usedRemoteRoute: false,
      };
    }
    const route = deps.effectiveProfile?.expansion ?? null;
    if (route === null) {
      // Local-only mode: keep the stable unconfigured-route degradation.
      warnings.push(unconfiguredWarning("expansion"));
      return {
        status: "degraded",
        reason: UNCONFIGURED_ROUTE_CODE,
        generatedQueries: [],
        usedRemoteRoute: false,
      };
    }
    const outcome = await runExpansionStage(
      { plainQuery: request.plainQuery },
      route,
      deps,
    );
    if (outcome.warning !== null) warnings.push(outcome.warning);
    return {
      status: outcome.status,
      reason: outcome.reason,
      generatedQueries: outcome.generatedQueries,
      usedRemoteRoute: true,
    };
  } finally {
    timing.expansionMs = clock.nowMs() - stageStart;
  }
}

interface RetrievalOutcome {
  pool: HybridQueryResult[];
}

/**
 * Builds the exact retrieval-route submission in canonical order
 * (docs/spec/qmdx-v1.md, "Validation and ordering"): the original lexical
 * route first (QMD gives double RRF weight to the first non-empty list),
 * then generated lexical routes, then the original vector route before the
 * generated vector and HyDE routes. Typed query documents keep their
 * explicit routes first, with surviving generated queries appended.
 */
export function submissionRoutes(
  request: QueryRequest,
  generatedQueries: readonly GeneratedQueryDocument[],
  expansionRanWithRemoteRoute: boolean,
): ExpandedQuery[] {
  const generated = generatedQueries.map((query) => ({
    type: query.type,
    query: query.query,
  }));
  if (request.routes.length > 0) {
    return [
      ...request.routes.map((route) => ({
        type: route.type,
        query: route.query,
      })),
      ...generated,
    ];
  }
  if (!expansionRanWithRemoteRoute) {
    // Disabled or unconfigured stages preserve the QMD-compatible local
    // surface: the original lexical route only.
    return [{ type: "lex", query: request.originalQuery }];
  }
  return [
    { type: "lex", query: request.originalQuery },
    ...generated.filter((route) => route.type === "lex"),
    // Degraded or original-sufficient expansion continues with the original
    // lexical and vector routes; QMDX never fabricates local expansion.
    { type: "vec", query: request.originalQuery },
    ...generated.filter((route) => route.type === "vec"),
    ...generated.filter((route) => route.type === "hyde"),
  ];
}

async function retrievalStage(
  request: QueryRequest,
  generatedQueries: readonly GeneratedQueryDocument[],
  expansionRanWithRemoteRoute: boolean,
  _warnings: EnvelopeWarning[],
  timing: StageTimingCollector,
  clock: Clock,
  deps: SearchDeps,
): Promise<RetrievalOutcome> {
  const stageStart = clock.nowMs();
  try {
    if (deps.fetchPool !== undefined) {
      return { pool: await deps.fetchPool(request) };
    }
    const location = findProjectIndex();
    if (location === null) {
      throw localIndexUnavailableError(
        "No QMD project index found (looked for .qmd/index.yaml upward from the working directory).",
      );
    }
    let store: QMDStore | null = null;
    try {
      const opened = await openProjectStore(location);
      store = opened.store;
      const routes = submissionRoutes(
        request,
        generatedQueries,
        expansionRanWithRemoteRoute,
      );
      const pool = await fetchCandidatePool(store, {
        originalQuery: request.originalQuery,
        intent: request.intent,
        collections: request.collections,
      }, routes);
      return { pool };
    } finally {
      store?.close();
    }
  } finally {
    timing.retrievalMs = clock.nowMs() - stageStart;
  }
}

function rerankingStage(
  candidateCount: number,
  request: QueryRequest,
  warnings: EnvelopeWarning[],
): {
  report: { status: "ok" | "degraded" | "disabled"; reason: ReasonCode | null };
  remoteRerankScores: Map<HybridQueryResult, number> | null;
} {
  void candidateCount;
  if (request.noRerank) {
    return { report: { status: "disabled", reason: null }, remoteRerankScores: null };
  }
  warnings.push(unconfiguredWarning("reranking"));
  return {
    report: { status: "degraded", reason: UNCONFIGURED_ROUTE_CODE },
    remoteRerankScores: null,
  };
}

function unconfiguredWarning(stage: "expansion" | "reranking"): EnvelopeWarning {
  return {
    stage,
    code: UNCONFIGURED_ROUTE_CODE,
    message:
      stage === "expansion"
        ? "No remote expansion route is configured; kept original query routes."
        : "No remote reranking route is configured; kept QMD fused order.",
    retryable: false,
  };
}

function overallStatus(
  ...statuses: Array<
    "ok" | "degraded" | "disabled" | "expanded" | "original_sufficient"
  >
) {
  return statuses.some((status) => status === "degraded")
    ? ("degraded" as const)
    : ("ok" as const);
}

function shapeResults(
  pool: HybridQueryResult[],
  request: QueryRequest,
  _remoteRerankScores: Map<HybridQueryResult, number> | null,
): { results: SearchResultItem[]; paths: string[] } {
  const scored = pool.map((entry) => ({
    entry,
    rrfRank: rrfRankOf(entry),
    publicScore: publicScoreFor(entry),
  }));

  scored.sort(
    (a, b) =>
      b.publicScore - a.publicScore ||
      a.rrfRank - b.rrfRank ||
      identityOf(a.entry).localeCompare(identityOf(b.entry)),
  );

  const filtered = request.minScore === null
    ? scored
    : scored.filter((item) => item.publicScore >= request.minScore!);

  const results: SearchResultItem[] = [];
  const paths: string[] = [];
  for (const item of filtered.slice(0, request.limit)) {
    const result: SearchResultItem = {
      rank: results.length + 1,
      docid: `#${item.entry.docid}`,
      score: item.publicScore,
      file: item.entry.file,
      title: item.entry.title,
      context: item.entry.context ?? null,
      line: item.entry.bestChunkPos ?? null,
      snippet: snippetFor(item.entry),
    };
    if (request.full) {
      result.body = item.entry.body;
    }
    if (request.explain) {
      result.explanation = explanationFor(item.rrfRank, item.publicScore);
    }
    results.push(result);
    paths.push(
      typeof item.entry.displayPath === "string" && item.entry.displayPath !== ""
        ? item.entry.displayPath
        : item.entry.file,
    );
  }
  return { results, paths };
}

function rrfRankOf(entry: HybridQueryResult): number {
  const rank = entry.explain?.rrf?.rank;
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 1) {
    throw internalError(`QMD did not report an RRF rank for ${entry.file}`);
  }
  return rank;
}

function publicScoreFor(entry: HybridQueryResult): number {
  return qmdPositionScore(rrfRankOf(entry));
}

export function explanationFor(
  qmdRrfRank: number,
  finalScore: number,
): SearchResultItem["explanation"] {
  return {
    qmdRrfRank,
    qmdPositionWeight: DEGRADED_POSITION_WEIGHT,
    remoteRerankScore: null,
    finalScore,
  };
}

function identityOf(entry: HybridQueryResult): string {
  return `${entry.file}\u0000${entry.docid}`;
}

function snippetFor(entry: HybridQueryResult): string | null {
  const chunk = entry.bestChunk;
  if (typeof chunk !== "string" || chunk.trim() === "") return null;
  return chunk.replace(/\s+/g, " ").trim().slice(0, 240);
}
