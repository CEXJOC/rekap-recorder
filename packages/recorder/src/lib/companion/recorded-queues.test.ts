import { expect, it, vi } from "vitest";
import type { LiveClient } from "../live/session";
import { recordedGame, recordedQueuesOnly } from "./recorded-queues";

const sr = { gameMode: "CLASSIC", mapNumber: 11 };
const aram = { gameMode: "ARAM", mapNumber: 12 };

it("records Solo/Duo, Flex and Draft only, by the League client's queue", () => {
  expect([420, 440, 400].map((q) => recordedGame(q))).toEqual([
    true,
    true,
    true,
  ]);
  // ARAM, quickplay, Arena, custom and practice tool.
  expect([450, 2400, 490, 1700, 0, -1].map((q) => recordedGame(q))).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
});

it("does not record when the queue ID is missing", () => {
  expect(recordedGame(null)).toBe(false);
});

it.each([420, 440, 400, 2400])(
  "retries an unavailable queue before deciding queue %i",
  async (queue) => {
    // Even CLASSIC/map 11 must not bypass a missing queue ID.
    const payload = { gameData: sr };
    const getQueue = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("League client unavailable"))
      .mockResolvedValue(queue);
    const log = vi.fn();
    const client = recordedQueuesOnly(
      {
        url: new URL("https://127.0.0.1:2999/liveclientdata/allgamedata"),
        getJson: async () => payload,
        close: () => {},
      },
      getQueue,
      log,
    );
    expect(await client.getJson(1000)).toBeNull();
    expect(await client.getJson(1000)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const expected = queue === 2400 ? null : payload;
    expect(await client.getJson(1000)).toBe(expected);
    expect(await client.getJson(1000)).toBe(expected);
    expect(getQueue).toHaveBeenCalledTimes(3);
  },
);

it.each([null, new Error("Live Client unavailable")])(
  "forgets the queue decision after a live interruption (%s)",
  async (interruption) => {
    const payload = { gameData: sr };
    const getQueue = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(420)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(2400);
    const getJson = vi.fn().mockResolvedValueOnce(payload);
    if (interruption === null) getJson.mockResolvedValueOnce(null);
    else getJson.mockRejectedValueOnce(interruption);
    getJson.mockResolvedValue(payload);
    const client = recordedQueuesOnly(
      {
        url: new URL("https://127.0.0.1:2999/liveclientdata/allgamedata"),
        getJson,
        close: () => {},
      },
      getQueue,
    );
    expect(await client.getJson(1000)).toBe(payload);
    if (interruption === null) expect(await client.getJson(1000)).toBeNull();
    else await expect(client.getJson(1000)).rejects.toThrow(interruption);
    expect(await client.getJson(1000)).toBeNull();
    expect(await client.getJson(1000)).toBeNull();
    expect(await client.getJson(1000)).toBeNull();
    expect(getQueue).toHaveBeenCalledTimes(3);
  },
);

it("hides other queues from the recorder and asks the queue once per game", async () => {
  const payloads: (object | null)[] = [
    { gameData: aram },
    { gameData: aram },
    null,
    { gameData: sr },
    { gameData: sr },
  ];
  const queues = [450, 420];
  let asked = 0;
  const live = {
    url: new URL("https://127.0.0.1:2999/liveclientdata/allgamedata"),
    getJson: async () => payloads.shift() ?? null,
    close: () => {},
  } as unknown as LiveClient;
  const lines: string[] = [];
  const client = recordedQueuesOnly(
    live,
    async () => {
      asked++;
      return queues.shift() ?? null;
    },
    (l) => lines.push(l),
  );
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(await client.getJson(1000));
  expect(seen.map((r) => r !== null)).toEqual([
    false,
    false,
    false,
    true,
    true,
  ]);
  expect(asked).toBe(2);
  expect(lines).toEqual([
    "Not recording this game: queue 450 is not Solo/Duo, Flex or Draft.",
  ]);
});
