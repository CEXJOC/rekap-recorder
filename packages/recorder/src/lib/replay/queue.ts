// Replay queue logic: which game to record next, which team's fog, which
// player to select, where the stable screen elements are, and the labels each
// recording carries.
// The process side (client, recording, ffmpeg) is scripts/replay/replay-capture.ts, used by
// the research queue (replay-queue.ts) and the own-replay import (own-replay.ts).

export type Team = 100 | 200;

/**
 * Frames in a row that, all alike, mean the picture froze: the game clock in
 * the top bar changes every second, so 1.5 game seconds at 2 fps always show
 * a change in a game that runs.
 */
export const REPEATED_FRAMES = 4;

/**
 * When the newest frames (finished files, oldest first) end in at least
 * REPEATED_FRAMES identical ones, the index of the first of that run: the
 * last frame the game really drew. Otherwise null.
 */
export function frozenFrom(frames: Uint8Array[]): number | null {
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
  let first = frames.length - 1;
  if (first < 0) return null;
  while (first > 0 && same(frames[first - 1], frames[frames.length - 1])) first--;
  return frames.length - first >= REPEATED_FRAMES ? first : null;
}

/** Only a near-complete, frame-backed main capture may survive an end stall. */
export function acceptsEndStall(
  frames: number,
  start: number,
  end: number,
  fps: number,
  stalledAt: number,
  toleranceSeconds: number,
) {
  if (![frames, start, end, fps, stalledAt, toleranceSeconds].every(Number.isFinite) ||
      !Number.isInteger(frames) || frames < 1 || fps <= 0 || end <= start ||
      toleranceSeconds <= 0 || stalledAt < start || stalledAt > end) return false;
  const expected = Math.floor((end - start) * fps) + 1;
  const lastFrameTime = start + (frames - 1) / fps;
  return frames >= expected * 0.95 && frames <= expected &&
    end - stalledAt <= toleranceSeconds &&
    end - lastFrameTime <= toleranceSeconds && lastFrameTime <= stalledAt + 1e-6;
}

export type Candidate = {
  matchId: string;
  /** Tier of the player through whom the game was found (discovery.json). */
  tier: string;
  gameCreation: number;
};

/** Riot's teamPosition values, in the order the selected player rotates. */
export const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
export type Role = (typeof ROLES)[number];

export type Recorded = {
  tier: string;
  fogTeam: Team;
  at: string;
  /** The player whose panel was recorded; absent before 2026-10-05 or when no panel was found. */
  selected?: { participantId: number; role: string | null; champion: string };
};

export type QueueState = {
  recorded: Record<string, Recorded>;
  failed: Record<string, { reason: string; at: string }>;
  /** Failed attempts of games that may still succeed. */
  attempts: Record<string, number>;
  lastFogTeam: Team | null;
  lastSelectedRole: Role | null;
  /** Successful new games alternate single/paired; repairs do not advance it. */
  captureOrder?: { nextGame: "single" | "paired"; pendingPair?: string };
};

export const emptyQueueState = (): QueueState => ({
  recorded: {},
  failed: {},
  attempts: {},
  lastFogTeam: null,
  lastSelectedRole: null,
  captureOrder: { nextGame: "single" },
});

export const otherTeam = (team: Team): Team => (team === 100 ? 200 : 100);

/**
 * Recordings are folders of DATASET_ROOT/replays, and keys of the queue's
 * state and of the team's bucket. A game's first recording is named after the
 * match (`EUW1_8003011603`), whichever team's fog it shows; the same game
 * recorded again under the other team's fog adds that team
 * (`EUW1_8003011603-200`). Each team's own icons are always on its minimap,
 * so the two give every player's position, and each team's view of the other
 * (decided 2026-10-05).
 */
const RECORDING_ID = /^([A-Z0-9]+_\d+)(?:-(100|200))?$/;
export const isRecordingId = (id: string) => RECORDING_ID.test(id);
export const secondPassId = (matchId: string, team: Team) => `${matchId}-${team}`;
export const isSecondPass = (id: string) => RECORDING_ID.exec(id)?.[2] !== undefined;

/**
 * Next game to record again under the other team's fog: the oldest first,
 * since replays expire. `firstPasses` are this PC's first recordings that can
 * still be replayed; second passes recorded, failed or in `shared` are skipped.
 */
export function pickSecondPass<C extends { matchId: string; fogTeam: Team; gameCreation: number }>(
  firstPasses: C[],
  state: QueueState,
  shared?: ReadonlySet<string>,
): (C & { team: Team; recordingId: string }) | null {
  const open = firstPasses
    .map((c) => {
      const team = otherTeam(c.fogTeam);
      return { ...c, team, recordingId: secondPassId(c.matchId, team) };
    })
    .filter(
      (c) =>
        !state.recorded[c.recordingId] &&
        !state.failed[c.recordingId] &&
        !shared?.has(c.recordingId),
    );
  if (!open.length) return null;
  return open.reduce((oldest, c) => (c.gameCreation < oldest.gameCreation ? c : oldest));
}

/**
 * Next game: from the tier with the fewest recordings so far, the newest game
 * (replays expire with the patch). Recorded and failed games are skipped,
 * and so are the games of `shared`: recordings already in the team's dataset.
 * Tiers count games: second passes are left out.
 */
export function pickNext<C extends Candidate>(
  candidates: C[],
  state: QueueState,
  shared?: ReadonlySet<string>,
): C | null {
  const open = candidates.filter(
    (c) =>
      !state.recorded[c.matchId] &&
      !state.failed[c.matchId] &&
      !shared?.has(c.matchId),
  );
  if (!open.length) return null;
  const done = new Map<string, number>();
  for (const [id, r] of Object.entries(state.recorded))
    if (!isSecondPass(id)) done.set(r.tier, (done.get(r.tier) ?? 0) + 1);
  const count = (tier: string) => done.get(tier) ?? 0;
  return open.reduce((best, c) =>
    count(c.tier) < count(best.tier) ||
    (count(c.tier) === count(best.tier) && c.gameCreation > best.gameCreation)
      ? c
      : best,
  );
}

export type CaptureChoice<C extends Candidate = Candidate> = {
  candidate: C;
  team: Team;
  recordingId: string;
  secondPass: boolean;
};

/**
 * One new game under one fog, then a new game under both fogs. Complete the
 * pending pair before another new game, including after a restart. Legacy
 * unpaired games do not enter this rotation. If the pending replay expired,
 * failed or was shared, continue with the next new game.
 */
export function pickNextCapture<C extends Candidate>(
  candidates: C[],
  state: QueueState,
  unavailable?: ReadonlySet<string>,
  secondPasses = true,
): CaptureChoice<C> | null {
  const pending = state.captureOrder?.pendingPair;
  const first = pending ? state.recorded[pending] : undefined;
  const candidate = pending ? candidates.find((c) => c.matchId === pending) : undefined;
  if (secondPasses && first && candidate) {
    const pass = pickSecondPass([{ ...candidate, fogTeam: first.fogTeam }], state, unavailable);
    if (pass)
      return { candidate, team: pass.team, recordingId: pass.recordingId, secondPass: true };
  }
  const next = pickNext(candidates, state, unavailable);
  return next
    ? { candidate: next, team: nextFogTeam(state), recordingId: next.matchId, secondPass: false }
    : null;
}

/** Call only after a successful capture, never for a repair or failed attempt. */
export function advanceCaptureOrder(
  state: QueueState,
  matchId: string,
  secondPass: boolean,
  secondPasses = true,
): void {
  // --no-second-pass pauses the rotation, including any unfinished pair.
  if (!secondPasses) return;
  const order = state.captureOrder ?? { nextGame: "single" };
  if (secondPass) {
    if (order.pendingPair === matchId) state.captureOrder = { nextGame: order.nextGame };
    return;
  }
  state.captureOrder = order.nextGame === "single"
    ? { nextGame: "paired" }
    : { nextGame: "single", pendingPair: matchId };
}

/**
 * Several different games failing in a row point at the PC, not at the games:
 * their attempts are given back. Once per game and per run: a game in
 * `forgiven` was given back before and failed again, so it keeps its failure.
 * (Given back every time, the same second passes failed all night: they come
 * first, and the queue never reached a new game.) Returns the games given
 * back and adds them to `forgiven`.
 */
export function gamesGivenBack(failing: Iterable<string>, forgiven: Set<string>): string[] {
  const back = [...failing].filter((id) => !forgiven.has(id));
  for (const id of back) forgiven.add(id);
  return back;
}

/**
 * Whether a failure says the replay itself cannot be watched: incompatible
 * with the installed patch, or not downloadable. Such a game is never tried
 * again, even with --retry-failed. A replay left in "checking" is not one:
 * the League client could not reach Riot's replay service. Games failed that
 * way up to 2026-10-09 ("not downloadable/watchable (state: checking)") were
 * the client's fault and get their try back.
 */
export const isGameFault = (reason: string) =>
  /incompatible|not downloadable/i.test(reason) && !/state: checking/i.test(reason);

/**
 * The game processes to end when the queue closes its replay: the one that
 * answers on the Replay API, and the one the queue opened, as long as a game
 * client still runs under its ID. A frozen replay does not answer, and ending
 * it by name needs the League client to say that no real game runs: with the
 * client closed too, the ID is the only way left.
 */
export function replayProcesses(
  answering: number,
  opened: number | null | undefined,
  running: readonly number[],
  onlyOwned = false,
): number[] {
  if (onlyOwned) {
    if (!opened || !running.includes(opened) || (Number.isInteger(answering) && answering > 0 && answering !== opened)) return [];
    return [opened];
  }
  const ids = new Set<number>();
  if (Number.isInteger(answering) && answering > 0) ids.add(answering);
  if (opened && running.includes(opened)) ids.add(opened);
  return [...ids];
}

/** The fog of first passes alternates between teams from one game to the next. */
export const nextFogTeam = (state: QueueState): Team =>
  state.lastFogTeam === 100 ? 200 : 100;

/**
 * The selected player's role changes from one game to the next, top first.
 * With the fog alternating, each role of each team comes up once in ten games.
 */
export const nextSelectedRole = (state: QueueState): Role =>
  ROLES[
    state.lastSelectedRole
      ? (ROLES.indexOf(state.lastSelectedRole) + 1) % ROLES.length
      : 0
  ];

export type SelectCandidate = {
  participantId: number;
  teamId: number;
  championName: string;
  teamPosition?: string;
};

/**
 * The player whose panel a recording keeps. On the fog team, since the panel
 * (abilities and their cooldowns, summoner spells) is that player's own
 * knowledge: the player in `role`, or else the next role in the rotation that
 * the team has (teamPosition is empty in some games).
 */
export function playerToSelect<P extends SelectCandidate>(
  participants: P[],
  team: Team,
  role: Role,
): P | null {
  const ours = participants.filter((p) => p.teamId === team);
  const start = ROLES.indexOf(role);
  for (let i = 0; i < ROLES.length; i++) {
    const found = ours.find(
      (p) => p.teamPosition === ROLES[(start + i) % ROLES.length],
    );
    if (found) return found;
  }
  return ours[0] ?? null;
}

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Stable elements of the spectator HUD at 1920×1080 with the replay interface
 * scale at 1 (measured on patch 16.19): the five frames of each team at the
 * sides, the top bar (score, towers, dragons, clock) and the bottom
 * scoreboard. Under one team's fog the scoreboard darkens the portrait of an
 * enemy the team cannot see and marks it with a question mark (the side frames
 * do not), and its gold mode (the X key) shows every player's current gold.
 * The side strips extend inward to retain the ultimate discs: the old 82 px
 * strips clipped their inner edges. At 90 px they also keep a small margin
 * beyond the measured discs (research/audits/FRAMES_READINESS_AUDIT.md).
 * The minimap is located in each game, since its size is a setting.
 */
export const SPECTATOR_LAYOUT_1080: Record<
  "framesBlue" | "framesRed" | "topBar" | "scoreboard",
  Box
> = {
  framesBlue: { x: 0, y: 132, width: 90, height: 508 },
  framesRed: { x: 1830, y: 132, width: 90, height: 508 },
  topBar: { x: 395, y: 0, width: 1145, height: 100 },
  scoreboard: { x: 600, y: 848, width: 736, height: 232 },
};

/**
 * The name above each team frame (5 rows, 103 px apart) is blacked out when
 * frames.mp4 is written: no player name leaves a recording (data contract
 * 0.2, doc/tasks/open-recorder.md). Readers start lower, at +18 px for the
 * ultimate disc (ally-readiness.ts), +28 px for the portrait and +74 px for
 * the bars (replay-frames.ts); measured on a real capture 2026-10-12.
 */
export const FRAME_NAME_BAND = { rowPitch: 103, height: 17, rows: 5 };

/** ffmpeg filter that blacks out the name bands of joined team frames. */
export function frameNameMask(band = FRAME_NAME_BAND) {
  return Array.from({ length: band.rows }, (_, row) => `drawbox=x=0:y=${row * band.rowPitch}:w=iw:h=${band.height}:color=black:t=fill`).join(",");
}

/**
 * Share of the scoreboard box's top rows that its gold border fills (the best
 * of the first four rows). From the afternoon of 2026-10-08 replays opened
 * with the scoreboard collapsed (ShowReplayScoreboard=0 in game.cfg, cause
 * unknown): only its border shows, about 210 px lower, and the box holds the
 * map. Measured 2026-10-09 on the 600 s frame: 0.96 on the 98 recordings of
 * 16.19, on the one of 16.20 made before, and on a 16.20 replay with the line
 * at 1; 0.00 on the 40 recordings made with it at 0.
 */
export function scoreboardBorder(frame: { width: number; data: Uint8Array }) {
  const s = SPECTATOR_LAYOUT_1080.scoreboard;
  let best = 0;
  for (let y = s.y; y < s.y + 4; y++) {
    let n = 0;
    for (let x = s.x; x < s.x + s.width; x++) {
      const i = (y * frame.width + x) * 3;
      const [r, g, b] = [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
      if (r > 80 && r > g && g > b && b < 0.75 * r && r - b > 35) n++;
    }
    best = Math.max(best, n / s.width);
  }
  return best;
}
/** At or above this share of border the scoreboard is drawn in full. */
export const SCOREBOARD_SHOWN = 0.8;

/**
 * The next game of a record-again list (first passes recorded here without
 * their scoreboard): one this queue recorded, still replayable on the
 * installed patch (in `pool`), not yet recorded again (`redone`), and not
 * given up in this run. Its fog team and selected player are the earlier ones.
 */
export function nextToRecordAgain<C extends { matchId: string }>(
  ids: readonly string[],
  pool: readonly C[],
  state: QueueState,
  redone: (id: string) => boolean,
  gaveUp: ReadonlySet<string>,
): { candidate: C; before: Recorded } | null {
  const byId = new Map(pool.map((c) => [c.matchId, c]));
  for (const id of ids) {
    const candidate = byId.get(id);
    const before = state.recorded[id];
    if (candidate && before && !gaveUp.has(id) && !redone(id)) return { candidate, before };
  }
  return null;
}

/**
 * game.cfg with the replay's scoreboard drawn in full (ShowReplayScoreboard=1
 * under [Replay]), or null when it already is. It was 0 on a team PC from the
 * afternoon of 2026-10-08.
 */
export function withReplayScoreboard(cfg: string): string | null {
  return withGameCfgSetting(cfg, "Replay", "ShowReplayScoreboard", "1");
}

/**
 * The game.cfg settings every recording needs, set before each replay opens:
 * the replay's scoreboard drawn in full, and the minimap's camp countdowns.
 * On 2026-10-16, the 178 of 659 prepared recordings without camp clocks all
 * came from the PCs whose minimap drew an hourglass on a respawning camp and
 * no countdown; the PC with MinimapEnableAllTimers=1 and ShowNeutralCamps=1
 * under [HUD] had clocks in all 477 of its recordings.
 */
export const REPLAY_GAME_CFG = [
  { section: "Replay", key: "ShowReplayScoreboard", value: "1" },
  { section: "HUD", key: "MinimapEnableAllTimers", value: "1" },
  { section: "HUD", key: "ShowNeutralCamps", value: "1" },
] as const;

/** game.cfg with `key=value` under `[section]`, or null when it already is. */
export function withGameCfgSetting(cfg: string, section: string, key: string, value: string): string | null {
  const eol = cfg.includes("\r\n") ? "\r\n" : "\n";
  const lines = cfg.split(/\r?\n/);
  const wanted = `${key}=${value}`;
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) {
    const end = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(end, 0, `[${section}]`, wanted);
    return lines.join(eol);
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const at = lines.slice(start + 1, end).findIndex((l) => isKey(l, key));
  if (at < 0) lines.splice(start + 1, 0, wanted);
  else if (lines[start + 1 + at].trim() === wanted) return null;
  else lines[start + 1 + at] = wanted;
  return lines.join(eol);
}

/** game.cfg with each setting (default: REPLAY_GAME_CFG) and the keys it changed, or null when all already were. */
export function withReplaySettings(
  cfg: string,
  settings: readonly { section: string; key: string; value: string }[] = REPLAY_GAME_CFG,
): { cfg: string; changed: string[] } | null {
  const changed: string[] = [];
  for (const s of settings) {
    const next = withGameCfgSetting(cfg, s.section, s.key, s.value);
    if (next === null) continue;
    cfg = next;
    changed.push(`${s.key}=${s.value}`);
  }
  return changed.length ? { cfg, changed } : null;
}

/** The value of `key` under `[section]` in game.cfg, or null when it is absent. */
export function gameCfgValue(cfg: string, section: string, key: string): string | null {
  let inSection = false;
  for (const line of cfg.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inSection = line.trim() === `[${section}]`;
    else if (inSection && isKey(line, key)) return line.slice(line.indexOf("=") + 1).trim();
  }
  return null;
}
const isKey = (line: string, key: string) => line.includes("=") && line.slice(0, line.indexOf("=")).trim() === key;

/**
 * Where the queue looks for the selected champion's panel at 1920×1080: left
 * of the scoreboard and below the blue frames. With the replay controls shown
 * it sat at x 1–306, y 803–961 (fog test, patch 16.19). The queue hides the
 * controls, which may move it, so it finds the panel in each game.
 */
export const PANEL_SEARCH_1080: Box = { x: 0, y: 650, width: 600, height: 430 };

/**
 * Render flags that keep only the minimap, the frames, the top bar, the
 * scoreboard and the objective timers (players can show those in game too),
 * and with `target` the selected champion's panel.
 */
export function minimalInterface(
  render: Record<string, unknown>,
  target = false,
) {
  const keep = [
    "interfaceAll",
    "interfaceMinimap",
    "interfaceFrames",
    "interfaceScore",
    "interfaceScoreboard",
    "interfaceNeutralTimers",
    ...(target ? ["interfaceTarget"] : []),
  ];
  return Object.fromEntries(
    Object.keys(render)
      .filter((k) => k.startsWith("interface"))
      .map((k) => [k, keep.includes(k)]),
  );
}

/**
 * Labels of a recording under one team's verified fog (doc/DECISION_FACTS.md,
 * "Information policy"): player knowledge for that team, except what
 * spectator mode shows beyond the team's vision. Gold is recorded for all ten
 * players; only the judged player's own gold is that player's knowledge.
 * Camp timers (decided 2026-10-04): known to the team only when the camp died
 * in its vision; epic objective timers are announced to both teams. The
 * selected player's panel, when recorded, is that player's own knowledge
 * (abilities and their cooldowns, summoner spells, buffs, stats); the four
 * teammates do not see it.
 */
export const captureLabels = (fogTeam: Team, selectedPanel = false) => ({
  provenance: "TEAM_FOG_REPLAY" as const,
  fogTeam,
  playerKnowledgeFor: fogTeam,
  playerKnowledge: [
    "minimap",
    "campTimersStartedInTeamVision",
    "epicObjectiveTimers",
    "ownTeamFrames",
    "scoreboardQuestionMarks",
    "enemyFramesWhileSeen",
    "judgedPlayerOwnGold",
    ...(selectedPanel ? ["selectedPlayerOwnPanel"] : []),
  ],
  evaluationOnly: [
    "campTimersStartedInFog",
    "enemyFramesWhileQuestionMarked",
    "otherPlayersGold",
    "topBarTeamGold",
    ...(selectedPanel ? ["selectedPlayerPanelForTeammates"] : []),
  ],
});
