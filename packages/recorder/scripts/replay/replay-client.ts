// The replay game client, shared by the replay fog test and the replay queue:
// is a replay open, close it, screenshot the screen, pick a current-patch game.
// Downloading and launching a replay reuse scripts/dataset/replay.ts.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { decodePng, Raster } from "../../src/lib/map/perception/raster";
import { replayProcesses } from "../../src/lib/replay/queue";
import { comparePatch } from "../../src/lib/riot/patch";
import { lcuRequest, ReplayMetadataSeed, replayRequest, riotClientRequest } from "../dataset/replay";
import { readGameFile } from "../common/game-files";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const LAUNCH_LEAGUE = "/product-launcher/v1/products/league_of_legends/patchlines/live";
/** How long League gets to appear once it is asked for (24 to 39 s over 10 starts). */
const LEAGUE_APPEARS_MS = 90_000;

/**
 * Whether the League client is there within `withinMs`: it answers on the
 * port of its lockfile, with any status (a client that closed badly can leave
 * its lockfile behind).
 */
async function leagueClientAppears(withinMs: number) {
  const until = Date.now() + withinMs;
  do {
    const answers = await lcuRequest("/riotclient/ux-state").then(
      () => true,
      (error) => /returned \d+/.test((error as Error).message),
    );
    if (answers) return true;
    await sleep(3000);
  } while (Date.now() < until);
  return false;
}

/**
 * Tries to start the League client and says how; it counts as started when
 * it answers on its port. What the Riot Client does (its logs and the tests of
 * 2026-10-05 and 06; doc/REPLAY.md):
 * - While it runs in full, its local API launches League: up 8 s after
 *   League was quit on purpose (1 of 1).
 * - About 14 s after it starts, and some time after League closes, it drops
 *   to the background. Its lockfile then points to a stub that answers 404,
 *   and `--launch-product` is handed to it and ignored, so it must be closed.
 * - Started with `--launch-product` alone it shows its own window, or tries
 *   to, instead of launching the game: League came up in 1 of 8 starts. With
 *   `--allow-direct-launch` as well (what Deceive passes since 2026-09-01,
 *   "skip Riot Client on launch") it launched League in 10 of 10.
 * So: the API once, then the Riot Client is closed and started once with
 * that flag. One try only, and callers leave 30 minutes between calls: too
 * many launches in a short time stop Vanguard for 30 minutes (error VAN 216,
 * hit after 13 launches in 20 minutes; each new launch restarts the wait).
 * The Riot Client signs in by itself only if "stay signed in" was ticked.
 * Never while a game runs. Throws when League did not appear.
 */
export async function startLeagueClient(): Promise<string> {
  if (await leagueClientAppears(0)) return "(it is already running)";
  const asked = await riotClientRequest(LAUNCH_LEAGUE, "POST", {}).then(
    () => true,
    (error) => /already_launched/.test((error as Error).message),
  );
  if (asked && (await leagueClientAppears(LEAGUE_APPEARS_MS)))
    return "through the Riot Client's local API";
  if ((await gameProcessIds()).length)
    throw new Error("a game is running: the Riot Client is left alone");
  await run("taskkill", ["/IM", "RiotClientServices.exe", "/T", "/F"]).catch(() => {});
  await sleep(5000);
  const riot =
    process.env.RIOT_CLIENT_PATH ||
    "C:/Riot Games/Riot Client/RiotClientServices.exe";
  const child = spawn(
    riot,
    ["--launch-product=league_of_legends", "--launch-patchline=live", "--allow-direct-launch"],
    // The folder League's own shortcut starts in.
    { windowsHide: true, detached: true, stdio: "ignore", cwd: path.dirname(riot) },
  );
  child.on("error", () => {});
  child.unref();
  if (await leagueClientAppears(LEAGUE_APPEARS_MS)) return "by restarting the Riot Client";
  throw new Error(
    'League did not appear after the Riot Client was restarted: is it signed in ("stay signed in")?',
  );
}

/** Whether the League client stops answering within `withinMs`. */
async function leagueClientGone(withinMs: number) {
  const until = Date.now() + withinMs;
  while (await leagueClientAppears(0)) {
    if (Date.now() > until) return false;
    await sleep(3000);
  }
  return true;
}

/**
 * Quits a League client that can no longer reach Riot's servers and starts it
 * again (startLeagueClient, with the same rules). On 2026-10-09 the Riot
 * Client closed; the League client failed to reconnect to it, deleted its
 * sign-in ("Failed to recover external client", then "LeagueEdgeClient lost
 * session auth" in its log) and went on answering locally, so it never looked
 * closed. Quit through its API, by name if it stays. Never while a game runs.
 */
export async function restartLeagueClient(): Promise<string> {
  if ((await gameProcessIds()).length)
    throw new Error("a game is running: the League client is left alone");
  await lcuRequest("/process-control/v1/process/quit", "POST").catch(() => {});
  if (!(await leagueClientGone(60_000))) {
    await run("taskkill", ["/IM", "LeagueClient.exe", "/T", "/F"]).catch(() => {});
    if (!(await leagueClientGone(30_000))) throw new Error("the League client did not quit");
  }
  await sleep(5000);
  return startLeagueClient();
}

export async function replayApiUp() {
  try {
    await replayRequest("/replay/game");
    return true;
  } catch {
    return false;
  }
}

export type Playback = {
  length: number;
  paused: boolean;
  seeking: boolean;
  speed: number;
  time: number;
};

// Client phases in which a replay would get in the way of the player.
const BUSY = new Set([
  "Matchmaking",
  "ReadyCheck",
  "ChampSelect",
  "GameStart",
  "InProgress",
  "Reconnect",
  "PreEndOfGame",
  "WaitingForStats",
]);
/** Throws when the League client is missing, patching or in a game. */
export async function assertClientIdle() {
  const phase = await lcuRequest<string>("/lol-gameflow/v1/gameflow-phase");
  if (BUSY.has(phase))
    throw new Error(`League client is busy (${phase}); not opening a replay.`);
  const config = await lcuRequest<{
    gameVersion: string;
    isPatching: boolean;
    isPlayingGame: boolean;
  }>("/lol-replays/v1/configuration");
  if (config.isPatching || config.isPlayingGame)
    throw new Error("League client is patching or in a game.");
  return { phase, gameVersion: config.gameVersion };
}

const GAME_EXE = "League of Legends.exe";

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

/** Process IDs of running game clients (a replay or a real game). */
export async function gameProcessIds(): Promise<number[]> {
  const out = await run("tasklist", ["/FI", `IMAGENAME eq ${GAME_EXE}`, "/FO", "CSV", "/NH"]);
  return [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
}

/** The process ID of the replay that answers on the Replay API, or null. */
export const replayProcessId = () =>
  replayRequest<{ processID?: number }>("/replay/game").then(
    (game) => (Number(game.processID) > 0 ? Number(game.processID) : null),
    () => null,
  );

/**
 * Closes the replay game client; true once no game client is left. A frozen
 * replay does not answer the Replay API (2026-10-04: one hung 9 hours and the
 * client refused every replay after it), so it is also closed by name, but
 * never while the League client says a real game is running. `opened` is the
 * process ID of the replay the caller opened: by it a frozen replay is ended
 * even when the League client is closed too and can say nothing.
 */
export async function closeReplayClient(opened?: number | null, onlyOwned = false): Promise<boolean> {
  const answering = (await replayProcessId()) ?? NaN;
  const running = opened ? await gameProcessIds().catch(() => []) : [];
  for (const pid of replayProcesses(answering, opened, running, onlyOwned))
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
  const gone = async () => {
    for (let i = 0; i < 15; i++) {
      const ids = await gameProcessIds();
      if (onlyOwned ? !opened || !ids.includes(opened) : !ids.length) return true;
      await sleep(2000);
    }
    return false;
  };
  if (await gone()) return true;
  if (onlyOwned) return false;
  const phase = await lcuRequest<string>("/lol-gameflow/v1/gameflow-phase").catch(() => null);
  if (phase === null || BUSY.has(phase)) return false;
  await run("taskkill", ["/IM", GAME_EXE, "/T", "/F"]).catch(() => {});
  return gone();
}

/** One PNG of the whole monitor through Desktop Duplication (ddagrab). */
export function screenshotPng(monitor = 0): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg-static did not provide a binary.");
  const args = [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-f", "lavfi", "-i"],
    `ddagrab=output_idx=${monitor}:framerate=10:draw_mouse=0`,
    // The first frames after the grab starts can be stale.
    ...["-vf", "hwdownload,format=bgra,select=gte(n\\,3)"],
    ...["-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"],
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 && out.length
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg screenshot failed (${code}): ${err.trim()}`)),
    );
  });
}

// Keyboard scancodes (set 1) for pressKeys.
export const SCAN = { ctrl: 0x1d, f1: 0x3b, f2: 0x3c, f3: 0x3d } as const;

// Window and keyboard calls through user32. Keys go through SendInput with
// scancodes, which games read like a physical key; INPUT must have the size
// of the union's largest member (MOUSEINPUT) or SendInput fails. Synthetic
// mouse input is rejected on this PC (SendInput error 87, probably Vanguard),
// so the replay HUD cannot be clicked.
const USER32 = `
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class RiftWindow {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  static void Send(ushort scan, bool up) {
    var input = new INPUT();
    input.type = 1;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = 0x0008u | (up ? 0x0002u : 0u);
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
    Thread.Sleep(40);
  }
  static void SendVirtual(ushort vk, bool up) {
    var input = new INPUT();
    input.type = 1;
    input.u.ki.wVk = vk;
    input.u.ki.dwFlags = up ? 0x0002u : 0u;
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  static bool Activate(IntPtr window) {
    SetForegroundWindow(window);
    Thread.Sleep(300);
    return GetForegroundWindow() == window;
  }
  // A fullscreen game minimizes when it loses focus, and then renders nothing
  // (DEPLA-C006225W, 2026-10-13: the replay opened behind VS Code and shrank
  // to 1×1). Windows refused this call to the queue started hours before,
  // twice, while the same call from a newly started process worked. Windows
  // lets the process that sent the last input take the focus, and lifts the
  // lock when Alt is pressed: first a key-up of an unassigned key (0xE8),
  // which no window acts on, then Alt. Both go to the window in front, never
  // to the game. Never attached to another thread's input (#237).
  public static string Focus(int pid) {
    var window = Process.GetProcessById(pid).MainWindowHandle;
    if (IsIconic(window)) { ShowWindow(window, 9); Thread.Sleep(1500); }
    if (GetForegroundWindow() == window) return "focused";
    SendVirtual(0xE8, true);
    if (Activate(window)) return "focused";
    SendVirtual(0x12, false);
    SendVirtual(0x12, true);
    if (Activate(window)) return "focused after Alt";
    var title = new StringBuilder(100);
    GetWindowText(GetForegroundWindow(), title, title.Capacity);
    return "not focused (in front: " + title + ")";
  }
  // Keys pressed without the focus would go to the window in front (an x
  // typed into VS Code, 2026-10-11).
  public static string Press(int pid, ushort[] scans) {
    var focused = Focus(pid);
    if (!focused.StartsWith("focused")) return focused;
    foreach (var s in scans) Send(s, false);
    Thread.Sleep(80);
    for (int k = scans.Length - 1; k >= 0; k--) Send(scans[k], true);
    return focused;
  }
  // Whole seconds since the last keyboard or mouse input on this PC.
  public static string IdleSeconds() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref info);
    return (((uint)Environment.TickCount - info.dwTime) / 1000).ToString();
  }
}
"@
`;

/** Restores and focuses the replay game window. */
export const focusGame = () => runInGame("Focus({pid})");

/** Presses a key combination in the replay game window. */
export const pressKeys = (scancodes: number[]) =>
  runInGame(`Press({pid}, [uint16[]]@(${scancodes.join(",")}))`);

/** Seconds since someone last used the keyboard or mouse of this PC. */
export const userIdleSeconds = async () =>
  Number(await runUser32("IdleSeconds()"));

async function runInGame(call: string) {
  const game = await replayRequest<{ processID?: number }>("/replay/game");
  return runUser32(call.replace("{pid}", String(Number(game.processID))));
}

function runUser32(call: string) {
  const script = `${USER32}\n[RiftWindow]::${call}`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        ...["-NoProfile", "-NonInteractive", "-EncodedCommand"],
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b));
    child.stderr.on("data", (b: Buffer) => (stderr += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`user32 call failed (${code}): ${stderr.trim()}`)),
    );
  });
}

/** RGB raster of a PNG (alpha dropped). */
export function pngRaster(png: Buffer): Raster {
  const img = decodePng(png);
  if (img.channels === 3)
    return { width: img.width, height: img.height, data: img.data };
  const data = new Uint8Array(img.width * img.height * 3);
  for (let p = 0; p < img.width * img.height; p++)
    for (let c = 0; c < 3; c++)
      data[p * 3 + c] = img.data[p * img.channels + Math.min(c, img.channels - 1)];
  return { width: img.width, height: img.height, data };
}

export type ReplayParticipant = {
  puuid?: string;
  participantId: number;
  teamId: number;
  championName: string;
  riotIdGameName?: string;
  summonerName?: string;
  teamPosition?: string;
};
export type ReplayMatch = {
  metadata: { matchId: string };
  info: {
    gameVersion: string;
    gameType?: string;
    queueId: number;
    gameCreation: number;
    gameDuration: number;
    participants: ReplayParticipant[];
  };
};

export const numericGameId = (matchId: string) => matchId.split("_")[1];

export const readMatch = (gamesDir: string, matchId: string) =>
  readGameFile<ReplayMatch>(path.join(gamesDir, matchId), "match.json");

/** What the League client needs to create replay metadata for a match. */
export const replaySeed = (match: ReplayMatch): ReplayMetadataSeed => ({
  gameVersion: match.info.gameVersion,
  gameType: match.info.gameType ?? "MATCHED_GAME",
  queueId: match.info.queueId,
  gameEnd: match.info.gameCreation + Math.round(match.info.gameDuration * 1000),
});

/** EUW1 match IDs in the dataset, newest first (IDs grow with time). */
export const euwGamesNewestFirst = (gamesDir: string) =>
  readdirSync(gamesDir)
    .filter((d) => /^EUW1_\d+$/.test(d))
    .sort((a, b) => Number(numericGameId(b)) - Number(numericGameId(a)));

/** The newest ranked solo game on the installed patch, at least 15 min long. */
export function newestCurrentPatchGame(gamesDir: string, installed: string) {
  for (const id of euwGamesNewestFirst(gamesDir)) {
    const match = readMatch(gamesDir, id);
    const patch = comparePatch(match.info.gameVersion, installed);
    if (patch < 0) return null; // older from here on
    if (patch === 0 && match.info.queueId === 420 && match.info.gameDuration >= 900)
      return match;
  }
  return null;
}
