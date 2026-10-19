import { z } from "zod";
import {
  blackBoxes,
  keptRegions,
  MASKED_SIZE,
  REGION_ANCHORS,
} from "./masked-screen";
import { fitGraph, screenFit } from "./screen-fit";

const dimension = z.number().int().min(1).max(8192);
/** Measured geometry; minimap coordinates are canonical 1920x1080 pixels. */
export const analysisTrackProfileSchema = z
  .object({
    source: z.object({
      width: dimension.min(640).max(3840),
      height: dimension.min(480).max(2160),
    }),
    minimap: z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: dimension.min(32),
      height: dimension.min(32),
    }),
  })
  .superRefine((p, ctx) => {
    if (
      !["keep", "scale"].includes(screenFit(p.source).kind) ||
      p.minimap.width !== p.minimap.height ||
      p.minimap.x + p.minimap.width > 1920 ||
      p.minimap.y + p.minimap.height > 1080
    )
      ctx.addIssue({
        code: "custom",
        message: "Unsupported screen or canonical minimap geometry.",
      });
  });
export type AnalysisTrackProfile = z.infer<typeof analysisTrackProfileSchema>;
export const ANALYSIS_TRACK_FPS = 1;
export const ANALYSIS_TRACK_MANIFEST = "analysis-track.json";
export function analysisSegmentFile(screenFile: string) {
  if (!/\.mkv$/i.test(screenFile))
    throw new Error("Analysis segments require Matroska input names.");
  return screenFile.replace(/\.mkv$/i, ".analysis.mkv");
}

/**
 * The masked track's surfaces plus the whole corner the analyzer reads around
 * the minimap: its side band (ally portraits and the death timers above them,
 * from 0.85 minimap sizes above and 0.25 to the left; analyze.ts) and the
 * minimap's search margin, with 4 px for the located square's drift. Paired
 * check, 2026-10-16: with the masked surfaces alone the timers above the
 * allies' portraits were lost.
 */
export function analysisTrackRegions(minimap: AnalysisTrackProfile["minimap"]) {
  const x = Math.max(0, Math.round(minimap.x - 0.25 * minimap.width) - 4);
  const y = Math.max(0, Math.round(minimap.y - 0.85 * minimap.height) - 4);
  return [
    ...keptRegions(MASKED_SIZE, minimap)!.map((r) => ({ ...r, anchor: REGION_ANCHORS[r.name] })),
    { x, y, width: MASKED_SIZE.width - x, height: MASKED_SIZE.height - y, anchor: "right" as const },
  ];
}

/**
 * Puts a restarted segment's track on the session's clock. Each capture
 * segment's timestamps start at its own zero, and 1 fps keeps one frame per
 * whole second of them, so after a restart the track samples at a fractional
 * phase of the joined video (live game 2026-10-17: 0.31 s behind the full
 * pass). With a clock, a named setpts before the 1 fps selection moves the
 * frames by the segment's start since `originMs` (the first segment's video
 * second 0) minus `offsetSeconds`, the whole seconds above it: the track
 * keeps screen.mp4's whole seconds, and pts + offsetSeconds is its time.
 *
 * The start is FrameClock's, the value screen.mp4's layout uses, sent by the
 * recorder from the first progress report and again whenever it improves
 * (analysisClockCommand). Until then setpts keeps the segment's own clock:
 * frames before `fromSeconds` (track seconds, the progress time of the first
 * command plus a margin) are not on the session's clock and are left out
 * when joining. The shift is never positive and the track is never held
 * back, because ffmpeg 6.1 ties the outputs together: -progress out_time,
 * from which FrameClock reads the full video's start, is the latest
 * timestamp of all outputs, and the full output waits for the track's first
 * packet (synthetic: 57 ms, 1,077 ms with the track held one second).
 */
export type AnalysisTrackClock = {
  originMs: number;
  /** Set once ffmpeg confirmed the first start (ret:0); absent before. */
  offsetSeconds?: number;
  /** Track seconds from which frames are on the session's clock. */
  fromSeconds?: number;
  /** The FrameClock start last confirmed. */
  anchoredMs?: number;
  /** ffmpeg refused a start: the track stays on the segment's own clock. */
  failed?: boolean;
};

/** ffmpeg's answer to each stdin command, in order: true when applied. */
export function clockCommandReplies(stderr: string) {
  return [...stderr.matchAll(/Command reply for stream \d+: ret:(-?\d+)/g)].map(
    (m) => m[1] === "0",
  );
}

const CLOCK_FILTER = "clock";
/** Track seconds between the first command and the frames it surely moved. */
const CLOCK_MARGIN_SECONDS = 2;

/** Whole seconds above the segment's start, fixing the track's offset. */
export const analysisTrackOffset = (originMs: number, startedAtMs: number) =>
  Math.max(0, Math.ceil((startedAtMs - originMs) / 1000));

/** First track second surely on the session's clock, from progress time. */
export const analysisTrackClockFrom = (progressSeconds: number) =>
  Math.floor(progressSeconds) + CLOCK_MARGIN_SECONDS;

/**
 * ffmpeg stdin command ('c' then target, time, command, argument) giving the
 * clocked setpts the segment's start: pts + (start - origin) - offset, <= 0.
 */
export function analysisClockCommand(
  originMs: number,
  offsetSeconds: number,
  startedAtMs: number,
) {
  const shift = Math.min(0, (startedAtMs - originMs) / 1000 - offsetSeconds);
  return `csetpts@${CLOCK_FILTER} -1 expr PTS-${(-shift).toFixed(3)}/TB\n`;
}

/** Select 1 fps on the shared GPU source before CPU readback. */
export function analysisTrackGraph(
  profile: AnalysisTrackProfile,
  hardware = true,
  clocked = false,
) {
  const p = analysisTrackProfileSchema.parse(profile);
  const regions = analysisTrackRegions(p.minimap);
  const fit = fitGraph(
    screenFit(p.source),
    regions,
    "rgb24",
    [
      ...(clocked ? [`setpts@${CLOCK_FILTER}=PTS`] : []),
      `fps=${ANALYSIS_TRACK_FPS}`,
      ...(hardware ? ["hwdownload", "format=bgra"] : []),
    ],
  ).replace("[0:v]", "[analysis-source]");
  const mask = blackBoxes(MASKED_SIZE, regions)
    .map(
      (b) =>
        `drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=black:t=fill`,
    )
    .join(",");
  return `[0:v]split=2[full][analysis-source];${fit};[fit]${mask || "null"}[analysis]`;
}

/** Independent crash-readable lossless RGB output for each capture segment. */
export function analysisTrackOutputArgs(file: string) {
  return [
    "-map",
    "[analysis]",
    "-an",
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-g",
    "1",
    "-pix_fmt",
    "bgr0",
    "-threads",
    "1",
    "-f",
    "matroska",
    "-cluster_time_limit",
    "1000",
    "-flush_packets",
    "1",
    "-y",
    file,
  ];
}
