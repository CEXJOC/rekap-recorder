import { expect, it } from "vitest";
import { matchesRecordingAccount } from "./account-identity";
import { livePayloadSchema } from "./types";
const payload = (active: object, players: object[]) =>
  livePayloadSchema.parse({
    activePlayer: active,
    allPlayers: players.length ? players : [{ riotId: "Other#MOCK" }],
    gameData: { gameTime: 3 },
  });
it("requires the complete explicit Riot ID, not a name-only guess", () => {
  expect(
    matchesRecordingAccount(
      payload({ riotId: "Synthetic#ONE" }, []),
      "synthetic#one",
    ),
  ).toBe(true);
  expect(
    matchesRecordingAccount(
      payload({ riotId: "Synthetic#TWO" }, []),
      "Synthetic#ONE",
    ),
  ).toBe(false);
  expect(
    matchesRecordingAccount(
      payload({ riotIdGameName: "Synthetic" }, []),
      "Synthetic#ONE",
    ),
  ).toBe(false);
});
it("can use a uniquely identified roster name/tag but refuses duplicate names", () => {
  const own = { riotIdGameName: "Synthetic", riotIdTagLine: "ONE" };
  expect(
    matchesRecordingAccount(
      payload({ riotIdGameName: "Synthetic" }, [own]),
      "Synthetic#ONE",
    ),
  ).toBe(true);
  expect(
    matchesRecordingAccount(
      payload({ riotIdGameName: "Synthetic" }, [
        own,
        { ...own, riotIdTagLine: "TWO" },
      ]),
      "Synthetic#ONE",
    ),
  ).toBe(false);
});
