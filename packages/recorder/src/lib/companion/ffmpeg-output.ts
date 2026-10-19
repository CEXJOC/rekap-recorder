// Pure parsers for ffmpeg's text output.

export type ProgressBlock = Record<string, string>;

/**
 * Splits `-progress pipe:1` output (key=value lines, each block ending with
 * `progress=continue|end`) into blocks. Feed it raw stdout chunks.
 */
export class ProgressParser {
  private buffer = "";
  private block: ProgressBlock = {};
  constructor(private onBlock: (block: ProgressBlock) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      this.block[key] = line.slice(eq + 1).trim();
      if (key === "progress") {
        const block = this.block;
        this.block = {};
        this.onBlock(block);
      }
    }
  }
}

const finite = (value: string | undefined) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
};

/** Frame count and output time (seconds) of one progress block. */
export function progressPosition(block: ProgressBlock) {
  const frames = finite(block.frame) ?? 0;
  const outUs = finite(block.out_time_us) ?? finite(block.out_time_ms);
  return { frames, seconds: outUs !== null && outUs >= 0 ? outUs / 1e6 : null };
}

/**
 * Wall-clock time of video second 0. Every progress report bounds it from
 * above (report time − output time ≥ real start, the difference being encode
 * and pipe latency), so the minimum over the first reports is the best
 * estimate, typically within ~0.1 s.
 */
export class FrameClock {
  startedAtMs: number | null = null;
  reports = 0;
  constructor(private maxReports = 20) {}
  observe(block: ProgressBlock, nowMs: number) {
    const { frames, seconds } = progressPosition(block);
    if (frames <= 0 || seconds === null || this.reports >= this.maxReports)
      return this.startedAtMs;
    this.reports++;
    const estimate = Math.round(nowMs - seconds * 1000);
    this.startedAtMs =
      this.startedAtMs === null
        ? estimate
        : Math.min(this.startedAtMs, estimate);
    return this.startedAtMs;
  }
}

/** Last output time (seconds) in a finished run's `-progress` output. */
export function lastProgressSeconds(stdout: string): number | null {
  let last: number | null = null;
  for (const match of stdout.matchAll(/^out_time_us=(\d+)\s*$/gm))
    last = Number(match[1]) / 1e6;
  return last;
}

/**
 * The last thing ffmpeg said that explains a failure. Per-frame muxer notes
 * such as "Invalid DTS … replacing by guess" are harmless and skipped.
 */
export function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const harmless =
    /replacing by guess|Increasing reorder buffer|Last message repeated|Enter command:|Command reply for/i;
  return (lines.filter((line) => !harmless.test(line)).pop() ?? "").slice(
    0,
    300,
  );
}

/** Container duration from ffmpeg's input banner, in seconds. */
export function parseDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Width and height of the first video stream in ffmpeg's banner. */
export function parseVideoSize(
  stderr: string,
): { width: number; height: number } | null {
  for (const line of stderr.split(/\r?\n/)) {
    if (!/Stream #\d+:\d+.*Video:/.test(line)) continue;
    const match = /,\s(\d{2,5})x(\d{2,5})(?=[\s,]|$)/.exec(line);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return null;
}

/** The remuxed file is kept only if it decodes through 95% of its length. */
export const DECODE_COVERAGE = 0.95;
export function decodesFully(
  decodedSeconds: number | null,
  durationSeconds: number | null,
) {
  return (
    decodedSeconds !== null &&
    durationSeconds !== null &&
    durationSeconds > 0 &&
    decodedSeconds >= DECODE_COVERAGE * durationSeconds
  );
}
