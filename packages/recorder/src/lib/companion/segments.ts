// A game normally yields one capture file. If ffmpeg dies mid-game (display
// mode change, driver reset) capture restarts into a new segment. At the end
// the segments are joined into ONE screen.mp4 whose timeline stays on the
// wall clock of the first segment: the time without capture remains in the
// video as a frozen frame, so "game seconds = video seconds + offset" holds
// before and after a restart. Pure helpers; ffmpeg runs in capture.ts.

export type SegmentTiming = {
  /** File name inside the session folder (no path). */
  file: string;
  /** Wall clock of the segment's first frame. */
  startedAtMs: number;
  /** Readable length of the segment. */
  durationSeconds: number;
};

/** A stretch of the joined video without picture (frozen frame). */
export type VideoGap = { startSeconds: number; endSeconds: number };

export type SegmentLayout = {
  /** Video second at which each segment begins in the joined file. */
  starts: number[];
  totalSeconds: number;
  gaps: VideoGap[];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Places segments on the first segment's wall clock. A segment never starts
 * before the previous one ends plus one frame (start times are estimates, and
 * timestamps in the joined file must keep increasing).
 */
export function layoutSegments(
  segments: readonly SegmentTiming[],
  frameSeconds: number,
): SegmentLayout {
  const starts: number[] = [];
  const gaps: VideoGap[] = [];
  let end = 0;
  segments.forEach((segment, i) => {
    const wanted = (segment.startedAtMs - segments[0].startedAtMs) / 1000;
    const start = i === 0 ? 0 : round3(Math.max(wanted, end + frameSeconds));
    if (i > 0) gaps.push({ startSeconds: round3(end), endSeconds: start });
    starts.push(start);
    end = start + Math.max(0, segment.durationSeconds);
  });
  return { starts, totalSeconds: round3(end), gaps };
}

/**
 * ffconcat script: each `duration` is the distance to the next segment's
 * start, which is what shifts the next segment's timestamps.
 */
export function concatScript(
  segments: readonly SegmentTiming[],
  starts: readonly number[],
) {
  const lines = ["ffconcat version 1.0"];
  segments.forEach((segment, i) => {
    if (!/^[A-Za-z0-9._-]+$/.test(segment.file))
      throw new Error(`Unexpected segment file name: ${segment.file}`);
    lines.push(`file '${segment.file}'`);
    if (i < segments.length - 1)
      lines.push(`duration ${(starts[i + 1] - starts[i]).toFixed(3)}`);
  });
  return `${lines.join("\n")}\n`;
}

/** Total seconds without picture. */
export const gapSeconds = (gaps: readonly VideoGap[]) =>
  round3(gaps.reduce((sum, g) => sum + (g.endSeconds - g.startSeconds), 0));
