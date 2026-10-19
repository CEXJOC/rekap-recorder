import { z } from "zod";

/**
 * What may leave the player's PC, file by file, for each kind of recording.
 * The uploader sends only files listed for the recording's source, and the
 * server refuses anything else for the announced version. A change to these
 * lists is a new version and a change to docs/data-contract.md.
 */
export const CONTRACT_VERSION = "0.2.0-draft";

/**
 * live: a game the player plays, recorded from the game screen.
 * replay: one of the player's own past games, recorded from League's replay
 * viewer (spectator interface) under the player's team's fog of war.
 */
export const SOURCES = ["live", "replay"] as const;
export type Source = (typeof SOURCES)[number];

export const manifestEntrySchema = z.object({
  /** File name inside a recording folder. */
  path: z.string().regex(/^[a-z0-9-]+\.(mp4|json|ndjson)$/),
  required: z.boolean(),
  /** Why Rekap needs it. */
  purpose: z.string().min(1),
  /** What it holds, in plain words. */
  contains: z.string().min(1),
  /** What the PC does to it before it may leave. */
  before: z.array(z.string()),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

const NO_SOUND = "No sound.";

export const UPLOAD_MANIFEST: Readonly<Record<Source, readonly ManifestEntry[]>> = {
  live: [
    {
      path: "game.json",
      required: true,
      purpose: "Know which game this is and who played which champion.",
      contains: "Contract version, game mode, map, and for each of the ten players a slot (P1-P10), champion, team and position; which slot is the player.",
      before: ["Built from the first Live Client payload; Riot IDs, summoner names, runes text and tooltips are left out."],
    },
    {
      path: "samples.ndjson",
      required: true,
      purpose: "Rebuild the game second by second: gold, health, items, deaths and objectives.",
      contains: "One line per second: game time; the player's gold, level, health and resource; for all ten players champion, team, level, dead or alive, K/D/A, CS, ward score and items; new game events.",
      before: ["Every player name is replaced by its slot (P1-P10); a name that is not a player or a game object becomes \"unknown\"."],
    },
    {
      path: "clock.json",
      required: true,
      purpose: "Line up the video with the game clock.",
      contains: "Frame rate, size, offset between video time and game time, its spread, and gaps where capture stopped.",
      before: ["Keeps only these fields from the local screen.json."],
    },
    {
      path: "masked.mp4",
      required: true,
      purpose: "Positions, vision, health and the player's own state, as the player saw them.",
      contains: `The game screen with everything black except the top counters (score, K/D/A, CS, clock), the ally portraits, the minimap and the player's HUD. ${NO_SOUND}`,
      before: ["The 3D world, chat, kill feed, target panel, other windows and notifications are blacked out on the PC (masked-screen.ts)."],
    },
  ],
  replay: [
    {
      path: "capture.json",
      required: true,
      purpose: "Know which game, which team's fog of war and which player the recording follows, and how it was checked.",
      contains: "Match ID, game version, fog team, the followed player's participant ID, champion and role, frame rate, frame count, screen size, minimap square and the capture checks.",
      before: ["The followed player's Riot ID is removed (selectedPlayer.riotIdGameName, selectionCheck.selection)."],
    },
    {
      path: "minimap.mp4",
      required: true,
      purpose: "Positions, waves and vision under the player's team's fog of war.",
      contains: `The minimap square only. ${NO_SOUND}`,
      before: ["Cropped on the PC."],
    },
    {
      path: "frames.mp4",
      required: false,
      purpose: "Health, resource, spells, ultimate and level of the ten players, as the team frames show them.",
      contains: `The two team frame columns. ${NO_SOUND}`,
      before: ["Cropped on the PC.", "The name above each portrait is blacked out."],
    },
    {
      path: "top.mp4",
      required: false,
      purpose: "Kills, towers, objectives and the game clock.",
      contains: `The top bar only. ${NO_SOUND}`,
      before: ["Cropped on the PC."],
    },
    {
      path: "scoreboard.mp4",
      required: false,
      purpose: "Items, K/D/A and CS of the ten players.",
      contains: `The spectator scoreboard, which shows no player names. ${NO_SOUND}`,
      before: ["Cropped on the PC."],
    },
    {
      path: "player.mp4",
      required: false,
      purpose: "The followed player's own health, stats, spells and cooldowns.",
      contains: `The followed player's panel. ${NO_SOUND}`,
      before: ["Cropped on the PC."],
    },
    {
      path: "cooldowns.json",
      required: false,
      purpose: "The followed player's spell cooldowns, read from their panel.",
      contains: "Cooldown start times per spell slot.",
      before: [],
    },
  ],
};

/** Files that exist on the PC and never leave it, with the reason. */
export const NEVER_UPLOADED: Readonly<Record<string, string>> = {
  "screen.mp4": "Full-screen video: it can show other windows, notifications and names.",
  "screen.mkv": "Full-screen video while recording.",
  "screen.json": "Local video details; clock.json carries the fields the server needs.",
  "screen.recording.json": "Local crash recovery.",
  "meta.json": "First Live Client payload with every player's Riot ID; game.json replaces it.",
  "source.json": "Local folder description with the player's PUUID.",
  "report.json": "The local review; the server computes its own.",
  "report.md": "The local review; the server computes its own.",
  "match.json": "The server fetches match data from Riot itself.",
  "timeline.json": "The server fetches the timeline from Riot itself.",
  "map.json": "The local analysis; the server computes its own.",
  "map-debug.json": "Local analysis details.",
  "map-analyze.log": "Local analysis log.",
};

export type UploadCheck = {
  allowed: string[];
  refused: { path: string; reason: string }[];
  missing: string[];
};

/** Splits a recording folder's files into what may be sent and what may not. */
export function checkUpload(source: Source, paths: readonly string[]): UploadCheck {
  const entries = UPLOAD_MANIFEST[source];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const allowed: string[] = [];
  const refused: UploadCheck["refused"] = [];
  for (const path of paths) {
    if (byPath.has(path)) allowed.push(path);
    else refused.push({ path, reason: NEVER_UPLOADED[path] ?? "Not in the upload manifest for this source." });
  }
  const missing = entries.filter((entry) => entry.required && !paths.includes(entry.path)).map((entry) => entry.path);
  return { allowed, refused, missing };
}

/** capture.json without the followed player's Riot ID. */
export function cleanReplayCapture<T extends Record<string, unknown>>(capture: T): T {
  const out = structuredClone(capture) as Record<string, unknown>;
  const selected = out.selectedPlayer as Record<string, unknown> | undefined;
  if (selected) delete selected.riotIdGameName;
  const check = out.selectionCheck as Record<string, unknown> | undefined;
  if (check) delete check.selection;
  return out as T;
}
