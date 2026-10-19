// Aligns the screen recording with the game clock.
//
//   game seconds = video seconds + clockOffsetSeconds
//
// Each Live Client sample gives one estimate:
//   gameTime − (t − startedAtMs) / 1000
// The median is robust to poll latency. A pause or a reconnect shifts every
// later estimate (the game clock stops, the video keeps running), so a single
// offset is then wrong for part of the video; the spread flags that case.

export type ClockSample = { t: number; gameTime: number };
export type ClockOffset = {
  /** Median offset in seconds, or null without samples. */
  offset: number | null;
  /** p95 − p5 of the per-sample offsets in seconds (≈ 0.1 s when clean). */
  spread: number | null;
  /** Samples inside the video window that were used. */
  count: number;
};

/** Spreads above this suggest a pause, reconnect or capture stall. */
export const SPREAD_WARNING_SECONDS = 1;

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const index = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Offset of one video file. Only samples taken while the video was running
 * (startedAtMs … startedAtMs + durationSeconds) count when a duration is known.
 */
export function computeClockOffset(
  samples: readonly ClockSample[],
  startedAtMs: number,
  durationSeconds?: number | null,
): ClockOffset {
  const end =
    durationSeconds != null && durationSeconds > 0
      ? startedAtMs + durationSeconds * 1000
      : Infinity;
  const offsets = samples
    .filter((s) => s.t >= startedAtMs && s.t <= end)
    .map((s) => s.gameTime - (s.t - startedAtMs) / 1000)
    .sort((a, b) => a - b);
  if (!offsets.length) return { offset: null, spread: null, count: 0 };
  return {
    offset: round3(percentile(offsets, 0.5)),
    spread: round3(percentile(offsets, 0.95) - percentile(offsets, 0.05)),
    count: offsets.length,
  };
}
