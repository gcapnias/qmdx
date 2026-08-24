export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export interface ManualClock extends Clock {
  advance(ms: number): void;
}

export function manualClock(startAtMs = 0): ManualClock {
  let current = startAtMs;
  return {
    nowMs: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}
