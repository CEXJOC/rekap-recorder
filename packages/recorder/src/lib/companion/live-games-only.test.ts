import { expect, it, vi } from "vitest";
import { liveGamesOnly } from "./live-games-only";
it("excludes a replay on the shared API port and preserves genuine live payloads", async () => {
  const payload = { gameData: { gameTime: 30 } };
  const live = {
    url: new URL("https://127.0.0.1:2999/liveclientdata/allgamedata"),
    getJson: vi.fn().mockResolvedValue(payload),
    close: vi.fn(),
  };
  const replay = {
    url: new URL("https://127.0.0.1:2999/replay/game"),
    getJson: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
  };
  const client = liveGamesOnly(live, replay);
  expect(await client.getJson(1000)).toBeNull();
  replay.getJson.mockRejectedValueOnce(new Error("HTTP 404"));
  expect(await client.getJson(1000)).toBe(payload);
  client.close();
  expect(live.close).toHaveBeenCalledOnce();
  expect(replay.close).toHaveBeenCalledOnce();
});
it("does not probe Riot APIs for a fixture or a custom live endpoint", async () => {
  const live = {
    url: new URL("http://127.0.0.1:3333/fixture"),
    getJson: vi.fn().mockResolvedValue({ fixture: true }),
    close: vi.fn(),
  };
  const replay = { ...live, getJson: vi.fn() };
  expect(await liveGamesOnly(live, replay).getJson(1000)).toEqual({
    fixture: true,
  });
  expect(replay.getJson).not.toHaveBeenCalled();
});
