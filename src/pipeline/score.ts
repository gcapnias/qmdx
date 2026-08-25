export type RetrievalWeight = 0.75 | 0.6 | 0.4;

export function retrievalWeightForRank(qmdRrfRank: number): RetrievalWeight {
  if (qmdRrfRank <= 3) return 0.75;
  if (qmdRrfRank <= 10) return 0.6;
  return 0.4;
}

export function qmdPositionScore(qmdRrfRank: number): number {
  return round6(1 / qmdRrfRank);
}

export const DEGRADED_POSITION_WEIGHT = 1;

export function blendedFinalScore(
  qmdRrfRank: number,
  remoteScore: number,
): number {
  const weight = retrievalWeightForRank(qmdRrfRank);
  return round6(weight * (1 / qmdRrfRank) + (1 - weight) * remoteScore);
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
