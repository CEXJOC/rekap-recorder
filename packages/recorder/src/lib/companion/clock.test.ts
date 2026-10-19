import { describe, expect, it } from "vitest";
import {
  ClockSample,
  computeClockOffset,
  percentile,
  SPREAD_WARNING_SECONDS,
} from "./clock";

const START = 1_790_000_000_000; // wall clock of video second 0

// One sample per second; the game clock was at `offset` when the video began.
function game(
  seconds: number,
  offset: number,
  jitterMs = (i: number) => (i % 3) * 20, // response latency 0–40 ms
): ClockSample[] {
  return Array.from({ length: seconds }, (_, i) => ({
    t: START + i * 1000 + jitterMs(i),
    gameTime: offset + i,
  }));
}

describe("clock offset", () => {
  it("is the game time at video second 0", () => {
    const result = computeClockOffset(game(600, 95.5), START);
    expect(result.offset).toBeCloseTo(95.48, 2); // latency makes t later
    expect(result.spread).toBeLessThan(0.05);
    expect(result.count).toBe(600);
  });

  it("works when the video started before the game clock (negative offset)", () => {
    const samples = game(120, 0).map((s) => ({ ...s, t: s.t + 3000 }));
    expect(computeClockOffset(samples, START).offset).toBeCloseTo(-3.02, 2);
  });

  it("ignores samples outside the video", () => {
    const samples = [
      { t: START - 5000, gameTime: 0 }, // before capture started
      ...game(60, 10, () => 0),
      { t: START + 120_000, gameTime: 500 }, // after the video ended
    ];
    const result = computeClockOffset(samples, START, 60);
    expect(result).toEqual({ offset: 10, spread: 0, count: 60 });
  });

  it("keeps the majority offset and flags a pause with the spread", () => {
    // 10 min of play, a 45 s pause (game clock frozen, video running), then
    // 5 more minutes: later samples are 45 s "behind" the video.
    const before = game(600, 20, () => 0);
    const pause = Array.from({ length: 45 }, (_, i) => ({
      t: START + (600 + i) * 1000,
      gameTime: 620,
    }));
    const after = Array.from({ length: 300 }, (_, i) => ({
      t: START + (645 + i) * 1000,
      gameTime: 620 + i,
    }));
    const result = computeClockOffset([...before, ...pause, ...after], START);
    expect(result.offset).toBe(20); // the longer part wins
    expect(result.spread).toBeGreaterThan(40);
    expect(result.spread!).toBeGreaterThan(SPREAD_WARNING_SECONDS);
  });

  it("flags even a short pause near the end", () => {
    const before = game(1500, 0, () => 0);
    const after = Array.from({ length: 120 }, (_, i) => ({
      t: START + (1530 + i) * 1000,
      gameTime: 1500 + i,
    }));
    const result = computeClockOffset([...before, ...after], START);
    expect(result.offset).toBe(0);
    expect(result.spread).toBeCloseTo(30, 0);
  });

  it("returns null without usable samples", () => {
    expect(computeClockOffset([], START)).toEqual({
      offset: null,
      spread: null,
      count: 0,
    });
    expect(
      computeClockOffset([{ t: START - 1, gameTime: 3 }], START).offset,
    ).toBeNull();
  });

  it("interpolates percentiles", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNaN();
  });
});
