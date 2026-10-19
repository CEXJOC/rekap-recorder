import {
  analysisTrackGraph,
  analysisTrackOutputArgs,
  analysisSegmentFile,
  type AnalysisTrackClock,
  type AnalysisTrackProfile,
} from "./analysis-track";

// Screen capture with ffmpeg: Windows Desktop Duplication (`ddagrab`, frames
// stay on the GPU as D3D11 textures) feeding a hardware H.264 encoder.
// Pure helpers only; process handling lives in capture.ts.

/** Fallback order: vendor hardware encoders, Media Foundation, then CPU. */
export const ENCODER_ORDER = [
  "h264_nvenc",
  "h264_amf",
  "h264_qsv",
  "h264_mf",
  "libx264",
] as const;
export type EncoderName = (typeof ENCODER_ORDER)[number];
export const isEncoderName = (value: string): value is EncoderName =>
  (ENCODER_ORDER as readonly string[]).includes(value);

/** libx264 encodes on the CPU next to the game, so it is capped at 15 fps. */
export const SOFTWARE_MAX_FPS = 15;
export const effectiveFps = (encoder: EncoderName, fps: number) =>
  encoder === "libx264" ? Math.min(fps, SOFTWARE_MAX_FPS) : fps;

/** Encoder names listed by `ffmpeg -hide_banner -encoders`. */
export function parseEncoderList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*V[.A-Z]{5}\s+(\w[\w-]*)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Candidates to probe, in order; a preferred encoder is tried first. */
export function encoderCandidates(
  available: Set<string>,
  preferred?: EncoderName,
): EncoderName[] {
  const order = preferred
    ? [preferred, ...ENCODER_ORDER.filter((e) => e !== preferred)]
    : [...ENCODER_ORDER];
  return order.filter((e) => available.has(e));
}

/** A screen rectangle in monitor pixels; even sizes, as H.264 4:2:0 needs. */
export type CaptureArea = { x: number; y: number; width: number; height: number };

export type CaptureSettings = {
  encoder: EncoderName;
  fps: number;
  monitor: number;
  /** Only this part of the screen (the minimap); the whole screen without. */
  area?: CaptureArea;
  analysisProfile?: AnalysisTrackProfile;
  /** Restarted segments only: the analysis track on the session's clock. */
  analysisClock?: AnalysisTrackClock;
};

/**
 * lavfi source graph. NVENC and AMF take the D3D11 frames directly (no copy
 * to system memory, ~0.2% CPU measured); the other encoders need a GPU→CPU
 * download and a colour conversion on the CPU (fast_bilinear is the cheapest).
 * With an area, ddagrab copies only that rectangle out of the desktop image,
 * so everything after it (download, encoding, disk) handles that many pixels.
 * Windows still keeps the whole display's duplication surface up to date
 * between our samples: that part does not shrink with the area or the rate.
 */
export function captureFilter({ encoder, fps, monitor, area }: CaptureSettings) {
  const region = area
    ? `:video_size=${area.width}x${area.height}:offset_x=${area.x}:offset_y=${area.y}`
    : "";
  const grab = `ddagrab=output_idx=${monitor}:framerate=${effectiveFps(encoder, fps)}:draw_mouse=0${region}`;
  const download = `${grab},hwdownload,format=bgra,scale=flags=fast_bilinear`;
  switch (encoder) {
    case "h264_nvenc":
    case "h264_amf":
      return grab;
    case "h264_qsv":
    case "h264_mf": // Media Foundation encoders typically accept NV12 only
      return `${download},format=nv12`;
    case "libx264":
      return `${download},format=yuv420p`;
  }
}

// Space-separated argument lists (no argument here contains a space).
const argv = (args: string) => args.split(" ");

/**
 * Constant-quality settings, GOP of 2 s, low encoder overhead. No B-frames:
 * frames are written in display order (DTS = PTS), which keeps timestamps
 * exact in Matroska's 1 ms timebase even when the capture drops a frame.
 * Measured on League footage with NVENC: +9.5% size, +0.5 dB PSNR.
 */
export function encoderArgs({ encoder, fps }: CaptureSettings): string[] {
  const gop = Math.round(effectiveFps(encoder, fps) * 2);
  const quality = {
    h264_nvenc: "-preset p4 -rc vbr -cq 30 -b:v 0",
    h264_amf: "-usage transcoding -quality speed -rc cqp -qp_i 26 -qp_p 28",
    h264_qsv: "-preset veryfast -global_quality 28",
    h264_mf: "-hw_encoding 1 -rate_control quality -quality 60",
    libx264: "-preset ultrafast -crf 28 -threads 4",
  }[encoder];
  return argv(`-c:v ${encoder} ${quality} -g ${gop} -bf 0`);
}

/**
 * Long-running capture into Matroska, which stays readable if the process is
 * killed. Clusters of 1 s, flushed as soon as they are complete: a hard kill
 * loses at most about the last second (measured 0.1–0.9 s) instead of several.
 */
export function buildCaptureArgs(settings: CaptureSettings, output: string) {
  const profile = settings.analysisProfile;
  if (profile && (settings.encoder !== "h264_nvenc" || settings.area))
    throw new Error("Experimental analysis track requires full-screen NVENC capture.");
  return [
    // key=value progress blocks on stdout, used for first-frame timing.
    ...argv("-hide_banner -nostats -loglevel warning"),
    ...argv("-progress pipe:1 -stats_period 0.5"),
    ...["-f", "lavfi", "-i", captureFilter(settings)],
    ...(profile
      ? ["-filter_complex_threads", "1", "-filter_complex", analysisTrackGraph(profile, true, Boolean(settings.analysisClock)), "-map", "[full]"]
      : []),
    "-an",
    ...encoderArgs(settings),
    ...argv("-f matroska -cluster_time_limit 1000 -flush_packets 1"),
    ...["-y", output],
    ...(profile ? analysisTrackOutputArgs(analysisSegmentFile(output)) : []),
  ];
}

/** Lossless remux of one or more inputs (already demuxed as `input`) to MP4. */
export function buildRemuxArgs(input: string[], output: string) {
  return [
    ...argv("-hide_banner -nostats -loglevel error -y"),
    ...input,
    ...argv("-map 0:v:0 -c copy -movflags +faststart -f mp4"),
    output,
  ];
}

/**
 * Decodes a whole video and discards the frames, reporting progress on
 * stdout. With `hardware`, decoding runs on the GPU and frames never reach
 * system memory (measured: 12x less CPU than software decoding); ffmpeg
 * itself falls back to software when the GPU cannot decode the stream.
 */
export function buildDecodeCheckArgs(file: string, hardware: boolean) {
  return [
    ...argv("-hide_banner -nostats -progress pipe:1"),
    ...(hardware ? argv("-hwaccel d3d11va -hwaccel_output_format d3d11") : []),
    ...["-i", file],
    ...argv("-map 0:v:0 -f null -"),
  ];
}

/** Reads every packet without decoding: the readable length of a file. */
export function buildCopyProbeArgs(file: string) {
  return [
    ...argv("-hide_banner -nostats -progress pipe:1"),
    ...["-i", file],
    ...argv("-map 0:v:0 -c copy -f null -"),
  ];
}

/** One-second test encode of the real capture graph, discarded. */
export function buildProbeArgs(settings: CaptureSettings) {
  return [
    ...argv("-hide_banner -nostats -loglevel error"),
    ...["-f", "lavfi", "-i", captureFilter(settings), "-t", "1", "-an"],
    ...encoderArgs(settings),
    ...argv("-f null -"),
  ];
}
