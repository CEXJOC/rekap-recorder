import { expect, it } from "vitest";
import { replayAnalysisMessage, replayQueueMessage, isDownloadedReplay, assertLocalReplayAccount, assertReplayAccount, ownReplayMatches, ownReplayPlayer } from "./own-game";
it("reports analysis progress without estimating a false completion", () => {
  expect(replayAnalysisMessage("[map-analyze 14:19:06] analysed 338/3134 frames (11%), 1.9 frames/s")).toContain("11 % (338 / 3134 images)");
  expect(replayAnalysisMessage("analysing finished")).toBeNull();
});
it("reports actual queue stages including pause, capture progress and video finalization", () => {
  expect(replayQueueMessage("waiting until the PC is idle for 120 s")).toContain("pause");
  expect(replayQueueMessage("EUW1_1: 23:46 of 26:06, 2.3x real time")).toContain("23:46 / 26:06");
  expect(replayQueueMessage("recording stopped at 2:53 (someone used the PC)")).toContain("pause");
  expect(replayQueueMessage("desktop: encoding video")).toContain("sauvegarde");
  expect(replayQueueMessage("desktop: finalizing capture")).toContain("finalisation");
  expect(replayQueueMessage("keys could not reach the replay (window not focused, try 1 of 3); waiting for idle to press again")).toContain("focus");
  expect(replayQueueMessage("unrelated log")).toBeNull();
});
it("accepts the client's downloaded watch state and rejects unfinished or expired replays", () => {
  expect(isDownloadedReplay({state: "watch"})).toBe(true);
  expect(isDownloadedReplay({state: "watchable"})).toBe(true);
  for (const state of ["checking", "downloading", "missingorexpired", "", undefined])
    expect(isDownloadedReplay({state})).toBe(false);
  expect(isDownloadedReplay(null)).toBe(false);
});
it("checks the League client's account locally, by PUUID or Riot ID, without the Riot API", () => {
  const s = {puuid: "internal", gameName: "玩家", tagLine: "CHILL"};
  expect(() => assertLocalReplayAccount(s, "own", "玩家#chill")).not.toThrow();
  expect(() => assertLocalReplayAccount({puuid: "own"}, "own", "Other#EUW")).not.toThrow();
  expect(() => assertLocalReplayAccount(s, "own", "Other#EUW")).toThrow("même compte");
  expect(() => assertLocalReplayAccount({puuid: "internal"}, "own", "玩家#CHILL")).toThrow("Riot ID");
});
it("distinguishes an unavailable client identity from a different account", () => {
  expect(() => assertReplayAccount(undefined, "own")).toThrow("pas encore communiqué");
  expect(() => assertReplayAccount("", "own")).toThrow("pas encore communiqué");
  expect(() => assertReplayAccount("foreign", "own")).toThrow("même compte");
  expect(() => assertReplayAccount("own", "own")).not.toThrow();
});
const id = "EUW1_123456";
const player = {
  puuid: "own",
  participantId: 3,
  teamId: 100,
  championName: "Ahri",
};
const match = {
  metadata: { matchId: id },
  info: {
    gameVersion: "16.19.1",
    queueId: 400,
    gameDuration: 1200,
    participants: [player],
  },
};
const source = {
  provenance: "TEAM_FOG_REPLAY",
  matchId: id,
  puuid: "own",
  participantId: 3,
  teamId: 100,
};
const capture = {
  version: "replay-capture-0.1",
  provenance: "TEAM_FOG_REPLAY",
  matchId: id,
  fogTeam: 100,
  selectedPlayer: { participantId: 3, teamId: 100 },
};
it.each([420, 440, 400])(
  "selects the connected player in queue %i on the installed patch",
  (queueId) => {
    expect(
      ownReplayPlayer(
        { ...match, info: { ...match.info, queueId } },
        id,
        "own",
        "26.19",
      ),
    ).toEqual(player);
  },
);
it("refuses foreign games, expired patches, wrong matches and unsupported queues", () => {
  expect(() => ownReplayPlayer(match, id, "foreign", "16.19")).toThrow(
    "compte",
  );
  expect(() => ownReplayPlayer(match, "EUW1_654321", "own", "16.19")).toThrow(
    "demande",
  );
  expect(() => ownReplayPlayer(match, id, "own", "16.20")).toThrow("expiré");
  expect(() =>
    ownReplayPlayer(
      { ...match, info: { ...match.info, queueId: 450 } },
      id,
      "own",
      "16.19",
    ),
  ).toThrow("Solo/Duo");
  expect(() =>
    ownReplayPlayer(
      { ...match, info: { ...match.info, gameDuration: 899 } },
      id,
      "own",
      "16.19",
    ),
  ).toThrow("15 minutes");
});
it("links a replay only to its account, match, selected player and team fog", () => {
  expect(ownReplayMatches(match, source, capture, id, "own")).toBe(true);
  expect(ownReplayMatches(match, source, capture, id, "foreign")).toBe(false);
  expect(
    ownReplayMatches(
      match,
      { ...source, puuid: "foreign" },
      capture,
      id,
      "own",
    ),
  ).toBe(false);
  expect(
    ownReplayMatches(match, source, { ...capture, fogTeam: 200 }, id, "own"),
  ).toBe(false);
  expect(
    ownReplayMatches(
      match,
      source,
      { ...capture, selectedPlayer: { participantId: 4, teamId: 100 } },
      id,
      "own",
    ),
  ).toBe(false);
  expect(
    ownReplayMatches(
      match,
      source,
      { ...capture, matchId: "EUW1_654321" },
      id,
      "own",
    ),
  ).toBe(false);
  expect(
    ownReplayMatches(
      match,
      { ...source, provenance: "LIVE" },
      capture,
      id,
      "own",
    ),
  ).toBe(false);
  expect(ownReplayMatches(match, source, null, id, "own")).toBe(false);
});
