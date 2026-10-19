// Replay capture (doc/REPLAY.md): records one game of a League replay under one
// team's fog of war and keeps only the stable spectator elements as small
// videos (minimap, team frames with names blacked out, top bar, scoreboard,
// the followed player's panel). Shared by the research queue
// (replay-queue.ts, private: game choice, rotation, sharing) and the import of
// one's own replay (own-replay.ts, run on the player's PC). Moved from
// replay-queue.ts on 2026-10-12 without changing what it does.
import { spawn } from "node:child_process";
import { isDownloadedReplay, replayQueueMessage } from "../../src/lib/replay/own-game";
import { FOCUS_ATTEMPTS, pressFocused } from "../../src/lib/replay/focus";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { locateMinimap, LocateResult } from "../../src/lib/map/perception/locate";
import { crop, Raster, rasterPng } from "../../src/lib/map/perception/raster";
import { baseLight, fogSide } from "../../src/lib/replay/fog";
import { panelGaps, showsPanel } from "../../src/lib/replay/panel";
import { findSelectedPanel, type SelectionSample } from "../../src/lib/replay/selection";
import { fitFramesArgs, pngSize, screenFit, type AnchoredBox } from "../../src/lib/companion/screen-fit";
import { readDisplay, REPLAY_DISPLAY, sameDisplay, withDisplay, type Display } from "../../src/lib/replay/replay-display";
import {
  Box,
  Candidate,
  acceptsEndStall,
  captureLabels,
  frozenFrom,
  isGameFault,
  minimalInterface,
  PANEL_SEARCH_1080,
  REPEATED_FRAMES,
  Role,
  SCOREBOARD_SHOWN,
  scoreboardBorder,
  SPECTATOR_LAYOUT_1080,
  frameNameMask,
  Team,
  gameCfgValue,
  REPLAY_GAME_CFG,
  withReplaySettings,
} from "../../src/lib/replay/queue";
import { hostname } from "node:os";

import {
  ensureReplayDownloaded,
  launchReplay,
  lcuRequest,
  assertCurrentReplayAccount,
  ReplayRecording,
  replayRequest,
  ReplayServiceUnreachable,
  waitFor,
} from "../dataset/replay";
import {
  assertClientIdle,
  closeReplayClient,
  focusGame,
  gameProcessIds,
  numericGameId,
  Playback,
  pngRaster,
  pressKeys,
  ReplayMatch,
  ReplayParticipant,
  replayApiUp,
  replayProcessId,
  replaySeed,
  sleep,
  userIdleSeconds,
} from "./replay-client";

import { writeCooldowns } from "./replay-cooldown-reader";

export type CaptureOptions = {
  /** Dataset folder: games/<matchId>/match.json in, replays/<id>/ out, replay-work/ scratch. */
  root: string;
  fps: number;
  minFreeBytes: number;
  /** Game second of the fog check. */
  fogCheckAt: number;
  /** Seconds without keyboard or mouse before a replay opens or resumes. */
  idleSeconds: number;
  stallSeconds: number;
  endStallSeconds: number;
  /** Spectator keys for team 1, team 2 and all, e.g. "f1,f2,f3"; the gold mode key. */
  fogKeys: string;
  goldKey: string;
  keepWorld: boolean;
  keepRofl: boolean;
  /** The player's own replay (desktop import): no download, no deletion, account checked locally. */
  own?: { puuid: string; riotId: string };
};
let fps = 2;
let minFree = 30e9;
let fogCheckAt = 90;
let idleSeconds = 120;
let stallMs = 90_000;
let endStallSeconds = 120;
let root = "";
let gamesDir = "";
let replaysDir = "";
// While this file exists the queue opens and resumes nothing.
let pauseFile = "";
let keepWorld = false;
let keepRofl = false;
let ownPuuid: string | undefined;
let ownRiotId = "";

/** Sets what every capture of this run uses; call once, before anything else. */
export function configureCapture(o: CaptureOptions) {
  if (!Number.isFinite(o.endStallSeconds) || o.endStallSeconds < 0)
    throw new Error("--end-stall-seconds must be a finite non-negative number (0 disables recovery).");
  if (o.own && !o.own.riotId.includes("#")) throw new Error("Own replay capture needs the Riot ID as name#tag.");
  fps = o.fps;
  minFree = o.minFreeBytes;
  fogCheckAt = o.fogCheckAt;
  idleSeconds = o.idleSeconds;
  stallMs = o.stallSeconds * 1000;
  endStallSeconds = o.endStallSeconds;
  root = path.resolve(o.root);
  gamesDir = path.join(root, "games");
  replaysDir = path.join(root, "replays");
  pauseFile = path.join(root, "replay-queue.pause");
  keepWorld = o.keepWorld;
  keepRofl = o.keepRofl;
  ownPuuid = o.own?.puuid;
  ownRiotId = o.own?.riotId ?? "";
  [team1Keys, team2Keys, allKeys] = o.fogKeys.split(",").map(keyCombo);
  // evtSetVisibilityTeam1 is ORDER (blue), Team2 CHAOS (red), TeamNone "All".
  fogKeys = { 100: team1Keys, 200: team2Keys };
  goldKeys = keyCombo(o.goldKey);
}

const MAX_RESUMES = 20;
// How often a recording checks whether someone used the PC (each check runs PowerShell).
const INPUT_CHECK_MS = 10_000;
// How often a recording sets again what the game drops (the selected champion).
// Over the same 60 game seconds the panel showed in 107, 110 and 113 of 121
// frames with 250, 100 and 50 ms, at the same speed (EUW1_8004857210,
// 2026-10-05). The game drops the selection about every 10 game seconds; at
// 50 ms that costs one frame.
const WHILE_RECORDING_MS = 50;
// Within one recording, the replay is opened again after this many freezes at
// most, and never after two freezes this close in game time: the game that
// froze at 36:56 on 2026-10-04 played through 36:56 when recorded again.
const MAX_FREEZES_RECOVERED = 3;
const SAME_FREEZE_SECONDS = 10;
// Game seconds a resumed piece records before the frame it resumes at, and
// drops: the stale places lasted about 1 s (two frames); 10 s cost 2 s of real time.
const RESUME_LEAD_SECONDS = 10;
const gameCfg = path.join(
  process.env.LEAGUE_INSTALL_DIR ?? "C:\\Riot Games\\League of Legends",
  "Config",
  "game.cfg",
);

const SCANCODES: Record<string, number> = {
  ctrl: 0x1d,
  shift: 0x2a,
  alt: 0x38,
  x: 0x2d,
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, 0x3b + i]),
  ),
  f11: 0x57,
  f12: 0x58,
};
const keyCombo = (combo: string) =>
  combo.split("+").map((k) => {
    const code = SCANCODES[k.trim().toLowerCase()];
    if (code === undefined) throw new Error(`Unknown key "${k}" in --fog-keys`);
    return code;
  });
let team1Keys: number[] = [], team2Keys: number[] = [], allKeys: number[] = [];
let fogKeys: Record<Team, number[]> = { 100: [], 200: [] };
let goldKeys: number[] = [];

const time = () => new Date().toISOString().slice(11, 19);
export const log = (line: string) => {
  console.log(`[queue ${time()}] ${line}`);
  const message = ownPuuid ? replayQueueMessage(line) : null;
  if (message) console.log(`[replay-progress]${JSON.stringify(message)}`);
};

let stopReason: string | null = null;
export const stop = (reason: string) => {
  if (!stopReason) {
    stopReason = reason;
    log(`stopping: ${reason}`);
  }
};
/** Why the run is stopping, or null. */
export const stopped = () => stopReason;

/** A problem with the setup rather than the game: the queue stops. */
export class SetupError extends Error {}
/** A problem with this game's replay (not downloadable, incompatible): skip it. */
export class GameError extends Error {}
/** The League client cannot reach Riot's replay service: it is started again. */
export class ClientError extends Error {}
/** The game stopped advancing during a recording. */
export class StallError extends Error {
  constructor(
    message: string,
    /** Game second of the last frame known good. */
    readonly at = -Infinity,
    readonly salvageable = false,
    /** Nobody used the PC during the piece: the frames up to `at` are clean. */
    readonly untouched = false,
    /** The game time stopped, the game closed, or its picture froze. */
    readonly kind: "stall" | "crash" | "frozen" = "stall",
  ) {
    super(message);
  }
}

// The client ignores a request to open a replay for a few seconds after one
// was closed or killed (seen twice: the launch then times out after 90 s).
const CLOSE_COOLDOWN_MS = 15_000;
let lastClosedAt = 0;
// The game process of the replay this queue opened. A frozen replay does not
// answer the Replay API; with the League client closed as well, nothing was
// recorded for the rest of the night, since only this ID can then end it.
let openedReplay: number | null = null;
/**
 * Sets the game.cfg settings every recording needs (REPLAY_GAME_CFG: the
 * replay's scoreboard drawn in full, the minimap's camp countdowns). The game
 * reads the file when a replay starts, and no replay is open here. A missing
 * file is left alone: the check in setGoldMode stops the queue if it matters.
 * A player's own import sets only the scoreboard, as before: the camp timers
 * are a preference of their own game.
 */
async function setReplaySettings() {
  let cfg: string;
  try {
    cfg = readFileSync(gameCfg, "utf8");
  } catch {
    return;
  }
  const fixed = withReplaySettings(cfg, ownPuuid ? REPLAY_GAME_CFG.filter((s) => s.section === "Replay") : REPLAY_GAME_CFG);
  if (fixed === null) return;
  await writeFile(gameCfg, fixed.cfg);
  log(`set ${fixed.changed.join(", ")} in ${gameCfg}`);
}

/**
 * The REPLAY_GAME_CFG settings as game.cfg holds them after a recording
 * (null: absent or unreadable), kept in capture.json. A camp countdown
 * setting other than 1 is warned about: the client may have written the
 * account's own settings over the queue's, and the camp clocks are then
 * missing from the recording (doc/REPLAY.md).
 */
function replaySettingsNow(matchId: string): Record<string, string | null> {
  let cfg = "";
  try {
    cfg = readFileSync(gameCfg, "utf8");
  } catch {
    // Every value null.
  }
  const values = Object.fromEntries(REPLAY_GAME_CFG.map((s) => [s.key, cfg ? gameCfgValue(cfg, s.section, s.key) : null]));
  const off = REPLAY_GAME_CFG.filter((s) => s.section === "HUD" && values[s.key] !== s.value);
  if (off.length && !ownPuuid)
    log(
      `${matchId}: WARNING game.cfg has ${off.map((s) => `${s.key}=${values[s.key] ?? "absent"}`).join(", ")} after the recording: the minimap may show no camp clocks; turn the neutral camp timers on in League's interface settings`,
    );
  return values;
}

/**
 * Where the player's own window settings wait while an import forces 1920×1080
 * (replay-display.ts): beside the import jobs, so that an import that crashed
 * leaves them for the next one, which keeps them and restores them at its end.
 */
const displayRestoreFile = () => path.join(path.dirname(root), "replay-display-restore.json");

/** Own imports only: game.cfg set to 1920×1080 fullscreen before the replay opens. */
async function forceReplayDisplay() {
  if (!ownPuuid) return;
  let cfg: string;
  try {
    cfg = readFileSync(gameCfg, "utf8");
  } catch {
    return;
  }
  const current = readDisplay(cfg);
  if (sameDisplay(current, REPLAY_DISPLAY)) return;
  if (!existsSync(displayRestoreFile())) await writeFile(displayRestoreFile(), `${JSON.stringify(current)}\n`);
  await writeFile(gameCfg, withDisplay(cfg, REPLAY_DISPLAY));
  log(`game window set to 1920×1080 fullscreen for the replay (was ${current.Width ?? "?"}×${current.Height ?? "?"}, mode ${current.WindowMode ?? "?"})`);
}

/** Puts the player's window settings back once no replay is open. */
export async function restoreReplayDisplay() {
  if (!root || !existsSync(displayRestoreFile())) return;
  const saved = JSON.parse(readFileSync(displayRestoreFile(), "utf8")) as Display;
  await writeFile(gameCfg, withDisplay(readFileSync(gameCfg, "utf8"), saved));
  await rm(displayRestoreFile(), { force: true });
  log(`game window settings restored (${saved.Width ?? "?"}×${saved.Height ?? "?"}, mode ${saved.WindowMode ?? "?"})`);
}

/** Opens a replay and remembers its process. */
async function openReplay(gameId: string) {
  if (ownPuuid) {
    if (existsSync(path.join(root,"cancel"))) throw new SetupError("Récupération annulée.");
    await assertClientIdle();
    await assertCurrentReplayAccount(ownPuuid, ownRiotId);
    if ((await gameProcessIds()).length) throw new SetupError("Un jeu ou un replay est déjà ouvert : aucune fenêtre n’est fermée.");
  }
  await setReplaySettings();
  await forceReplayDisplay();
  await launchReplay(gameId);
  openedReplay = await replayProcessId();
}
/** True once no game client is left. */
export async function closeReplay() {
  const closed = await closeReplayClient(openedReplay, Boolean(ownPuuid)).catch(() => false);
  lastClosedAt = Date.now();
  if (closed) openedReplay = null;
  return closed;
}
async function afterCooldown() {
  const wait = lastClosedAt + CLOSE_COOLDOWN_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

export async function freeBytes() {
  const s = await statfs(root);
  return s.bavail * s.bsize;
}

const pngFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? pngFiles(path.join(dir, e.name))
        : e.name.endsWith(".png")
          ? [path.join(dir, e.name)]
          : [],
    )
    .sort();

/**
 * Index of the frame a piece's picture froze on (see frozenFrom), from its
 * finished frames; null while it changes. Sizes first: frames that differ
 * almost never have the same size, so files are read only when they do.
 */
function frozenFrame(dir: string) {
  // The newest file may still be written.
  const files = pngFiles(dir).slice(0, -1);
  if (files.length < REPEATED_FRAMES) return null;
  const sizes = files.slice(-REPEATED_FRAMES).map((f) => statSync(f).size);
  if (sizes.some((s) => s !== sizes[0])) return null;
  // Read back as far as the run of alike frames goes, plus one.
  const run: Buffer[] = [];
  for (let i = files.length - 1; i >= 0; i--) {
    const frame = readFileSync(files[i]);
    run.unshift(frame);
    if (run.length > 1 && !frame.equals(run[run.length - 1])) break;
  }
  const first = frozenFrom(run);
  return first === null ? null : files.length - run.length + first;
}

/** Waits until nobody has used the keyboard or mouse for --idle-seconds. */
export async function waitUntilIdle(reason: string) {
  let told = "";
  while (!stopReason) {
    if (ownPuuid && existsSync(path.join(root, "cancel"))) {
      stop("Own replay cancelled");
      return;
    }
    const paused = existsSync(pauseFile);
    const idle = paused ? 0 : await userIdleSeconds();
    if (!paused && idle >= idleSeconds) return;
    const why = paused
      ? `paused while ${pauseFile} exists`
      : `waiting until the PC is idle for ${idleSeconds} s`;
    if (told !== why) log(`${why} (${reason})`);
    told = why;
    await sleep(ownPuuid ? 1000 : paused ? 15_000 : Math.max(5, idleSeconds - idle) * 1000);
  }
}

/**
 * One recording run from `start`. It stops early if the game loses focus, or
 * when someone uses the PC: keys pressed in the game window could change the
 * fog, the scoreboard or the interface. Returns the game second up to which
 * the frames are known clean when someone used the PC, otherwise null.
 * `whileRecording` runs every WHILE_RECORDING_MS from the moment the game
 * plays until the recording ends: it sets again what the start of a recording
 * drops (the selected champion, tested 2026-10-05).
 */
async function recordSegment(
  dir: string,
  start: number,
  end: number,
  rate: number,
  label: string,
  whileRecording?: () => Promise<unknown>,
) {
  await mkdir(dir, { recursive: true });
  await replayRequest("/replay/playback", "POST", { time: start, paused: true, speed: 1 });
  await waitFor(async () => {
    const p = await replayRequest<Playback>("/replay/playback");
    return !p.seeking && Math.abs(p.time - start) < 2;
  }, 180_000);
  const focus = await focusGame();
  if (focus !== "focused") log(`${label}: before recording, ${focus}`);
  await sleep(1000);
  const started = Date.now();
  const recording = await replayRequest<ReplayRecording>("/replay/recording", "POST", {
    recording: true,
    codec: "png",
    startTime: start,
    endTime: end,
    framesPerSecond: rate,
    enforceFrameRate: true,
    path: dir.replaceAll("\\", "/"),
  });
  // A minimized window records at 16×0 pixels: nothing usable.
  if (Number(recording?.width) < 100) {
    await replayRequest("/replay/recording", "POST", { recording: false }).catch(() => {});
    return null;
  }
  await replayRequest("/replay/playback", "POST", { paused: false });
  // At 5× real time a second of waiting is 5 game seconds, and a call right
  // after unpausing comes before the recording's seek, which undoes it
  // (2026-10-05): it repeats on its own beat.
  let recordingOver = false;
  const repeating = (async () => {
    while (whileRecording && !recordingOver) {
      await whileRecording().catch(() => {});
      await sleep(WHILE_RECORDING_MS);
    }
  })();
  // Input since the recording started means someone used the PC (the queue's
  // own key presses all happen before). Frames up to the game time read
  // before the last check that found no input are clean.
  const usedSinceStart = async () =>
    (await userIdleSeconds()) + 2 < (Date.now() - started) / 1000;
  let clean = start;
  let touched: number | null = null;
  let lastLog = Date.now();
  let lastCheck = Date.now();
  // Watchdog: a game that stops advancing (seen 2026-10-04: frozen at 36:56
  // for five hours) is abandoned instead of waited for.
  let progress = { t: -Infinity, at: Date.now() };
  let stalled = false;
  let crashed = false;
  let frozenAt: number | null = null;
  await waitFor(
    async () => {
      if (ownPuuid && existsSync(path.join(root, "cancel"))) {
        await replayRequest("/replay/recording", "POST", { recording: false }).catch(() => {});
        throw new SetupError("Récupération annulée.");
      }
      if (Date.now() - progress.at > stallMs) {
        stalled = true;
        return true;
      }
      let r: ReplayRecording;
      try {
        r = await replayRequest<ReplayRecording>("/replay/recording");
      } catch (error) {
        // A game that crashed is gone at once; one that hangs is the watchdog's.
        if (!(await gameProcessIds()).length) {
          crashed = true;
          return true;
        }
        throw error;
      }
      const now = Number(r.currentTime);
      if (Number.isFinite(now) && now > progress.t + 0.01) progress = { t: now, at: Date.now() };
      // The picture can freeze while the game time runs on: its frames are
      // then all alike. Not in the last seconds, where the game ends.
      if (r.recording !== false && Number.isFinite(now) && now < end - 10) {
        const first = frozenFrame(dir);
        if (first !== null) {
          frozenAt = start + first / rate;
          await replayRequest("/replay/recording", "POST", { recording: false }).catch(() => {});
          return true;
        }
      }
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        const done = Number(r.currentTime) - start;
        log(`${label}: ${fmt(Number(r.currentTime))} of ${fmt(end)}, ${(done / ((Date.now() - started) / 1000)).toFixed(1)}x real time`);
      }
      if (r.recording !== false && Date.now() - lastCheck > INPUT_CHECK_MS) {
        lastCheck = Date.now();
        if (await usedSinceStart()) {
          touched = clean;
          await replayRequest("/replay/recording", "POST", { recording: false }).catch(() => {});
          return true;
        }
        clean = Number(r.currentTime);
      }
      return r.recording === false && Date.now() - started > 1500;
    },
    Math.max(120_000, (end - start) * 2000),
    1000,
  ).finally(async () => {
    recordingOver = true;
    await repeating;
  });
  if (stalled || crashed || frozenAt !== null) {
    let stopped = false;
    try {
      await replayRequest("/replay/recording", "POST", { recording: false });
      stopped = true;
    } catch {}
    // Keys may have changed the fog/HUD while the game was frozen. Such a
    // segment cannot be salvaged, even if it is close to the end.
    const untouched = touched === null && !(await usedSinceStart());
    const when = Number.isFinite(progress.t) ? `at ${fmt(progress.t)}` : "before its first frame";
    throw new StallError(
      crashed
        ? `The game closed ${when}.`
        : frozenAt !== null
          ? `The picture froze at ${fmt(frozenAt)} (${REPEATED_FRAMES} or more frames alike).`
          : `The game stopped advancing ${when} for ${Math.round(stallMs / 1000)} s.`,
      frozenAt ?? progress.t,
      stopped && untouched,
      untouched,
      crashed ? "crash" : frozenAt !== null ? "frozen" : "stall",
    );
  }
  // A recording cut short by a focus loss may follow keys pressed in the game.
  if (touched === null && (await usedSinceStart())) touched = clean;
  return touched;
}

/**
 * Records game seconds [start, end] as PNG frames, one every 1/fps game
 * seconds (enforceFrameRate makes the game step exactly; it runs faster than
 * real time). The game stops recording when its window loses focus: the
 * recording then resumes at the next missing frame once the PC is idle, and
 * the pieces are numbered as one sequence. With `recover`, a game that stops
 * advancing, closes or freezes its picture is opened again and the recording
 * resumes the same way, after the last good frame. Returns the frame files in
 * order, the accepted end stall and the freezes recovered from.
 */
async function recordPng(
  dir: string,
  start: number,
  end: number,
  rate: number,
  label: string,
  hooks: {
    /** Restores the replay's settings after someone used the PC. */
    restore?: () => Promise<void>;
    /** Runs while each piece records (see recordSegment). */
    whileRecording?: () => Promise<unknown>;
    /** Main capture only; setup probes must still finish in full. */
    endTolerance?: number;
    /** Main capture only: closes the replay, opens it again and sets it up. */
    recover?: () => Promise<void>;
  } = {},
) {
  const { restore, whileRecording, endTolerance = 0, recover } = hooks;
  await rm(dir, { recursive: true, force: true });
  const all = path.join(dir, "all");
  await mkdir(all, { recursive: true });
  const expected = Math.floor((end - start) * rate) + 1;
  const started = Date.now();
  let frames = 0;
  let touched = false;
  let endStall: number | null = null;
  const freezes: { at: number; kind: StallError["kind"]; resumedAtFrame: number }[] = [];
  let reopen = false;
  for (let piece = 0; frames < expected; piece++) {
    if (piece > 0) {
      if (piece > MAX_RESUMES || stopReason)
        throw new Error(`Recording stopped ${piece} times; ${frames} of ${expected} frames.`);
      if (!reopen)
        log(
          `${label}: recording stopped at ${fmt(start + frames / rate)} (${touched ? "someone used the PC" : "the game lost focus"})`,
        );
      await waitUntilIdle(reopen ? "to open the replay again" : "to resume the recording");
      if (reopen) await recover!();
      else if (touched && restore) await restore();
      reopen = false;
    }
    const pieceStart = start + frames / rate;
    // A resumed piece starts a little earlier and drops those frames: after a
    // seek the game draws champions at stale places for about a second
    // (2026-10-06: an enemy at its fountain in the two frames after a resume,
    // then back in its lane).
    const leadFrames = piece > 0 ? Math.min(Math.round(RESUME_LEAD_SECONDS * rate), frames) : 0;
    const from = pieceStart - leadFrames / rate;
    const pieceDir = path.join(dir, `piece-${piece}`);
    let cleanUntil: number | null = null;
    let stall: StallError | null = null;
    try {
      cleanUntil = await recordSegment(pieceDir, from, end, rate, label, whileRecording);
    } catch (error) {
      if (!(error instanceof StallError)) throw error;
      stall = error;
    }
    let files = pngFiles(pieceDir);
    // Frame k of the piece shows from + k / rate. Kept: up to the clean time
    // when someone used the PC, or up to the last advancing Replay API time
    // (or the last frame drawn) when the game stopped, so that repeated
    // terminal images never count as captured game time; then without the lead.
    const until = stall ? stall.at : cleanUntil;
    if (until !== null) files = files.slice(0, Math.max(0, Math.floor((until - from) * rate + 1e-6) + 1));
    files = files.slice(leadFrames);
    if (stall) {
      const at = Number.isFinite(stall.at) ? stall.at : pieceStart;
      if (
        stall.salvageable &&
        endTolerance > 0 &&
        acceptsEndStall(frames + files.length, start, end, rate, stall.at, endTolerance)
      ) {
        endStall = stall.at;
        log(`${label}: accepting end stall at ${fmt(stall.at)}; ${frames + files.length}/${expected} frames, last frame ${fmt(start + (frames + files.length - 1) / rate)}`);
      } else if (
        // A freeze at the same moment as an earlier one is the replay's,
        // not the PC's: opening it again would only freeze again.
        recover &&
        stall.untouched &&
        freezes.length < MAX_FREEZES_RECOVERED &&
        !freezes.some((f) => Math.abs(f.at - at) < SAME_FREEZE_SECONDS)
      ) {
        reopen = true;
        freezes.push({ at, kind: stall.kind, resumedAtFrame: frames + files.length });
        log(`${label}: ${stall.message} Opening the replay again to record on from ${fmt(start + (frames + files.length) / rate)}.`);
      } else throw stall;
    }
    touched = cleanUntil !== null;
    for (const file of files)
      await rename(file, path.join(all, `${String(frames++).padStart(6, "0")}.png`));
    await rm(pieceDir, { recursive: true, force: true });
    if (endStall !== null) break;
  }
  return { files: await atFrameSize(all), wallSeconds: (Date.now() - started) / 1000, endStall, freezes };
}

/**
 * What a 16:10 to 5:4 replay window keeps when rebuilt at 1920×1080
 * (screen-fit.ts), with the edge each is pinned to: the team frames, the top
 * bar, the scoreboard, the selected player's panel and the minimap corner
 * (its size is a setting: the block holds a 460 px minimap, larger than the
 * 254–306 px measured).
 */
export const REPLAY_SURFACES: AnchoredBox[] = [
  { ...SPECTATOR_LAYOUT_1080.framesBlue, anchor: "left" },
  { ...SPECTATOR_LAYOUT_1080.framesRed, anchor: "right" },
  { ...SPECTATOR_LAYOUT_1080.topBar, anchor: "center" },
  { ...SPECTATOR_LAYOUT_1080.scoreboard, anchor: "center" },
  // The panel measured x 1–306 (PANEL_SEARCH_1080): narrower than the search
  // area, so that on a narrow window it cannot take in the centred scoreboard.
  { ...PANEL_SEARCH_1080, width: 420, anchor: "left" },
  { x: 1440, y: 500, width: 480, height: 580, anchor: "right" },
];

/**
 * The frames of `dir` at 1920×1080, where every reader is measured: another
 * game window is brought to it in one ffmpeg pass (screen-fit.ts); a shape
 * it cannot read stops the recording with the reason.
 */
async function atFrameSize(dir: string) {
  const files = pngFiles(dir);
  const size = files.length ? pngSize(readFileSync(files[0])) : null;
  const fit = size ? screenFit(size) : ({ kind: "keep" } as const);
  if (fit.kind === "keep") return files;
  if (fit.kind === "unsupported") throw new SetupError(fit.reason);
  log(`${path.basename(path.dirname(dir))}: frames recorded at ${size!.width}×${size!.height}, ${fit.kind === "scale" ? "scaled" : "rebuilt surface by surface"} to 1920×1080`);
  const scaled = `${dir}-1080`;
  await rm(scaled, { recursive: true, force: true });
  await mkdir(scaled, { recursive: true });
  await run(ffmpegPath!, fitFramesArgs(path.join(dir, "%06d.png"), path.join(scaled, "%06d.png"), fit, REPLAY_SURFACES));
  const out = pngFiles(scaled);
  if (out.length !== files.length) throw new Error(`Scaling ${size!.width}×${size!.height} frames gave ${out.length} of ${files.length}.`);
  await rm(dir, { recursive: true, force: true });
  await rename(scaled, dir);
  return pngFiles(dir);
}

const fmt = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// The scoreboard's item columns at 1920×1080 (items mode), blue then red.
const ITEM_AREAS = [
  { x: 655, y: 856, width: 155, height: 220 },
  { x: 1130, y: 856, width: 135, height: 220 },
];
/**
 * Mean colour strength (max − min channel) of the item columns: item icons
 * are colourful, gold numbers are white on a dark background. Measured
 * 2026-10-04: 22.8 in items mode (one screenshot), 8.7 in gold mode (one
 * recorded frame). Saturation does not separate them (0.52 against 0.46):
 * the dark navy background is saturated.
 */
function itemColour(frame: Raster) {
  let sum = 0,
    n = 0;
  for (const a of ITEM_AREAS)
    for (let y = a.y; y < a.y + a.height; y++)
      for (let x = a.x; x < a.x + a.width; x++) {
        const i = (y * frame.width + x) * 3;
        const max = Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
        const min = Math.min(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
        sum += max - min;
        n++;
      }
  return sum / n;
}
/** Above this colour strength the scoreboard still shows items. */
const ITEMS_MODE_COLOUR = 15;
/** Game second of the gold-mode check (every queued game lasts 15 min or more). */
const GOLD_CHECK_AT = 600;
// Camera mode while parked (Replay API HudCameraMode): set from a test in a live replay.
const CAMERA_MODE = "fps";

/**
 * The frame of game second `at`, recorded for a check. With `lead`, the
 * recording starts that many seconds earlier and the last frame is kept,
 * which gives `whileRecording` time to act.
 */
async function frameAt(
  dir: string,
  at: number,
  check: string,
  { lead = 0, whileRecording }: { lead?: number; whileRecording?: () => Promise<unknown> } = {},
) {
  const r = lead
    ? await recordPng(dir, at - lead, at, 2, check, { whileRecording })
    : await recordPng(dir, at, at + 0.5, 2, check, { whileRecording });
  if (!r.files.length) throw new SetupError(`The ${check} recorded no frame.`);
  return pngRaster(readFileSync(r.files[lead ? r.files.length - 1 : 0]));
}

/**
 * Switches the scoreboard from items to every player's current gold (the
 * spectator key X, "Toggle scoreboards items"). The key toggles, and the mode
 * may carry over from an earlier replay, so the result is checked: the item
 * columns lose their colour in gold mode. First, the scoreboard must be drawn
 * in full: without it no game is recorded (a setup problem: the queue stops).
 */
async function setGoldMode(workDir: string) {
  // At 10:00 players carry several items; at 1:30 the item columns are
  // nearly empty and items mode measured 15.6 against 9.5 in gold mode.
  const frameOf = (name: string) => frameAt(path.join(workDir, name), GOLD_CHECK_AT, "gold check");
  const colourAt = async (name: string) => itemColour(await frameOf(name));
  const first = await frameOf("gold-before");
  const border = scoreboardBorder(first);
  if (border < SCOREBOARD_SHOWN)
    throw new SetupError(
      `The replay's scoreboard is not drawn in full (its border fills ${Math.round(border * 100)}% of the first row, ${SCOREBOARD_SHOWN * 100}% expected): is ShowReplayScoreboard=1 under [Replay] in ${gameCfg}? No game is recorded without the scoreboard.`,
    );
  const before = itemColour(first);
  await pressWhilePlaying(goldKeys);
  let after = await colourAt("gold-after");
  if (after > before) {
    // It was already in gold mode: the key switched it back to items.
    await pressWhilePlaying(goldKeys);
    after = await colourAt("gold-again");
  }
  // Not worth a lost night: the game is recorded without gold, and marked.
  const ok = after <= ITEMS_MODE_COLOUR;
  if (!ok)
    log(
      `gold mode not set (colour ${after.toFixed(1)}, before the key ${before.toFixed(1)}): recording without gold per second`,
    );
  return {
    ok,
    metric: "COLOUR_STRENGTH",
    at: GOLD_CHECK_AT,
    itemsModeAbove: ITEMS_MODE_COLOUR,
    itemColourBefore: before,
    itemColourAfter: after,
    // Share of the scoreboard's first row its border fills (scoreboardBorder).
    scoreboardBorder: border,
  };
}

// Only the minimap, the frames, the scoreboard and the top bar are kept, so
// the 3D world is not drawn (less GPU work), and the camera is parked over
// the fog team's enemy base: its view rectangle on the minimap then sits
// where that team sees nothing, instead of following the action over icons.
const WORLD_OFF = {
  environment: false,
  characters: false,
  champions: false,
  minions: false,
  particles: false,
  floatingText: false,
  healthBarChampions: false,
  healthBarMinions: false,
  healthBarPets: false,
  healthBarStructures: false,
  healthBarWards: false,
  outlineHover: false,
  outlineSelect: false,
};
// Riot map coordinates (x, z on the ground); blue base bottom left, red top right.
const ENEMY_BASE: Record<Team, { x: number; z: number }> = {
  100: { x: 13900, z: 13900 },
  200: { x: 900, z: 900 },
};
async function quietWorld(team: Team) {
  const base = ENEMY_BASE[team];
  const now = await replayRequest<Record<string, unknown>>("/replay/render");
  const height = (now.cameraPosition as { y?: number } | undefined)?.y ?? 1900;
  await replayRequest("/replay/render", "POST", {
    ...WORLD_OFF,
    selectionName: "",
    cameraAttached: false,
    cameraMode: CAMERA_MODE,
    cameraPosition: { x: base.x, y: height, z: base.z },
  });
}

/**
 * Presses keys while the replay plays (see setFog). A key pressed while the
 * replay window lacks the focus goes to another window: the press is retried
 * after the PC is idle again, a bounded number of times, then setup fails.
 */
async function pressWhilePlaying(keys: number[]) {
  const press = async () => {
    await replayRequest("/replay/playback", "POST", { paused: false });
    await sleep(500);
    const focus = await pressKeys(keys);
    await sleep(1000);
    return focus;
  };
  const result = await pressFocused(press, async (attempt, answer) => {
    log(`keys could not reach the replay (${answer}, try ${attempt} of ${FOCUS_ATTEMPTS}); waiting for idle to press again`);
    await waitUntilIdle("to press the replay keys again");
    await sleep(2000);
    return !stopReason;
  });
  if (result.ok && result.answer !== "focused") log(`replay keys: ${result.answer}`);
  if (!result.ok)
    throw new SetupError(
      stopReason ??
        (ownPuuid
          ? "Le replay n’a pas reçu les touches du brouillard et de l’or : laisse le PC au repos pendant la préparation, puis réessaie."
          : `The replay keys could not reach the replay window after ${result.attempts} tries (it never kept the focus).`),
    );
}

/**
 * Sets one team's fog with the spectator hotkeys and checks it on the minimap
 * against the "All" view, where both bases are lit (each team sees its own).
 * Keys only, pressed while the replay plays: toggling the API's fogOfWar while
 * paused and then pressing a team key crashes the game (patch 16.19,
 * reproduced; either alone is fine).
 */
async function setFog(team: Team, workDir: string) {
  await pressWhilePlaying(allKeys);
  const allFrame = await frameAt(path.join(workDir, "fog-all"), fogCheckAt, "fog check");
  await pressWhilePlaying(fogKeys[team]);
  const teamFrame = await frameAt(path.join(workDir, "fog-team"), fogCheckAt, "fog check");
  const minimap = findMinimap(allFrame);
  const allLight = baseLight(allFrame, minimap);
  const teamLight = baseLight(teamFrame, minimap);
  const side = fogSide(teamLight, allLight);
  const check = { at: fogCheckAt, all: allLight, team: teamLight, side, minimap };
  if (side !== team)
    throw new SetupError(
      `Fog check failed: wanted team ${team}, the minimap shows ${side} (base corner light under All ${JSON.stringify(allLight)}, under the team key ${JSON.stringify(teamLight)}). Check that evtSetVisibilityTeam1/Team2/TeamNone are bound to --fog-keys (doc/REPLAY.md).`,
    );
  return { check, allFrame, teamFrame };
}

function findMinimap(frame: Raster): LocateResult {
  const rx = Math.round(frame.width * 0.55),
    ry = Math.round(frame.height * 0.35);
  const found = locateMinimap(crop(frame, rx, ry, frame.width - rx, frame.height - ry), {
    minSize: frame.height * 0.12,
    maxSize: frame.height * 0.6,
    offsetX: rx,
    offsetY: ry,
  });
  if (found.score < 0.4) throw new SetupError(`Minimap not found (score ${found.score.toFixed(2)}).`);
  return found;
}

/**
 * Selects a champion by its player's name ("" for none) without moving the
 * parked camera. Returns the selection the game reports: the player's name
 * (the fog test also selected by champion name), or "" for none.
 */
async function select(name: string) {
  await reselect(name);
  await sleep(500);
  return (await replayRequest<{ selectionName?: string }>("/replay/render")).selectionName ?? "";
}
/**
 * The selection without the check, for use while recording. A seek drops it,
 * so does the start of each recording, which seeks to its start time, and the
 * game drops it again about every 10 game seconds while recording (tested
 * 2026-10-05). Set again every WHILE_RECORDING_MS, the panel misses one frame
 * each time.
 */
const reselect = (name: string, cameraAttached = false) =>
  replayRequest("/replay/render", "POST", { selectionName: name, cameraAttached });

/** Game second of the selection check (every queued game lasts 15 min or more). */
const SELECTION_CHECK_AT = 600;
// The check records from this many seconds earlier and uses the latest valid
// same-time selected/unselected pair, since the final frame can lose selection:
// the panel is missing from the first frames of a recording. With 3 s (seven
// frames, 0.6 s of real time) it was missing from all of them (2026-10-05).
const SELECTION_LEAD = 10;
// The panel measured 306×159 px at 1920×1080 (fog test): a smaller change is not it.
const MIN_PANEL = { width: 150, height: 80 };
// The selection must leave the recorded strips as they are (it changed none of
// them in the fog test): above this share of changed pixels in one, no player
// is selected.
const MAX_STRIP_CHANGE = 0.005;
// selectionCheck.ok wants the panel in at least this share of the frames: 86%
// on the first whole game, re-selecting every 250 ms (EUW1_8004857210), 93% of
// 60 seconds at 50 ms.
const MIN_PANEL_SHARE = 0.8;

type SelectionCheck = {
  ok: boolean;
  at: number;
  /** The player's name as the game reports it once selected. */
  selection: string;
  searchArea: Box;
  /** Where the frames without and with the selection differ. */
  changed?: Box | null;
  /** Share of each recorded strip's pixels the selection changed. */
  changedInStrips?: Record<string, number>;
  /** The crop of player.mp4. */
  box?: Box;
  /** Frames of player.mp4 that show the panel, and [first, last] game seconds of each stretch without it. */
  recording?: { frames: number; withPanel: number; gaps: [number, number][] };
  reason?: string;
};
/** `selectBy`: the name the game accepted, which re-selects the player while recording. */
type Panel = { box: Box; selection: string; selectBy: string; withPanel: Raster; without: Raster };

/**
 * Selects one player's champion and finds the panel the selection draws
 * (abilities and their cooldowns, summoner spells, health, mana, buffs): one
 * frame of the same game moment without and with the selection, and the panel
 * is where they differ. Like gold mode, a selection that fails costs the
 * panel, not the game.
 */
async function setSelection(
  player: ReplayParticipant,
  workDir: string,
  minimap: LocateResult,
  team: Team,
): Promise<{ check: SelectionCheck; panel?: Panel }> {
  // With the world kept (own imports), the camera moves when the player is
  // selected, and the world shows through the frames and the top bar: 2-17% of
  // their pixels changed and no pair passed (2026-10-13). The check runs with
  // the world off and the camera parked, as the research queue records, and
  // the world comes back for the recording.
  if (!keepWorld) return checkSelection(player, workDir, minimap);
  const before = await replayRequest<Record<string, unknown>>("/replay/render");
  await quietWorld(team);
  try {
    return await checkSelection(player, workDir, minimap);
  } finally {
    // The camera too: left parked in its mode, it showed the map's edge
    // and did not follow the selected player (panel in 82% of frames).
    const keys = [...Object.keys(WORLD_OFF), "cameraMode", "cameraPosition", "cameraRotation", "cameraAttached", "fieldOfView"];
    await replayRequest("/replay/render", "POST", Object.fromEntries(keys.filter((k) => k in before).map((k) => [k, before[k]])));
  }
}

async function checkSelection(
  player: ReplayParticipant,
  workDir: string,
  minimap: LocateResult,
): Promise<{ check: SelectionCheck; panel?: Panel }> {
  await select("");
  const start = SELECTION_CHECK_AT - SELECTION_LEAD;
  const rate = 2;
  const off = await recordPng(path.join(workDir, "select-off"), start, SELECTION_CHECK_AT, rate, "selection check");
  // The game answers with the player's name, but may not accept that name
  // back: asked for "你噶博弈" it selected nobody, asked for "Orianna" it
  // answered "你噶博弈" (2026-10-13). So the champion's name comes first
  // (unique in a Summoner's Rift game), and the name that worked is the one
  // used again.
  let selection = "";
  let selectBy = "";
  for (const name of [player.championName, player.riotIdGameName])
    if (name && !selection) {
      selection = await select(name);
      if (selection) selectBy = name;
    }
  const check: SelectionCheck = { ok: false, at: SELECTION_CHECK_AT, selection, searchArea: PANEL_SEARCH_1080 };
  const fail = async (reason: string) => {
    await select("");
    log(`no player panel: ${reason}`);
    return { check: { ...check, reason } };
  };
  if (!selection) return fail(`the game did not select ${player.championName}`);
  const on = await recordPng(path.join(workDir, "select-on"), start, SELECTION_CHECK_AT, rate, "selection check", {
    whileRecording: () => reselect(selectBy),
  });
  const strips: Record<string, Box> = {
    ...SPECTATOR_LAYOUT_1080,
    minimap: { x: minimap.x, y: minimap.y, width: minimap.size, height: minimap.size },
  };
  function* samples(): Generator<SelectionSample> {
    // Frame indices share the same start and enforced rate. Skip the seek's
    // first frame, which may still contain the previous rendered interface.
    for (let i = Math.min(off.files.length, on.files.length) - 1; i > 0; i--)
      yield {
        at: start + i / rate,
        without: pngRaster(readFileSync(off.files[i])),
        withPanel: pngRaster(readFileSync(on.files[i])),
      };
  }
  const sample = findSelectedPanel(samples(), PANEL_SEARCH_1080, strips, MIN_PANEL, MAX_STRIP_CHANGE);
  if (!sample) return fail("no same-time setup pair showed a player panel without changing the retained strips");
  const { at, changed, changedInStrips, box, without, withPanel } = sample;
  if (at !== SELECTION_CHECK_AT) log(`selection check: panel verified at ${at.toFixed(1)} s (final frame lost selection)`);
  return {
    check: { ...check, at, changed, changedInStrips, ok: true, box },
    panel: { box, selection, selectBy, withPanel, without },
  };
}

/**
 * Which frames of player.mp4 show the panel: each is compared with the two
 * check frames cut to the panel (see showsPanel). It reads the small track,
 * not the full frames: seconds for a whole game.
 */
function panelFrames(file: string, panel: Panel): Promise<boolean[]> {
  const { box } = panel;
  const withPanel = crop(panel.withPanel, box.x, box.y, box.width, box.height);
  const without = crop(panel.without, box.x, box.y, box.width, box.height);
  const whole = { x: 0, y: 0, width: box.width, height: box.height };
  const size = box.width * box.height * 3;
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath!,
      ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const present: boolean[] = [];
    let pending = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      pending = Buffer.concat([pending, b]);
      for (; pending.length >= size; pending = pending.subarray(size)) {
        const frame = { width: box.width, height: box.height, data: new Uint8Array(pending.subarray(0, size)) };
        present.push(showsPanel(frame, withPanel, without, whole).present);
      }
    });
    child.stderr.on("data", (b: Buffer) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(present) : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-300)}`)),
    );
  });
}

function run(binary: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b: Buffer) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-500)}`)),
    );
  });
}

/**
 * Crops the stable elements of the frames into four videos, and the selected
 * player's panel into a fifth when there is one (4:4:4 keeps icon colours).
 */
async function cropTracks(files: string[], minimap: LocateResult, outDir: string, panel: Box | null) {
  const first = path.dirname(files[0]);
  const {
    framesBlue: l,
    framesRed: r,
    topBar: t,
    scoreboard: s,
  } = SPECTATOR_LAYOUT_1080;
  const p = panel;
  const encode = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv444p"];
  await run(ffmpegPath!, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-framerate", String(fps), "-i", path.join(first, "%06d.png")],
    "-filter_complex",
    [
      p ? "[0]split=6[a][b][c][d][e][g]" : "[0]split=5[a][b][c][d][e]",
      `[a]crop=${minimap.size}:${minimap.size}:${minimap.x}:${minimap.y}[m]`,
      `[b]crop=${l.width}:${l.height}:${l.x}:${l.y}[l]`,
      `[c]crop=${r.width}:${r.height}:${r.x}:${r.y}[r]`,
      `[l][r]hstack,${frameNameMask()}[f]`,
      `[d]crop=${t.width}:${t.height}:${t.x}:${t.y}[t]`,
      `[e]crop=${s.width}:${s.height}:${s.x}:${s.y}[s]`,
      ...(p ? [`[g]crop=${p.width}:${p.height}:${p.x}:${p.y}[p]`] : []),
    ].join(";"),
    ...["-map", "[m]", ...encode, path.join(outDir, "minimap.mp4")],
    ...["-map", "[f]", ...encode, path.join(outDir, "frames.mp4")],
    ...["-map", "[t]", ...encode, path.join(outDir, "top.mp4")],
    ...["-map", "[s]", ...encode, path.join(outDir, "scoreboard.mp4")],
    ...(p ? ["-map", "[p]", ...encode, path.join(outDir, "player.mp4")] : []),
  ]);
}

/** The player whose panel a recording keeps, and the role rotation's turn it was picked for. */
export type Selected = { player: ReplayParticipant; turn: Role };

/**
 * Records one game under `team`'s fog into replays/<id>: the match ID for a
 * first pass, <matchId>-<team> for a second pass.
 */
export async function recordGame(
  c: Candidate & { match: ReplayMatch },
  team: Team,
  selected: Selected | null,
  id = c.matchId,
) {
  const gameId = numericGameId(c.matchId);
  const started = Date.now();
  const workDir = path.join(root, "replay-work", c.matchId);
  const outDir = path.join(replaysDir, id);
  await rm(workDir, { recursive: true, force: true });
  if (await replayApiUp()) {
    await closeReplay();
    await waitFor(async () => !(await replayApiUp()), 60_000);
  }
  await afterCooldown();
  const roflDir = await lcuRequest<string>("/lol-replays/v1/rofls/path");
  const rofl = path.join(roflDir, `EUW1-${gameId}.rofl`);
  const roflExisted = existsSync(rofl);
  try {
    if (ownPuuid) {
      const metadata = await lcuRequest<{state?: string}>(`/lol-replays/v1/metadata/${gameId}`);
      if (!isDownloadedReplay(metadata)) throw new GameError("Télécharge ce replay dans l’historique LoL, puis réessaie.");
    } else await ensureReplayDownloaded(gameId, replaySeed(c.match));
  } catch (error) {
    // A client that does not answer is not the game's fault.
    const message = (error as Error).message;
    if (error instanceof ReplayServiceUnreachable) throw new ClientError(message);
    throw isGameFault(message) ? new GameError(message) : error;
  }
  try {
    await openReplay(gameId);
  } catch (error) {
    log(`${c.matchId}: the replay did not open (${(error as Error).message}); trying once more`);
    await closeReplay();
    await afterCooldown();
    await openReplay(gameId);
  }
  try {
    await waitFor(
      async () => (await replayRequest<Playback>("/replay/playback")).length > 0,
      180_000,
    );
    await focusGame();
    const render = await replayRequest<Record<string, unknown>>("/replay/render");
    const ui = minimalInterface(render, selected !== null);
    await replayRequest("/replay/render", "POST", ui);
    if (!keepWorld) await quietWorld(team);

    const gold = await setGoldMode(workDir);
    const fog = await setFog(team, workDir);
    const selection = selected ? await setSelection(selected.player, workDir, fog.check.minimap, team) : null;
    if (ownPuuid && !selection?.check.ok)
      throw new SetupError("Le joueur du compte connecté n’a pas pu être sélectionné dans le replay.");
    const panel = selection?.panel ?? null;
    const end = Math.floor(c.match.info.gameDuration);
    const expected = Math.floor(end * fps) + 1;
    const free = await freeBytes();
    if (free - expected * 2e6 < minFree)
      throw new SetupError(`Not enough disk for ${expected} frames (${(free / 1e9).toFixed(0)} GB free).`);
    const who = selected?.player;
    log(
      `${c.matchId}: recording 0:00 to ${fmt(end)} at ${fps} fps under team ${team}'s fog${panel && who ? `, with ${who.championName}'s panel (${who.teamPosition || "no role"})` : ""}`,
    );
    // After someone used the PC, keys may have changed the replay: set and check everything again.
    const restore = async () => {
      await focusGame();
      await replayRequest("/replay/render", "POST", ui);
      if (!keepWorld) await quietWorld(team);
      await setGoldMode(workDir);
      await setFog(team, workDir);
    };
    // A replay that froze or closed is opened again and set up as at the
    // start; the selection comes back with whileRecording.
    const recover = async () => {
      if (!(await closeReplay())) throw new StallError("The frozen replay could not be closed.");
      await afterCooldown();
      try {
        await openReplay(gameId);
      } catch (error) {
        log(`${c.matchId}: the replay did not open again (${(error as Error).message}); trying once more`);
        await closeReplay();
        await afterCooldown();
        await openReplay(gameId);
      }
      await waitFor(async () => (await replayRequest<Playback>("/replay/playback")).length > 0, 180_000);
      await restore();
    };
    // Each piece's start drops the selection (and quietWorld clears it): set it again as each piece records.
    const whileRecording = panel ? () => reselect(panel.selectBy, Boolean(ownPuuid)) : undefined;
    const rec = await recordPng(path.join(workDir, "frames"), 0, end, fps, c.matchId, {
      restore,
      whileRecording,
      endTolerance: endStallSeconds,
      recover,
    });
    if (rec.files.length < expected * 0.95)
      throw new Error(`Recorded ${rec.files.length} frames, expected ${expected}.`);
    // The fog must have survived the seek to the start: check the recording itself.
    const checkFrame = rec.files[Math.round(fogCheckAt * fps)];
    const recordedSide = fogSide(baseLight(pngRaster(readFileSync(checkFrame)), fog.check.minimap), fog.check.all);
    if (recordedSide !== team)
      throw new SetupError(`The recording lost the fog: its minimap shows ${recordedSide} at ${fogCheckAt} s.`);

    await mkdir(outDir, { recursive: true });
    if (ownPuuid) log("desktop: encoding tracks");
    await cropTracks(rec.files, fog.check.minimap, outDir, panel?.box ?? null);
    if (ownPuuid) {
      log("desktop: encoding video");
      await run(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(path.dirname(rec.files[0]), "%06d.png"), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart", path.join(outDir, "screen.mp4")]);
    }
    // Every frame of the panel's track is checked: a panel in some frames is
    // kept, with the stretches of game time it was missing.
    let kept: Box | null = null;
    if (ownPuuid) log("desktop: verifying capture");
    if (selection && panel) {
      const present = await panelFrames(path.join(outDir, "player.mp4"), panel);
      const withPanel = present.filter(Boolean).length;
      const gaps = panelGaps(present, fps);
      selection.check.recording = { frames: present.length, withPanel, gaps };
      selection.check.ok = withPanel >= present.length * MIN_PANEL_SHARE;
      if (withPanel) kept = panel.box;
      else await rm(path.join(outDir, "player.mp4"), { force: true });
      const longest = Math.max(0, ...gaps.map(([a, b]) => b - a + 1 / fps));
      log(
        `${c.matchId}: player panel in ${withPanel} of ${present.length} frames (${Math.round((100 * withPanel) / Math.max(1, present.length))}%), ${gaps.length} gaps, the longest ${longest.toFixed(1)} s${kept ? "" : "; player.mp4 not kept"}`,
      );
    }
    const m = fog.check.minimap;
    await writeFile(path.join(outDir, "fog-check-all.png"), rasterPng(crop(fog.allFrame, m.x, m.y, m.size, m.size)));
    await writeFile(path.join(outDir, "fog-check-team.png"), rasterPng(crop(fog.teamFrame, m.x, m.y, m.size, m.size)));
    if (kept && panel)
      await writeFile(
        path.join(outDir, "panel-check.png"),
        rasterPng(crop(panel.withPanel, kept.x, kept.y, kept.width, kept.height)),
      );
    // Cooldowns from the panel (cooldowns.json). A reader that fails costs
    // the cooldowns, not the recording: npm run replay:cooldowns reads it later.
    if (kept && who && selection)
      try {
        const summary = await writeCooldowns(
          outDir,
          {
            matchId: c.matchId,
            fps,
            selectedPlayer: { participantId: who.participantId, championName: who.championName, role: who.teamPosition || null },
            selectionCheck: { changed: selection.check.changed },
            layout: { playerPanel: kept },
          },
          gamesDir,
        );
        log(`${c.matchId}: cooldowns read: ${summary}`);
      } catch (error) {
        log(`${c.matchId}: cooldowns not read (${(error as Error).message}); npm run replay:cooldowns reads them later`);
      }
    const capture = {
      version: "replay-capture-0.1",
      matchId: c.matchId,
      // The recording of the same game under the other team's fog, for a second pass.
      ...(id !== c.matchId ? { recordingId: id, pairedWith: c.matchId } : {}),
      gameVersion: c.match.info.gameVersion,
      tier: c.tier,
      // Which queue PC recorded it (never a player's own PC), and its game.cfg
      // settings then: the camp clocks depend on them (2026-10-16).
      recorder: { ...(ownPuuid ? {} : { host: hostname() }), gameCfg: replaySettingsNow(c.matchId) },
      ...captureLabels(team, kept !== null),
      fogCheck: fog.check,
      goldModeCheck: gold,
      selectedPlayer: who
        ? {
            participantId: who.participantId,
            teamId: who.teamId,
            championName: who.championName,
            riotIdGameName: who.riotIdGameName ?? null,
            role: who.teamPosition || null,
            rotationTurn: selected!.turn,
          }
        : null,
      selectionCheck: selection?.check ?? null,
      fps,
      startTime: 0,
      frames: rec.files.length,
      completion: rec.endStall === null ? "COMPLETE" : "END_STALL",
      expectedEndTime: end,
      capturedThrough: (rec.files.length - 1) / fps,
      missingTailSeconds: Math.max(0, end - (rec.files.length - 1) / fps),
      stalledAt: rec.endStall,
      // Freezes the recording came back from: the replay was opened again and
      // recorded on from frame resumedAtFrame.
      freezesRecovered: rec.freezes,
      frameTime: "game second of frame i = startTime + i / fps",
      screen: { width: fog.allFrame.width, height: fog.allFrame.height },
      minimap: m,
      layout: kept ? { ...SPECTATOR_LAYOUT_1080, playerPanel: kept } : SPECTATOR_LAYOUT_1080,
      tracks: {
        minimap: "minimap.mp4",
        frames: "frames.mp4 (blue frames left, red frames right)",
        topBar: "top.mp4",
        scoreboard:
          "scoreboard.mp4 in gold mode (blue rows left, red right: current gold, KDA, CS; a question mark on an enemy the fog team cannot see)",
        ...(kept
          ? {
              player:
                "player.mp4: the selected player's panel (abilities with their rank and cooldown, summoner spells and their cooldown, health, mana, level, stats, buffs)",
            }
          : {}),
      },
      wallSeconds: { recording: rec.wallSeconds, total: (Date.now() - started) / 1000 },
      recordedAt: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, "capture.json"), JSON.stringify(capture, null, 2));
    if (ownPuuid) log("desktop: finalizing capture");
    return capture;
  } finally {
    // A folder Windows will not let go must not keep the replay open: it is
    // removed at the queue's next start.
    await rm(workDir, { recursive: true, force: true, maxRetries: 20 }).catch(() => {});
    await closeReplay();
    if (!ownPuuid && !roflExisted && !keepRofl) await rm(rofl, { force: true }).catch(() => {});
  }
}
