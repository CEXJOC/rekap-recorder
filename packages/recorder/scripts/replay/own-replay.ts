// Records one of the player's own replays (doc/REPLAY.md, desktop import): the
// game the desktop app asked for, under the player's team's fog, with the
// player's panel. The capture is replay-capture.ts, shared with the research
// queue; nothing here picks games, rotates fogs, shares to the team bucket or
// calls the Riot API. The desktop job folder (--out) already holds
// games/<matchId>/match.json; the recording goes to replays/<matchId>/.
//
//   npx tsx scripts/replay/own-replay.ts --out <job> --match-id EUW1_… \
//     --own-puuid <PUUID> --own-riot-id <name#tag> [--keep-world] [--fps 2]
//
// Like the queue's former --own-puuid mode it replaces (2026-10-12): it records
// one game and stops, never downloads or deletes the .rofl, writes progress as
// [replay-progress] lines, and ends with "stopping: <reason>" and exit code 0
// when the game could not be recorded (the desktop reads capture.json).
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertCurrentReplayAccount } from "../dataset/replay";
import { claimQueueLock } from "../../src/lib/replay/queue-lock-file";
import { emptyQueueState, nextSelectedRole, type Team } from "../../src/lib/replay/queue";
import { ownReplayPlayer } from "../../src/lib/replay/own-game";
import { assertClientIdle, closeReplayClient, gameProcessIds, readMatch } from "./replay-client";
import { closeReplay, configureCapture, log, recordGame, restoreReplayDisplay, SetupError, stop, stopped, waitUntilIdle } from "./replay-capture";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "match-id": { type: "string" },
    "own-puuid": { type: "string" },
    "own-riot-id": { type: "string" },
    fps: { type: "string", default: "2" },
    "min-free-gb": { type: "string", default: "30" },
    "fog-keys": { type: "string", default: "f1,f2,f3" },
    "gold-key": { type: "string", default: "x" },
    "fog-check-at": { type: "string", default: "90" },
    "idle-seconds": { type: "string", default: "120" },
    "stall-seconds": { type: "string", default: "90" },
    "end-stall-seconds": { type: "string", default: "120" },
    "keep-world": { type: "boolean", default: false },
  },
});
const matchId = values["match-id"] ?? "";
const puuid = values["own-puuid"] ?? "";
const riotId = values["own-riot-id"] ?? "";
if (!values.out || !/^[A-Z0-9]+_\d+$/.test(matchId) || !puuid)
  throw new Error("Usage: own-replay --out <job> --match-id <EUW1_…> --own-puuid <PUUID> --own-riot-id <name#tag>");
const root = path.resolve(values.out);
configureCapture({
  root,
  fps: Number(values.fps),
  minFreeBytes: Number(values["min-free-gb"]) * 1e9,
  fogCheckAt: Number(values["fog-check-at"]),
  idleSeconds: Number(values["idle-seconds"]),
  stallSeconds: Number(values["stall-seconds"]),
  endStallSeconds: Number(values["end-stall-seconds"]),
  fogKeys: values["fog-keys"]!,
  goldKey: values["gold-key"]!,
  keepWorld: values["keep-world"]!,
  // The player's .rofl is never deleted.
  keepRofl: true,
  own: { puuid, riotId },
});

let interrupts = 0;
process.on("SIGINT", () => {
  if (++interrupts > 1) {
    closeReplayClient()
      .catch(() => {})
      .finally(() => process.exit(1));
    return;
  }
  stop("Ctrl+C, after the current step (press again to quit at once)");
});

async function main() {
  if (process.platform !== "win32") throw new Error("Replays are recorded on Windows.");
  // One replay client per PC: the research queue and this import never run together.
  try {
    const machineLock = claimQueueLock(path.join(os.tmpdir(), "riftrecall-replay-client.lock"));
    process.on("exit", machineLock.release);
    const lock = claimQueueLock(path.join(root, "replay-queue.lock"));
    process.on("exit", lock.release);
  } catch (error) {
    throw new SetupError((error as Error).message);
  }
  const workRoot = path.join(root, "replay-work");
  if (existsSync(workRoot) && readdirSync(workRoot).length)
    await rm(workRoot, { recursive: true, force: true, maxRetries: 20 }).catch(() => {});
  try {
    const installed = (await assertClientIdle()).gameVersion;
    const match = readMatch(path.join(root, "games"), matchId);
    const own = ownReplayPlayer(match, matchId, puuid, installed);
    // A replay takes the whole screen: never while someone uses the PC.
    await waitUntilIdle("to open the next replay");
    if (stopped()) return;
    if ((await gameProcessIds()).length)
      throw new SetupError("Un jeu ou un replay est déjà ouvert : aucune fenêtre n’est fermée.");
    if (existsSync(path.join(root, "cancel"))) throw new SetupError("Récupération annulée.");
    await assertCurrentReplayAccount(puuid, riotId);
    const player = match.info.participants.find((p) => p.participantId === own.participantId);
    if (!player) throw new SetupError("Own replay participant missing.");
    const team = player.teamId as Team;
    const turn = nextSelectedRole(emptyQueueState());
    log(`${matchId} (UNKNOWN), fog of team ${team}, selecting ${player.championName} (${player.teamPosition || "no role"})`);
    const capture = await recordGame(
      { matchId, tier: "UNKNOWN", gameCreation: match.info.gameCreation, match },
      team,
      { player, turn },
    );
    log(`${matchId}: ${capture.frames} frames in ${(capture.wallSeconds.total / 60).toFixed(1)} min (1 recorded)`);
    stop("Own replay batch complete");
  } catch (error) {
    stop((error as Error).message);
  } finally {
    // The player's window settings come back once the replay is closed: the
    // game may write its settings to game.cfg when it quits.
    if ((await gameProcessIds()).length) await closeReplay();
    await restoreReplayDisplay().catch((error) => log(`game window settings not restored: ${(error as Error).message}`));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
