// Screen recording during a game: ffmpeg ddagrab -> hardware H.264 ->
// screen.mkv (readable even after a crash), stopped with `q`, then remuxed
// losslessly to ONE screen.mp4 per session and described in screen.json.
import {
  ANALYSIS_TRACK_MANIFEST,
  ANALYSIS_TRACK_FPS,
  analysisClockCommand,
  analysisSegmentFile,
  clockCommandReplies,
  analysisTrackClockFrom,
  analysisTrackOffset,
  type AnalysisTrackClock,
  type AnalysisTrackProfile,
} from "./analysis-track";
import { ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ClockSample, computeClockOffset } from "./clock";
import {
  buildCaptureArgs,
  buildCopyProbeArgs,
  buildDecodeCheckArgs,
  buildProbeArgs,
  buildRemuxArgs,
  CaptureArea,
  CaptureSettings,
  effectiveFps,
  ENCODER_ORDER,
  EncoderName,
  encoderCandidates,
  parseEncoderList,
} from "./encoder";
import {
  decodesFully,
  FrameClock,
  lastErrorLine,
  lastProgressSeconds,
  parseDuration,
  parseVideoSize,
  progressPosition,
  ProgressParser,
} from "./ffmpeg-output";
import { killTree, lowerPriority, run } from "./process";
import { concatScript, layoutSegments, VideoGap } from "./segments";
import { readJson, writeJsonAtomic } from "./status";

type Log = (message: string) => void;

export type ProbeAttempt = {
  encoder: EncoderName;
  ok: boolean;
  ms: number;
  error?: string;
};

const delay = (ms: number) =>
  new Promise<false>((done) => setTimeout(() => done(false), ms));

/**
 * ffmpeg runs below normal priority, so with League open (client or game) a
 * one-second command can take tens of seconds: measured 19-28 s for the
 * encoder list on an RTX 2060 PC with the client and the Practice Tool.
 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Lists encoders once, then test-encodes one second of the real capture graph
 * with each candidate in fallback order. Returns the first that works. A list
 * that fails or comes back empty is reported in `listError`, and every known
 * encoder is then test-encoded, since the encode test alone decides.
 */
export async function probeEncoder(
  ffmpeg: string,
  options: {
    fps: number;
    monitor: number;
    preferred?: EncoderName;
    run?: typeof run;
  },
): Promise<{
  encoder: EncoderName | null;
  attempts: ProbeAttempt[];
  listError?: string;
}> {
  const exec = options.run ?? run;
  const list = await exec(ffmpeg, ["-hide_banner", "-encoders"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const listed = parseEncoderList(list.stdout);
  const listError =
    list.timedOut || list.code !== 0 || listed.size === 0
      ? list.timedOut
        ? `encoder list timed out after ${PROBE_TIMEOUT_MS / 1000} s`
        : lastErrorLine(list.stderr) || `encoder list failed (exit ${list.code})`
      : undefined;
  const candidates = encoderCandidates(
    listError ? new Set<string>(ENCODER_ORDER) : listed,
    options.preferred,
  );
  const attempts: ProbeAttempt[] = [];
  for (const encoder of candidates) {
    const started = Date.now();
    const result = await exec(
      ffmpeg,
      buildProbeArgs({ encoder, fps: options.fps, monitor: options.monitor }),
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const ok = result.code === 0 && !result.timedOut;
    attempts.push({
      encoder,
      ok,
      ms: Date.now() - started,
      ...(ok
        ? {}
        : {
            error: result.timedOut
              ? "timed out"
              : lastErrorLine(result.stderr) || `exit ${result.code}`,
          }),
    });
    if (ok) return { encoder, attempts, ...(listError ? { listError } : {}) };
  }
  return { encoder: null, attempts, ...(listError ? { listError } : {}) };
}

/** One ffmpeg run. Several only when capture had to be restarted. */
export type CaptureSegment = {
  index: number;
  /** Matroska file name inside the session folder. */
  file: string;
  analysisFile?: string;
  /** Restarted segments: the analysis track on the first segment's clock. */
  analysisClock?: AnalysisTrackClock;
  spawnedAtMs: number;
  /** Wall clock of video second 0 (see FrameClock), null before a frame. */
  startedAtMs: number | null;
  frames: number;
  /** Output time reached, from ffmpeg progress. */
  seconds: number;
  dropFrames: number;
  dupFrames: number;
  endedAtMs: number | null;
  exitCode: number | null;
  error: string | null;
};

/** Persisted as screen.recording.json while recording (crash recovery). */
export type CaptureRecording = {
  encoder: EncoderName;
  fps: number;
  monitor: number;
  /** The part of the screen recorded (--minimap-only); the whole screen without. */
  area?: CaptureArea;
  analysisProfile?: AnalysisTrackProfile;
  segments: CaptureSegment[];
};

export const RECORDING_FILE = "screen.recording.json";
export const VIDEO_FILE = "screen.mp4";
const STOP_TIMEOUT_MS = 10_000;
const STALL_MS = 30_000;
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export const segmentFile = (index: number) =>
  index === 1 ? "screen.mkv" : `screen-${index}.mkv`;

/**
 * Source resets the experimental analysis branch may survive per session:
 * the fullscreen switch at game start, plus a few alt-tabs.
 */
const MAX_ANALYSIS_RESETS = 3;

/**
 * True when ffmpeg ended because its ddagrab input failed, before the split
 * into the full and analysis branches. ddagrab is the lavfi input, so a lost
 * Desktop Duplication surfaces as a demuxer read error (live game,
 * 2026-10-17: "Error retrieving a packet from demuxer: Generic error in an
 * external library" at the loading-screen-to-game switch). Filter and
 * encoder errors, which the branch can cause, never match.
 */
export function desktopDuplicationReset(stderr: string) {
  // ffmpeg prints the wrapper for any input read error; ddagrab reports DXGI
  // failures (access lost, AcquireNextFrame) as AVERROR_EXTERNAL.
  const source =
    /Error retrieving a packet from demuxer: Generic error in an external library/i;
  const errors = stderr
    .split(/\r?\n/)
    .filter((line) => /error|failed/i.test(line));
  return (
    errors.some((line) => source.test(line)) &&
    !errors.some(
      (line) =>
        !source.test(line) &&
        /filter|encod|ffv1|hwdownload|matroska|No space/i.test(line),
    )
  );
}

/**
 * Records the desktop until stop(). Capture is only restarted when the
 * ffmpeg process has actually exited (display mode change, driver reset,
 * secure desktop): the next segment goes to a new file, with a growing
 * back-off. Warnings on stderr never trigger a restart.
 */
export class ScreenRecorder {
  readonly recording: CaptureRecording;
  private child: ChildProcess | null = null;
  private closed: Promise<true> = Promise.resolve(true);
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private analysisEnabled = true;
  private analysisResets = 0;

  constructor(
    private readonly ffmpeg: string,
    settings: CaptureSettings,
    private readonly dir: string,
    private readonly log: Log,
    /** Capture problems worth showing in the status (not fatal). */
    private readonly onNotice: (message: string) => void = () => {},
  ) {
    this.recording = {
      encoder: settings.encoder,
      fps: effectiveFps(settings.encoder, settings.fps),
      monitor: settings.monitor,
      ...(settings.area ? { area: settings.area } : {}),
      ...(settings.analysisProfile ? { analysisProfile: settings.analysisProfile } : {}),
      segments: [],
    };
  }

  private get settings(): CaptureSettings {
    const { encoder, fps, monitor, area, analysisProfile } = this.recording;
    return {
      encoder, fps, monitor,
      ...(area ? { area } : {}),
      ...(analysisProfile && this.analysisEnabled ? { analysisProfile } : {}),
    };
  }

  private persist() {
    try {
      writeJsonAtomic(join(this.dir, RECORDING_FILE), this.recording);
      if (this.recording.analysisProfile) {
        writeJsonAtomic(join(this.dir, ANALYSIS_TRACK_MANIFEST), {
          version: "analysis-track-0.1",
          status: "EXPERIMENTAL",
          admission: "EVALUATION_ONLY",
          fps: ANALYSIS_TRACK_FPS,
          width: 1920, height: 1080,
          profile: this.recording.analysisProfile,
          clockVerified: false,
          segments: this.recording.segments
            .filter(s => s.analysisFile)
            .map(s => ({
              file: s.analysisFile,
              screenFile: s.file,
              sourceStartedAtMs: s.startedAtMs,
              endedAtMs: s.endedAtMs,
              sourceExitCode: s.exitCode,
              ...(s.analysisClock
                ? {
                    clockOriginMs: s.analysisClock.originMs,
                    ...(s.analysisClock.offsetSeconds !== undefined
                      ? {
                          trackOffsetSeconds: s.analysisClock.offsetSeconds,
                          trackClockFromSeconds: s.analysisClock.fromSeconds,
                        }
                      : {}),
                    ...(s.analysisClock.anchoredMs !== undefined
                      ? { clockAnchoredMs: s.analysisClock.anchoredMs }
                      : {}),
                    ...(s.analysisClock.failed ? { clockFailed: true } : {}),
                  }
                : {}),
            })),
        });
      }
    } catch {
      // Only needed for crash recovery; never break the recording for it.
    }
  }

  start() {
    this.spawnSegment(this.recording.segments.length + 1);
  }

  /**
   * A restarted segment's track follows the first segment's clock, so that
   * its 1 fps samples keep screen.mp4's whole seconds (analysis-track.ts).
   */
  private analysisClock(spawnedAtMs: number): AnalysisTrackClock | undefined {
    const origin = this.recording.segments[0]?.startedAtMs;
    if (!this.settings.analysisProfile || origin == null || spawnedAtMs < origin)
      return undefined;
    return {
      originMs: origin,
    };
  }

  /**
   * ffmpeg's answers to the track clock's commands. A start counts once
   * applied, and moves the second from which the track is on that clock
   * (the offset is fixed by the first command). A refused command stops the
   * clock, and a track never confirmed stays unplaced for analysis.
   */
  private clockReplies(
    segment: CaptureSegment,
    replies: boolean[],
    sent: { startMs: number; offsetSeconds: number; fromSeconds: number }[],
  ) {
    const clock = segment.analysisClock!;
    for (const applied of replies) {
      const command = sent.shift();
      if (!command || clock.failed) continue;
      if (!applied) {
        clock.failed = true;
        this.log("Experimental analysis track: ffmpeg refused its clock; the restarted segment's track will not be aligned.");
      } else {
        // Frames before each applied start may carry the previous one: only
        // frames after the last applied start are kept.
        clock.offsetSeconds = command.offsetSeconds;
        clock.fromSeconds = Math.max(clock.fromSeconds ?? 0, command.fromSeconds);
        clock.anchoredMs = command.startMs;
      }
      this.persist();
    }
  }

  private spawnSegment(index: number) {
    const previous = this.recording.segments.at(-1);
    const spawnedAtMs = Date.now();
    const analysisClock = index > 1 ? this.analysisClock(spawnedAtMs) : undefined;
    const segment: CaptureSegment = {
      index,
      file: segmentFile(index),
      ...(this.settings.analysisProfile ? {analysisFile: analysisSegmentFile(segmentFile(index))} : {}),
      ...(analysisClock ? { analysisClock: { ...analysisClock } } : {}),
      spawnedAtMs,
      startedAtMs: null,
      frames: 0,
      seconds: 0,
      dropFrames: 0,
      dupFrames: 0,
      endedAtMs: null,
      exitCode: null,
      error: null,
    };
    this.recording.segments.push(segment);
    this.persist();
    const child = spawn(
      this.ffmpeg,
      buildCaptureArgs(
        { ...this.settings, ...(analysisClock ? { analysisClock } : {}) },
        join(this.dir, segment.file),
      ),
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    lowerPriority(child.pid);
    // ffmpeg may already be gone when `q` is written (e.g. it got Ctrl+C too).
    child.stdin?.on("error", () => {});
    const clock = new FrameClock();
    // Clock commands sent and not yet answered, in order (analysis-track.ts).
    const sent: { startMs: number; offsetSeconds: number; fromSeconds: number }[] = [];
    let sentStartMs: number | null = null;
    let sentOffset: number | undefined;
    // ddagrab delivers frames at a constant rate even for a static screen,
    // so a long silence means the process hangs: replace it.
    let lastFrameAt = Date.now();
    let stalledFor = 0;
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastFrameAt;
      if (this.stopping || segment.endedAtMs !== null || idle < STALL_MS)
        return;
      stalledFor = idle;
      killTree(child);
    }, 5_000);
    const parser = new ProgressParser((block) => {
      const { frames, seconds } = progressPosition(block);
      if (frames > segment.frames) lastFrameAt = Date.now();
      const firstFrame = segment.startedAtMs === null;
      segment.startedAtMs = clock.observe(block, Date.now());
      segment.frames = Math.max(segment.frames, frames);
      if (seconds !== null)
        segment.seconds = Math.max(segment.seconds, seconds);
      segment.dropFrames = Number(block.drop_frames) || segment.dropFrames;
      segment.dupFrames = Number(block.dup_frames) || segment.dupFrames;
      // FrameClock's start, the one screen.mp4's layout uses, goes to the
      // track's clock (analysis-track.ts), again each time it improves: at
      // most once per progress report until it settles. It counts only
      // once ffmpeg has confirmed it (clockReplies).
      const trackClock = segment.analysisClock;
      if (
        trackClock &&
        !trackClock.failed &&
        segment.startedAtMs !== null &&
        sentStartMs !== segment.startedAtMs
      ) {
        sentOffset ??= analysisTrackOffset(trackClock.originMs, segment.startedAtMs);
        sentStartMs = segment.startedAtMs;
        sent.push({
          startMs: segment.startedAtMs,
          offsetSeconds: sentOffset,
          fromSeconds: analysisTrackClockFrom(segment.seconds),
        });
        child.stdin?.write(
          analysisClockCommand(trackClock.originMs, sentOffset, segment.startedAtMs),
        );
      }
      if (firstFrame && segment.startedAtMs !== null) {
        this.persist();
        this.log(
          `Screen capture running (${this.recording.encoder}, ${this.recording.fps} fps, ffmpeg pid ${child.pid}) into ${segment.file}`,
        );
        if (previous?.error && previous.endedAtMs !== null)
          this.onNotice(
            `Screen capture was interrupted for ${((segment.startedAtMs - previous.endedAtMs) / 1000).toFixed(1)} s and restarted (${previous.error}). The video shows a frozen frame for that time.`,
          );
      }
    });
    child.stdout?.on("data", (chunk: Buffer) =>
      parser.push(chunk.toString("utf8")),
    );
    let stderr = "";
    let unread = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      if (segment.analysisClock && sent.length) {
        // Whole lines only: a reply may arrive in two chunks.
        unread += chunk.toString("utf8");
        const end = unread.lastIndexOf(String.fromCharCode(10)) + 1;
        const lines = unread.slice(0, end);
        unread = unread.slice(end).slice(-1024);
        this.clockReplies(segment, clockCommandReplies(lines), sent);
      }
    });
    const finished = (code: number | null, error?: string) => {
      if (segment.endedAtMs !== null) return;
      clearInterval(watchdog);
      segment.endedAtMs = Date.now();
      segment.exitCode = code;
      if (this.child === child) this.child = null;
      if (this.stopping) return this.persist();
      // Keep ordinary capture viable if the experimental branch fails. A
      // Desktop Duplication reset (fullscreen game start, alt-tab) ends the
      // shared source, not the branch: the branch then follows the restart,
      // a bounded number of times and never after an unexplained exit.
      if (segment.analysisFile && this.analysisEnabled) {
        if (
          !stalledFor &&
          desktopDuplicationReset(stderr) &&
          this.analysisResets < MAX_ANALYSIS_RESETS
        ) {
          this.analysisResets++;
          this.log("Experimental analysis track kept after a Desktop Duplication reset; it continues in the next segment.");
        } else {
          this.analysisEnabled = false;
          this.log("Experimental analysis track disabled after capture interruption; restarting ordinary capture.");
        }
      }
      // The process is gone: keep what was written, start a new segment.
      const said = lastErrorLine(stderr);
      segment.error = stalledFor
        ? `ffmpeg produced no frame for ${Math.round(stalledFor / 1000)} s and was stopped`
        : `${error ?? `ffmpeg exited with code ${code}`}${said ? `; last ffmpeg message: ${said}` : ""}`;
      this.persist();
      const ranMs = segment.endedAtMs - segment.spawnedAtMs;
      if (ranMs > 60_000) this.failures = 0;
      const wait =
        RESTART_DELAYS_MS[
          Math.min(this.failures, RESTART_DELAYS_MS.length - 1)
        ];
      this.failures++;
      const message = `Screen capture stopped (${segment.error}); restarting it in ${wait / 1000} s.`;
      this.log(message);
      this.onNotice(message);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopping) this.spawnSegment(index + 1);
      }, wait);
    };
    // "close" fires once stdout is drained, so the last progress block counts.
    this.closed = new Promise<true>((done) => {
      child.on("error", (error) => {
        finished(null, error.message);
        done(true);
      });
      child.on("close", (code) => {
        finished(code);
        done(true);
      });
    });
  }

  /**
   * A stop is on its way (Ctrl+C in a console also reaches ffmpeg, which
   * then finishes its file and exits): that exit is not a failure.
   */
  expectStop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Graceful stop: `q` on stdin, then a hard kill after a timeout. */
  async stop(): Promise<CaptureRecording> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (child) {
      child.stdin?.write("q");
      if (!(await Promise.race([this.closed, delay(STOP_TIMEOUT_MS)]))) {
        this.log("ffmpeg did not stop within 10 s; terminating it.");
        killTree(child);
        await Promise.race([this.closed, delay(5_000)]);
      }
      child.stdin?.destroy();
    }
    this.persist();
    return this.recording;
  }

  /** Immediate termination (second Ctrl+C); the .mkv stays recoverable. */
  kill() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) killTree(this.child);
  }
}

/** A capture file that could not be joined into screen.mp4. */
export type ExtraVideo = {
  file: string;
  startedAtMs: number;
  durationSeconds: number | null;
  clockOffsetSeconds: number | null;
  clockOffsetSpread: number | null;
  width: number | null;
  height: number | null;
};

/** screen.json. Top-level fields always describe `file`. */
export type ScreenInfo = {
  /** "screen.mp4", or the .mkv if the remux or its check failed. */
  file: string;
  encoder: EncoderName;
  fps: number;
  /** ddagrab output_idx that was captured. */
  monitor: number;
  /**
   * With --minimap-only: the video is only the minimap, this square of the
   * screen (screen pixels). Absent: the video is the whole screen.
   */
  area?: CaptureArea;
  width: number | null;
  height: number | null;
  /** Wall clock (ms) of video second 0. */
  startedAtMs: number;
  startedAtSource: "ffmpeg-progress" | "process-start";
  durationSeconds: number | null;
  /** game seconds = video seconds + clockOffsetSeconds. */
  clockOffsetSeconds: number | null;
  /** p95 − p5 of per-sample offsets; large after a pause or reconnect. */
  clockOffsetSpread: number | null;
  clockOffsetSamples: number;
  /** False when `file` is still the .mkv. */
  remuxed: boolean;
  dropFrames: number;
  /** Video time without picture (capture restarted); the offset still holds. */
  gaps: VideoGap[];
  /** Only when restarted segments could not be joined (resolution changed). */
  extraFiles?: ExtraVideo[];
  error?: string;
};

type Part = {
  segment: CaptureSegment;
  mkv: string;
  startedAtMs: number;
  /** Readable length of the .mkv. */
  seconds: number;
  width: number | null;
  height: number | null;
};

/** Readable length and size of a segment; null if it holds no video. */
async function inspectSegment(
  ffmpeg: string,
  dir: string,
  segment: CaptureSegment,
): Promise<Part | null> {
  const mkv = join(dir, segment.file);
  if (!existsSync(mkv)) return null;
  const copy = await run(ffmpeg, buildCopyProbeArgs(mkv), {
    timeoutMs: 15 * 60_000,
  });
  const seconds = lastProgressSeconds(copy.stdout);
  if (!seconds || seconds <= 0) {
    // A process that never produced a frame leaves only a header.
    if (statSync(mkv).size < 64 * 1024) rmSync(mkv, { force: true });
    return null;
  }
  const size = parseVideoSize(copy.stderr);
  return {
    segment,
    mkv,
    startedAtMs: segment.startedAtMs ?? segment.spawnedAtMs,
    seconds,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

type Checked = {
  ok: boolean;
  decoded: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
};

/**
 * Decodes the whole file once (GPU decoder when available, else CPU) and
 * reads its length: proof that it plays to the end.
 */
async function checkDecodes(ffmpeg: string, file: string): Promise<Checked> {
  let checked: Checked = {
    ok: false,
    decoded: null,
    duration: null,
    width: null,
    height: null,
  };
  for (const hardware of [true, false]) {
    const result = await run(ffmpeg, buildDecodeCheckArgs(file, hardware), {
      timeoutMs: 60 * 60_000,
    });
    const decoded = lastProgressSeconds(result.stdout);
    const duration = parseDuration(result.stderr);
    const size = parseVideoSize(result.stderr);
    checked = {
      ok: result.code === 0 && decodesFully(decoded, duration),
      decoded,
      duration,
      width: size?.width ?? null,
      height: size?.height ?? null,
    };
    if (checked.ok) break;
  }
  return checked;
}

type Produced =
  { ok: true; check: Checked } | { ok: false; error: string; check?: Checked };

/**
 * Stream-copies `input` into `<dir>/<name>` (MP4, faststart) via a .part
 * file, and only keeps it if it decodes to the end and is as long as the
 * source (`expectedSeconds`).
 */
async function produceMp4(
  ffmpeg: string,
  dir: string,
  input: string[],
  expectedSeconds: number,
  name: string,
): Promise<Produced> {
  const target = join(dir, name);
  const partial = `${target}.part`;
  rmSync(partial, { force: true });
  const remux = await run(ffmpeg, buildRemuxArgs(input, partial), {
    timeoutMs: 30 * 60_000,
  });
  if (remux.code !== 0 || !existsSync(partial)) {
    rmSync(partial, { force: true });
    return {
      ok: false,
      error: `remux failed: ${lastErrorLine(remux.stderr) || `exit ${remux.code}`}`,
    };
  }
  const check = await checkDecodes(ffmpeg, partial);
  // A remux that silently dropped part of the recording is not complete.
  if (!check.ok || (check.duration ?? 0) < 0.95 * expectedSeconds) {
    rmSync(partial, { force: true });
    return {
      ok: false,
      check,
      error: `mp4 check failed (decoded ${check.decoded?.toFixed(1) ?? "?"} of ${check.duration?.toFixed(1) ?? "?"} s, source ${expectedSeconds.toFixed(1)} s)`,
    };
  }
  rmSync(target, { force: true });
  renameSync(partial, target);
  return { ok: true, check };
}

const CONCAT_FILE = "screen.concat.txt";

/**
 * Writes into analysis-track.json the second of screen.mp4 at which each
 * track segment's screen segment begins (the ffconcat layout), so that a
 * restarted capture's tracks can be placed on the joined video. Segments
 * whose screen file is not in screen.mp4 get none. joinedScreenFiles lists
 * every segment in screen.mp4, so that a track missing later segments
 * (branch disabled mid-game) is refused instead of ending early.
 */
export function placeAnalysisSegments(
  dir: string,
  placed: { file: string; start: number }[],
) {
  const file = join(dir, ANALYSIS_TRACK_MANIFEST);
  const manifest = readJson(file) as
    | {
        joinedScreenFiles?: string[];
        segments?: { screenFile?: string; videoStartSeconds?: number }[];
      }
    | undefined;
  if (!manifest || !Array.isArray(manifest.segments)) return;
  try {
    manifest.joinedScreenFiles = placed.map((p) => p.file);
    for (const segment of manifest.segments) {
      const at = placed.find((p) => p.file === segment.screenFile);
      if (at) segment.videoStartSeconds = at.start;
      else delete segment.videoStartSeconds;
    }
    writeJsonAtomic(file, manifest);
  } catch {
    // The track is experimental: never fail the video for it.
  }
}

/**
 * Turns the recorded segment(s) into one screen.mp4, aligns it with the game
 * clock, writes screen.json and removes screen.recording.json. Each .mkv is
 * deleted only after the MP4 that contains it passed its decode check.
 * Returns null if nothing was captured.
 */
export async function finalizeVideo(options: {
  ffmpeg: string;
  dir: string;
  recording: CaptureRecording;
  samples: readonly ClockSample[];
  log: Log;
}): Promise<ScreenInfo | null> {
  const { ffmpeg, dir, recording, samples, log } = options;
  const done = (screen: ScreenInfo | null) => {
    if (screen) writeJsonAtomic(join(dir, "screen.json"), screen);
    rmSync(join(dir, RECORDING_FILE), { force: true });
    return screen;
  };
  const clockFields = (startedAtMs: number, duration: number | null) => {
    const clock = computeClockOffset(samples, startedAtMs, duration);
    return {
      clockOffsetSeconds: clock.offset,
      clockOffsetSpread: clock.spread,
      clockOffsetSamples: clock.count,
    };
  };
  const base = {
    encoder: recording.encoder,
    fps: recording.fps,
    monitor: recording.monitor,
    ...(recording.area ? { area: recording.area } : {}),
    dropFrames: recording.segments.reduce((sum, s) => sum + s.dropFrames, 0),
  };
  const sourceOf = (segment: CaptureSegment) =>
    segment.startedAtMs === null
      ? ("process-start" as const)
      : ("ffmpeg-progress" as const);

  const parts: Part[] = [];
  for (const segment of recording.segments) {
    const part = await inspectSegment(ffmpeg, dir, segment);
    if (part) parts.push(part);
  }
  if (!parts.length) {
    // Interrupted after screen.mp4 was complete but before screen.json.
    const first = recording.segments.find((s) => s.startedAtMs !== null);
    if (!first || !existsSync(join(dir, VIDEO_FILE))) return done(null);
    const check = await checkDecodes(ffmpeg, join(dir, VIDEO_FILE));
    return done({
      file: VIDEO_FILE,
      ...base,
      width: check.width,
      height: check.height,
      startedAtMs: first.startedAtMs!,
      startedAtSource: "ffmpeg-progress",
      durationSeconds: check.duration,
      ...clockFields(first.startedAtMs!, check.duration),
      remuxed: true,
      gaps: [],
    });
  }

  const first = parts[0];
  const sameSize = parts.every(
    (p) => p.width === first.width && p.height === first.height,
  );
  const layout = layoutSegments(
    parts.map((p) => ({
      file: p.segment.file,
      startedAtMs: p.startedAtMs,
      durationSeconds: p.seconds,
    })),
    1 / recording.fps,
  );
  let joined: Produced;
  if (parts.length === 1)
    joined = await produceMp4(
      ffmpeg,
      dir,
      ["-i", first.mkv],
      first.seconds,
      VIDEO_FILE,
    );
  else if (!sameSize)
    joined = { ok: false, error: "the screen resolution changed mid-game" };
  else {
    const list = join(dir, CONCAT_FILE);
    writeFileSync(
      list,
      concatScript(
        parts.map((p) => ({
          file: p.segment.file,
          startedAtMs: p.startedAtMs,
          durationSeconds: p.seconds,
        })),
        layout.starts,
      ),
    );
    joined = await produceMp4(
      ffmpeg,
      dir,
      ["-f", "concat", "-safe", "0", "-i", list],
      layout.totalSeconds,
      VIDEO_FILE,
    );
    rmSync(list, { force: true });
  }

  if (joined.ok) {
    placeAnalysisSegments(
      dir,
      parts.map((p, i) => ({ file: p.segment.file, start: layout.starts[i] })),
    );
    for (const part of parts) rmSync(part.mkv, { force: true });
    const duration = joined.check.duration;
    log(
      `Saved ${VIDEO_FILE} (${duration!.toFixed(1)} s, lossless remux${parts.length > 1 ? ` of ${parts.length} capture segments` : ""}).`,
    );
    return done({
      file: VIDEO_FILE,
      ...base,
      width: joined.check.width ?? first.width,
      height: joined.check.height ?? first.height,
      startedAtMs: first.startedAtMs,
      startedAtSource: sourceOf(first.segment),
      durationSeconds: duration,
      ...clockFields(first.startedAtMs, duration),
      remuxed: true,
      gaps: layout.gaps,
    });
  }

  if (parts.length === 1) {
    // The .mkv is kept and stays the session's video.
    log(`Kept ${first.segment.file}: ${joined.error}`);
    return done({
      file: first.segment.file,
      ...base,
      width: first.width,
      height: first.height,
      startedAtMs: first.startedAtMs,
      startedAtSource: sourceOf(first.segment),
      durationSeconds: first.seconds,
      ...clockFields(first.startedAtMs, first.seconds),
      remuxed: false,
      gaps: [],
      error: joined.error,
    });
  }

  // Segments that cannot be joined: the longest becomes screen.mp4, the
  // others are kept next to it, each with its own clock offset.
  log(`Could not join the capture segments (${joined.error}).`);
  type Kept = Part & { file: string; duration: number; remuxed: boolean };
  const kept: Kept[] = [];
  let primary: Kept | null = null;
  for (const part of [...parts].sort((a, b) => b.seconds - a.seconds)) {
    const name = primary ? `screen-${part.segment.index}.mp4` : VIDEO_FILE;
    const result = await produceMp4(
      ffmpeg,
      dir,
      ["-i", part.mkv],
      part.seconds,
      name,
    );
    if (result.ok) rmSync(part.mkv, { force: true });
    else log(`Kept ${part.segment.file}: ${result.error}`);
    const entry: Kept = {
      ...part,
      file: result.ok ? name : part.segment.file,
      duration: (result.ok && result.check.duration) || part.seconds,
      remuxed: result.ok,
    };
    kept.push(entry);
    if (result.ok && !primary) primary = entry;
  }
  const main = primary ?? kept[0];
  log(
    `Saved ${main.file} (${main.duration.toFixed(1)} s) and ${kept.length - 1} separate file(s).`,
  );
  return done({
    file: main.file,
    ...base,
    width: main.width,
    height: main.height,
    startedAtMs: main.startedAtMs,
    startedAtSource: sourceOf(main.segment),
    durationSeconds: main.duration,
    ...clockFields(main.startedAtMs, main.duration),
    remuxed: main.remuxed,
    gaps: [],
    extraFiles: kept
      .filter((k) => k !== main)
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .map((k) => {
        const clock = clockFields(k.startedAtMs, k.duration);
        return {
          file: k.file,
          startedAtMs: k.startedAtMs,
          durationSeconds: k.duration,
          clockOffsetSeconds: clock.clockOffsetSeconds,
          clockOffsetSpread: clock.clockOffsetSpread,
          width: k.width,
          height: k.height,
        };
      }),
    error: `Capture restarted and the parts could not be joined (${joined.error}); ${main.file} is the longest part.`,
  });
}

/** Recording metadata left behind by a companion that crashed or was killed. */
export function readRecording(dir: string): CaptureRecording | null {
  const raw = readJson(join(dir, RECORDING_FILE)) as
    CaptureRecording | undefined;
  return raw && Array.isArray(raw.segments) && typeof raw.encoder === "string"
    ? raw
    : null;
}
