// The companion: waits for a League game, records the Live Client Data API
// (src/lib/live/session.ts) and the screen (capture.ts), finalizes one
// session folder when the game ends, hands it to the post-game hooks (local
// review, match download, minimap analysis: post-game.ts), then waits for the
// next game. Post-game review only: nothing is shown in game,
// and the game process is never touched (official local API + Desktop
// Duplication, like OBS or ShadowPlay). See doc/COMPANION.md.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { liveGamesOnly } from "./live-games-only";
import { recordedQueuesOnly } from "./recorded-queues";
import { claimCompanionLock } from "./companion-lock";
import {
  createLiveClient,
  EndReason,
  endMessage,
  LiveSessionInfo,
  readSamples,
  recordLiveSession,
  Stopper,
} from "../live/session";
import { LiveSample } from "../live/types";
import {
  finalizeVideo,
  probeEncoder,
  readRecording,
  ScreenInfo,
  ScreenRecorder,
} from "./capture";
import { SPREAD_WARNING_SECONDS } from "./clock";
import { isStaleControl, parseStopRequest } from "./control";
import { CaptureArea, EncoderName } from "./encoder";
import { lcuRequest } from "./league-client";
import type { AnalysisTrackProfile } from "./analysis-track";
import { MASKED_FILE, writeMaskedScreen } from "./masked-screen";
import type { PostGame } from "./post-game";
import { grabFrame, minimapArea } from "./minimap-area";
import { lowerPriority } from "./process";
import { gameDisplay } from "./game-display";
import { gapSeconds } from "./segments";
import {
  analysisCanContinue,
  CompanionEvent,
  initialMachine,
  shouldAnalyze,
  transition,
} from "./state";
import {
  initialStatus,
  pidAlive,
  readJson,
  runningInstance,
  StatusWriter,
} from "./status";

export type Log = (message: string) => void;
export const timestamped: Log = (message) =>
  console.log(`[${new Date().toISOString()}] ${message}`);

export type VideoOptions = {
  enabled: boolean;
  /** ffmpeg binary (ffmpeg-static by default). */
  ffmpeg: string | null;
  fps: number;
  /** ddagrab output_idx. */
  monitor: number;
  autoMonitor?: boolean;
  /** Tried first; the usual fallback order follows. */
  encoder?: EncoderName;
  /** Record only the minimap square, found on screen at game start. */
  minimapOnly: boolean;
  /** The minimap square, when given instead of found (--area). */
  area?: CaptureArea;
  /** After the game, also write masked.mp4: only the surfaces Rekap reads (masked-screen.ts). */
  masked?: boolean;
  /** Experimental; never selected automatically for analysis. */
  analysisProfile?: AnalysisTrackProfile;
};

/** How often --minimap-only looks for the minimap until it is on screen. */
const LOCATE_EVERY_MS = 5_000;

const describeArea = (a: CaptureArea) =>
  `${a.width}x${a.height} at (${a.x}, ${a.y})`;

/**
 * The minimap square of the current screen, or null. Locating takes about a
 * second of this process's time, once per game.
 */
async function locateOnScreen(ffmpeg: string, monitor: number) {
  const found = minimapArea(await grabFrame(ffmpeg, monitor));
  return found
    ? {
        area: {
          x: found.x,
          y: found.y,
          width: found.width,
          height: found.height,
        },
        score: found.score,
      }
    : null;
}

export type CompanionOptions = {
  url: URL;
  interval: number;
  endAfter: number;
  disconnectGraceMs?: number;
  /** Session folders (.data/live). */
  outDir: string;
  label: string;
  /** status.json and control.json (.data/companion). */
  statusDir: string;
  video: VideoOptions;
  /** Repository root, for scripts/companion/game-display.ps1. */
  root: string;
  /** Review, match download and analysis; none means record only. */
  postGame: PostGame;
  /** Process start (ms); stop requests older than this are ignored. */
  startedAtMs: number;
  expectedRiotId?: string;
  log?: Log;
};

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function describeScreen(screen: ScreenInfo): string[] {
  const offset =
    screen.clockOffsetSeconds === null
      ? "no clock offset (no samples during the video)"
      : `game time = video time ${screen.clockOffsetSeconds >= 0 ? "+" : "-"} ${Math.abs(screen.clockOffsetSeconds).toFixed(2)} s (spread ${screen.clockOffsetSpread?.toFixed(2)} s)`;
  const lines = [
    `Video ${screen.file}: ${screen.width}x${screen.height}, ${screen.durationSeconds?.toFixed(1)} s, ${screen.encoder}; ${offset}.`,
  ];
  if ((screen.clockOffsetSpread ?? 0) > SPREAD_WARNING_SECONDS)
    lines.push(
      "  The clock offset is not constant (pause, reconnect or capture stall): video/game alignment is approximate.",
    );
  if (screen.gaps.length)
    lines.push(
      `  Capture restarted ${screen.gaps.length} time(s): ${gapSeconds(screen.gaps).toFixed(1)} s of the video show a frozen frame (${screen.gaps.map((g) => `${g.startSeconds.toFixed(1)}–${g.endSeconds.toFixed(1)} s`).join(", ")}).`,
    );
  if (screen.extraFiles?.length)
    lines.push(
      `  Separate capture files: ${screen.extraFiles.map((f) => f.file).join(", ")}.`,
    );
  if (screen.error) lines.push(`  ${screen.error}`);
  return lines;
}

type Game = {
  info: LiveSessionInfo;
  samples: LiveSample[];
  capture: Promise<ScreenRecorder | null>;
};

export async function runCompanion(options: CompanionOptions): Promise<number> {
  const log = options.log ?? timestamped;
  const { video, statusDir } = options;
  const statusPath = join(statusDir, "status.json");
  const controlPath = join(statusDir, "control.json");
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(options.outDir, { recursive: true });

  // Exclusive, unlike status.json: two companions started together cannot both run.
  const lock = claimCompanionLock(join(statusDir, "companion.lock"), {
    isAlive: pidAlive,
    ageMs: (file) => {
      try {
        return Date.now() - statSync(file).mtimeMs;
      } catch {
        return null;
      }
    },
  });
  if ("holder" in lock) {
    console.error(
      `Another companion is already running (pid ${lock.holder.pid}, started ${lock.holder.startedAt}). Stop it first (Ctrl+C in its window, or the app's stop button).`,
    );
    return 1;
  }
  process.once("exit", lock.release);
  const other = runningInstance(readJson(statusPath), {
    now: Date.now(),
    selfPid: process.pid,
    isAlive: pidAlive,
  });
  if (other) {
    lock.release();
    console.error(
      `Another companion is already running (pid ${other.pid}, ${other.state}, updated ${other.updatedAt}). Stop it first (Ctrl+C in its window, or the app's stop button).`,
    );
    return 1;
  }

  let statusErrorShown = false;
  const status = new StatusWriter(
    statusPath,
    {
      ...initialStatus(process.pid),
      ...(process.env.RIFTRECALL_AUTO_ACCOUNT
        ? { automatic: true, accountId: process.env.RIFTRECALL_AUTO_ACCOUNT }
        : {}),
      ...(process.env.RIFTRECALL_RECORDER_OWNER
        ? { owner: process.env.RIFTRECALL_RECORDER_OWNER }
        : {}),
    },
    {
      onError: (error) => {
        if (!statusErrorShown)
          log(`Cannot write ${statusPath}: ${errorText(error)}`);
        statusErrorShown = true;
      },
    },
  );
  status.start();
  lowerPriority();
  if (isStaleControl(readJson(controlPath), options.startedAtMs))
    rmSync(controlPath, { force: true });

  let machine = initialMachine();
  const dispatch = (event: CompanionEvent) => {
    const before = machine.state;
    machine = transition(machine, event);
    if (machine.state !== before) {
      log(`State: ${before} -> ${machine.state}`);
      status.update({ state: machine.state });
    }
  };
  const fail = (message: string) => {
    log(message);
    status.update({ lastError: message });
  };

  const poll = new Stopper(); // ends the Live Client polling loop
  const background = new Stopper(); // post-game background work
  const { postGame } = options;
  const mapEnabled = Boolean(postGame.analysis);
  const runner = postGame.analysis?.runner ?? null;
  const analysisQueue: string[] = [];
  let analysis: Promise<void> | null = null;
  let current: Game | null = null;
  let stopByControl = false;
  let captures: ScreenRecorder[] = [];
  let pumpRequests = () => {};

  const requestStop = (analyze: boolean, source: string) => {
    if (machine.stopping) return;
    log(
      `Stop requested (${source})${analyze ? ", minimap analysis first" : ""}; finishing up…`,
    );
    dispatch({ type: "STOP_REQUESTED", analyze });
    // Ctrl+C in a Windows console also reaches ffmpeg, which then exits by
    // itself: that is part of this stop, not a capture failure.
    for (const capture of captures) capture.expectStop();
    poll.stop();
    background.stop();
    if (!analyze) runner?.interrupt();
  };

  // Control file from the web app (it cannot send Ctrl+C on Windows).
  const controlTimer = setInterval(() => {
    if (machine.stopping) return;
    pumpRequests();
    if (!existsSync(controlPath)) return;
    const request = parseStopRequest(
      readJson(controlPath),
      options.startedAtMs,
    );
    if (!request) return;
    stopByControl = true;
    requestStop(request.analyze, "control.json");
  }, 1000);

  const onSignal = () => {
    if (!machine.stopping) return requestStop(false, "Ctrl+C");
    // Second Ctrl+C: leave now. Unfinished .mkv files are recovered next start.
    for (const capture of captures) capture.kill();
    runner?.interrupt();
    status.close({
      state: "stopped",
      lastError:
        "Stopped immediately; an unfinished recording is recovered on the next start.",
    });
    console.log("\nStopped.");
    process.exit(130);
  };
  // SIGHUP: the console window was closed (Windows then allows ~10 s; what
  // is not finished by then is recovered on the next start).
  const signals = ["SIGINT", "SIGBREAK", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, onSignal);

  // Screen encoder: probed once now, again at game start if nothing worked.
  let encoder: EncoderName | null = null;
  const probe = async () => {
    if (!video.enabled) return null;
    if (!video.ffmpeg) {
      fail(
        "ffmpeg-static has no binary for this platform; recording without video.",
      );
      return null;
    }
    const result = await probeEncoder(video.ffmpeg, {
      fps: video.fps,
      monitor: video.monitor,
      preferred: video.encoder,
    });
    if (result.listError) log(`  ${result.listError}; trying every encoder.`);
    for (const attempt of result.attempts)
      log(
        `  encoder ${attempt.encoder}: ${attempt.ok ? "ok" : `unavailable (${attempt.error})`} [${attempt.ms} ms]`,
      );
    if (!result.encoder)
      fail(
        "No working H.264 encoder/screen capture (see the log); recording the game data without video.",
      );
    else status.update({ encoder: result.encoder });
    return result.encoder;
  };

  // --minimap-only: the minimap is not on screen during the loading screen,
  // so it is looked for every few seconds until found or the game ends.
  const findArea = async (ffmpeg: string): Promise<CaptureArea | null> => {
    if (video.area) return video.area;
    let tries = 0;
    while (machine.state === "recording" && !machine.stopping) {
      try {
        const found = await locateOnScreen(ffmpeg, video.monitor);
        if (found) {
          log(
            `Minimap found: ${describeArea(found.area)} (match ${found.score.toFixed(2)}); recording only that square.`,
          );
          return found.area;
        }
      } catch (error) {
        if (tries === 0)
          log(
            `Could not grab a frame to find the minimap: ${errorText(error)}`,
          );
      }
      if (tries++ === 0)
        log("Minimap not on screen yet; looking again every 5 s.");
      await new Promise((done) => setTimeout(done, LOCATE_EVERY_MS));
    }
    return null;
  };

  const startCapture = async (dir: string) => {
    if (!video.enabled || !video.ffmpeg) return null;
    if (video.autoMonitor) {
      let detected: number | null = null;
      while (machine.state === "recording" && !machine.stopping) {
        detected = await gameDisplay(options.root);
        if (detected !== null) break;
        status.update({
          lastError:
            "Écran LoL introuvable. Affiche la fenêtre du jeu ; l’enregistrement commencera dès qu’elle sera détectée.",
        });
        await poll.sleep(5000);
      }
      if (detected === null) return null;
      if (video.monitor !== detected) encoder = null;
      video.monitor = detected;
      status.update({ lastError: null });
      log(`League screen detected: output ${detected}.`);
    }
    encoder ??= await probe();
    if (!encoder || machine.state !== "recording" || machine.stopping)
      return null;
    const area = video.minimapOnly ? await findArea(video.ffmpeg) : undefined;
    if (area === null || machine.state !== "recording" || machine.stopping)
      return null;
    if (video.analysisProfile && (encoder !== "h264_nvenc" || area))
      log("Experimental analysis track skipped: full-screen NVENC is required.");
    const recorder = new ScreenRecorder(
      video.ffmpeg,
      {
        encoder,
        fps: video.fps,
        monitor: video.monitor,
        ...(area ? { area } : {}),
        ...(video.analysisProfile && encoder === "h264_nvenc" && !area ? {analysisProfile: video.analysisProfile} : {}),
      },
      dir,
      log,
      (message) => status.update({ lastError: message }),
    );
    captures.push(recorder);
    recorder.start();
    return recorder;
  };

  const idleStatus = () =>
    status.update({
      session: null,
      champion: null,
      gameTime: null,
      startedAt: null,
    });

  const runAnalyses = () => {
    if (analysis) return;
    analysis = (async () => {
      while (runner && postGame.analysis && analysisQueue.length && analysisCanContinue(machine)) {
        const { logName } = postGame.analysis;
        const dir = analysisQueue.shift()!;
        status.update({analysisSession: basename(dir),lastError:null});
        if (machine.state === "analyzing")
          status.update({
            session: basename(dir),
            champion: null,
            gameTime: null,
          });
        log(`Minimap analysis of ${dir} (log: ${logName})…`);
        const result = await runner.run(dir);
        status.update({analysisSession: null});
        if (result.interrupted) break;
        if (result.code === 0) log("Minimap analysis finished.");
        else
          fail(
            `Minimap analysis failed (${result.error ?? `exit code ${result.code}`}); see ${join(dir, logName)}.`,
          );
        dispatch({
          type: "ANALYSIS_FINISHED",
          more: analysisQueue.length > 0,
        });
      }
      if (machine.state === "waiting" || machine.state === "analyzing")
        idleStatus();
    })().finally(() => {
      analysis = null;
    });
  };

  pumpRequests = () => {
    if (!postGame.analysis || !runner?.available) return;
    for (const dir of postGame.analysis.takeRequests()) {
      if (!analysisQueue.includes(dir) && runner.current !== dir) analysisQueue.push(dir);
    }
    if (analysisQueue.length && machine.state !== "finalizing") {
      dispatch({type:"ANALYSIS_REQUESTED"});
      runAnalyses();
    }
  };

  const finishGame = async (game: Game, reason: EndReason) => {
    dispatch({ type: "GAME_ENDED" });
    const { dir } = game.info;
    log(endMessage(reason, options.endAfter));
    const capture = await game.capture;
    const recording = capture ? await capture.stop() : null;
    captures = captures.filter((c) => c !== capture);
    if (postGame.review && game.samples.length) {
      try {
        postGame.review.write(dir, game.samples);
        log(`Saved report.md and report.json in ${dir}`);
      } catch (error) {
        fail(`Could not write the report: ${errorText(error)}`);
      }
    }
    let hasVideo = false;
    if (recording && video.ffmpeg) {
      try {
        const screen = await finalizeVideo({
          ffmpeg: video.ffmpeg,
          dir,
          recording,
          samples: game.samples,
          log,
        });
        if (!screen) fail("The screen capture produced no video.");
        else {
          hasVideo = true;
          for (const line of describeScreen(screen)) log(line);
          if (screen.error) status.update({ lastError: screen.error });
          if (video.masked && !screen.area && screen.width && screen.height && screen.durationSeconds)
            await writeMaskedScreen({
              ffmpeg: video.ffmpeg,
              input: join(dir, screen.file),
              output: join(dir, MASKED_FILE),
              screen: { width: screen.width, height: screen.height, durationSeconds: screen.durationSeconds },
            })
              .then((result) => log("skipped" in result ? `No ${MASKED_FILE}: ${result.skipped}` : `Saved ${MASKED_FILE} (${result.regions.map((r) => r.name).join(", ")} kept).`))
              .catch((error) => fail(`Masked video failed: ${errorText(error)}`));
        }
      } catch (error) {
        fail(`Video finalization failed: ${errorText(error)}`);
      }
    }
    status.update({ lastSession: game.info.name });
    if (postGame.afterGame && game.samples.length)
      void postGame
        .afterGame({
          dir,
          gameMode: game.info.gameMode,
          first: game.samples[0],
          stopper: background,
          log,
        })
        .catch((error) => log(`Post-game step failed: ${errorText(error)}`));
    const scriptExists = runner?.available ?? false;
    if (postGame.analysis && hasVideo && !scriptExists)
      log(`${postGame.analysis.name} not found; skipping minimap analysis.`);
    const wanted = { mapEnabled, scriptExists };
    if (shouldAnalyze(machine, { ...wanted, hasVideo }) && !analysisQueue.includes(dir) && runner?.current !== dir)
      analysisQueue.push(dir);
    // Only one analysis worker runs; new recordings join its queue.
    const analyze =
      analysisQueue.length > 0 &&
      shouldAnalyze(machine, { ...wanted, hasVideo: true });
    dispatch({ type: "FINALIZED", analyze });
    if (machine.state === "analyzing") runAnalyses();
    else idleStatus();
  };

  // Finish sessions a crashed or killed companion left behind.
  const recover = async () => {
    let names: string[] = [];
    try {
      names = readdirSync(options.outDir).filter((name) =>
        statSync(join(options.outDir, name)).isDirectory(),
      );
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(options.outDir, name);
      const recording = readRecording(dir);
      const hasSamples = existsSync(join(dir, "samples.ndjson"));
      const needsReport =
        Boolean(postGame.review) &&
        hasSamples &&
        !existsSync(join(dir, postGame.review!.file));
      if (!recording && !needsReport) continue;
      log(`Recovering the unfinished session ${name}…`);
      status.update({ state: "finalizing", session: name });
      try {
        const samples = hasSamples ? readSamples(dir).samples : [];
        if (samples.length && needsReport) {
          postGame.review!.write(dir, samples);
          log(`Saved report.md and report.json in ${dir}`);
        }
        if (recording && video.ffmpeg) {
          const screen = await finalizeVideo({
            ffmpeg: video.ffmpeg,
            dir,
            recording,
            samples,
            log,
          });
          if (screen) for (const line of describeScreen(screen)) log(line);
        }
      } catch (error) {
        fail(`Could not recover ${name}: ${errorText(error)}`);
      }
      status.update({ state: machine.state, session: null, lastSession: name });
    }
  };

  const liveClient = createLiveClient(options.url);
  const replayClient = createLiveClient(new URL("https://127.0.0.1:2999/replay/game"));
  // Only Solo/Duo, Flex and Draft games: the League client names the queue.
  const leagueQueue = async () => {
    const session = await lcuRequest<{ gameData?: { queue?: { id?: number } } }>("/lol-gameflow/v1/session");
    const id = session?.gameData?.queue?.id;
    // Customs and practice report 0 or -1: a real answer, never recorded.
    return typeof id === "number" ? id : null;
  };
  const client = recordedQueuesOnly(liveGamesOnly(liveClient, replayClient), leagueQueue, log);
  let exitCode = 0;
  try {
    log(
      `Rekap companion (pid ${process.pid}). Post-game review only: nothing is shown in game.`,
    );
    await recover();
    if (video.enabled && !video.autoMonitor && !machine.stopping) {
      log("Checking screen capture and encoders…");
      encoder = await probe();
      if (encoder)
        log(
          `Screen capture ready: ${encoder}, ${video.fps} fps, monitor ${video.monitor}${video.minimapOnly ? `, minimap only (${video.area ? describeArea(video.area) : "found at game start"})` : ""}.`,
        );
    } else if (!video.enabled) log("Video recording is off (--no-video).");
    log(
      `Waiting for a League game at ${options.url.origin} (Ctrl+C to stop). Everything stays on this computer.`,
    );
    while (!poll.stopped) {
      let reason: EndReason = "INTERRUPTED";
      current = null;
      try {
        const result = await recordLiveSession(
          {
            client,
            interval: options.interval,
            endAfter: options.endAfter,
            disconnectGraceMs: options.disconnectGraceMs ?? 120_000,
            outDir: options.outDir,
            label: options.label,
            expectedRiotId: options.expectedRiotId,
            stopper: poll,
            log,
          },
          {
            onStart: (info, first) => {
              dispatch({ type: "GAME_STARTED" });
              status.update({
                session: info.name,
                champion: info.champion,
                startedAt: iso(info.startedAtMs),
                gameTime: first.gameTime,
                lastError: null,
              });
              const capture = startCapture(info.dir).catch((error) => {
                fail(`Screen capture failed to start: ${errorText(error)}`);
                return null;
              });
              current = { info, samples: [], capture };
            },
            onSample: (sample) => {
              current?.samples.push(sample);
              status.update({ gameTime: sample.gameTime });
            },
          },
        );
        if (result) reason = result.reason;
      } catch (error) {
        fail(`Recording error: ${errorText(error)}`);
        if (!current) await poll.sleep(5000);
      }
      const game = current as Game | null;
      if (game) await finishGame(game, reason);
    }
    if (analysis) {
      if (machine.analyzeOnStop)
        log("Waiting for the minimap analysis to finish…");
      await analysis;
    }
  } catch (error) {
    exitCode = 1;
    fail(`Companion error: ${errorText(error)}`);
  } finally {
    clearInterval(controlTimer);
    for (const signal of signals) process.off(signal, onSignal);
    client.close();
    background.stop();
    if (stopByControl) rmSync(controlPath, { force: true });
    status.close({
      state: "stopped",
      session: null,
      champion: null,
      gameTime: null,
      startedAt: null,
    });
    log("Companion stopped.");
    lock.release();
  }
  return exitCode;
}

/**
 * Records `seconds` of desktop with the same pipeline as a game, for checking
 * capture, encoder and file size without League running.
 */
export async function runCaptureTest(options: {
  video: VideoOptions;
  dir: string;
  seconds: number;
  log?: Log;
}): Promise<ScreenInfo | null> {
  const log = options.log ?? timestamped;
  const { video } = options;
  if (!video.ffmpeg) throw new Error("ffmpeg-static has no binary here.");
  rmSync(options.dir, { recursive: true, force: true });
  mkdirSync(options.dir, { recursive: true });
  const { encoder, attempts, listError } = await probeEncoder(video.ffmpeg, {
    fps: video.fps,
    monitor: video.monitor,
    preferred: video.encoder,
  });
  if (listError) log(`  ${listError}; trying every encoder.`);
  for (const attempt of attempts)
    log(
      `  encoder ${attempt.encoder}: ${attempt.ok ? "ok" : `unavailable (${attempt.error})`} [${attempt.ms} ms]`,
    );
  if (!encoder) throw new Error("No working H.264 encoder/screen capture.");
  let area = video.area;
  if (video.minimapOnly && !area) {
    const found = await locateOnScreen(video.ffmpeg, video.monitor);
    if (!found)
      throw new Error(
        "Minimap not found on screen: open a game or a replay, or pass --area x,y,size.",
      );
    area = found.area;
  }
  if (area) log(`Recording only ${describeArea(area)}.`);
  const stopper = new Stopper();
  const onSignal = () => stopper.stop();
  process.on("SIGINT", onSignal);
  const recorder = new ScreenRecorder(
    video.ffmpeg,
    {
      encoder,
      fps: video.fps,
      monitor: video.monitor,
      ...(area ? { area } : {}),
      ...(video.analysisProfile && encoder === "h264_nvenc" && !area ? {analysisProfile: video.analysisProfile} : {}),
    },
    options.dir,
    log,
  );
  log(
    `Recording ${options.seconds} s of monitor ${video.monitor} with ${encoder} (Ctrl+C ends early)…`,
  );
  recorder.start();
  await stopper.sleep(options.seconds * 1000);
  const recording = await recorder.stop();
  process.off("SIGINT", onSignal);
  return finalizeVideo({
    ffmpeg: video.ffmpeg,
    dir: options.dir,
    recording,
    samples: [],
    log,
  });
}
