// The cooldown reader, shared by npm run replay:cooldowns and the replay queue
// (doc/REPLAY.md, "Per game"): reads the selected player's panel
// (player.mp4) frame by frame and writes cooldowns.json.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { Raster } from "../../src/lib/map/perception/raster";
import {
  cooldownEpisodes,
  COOLDOWNS_VERSION,
  createCooldownFrameReader,
  FLASH_READY_CONFIRM_SECONDS,
  hexflashSlot,
  NUMBER_PIXELS,
  panelOrigin,
  READY_COLOUR,
  rowProblem,
  Slot,
  SLOTS,
  SUMMONER_SPELLS,
} from "../../src/lib/replay/cooldowns";
import { Box } from "../../src/lib/replay/queue";
import { hasGameFile, readGameFile } from "../common/game-files";
import { pngRaster } from "./replay-client";

export type Capture = {
  matchId: string;
  fps: number;
  selectedPlayer?: {
    participantId: number;
    championName: string;
    role: string | null;
  } | null;
  selectionCheck?: { changed?: Box | null } | null;
  layout?: { playerPanel?: Box };
};
type Participant = {
  participantId: number;
  summoner1Id?: number;
  summoner2Id?: number;
  perks?: { styles?: { selections?: { perk?: number }[] }[] };
};
type Timeline = {
  info: {
    frames: {
      events: {
        type: string;
        participantId?: number;
        skillSlot?: number;
        timestamp: number;
      }[];
    }[];
  };
};

/** The states of every frame of player.mp4, one string per slot. */
function readStates(
  file: string,
  box: Box,
  reference: Raster,
  origin: { x: number; y: number },
  hexflash: "D" | "F" | null,
  fps: number,
) {
  const size = box.width * box.height * 3;
  const read = createCooldownFrameReader(reference, origin, hexflash, fps);
  let frameIndex = 0;
  return new Promise<Record<Slot, string>>((resolve, reject) => {
    const child = spawn(
      ffmpegPath!,
      [
        "-v",
        "error",
        "-i",
        file,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const states = Object.fromEntries(
      SLOTS.map((s) => [s, [] as string[]]),
    ) as Record<Slot, string[]>;
    let pending = Buffer.alloc(0);
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      pending = Buffer.concat([pending, b]);
      for (; pending.length >= size; pending = pending.subarray(size)) {
        const frame = {
          width: box.width,
          height: box.height,
          data: new Uint8Array(pending.subarray(0, size)),
        };
        const s = read(frame, frameIndex++ / fps);
        for (const slot of SLOTS) states[slot].push(s[slot]);
      }
    });
    child.stderr.on("data", (b: Buffer) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(
            Object.fromEntries(
              SLOTS.map((s) => [s, states[s].join("")]),
            ) as Record<Slot, string>,
          )
        : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-300)}`)),
    );
  });
}

/** Game second each of Q, W, E, R was first learned, from the Riot timeline. */
function learnedAt(timeline: Timeline, participantId: number) {
  const out: Partial<Record<Slot, number | null>> = {
    Q: null,
    W: null,
    E: null,
    R: null,
  };
  const keys = ["", "Q", "W", "E", "R"] as const;
  for (const e of timeline.info.frames.flatMap((f) => f.events))
    if (
      e.type === "SKILL_LEVEL_UP" &&
      e.participantId === participantId &&
      e.skillSlot &&
      e.skillSlot <= 4
    ) {
      const k = keys[e.skillSlot] as Slot;
      if (out[k] === null) out[k] = e.timestamp / 1000;
    }
  return out;
}

/**
 * Reads player.mp4 in a recording folder and writes cooldowns.json next to it;
 * `capture` is the recording's capture.json, or what the queue is about to
 * write there. Returns a one-line summary.
 */
export async function writeCooldowns(
  dir: string,
  capture: Capture,
  gamesDir: string,
  outDir = dir,
) {
  const matchId = capture.matchId;
  const box = capture.layout?.playerPanel;
  const changed = capture.selectionCheck?.changed;
  const player = capture.selectedPlayer;
  if (
    !box ||
    !changed ||
    !player ||
    !existsSync(path.join(dir, "panel-check.png"))
  )
    throw new Error("no selected player's panel in this recording");
  const origin = panelOrigin(changed, box);
  const reference = pngRaster(readFileSync(path.join(dir, "panel-check.png")));
  const game = path.join(gamesDir, matchId);
  const participant = hasGameFile(game, "match.json")
    ? readGameFile<{ info: { participants: Participant[] } }>(
        game,
        "match.json",
      ).info.participants.find((p) => p.participantId === player.participantId)
    : undefined;
  // With Hextech Flashtraption the Flash slot holds Hexflash while Flash is
  // down: told apart by colour, for the players the match file says took it.
  const runes = (participant?.perks?.styles ?? []).flatMap((s) =>
    (s.selections ?? []).map((x) => x.perk ?? 0),
  );
  const hexflash = hexflashSlot(
    runes,
    participant?.summoner1Id,
    participant?.summoner2Id,
  );
  const states = await readStates(
    path.join(dir, "player.mp4"),
    box,
    reference,
    origin,
    hexflash,
    capture.fps,
  );
  const problem = rowProblem(states);
  if (problem) throw new Error(`the ability row was not read: ${problem}`);
  const spell = (id?: number) =>
    id ? { id, name: SUMMONER_SPELLS[id] ?? `Summoner spell ${id}` } : null;
  const frames = states.P.length;
  const shown = [...states.P].filter((s) => s !== "?").length;
  const result = {
    version: COOLDOWNS_VERSION,
    matchId,
    source: "player.mp4",
    participantId: player.participantId,
    championName: player.championName,
    role: player.role,
    summonerSpells: {
      D: spell(participant?.summoner1Id),
      F: spell(participant?.summoner2Id),
    },
    // The Flash slot of a player who took Hextech Flashtraption, where h can be read; null otherwise.
    hexflash,
    fps: capture.fps,
    frames,
    framesWithPanel: shown,
    frameTime: "game second of frame i = i / fps",
    stateCodes: {
      r: "ready",
      c: "on cooldown",
      "-": "unavailable (greyed, no number)",
      "?": "unknown: missing/clipped panel slot or unconfirmed Flash return",
      h: "Hexflash ready in the Flash slot: Flash itself is on cooldown",
    },
    thresholds: {
      readyColour: READY_COLOUR,
      numberPixels: NUMBER_PIXELS,
      flashReadyConfirmSeconds: FLASH_READY_CONFIRM_SECONDS,
    },
    learnedAt: hasGameFile(game, "timeline.json")
      ? learnedAt(
          readGameFile<Timeline>(game, "timeline.json"),
          player.participantId,
        )
      : null,
    states,
    cooldowns: Object.fromEntries(
      SLOTS.map((s) => [s, cooldownEpisodes(states[s], capture.fps)]),
    ),
    readAt: new Date().toISOString(),
  };
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, "cooldowns.json");
  await writeFile(`${out}.tmp`, JSON.stringify(result, null, 1));
  await rename(`${out}.tmp`, out);
  const casts = SLOTS.map(
    (s) =>
      `${s} ${result.cooldowns[s].filter((e) => e.castAfter !== null).length}`,
  ).join(", ");
  return `${player.championName}, panel in ${shown} of ${frames} frames; cooldowns started: ${casts}`;
}
