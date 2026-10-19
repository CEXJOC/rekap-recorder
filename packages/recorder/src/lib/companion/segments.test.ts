import { describe, expect, it } from "vitest";
import { computeClockOffset } from "./clock";
import { concatScript, gapSeconds, layoutSegments } from "./segments";

const START = 1_790_000_000_000;
const FRAME = 1 / 30;

describe("capture segments", () => {
  it("is a plain single video when capture never restarted", () => {
    const layout = layoutSegments(
      [{ file: "screen.mkv", startedAtMs: START, durationSeconds: 1800.5 }],
      FRAME,
    );
    expect(layout).toEqual({ starts: [0], totalSeconds: 1800.5, gaps: [] });
  });

  it("keeps restarted segments on the wall clock of the first one", () => {
    // ffmpeg died 14.2 s in; capture came back 21.242 s after the start.
    const segments = [
      { file: "screen.mkv", startedAtMs: START, durationSeconds: 14.17 },
      {
        file: "screen-2.mkv",
        startedAtMs: START + 21_242,
        durationSeconds: 58.6,
      },
    ];
    const layout = layoutSegments(segments, FRAME);
    expect(layout.starts).toEqual([0, 21.242]);
    expect(layout.totalSeconds).toBe(79.842);
    expect(layout.gaps).toEqual([{ startSeconds: 14.17, endSeconds: 21.242 }]);
    expect(gapSeconds(layout.gaps)).toBe(7.072);
    expect(concatScript(segments, layout.starts)).toBe(
      "ffconcat version 1.0\nfile 'screen.mkv'\nduration 21.242\nfile 'screen-2.mkv'\n",
    );
  });

  it("keeps one clock offset valid across a restart", () => {
    // Game clock 1000 s when the video starts; one sample per second,
    // including the 7 s without capture.
    const samples = Array.from({ length: 80 }, (_, i) => ({
      t: START + i * 1000,
      gameTime: 1000 + i,
    }));
    const layout = layoutSegments(
      [
        { file: "screen.mkv", startedAtMs: START, durationSeconds: 14.17 },
        {
          file: "screen-2.mkv",
          startedAtMs: START + 21_242,
          durationSeconds: 58.6,
        },
      ],
      FRAME,
    );
    const clock = computeClockOffset(samples, START, layout.totalSeconds);
    expect(clock).toEqual({ offset: 1000, spread: 0, count: 80 });
    // A frame 30 s into the second segment is at video second 51.242.
    expect(layout.starts[1] + 30 + clock.offset!).toBeCloseTo(1051.242, 3);
  });

  it("never lets timestamps go backwards when start estimates overlap", () => {
    const layout = layoutSegments(
      [
        { file: "screen.mkv", startedAtMs: START, durationSeconds: 10 },
        // Estimated to start 0.2 s before the first one ended.
        {
          file: "screen-2.mkv",
          startedAtMs: START + 9_800,
          durationSeconds: 5,
        },
        {
          file: "screen-3.mkv",
          startedAtMs: START + 40_000,
          durationSeconds: 5,
        },
      ],
      FRAME,
    );
    expect(layout.starts[1]).toBeCloseTo(10 + FRAME, 3);
    expect(layout.starts[1]).toBeGreaterThan(10);
    expect(layout.starts[2]).toBe(40);
    expect(layout.gaps).toHaveLength(2);
    expect(layout.gaps[0].endSeconds - layout.gaps[0].startSeconds).toBeCloseTo(
      FRAME,
      3,
    );
    expect(layout.totalSeconds).toBe(45);
  });

  it("refuses file names that would need quoting in the concat script", () => {
    expect(() =>
      concatScript(
        [{ file: "it's.mkv", startedAtMs: START, durationSeconds: 1 }],
        [0],
      ),
    ).toThrow(/file name/);
    expect(() =>
      concatScript(
        [{ file: "..\\x.mkv", startedAtMs: START, durationSeconds: 1 }],
        [0],
      ),
    ).toThrow(/file name/);
  });
});
