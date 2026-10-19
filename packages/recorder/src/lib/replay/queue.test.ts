import { describe, expect, it } from "vitest";
import {
  captureLabels,
  acceptsEndStall,
  emptyQueueState,
  frozenFrom,
  gamesGivenBack,
  isRecordingId,
  isSecondPass,
  playerToSelect,
  minimalInterface,
  nextFogTeam,
  nextSelectedRole,
  pickNext,
  pickSecondPass,
  QueueState,
  replayProcesses,
  ROLES,
  secondPassId,
  SPECTATOR_LAYOUT_1080,
  FRAME_NAME_BAND,
  frameNameMask,
} from "./queue";
import { blank, crop, drawCircle, drawLine, type Raster } from "../map/perception/raster";

describe("spectator side-frame crop", () => {
  // Draw the measured R positions including the audit's ±1 px uncertainty.
  // The coloured disc perimeter and white hands both extend past the old
  // inner crop boundaries; dropping either is a recording regression.
  function ultimateFrame() {
    const screen = blank(1920, 1080);
    for (let row = 0; row < 5; row++) {
      const y = 132 + 31 + row * 103;
      for (const x of [71, 1846]) {
        drawCircle(screen, x, y, 13, [200, 60, 160]);
        drawLine(screen, x, y, x === 71 ? x + 13 : x - 13, y, [255, 255, 255]);
        drawLine(screen, x, y, x, y - 13, [255, 255, 255]);
      }
    }
    return screen;
  }
  function visiblePixels(r: Raster) {
    let count = 0;
    for (let i = 0; i < r.data.length; i += 3)
      if (r.data[i] || r.data[i + 1] || r.data[i + 2]) count++;
    return count;
  }
  it("retains the complete R discs and sweep hands on both sides of every row", () => {
    const screen = ultimateFrame();
    const { framesBlue: blue, framesRed: red } = SPECTATOR_LAYOUT_1080;
    const strips = [blue, red].map((b) =>
      crop(screen, b.x, b.y, b.width, b.height),
    );
    expect(strips.reduce((n, r) => n + visiblePixels(r), 0)).toBe(visiblePixels(screen));
    // Confirm the boundary pixels for all ten discs are retained in their
    // own strip, with spare background before the join (never the other team).
    for (let row = 0; row < 5; row++) {
      for (const [i, x] of [[0, 84], [1, 1833]] as const) {
        const b = i === 0 ? blue : red;
        const localX = x - b.x;
        const offset = ((31 + row * 103) * b.width + localX) * 3;
        expect(Array.from(strips[i].data.slice(offset, offset + 3))).toEqual([255, 255, 255]);
        expect(localX).toBeGreaterThanOrEqual(3);
        expect(localX).toBeLessThan(b.width - 3);
      }
    }
  });
  it("reproduces the lost disc and sweep pixels with the historical 82 px strips", () => {
    const screen = ultimateFrame();
    const retained = [0, 1838].reduce(
      (n, x) => n + visiblePixels(crop(screen, x, 132, 82, 508)),
      0,
    );
    expect(retained).toBeLessThan(visiblePixels(screen));
  });
});

const game = (matchId: string, tier: string, gameCreation: number) => ({
  matchId,
  tier,
  gameCreation,
});

describe("end-stall recovery", () => {
  it("keeps a 40-minute game frozen at 39:56 without padding its tail", () => {
    expect(acceptsEndStall(4793, 0, 2400, 2, 2396, 120)).toBe(true);
  });

  it("allows the 120-second boundary only with at least 95% of expected frames", () => {
    expect(acceptsEndStall(5761, 0, 3000, 2, 2880, 120)).toBe(true);
    expect(acceptsEndStall(5759, 0, 3000, 2, 2879, 120)).toBe(false);
    expect(acceptsEndStall(1561, 0, 900, 2, 780, 120)).toBe(false);
  });

  it("rejects near-end API progress when the PNG sequence is incomplete", () => {
    expect(acceptsEndStall(4000, 0, 2400, 2, 2396, 120)).toBe(false);
    expect(acceptsEndStall(5759, 0, 3000, 2, 2999, 120)).toBe(false);
  });

  it("rejects frames extending beyond observed progress or the intended end", () => {
    expect(acceptsEndStall(4794, 0, 2400, 2, 2396, 120)).toBe(false);
    expect(acceptsEndStall(4802, 0, 2400, 2, 2400, 120)).toBe(false);
  });

  it("requires valid progress and an explicit main-capture tolerance", () => {
    expect(acceptsEndStall(4793, 0, 2400, 2, 2396, 0)).toBe(false);
    expect(acceptsEndStall(4793, 0, 2400, 2, -Infinity, 120)).toBe(false);
    expect(acceptsEndStall(0, 0, 2400, 2, 2396, 120)).toBe(false);
    expect(acceptsEndStall(4793, 0, 2400, 0, 2396, 120)).toBe(false);
    expect(acceptsEndStall(4793, 0, 2400, 2, 2396, NaN)).toBe(false);
    expect(acceptsEndStall(4793, 0, 2400, 2, 2401, 120)).toBe(false);
  });
});

describe("frozen picture", () => {
  const frame = (v: number) => new Uint8Array([v, v, v, 7]);
  it("finds the last frame drawn before four or more repeats of it", () => {
    expect(frozenFrom([1, 2, 3, 3, 3, 3].map(frame))).toBe(2);
    expect(frozenFrom([1, 2, 3, 3, 3, 3, 3, 3].map(frame))).toBe(2);
  });
  it("lets a game that runs go, even with a few alike frames", () => {
    expect(frozenFrom([1, 2, 3, 3, 3].map(frame))).toBe(null);
    expect(frozenFrom([3, 3, 3, 3, 4].map(frame))).toBe(null);
    expect(frozenFrom([])).toBe(null);
  });
});

describe("replay queue", () => {
  it("takes the newest game of the least recorded tier", () => {
    const state = emptyQueueState();
    state.recorded.A = { tier: "GOLD", fogTeam: 100, at: "" };
    const next = pickNext(
      [game("B", "GOLD", 30), game("C", "MASTER", 10), game("D", "MASTER", 20)],
      state,
    );
    expect(next?.matchId).toBe("D");
  });

  it("skips recorded and failed games, and stops when none is left", () => {
    const state = emptyQueueState();
    state.recorded.A = { tier: "GOLD", fogTeam: 100, at: "" };
    state.failed.B = { reason: "incompatible", at: "" };
    expect(pickNext([game("A", "GOLD", 1), game("B", "GOLD", 2)], state)).toBe(null);
  });

  it("skips games a teammate already shared", () => {
    const games = [game("A", "GOLD", 1), game("B", "GOLD", 2), game("C", "GOLD", 3)];
    expect(pickNext(games, emptyQueueState(), new Set(["C"]))?.matchId).toBe("B");
    expect(pickNext(games, emptyQueueState(), new Set(["A", "B", "C"]))).toBe(null);
  });

  it("alternates the fog team, blue first", () => {
    const state = emptyQueueState();
    expect(nextFogTeam(state)).toBe(100);
    state.lastFogTeam = 100;
    expect(nextFogTeam(state)).toBe(200);
    state.lastFogTeam = 200;
    expect(nextFogTeam(state)).toBe(100);
  });

  it("rotates the selected role, so ten games cover each role of each team", () => {
    const state = emptyQueueState();
    const seen = new Set<string>();
    for (let game = 0; game < 10; game++) {
      const team = nextFogTeam(state);
      const role = nextSelectedRole(state);
      if (game === 0) expect(role).toBe("TOP");
      seen.add(`${team} ${role}`);
      state.lastFogTeam = team;
      state.lastSelectedRole = role;
    }
    expect(seen.size).toBe(10);
  });

  it("names a second pass after the team whose fog it shows", () => {
    expect(secondPassId("EUW1_8003011603", 200)).toBe("EUW1_8003011603-200");
    expect(isRecordingId("EUW1_8003011603")).toBe(true);
    expect(isRecordingId("EUW1_8003011603-200")).toBe(true);
    expect(isRecordingId("EUW1_8003011603-300")).toBe(false);
    expect(isRecordingId("notes")).toBe(false);
    expect(isSecondPass("EUW1_8003011603-100")).toBe(true);
    expect(isSecondPass("EUW1_8003011603")).toBe(false);
  });

  it("records the other team's fog of the oldest game first", () => {
    const firsts = [
      { ...game("EUW1_1", "GOLD", 30), fogTeam: 100 as const },
      { ...game("EUW1_2", "GOLD", 10), fogTeam: 200 as const },
      { ...game("EUW1_3", "GOLD", 20), fogTeam: 100 as const },
    ];
    const next = pickSecondPass(firsts, emptyQueueState());
    expect(next).toMatchObject({ matchId: "EUW1_2", team: 100, recordingId: "EUW1_2-100" });
  });

  it("skips second passes recorded, failed, shared or already here", () => {
    const firsts = [
      { ...game("EUW1_1", "GOLD", 1), fogTeam: 100 as const },
      { ...game("EUW1_2", "GOLD", 2), fogTeam: 100 as const },
      { ...game("EUW1_3", "GOLD", 3), fogTeam: 200 as const },
    ];
    const state = emptyQueueState();
    state.recorded["EUW1_1-200"] = { tier: "GOLD", fogTeam: 200, at: "" };
    state.failed["EUW1_2-200"] = { reason: "not downloadable", at: "" };
    // The first pass of EUW1_3 being recorded does not count: only its second pass does.
    state.recorded.EUW1_3 = { tier: "GOLD", fogTeam: 200, at: "" };
    expect(pickSecondPass(firsts, state)?.recordingId).toBe("EUW1_3-100");
    expect(pickSecondPass(firsts, state, new Set(["EUW1_3-100"]))).toBe(null);
  });

  it("balances tiers by games: second passes do not count", () => {
    const state = emptyQueueState();
    state.recorded.A = { tier: "GOLD", fogTeam: 100, at: "" };
    state.recorded.B = { tier: "MASTER", fogTeam: 100, at: "" };
    state.recorded["B-200"] = { tier: "MASTER", fogTeam: 200, at: "" };
    const next = pickNext([game("C", "GOLD", 30), game("D", "MASTER", 10)], state);
    expect(next?.matchId).toBe("C");
  });

  it("reads a state file saved before players were selected", () => {
    const old = { recorded: {}, failed: {}, attempts: {}, lastFogTeam: 200 };
    const state: QueueState = Object.assign(emptyQueueState(), old);
    expect(nextSelectedRole(state)).toBe("TOP");
  });

  it("selects the fog team's player in the role, or the next role the team has", () => {
    const players = ROLES.flatMap((role, i) => [
      { participantId: i + 1, teamId: 100, championName: `Blue${role}`, teamPosition: role },
      { participantId: i + 6, teamId: 200, championName: `Red${role}`, teamPosition: role },
    ]);
    expect(playerToSelect(players, 200, "MIDDLE")?.championName).toBe("RedMIDDLE");
    expect(playerToSelect(players, 100, "UTILITY")?.participantId).toBe(5);
    const noJungle = players.filter((p) => p.championName !== "BlueJUNGLE");
    expect(playerToSelect(noJungle, 100, "JUNGLE")?.championName).toBe("BlueMIDDLE");
    const noRoles = players.map((p) => ({ ...p, teamPosition: "" }));
    expect(playerToSelect(noRoles, 200, "TOP")?.teamId).toBe(200);
    expect(playerToSelect([], 100, "TOP")).toBe(null);
  });

  it("keeps the selected champion's panel only when a player is selected", () => {
    const render = { interfaceAll: true, interfaceTarget: true, interfaceMinimap: true };
    expect(minimalInterface(render).interfaceTarget).toBe(false);
    expect(minimalInterface(render, true).interfaceTarget).toBe(true);
  });

  it("keeps only the minimap, the frames, the top bar, the scoreboard and the timers", () => {
    expect(
      minimalInterface({
        interfaceAll: true,
        interfaceChat: true,
        interfaceMinimap: false,
        interfaceFrames: true,
        interfaceScore: true,
        interfaceReplay: true,
        interfaceScoreboard: false,
        interfaceNeutralTimers: false,
        fogOfWar: true,
      }),
    ).toEqual({
      interfaceAll: true,
      interfaceChat: false,
      interfaceMinimap: true,
      interfaceFrames: true,
      interfaceScore: true,
      interfaceReplay: false,
      interfaceScoreboard: true,
      interfaceNeutralTimers: true,
    });
  });

  it("labels a recording as player knowledge for its fog team only", () => {
    const labels = captureLabels(200);
    expect(labels.playerKnowledgeFor).toBe(200);
    expect(labels.evaluationOnly).toContain("enemyFramesWhileQuestionMarked");
    expect(labels.playerKnowledge).toContain("judgedPlayerOwnGold");
    expect(labels.evaluationOnly).toContain("otherPlayersGold");
    expect(labels.playerKnowledge).toContain("campTimersStartedInTeamVision");
    expect(labels.evaluationOnly).toContain("campTimersStartedInFog");
    expect(labels.playerKnowledge).not.toContain("selectedPlayerOwnPanel");
  });

  it("labels the selected player's panel as that player's knowledge only", () => {
    const labels = captureLabels(100, true);
    expect(labels.playerKnowledge).toContain("selectedPlayerOwnPanel");
    expect(labels.evaluationOnly).toContain("selectedPlayerPanelForTeammates");
  });
});

describe("games failing in a row", () => {
  it("gives a game its attempts back once, not every time", () => {
    const forgiven = new Set<string>();
    // The PC was at fault: all three get another try.
    expect(gamesGivenBack(["EUW1_1-200", "EUW1_2-100", "EUW1_3"], forgiven)).toEqual([
      "EUW1_1-200",
      "EUW1_2-100",
      "EUW1_3",
    ]);
    // The same second passes fail again: they keep their failure, and the
    // queue goes on to other games. A game new to the row is given back.
    expect(gamesGivenBack(["EUW1_1-200", "EUW1_2-100", "EUW1_4"], forgiven)).toEqual(["EUW1_4"]);
    expect(gamesGivenBack(["EUW1_1-200", "EUW1_2-100", "EUW1_4"], forgiven)).toEqual([]);
  });
});

describe("closing the replay", () => {
  it("own import never selects an unrelated answering replay for termination",()=>{
    expect(replayProcesses(9876,null,[9876],true)).toEqual([]);
    expect(replayProcesses(9876,4321,[4321,9876],true)).toEqual([]);
    expect(replayProcesses(4321,4321,[4321],true)).toEqual([4321]);
    expect(replayProcesses(NaN,4321,[4321],true)).toEqual([4321]);
  });
  it("ends the process that answers on the Replay API", () => {
    expect(replayProcesses(4321, null, [])).toEqual([4321]);
    expect(replayProcesses(4321, 4321, [4321])).toEqual([4321]);
  });
  it("ends the replay the queue opened when it is frozen and does not answer", () => {
    expect(replayProcesses(NaN, 4321, [4321])).toEqual([4321]);
  });
  it("leaves alone an ID that no game client has any more", () => {
    // The replay closed by itself; Windows may have given its ID to another program.
    expect(replayProcesses(NaN, 4321, [])).toEqual([]);
    expect(replayProcesses(NaN, 4321, [9876])).toEqual([]);
    expect(replayProcesses(NaN, null, [9876])).toEqual([]);
  });
});

describe("team frame names", () => {
  it("blacks out one band per row above everything the readers use", () => {
    const filter = frameNameMask();
    expect(filter.split(",")).toHaveLength(5);
    expect(filter).toContain("drawbox=x=0:y=412:w=iw:h=17:color=black:t=fill");
    // Readers start at +18 px (ultimate disc), so the band stays above them.
    expect(FRAME_NAME_BAND.height).toBeLessThanOrEqual(18);
    expect(FRAME_NAME_BAND.rowPitch * (FRAME_NAME_BAND.rows - 1) + FRAME_NAME_BAND.height).toBeLessThanOrEqual(SPECTATOR_LAYOUT_1080.framesBlue.height);
  });
});
