import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordedQueuesOnly } from "../companion/recorded-queues";
import {
  LiveClient,
  parseLiveUrl,
  readSamples,
  recordLiveSession,
  Stopper,
} from "./session";

// Fictional players only.
function payload(gameTime: number, events: { name: string; time: number }[]) {
  return {
    activePlayer: {
      riotId: "Fictional#MOCK",
      level: 3,
      currentGold: 500,
      championStats: {
        currentHealth: 500,
        maxHealth: 600,
        resourceValue: 200,
        resourceMax: 300,
        resourceType: "MANA",
      },
      abilities: { Q: { rawDescription: "x".repeat(400) } },
    },
    allPlayers: [
      {
        championName: "Annie",
        riotId: "Fictional#MOCK",
        team: "ORDER",
        position: "MIDDLE",
        level: 3,
        scores: { kills: 0, deaths: 0, assists: 0, creepScore: 10 },
        items: [],
      },
    ],
    events: {
      Events: events.map((e, i) => ({
        EventID: i,
        EventName: e.name,
        EventTime: e.time,
      })),
    },
    gameData: { gameMode: "CLASSIC", gameTime },
  };
}

/** Answers polls from a script; `null` entries simulate a failed request. */
function scriptedClient(script: unknown[]): LiveClient & { polls: number } {
  const client = {
    url: new URL("http://127.0.0.1:2998/liveclientdata/allgamedata"),
    polls: 0,
    getJson: async () => {
      const answer = script[Math.min(client.polls++, script.length - 1)];
      if (answer === null) throw new Error("HTTP 404");
      return answer;
    },
    close: () => {},
  };
  return client;
}

describe("live session loop", () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "rekap-live-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(out, { recursive: true, force: true });
  });

  const options = (client: LiveClient, stopper = new Stopper()) => ({
    client,
    interval: 1,
    endAfter: 3,
    outDir: out,
    label: "test",
    stopper,
    log: () => {},
  });

  it.each([null, 2400])(
    "never starts a recording for unknown/Chaos queue %s",
    async (queue) => {
      const stopper = new Stopper();
      let polls = 0;
      const live: LiveClient = {
        url: new URL("http://127.0.0.1:2998/liveclientdata/allgamedata"),
        getJson: async () => {
          if (++polls === 3) stopper.stop();
          return {
            ...payload(polls, []),
            gameData: { gameMode: "CLASSIC", mapNumber: 11, gameTime: polls },
          };
        },
        close: () => {},
      };
      const onStart = vi.fn();
      const onSample = vi.fn();
      const result = await recordLiveSession(
        options(
          recordedQueuesOnly(live, async () => queue),
          stopper,
        ),
        { onStart, onSample },
      );
      expect(result).toBeNull();
      expect(onStart).not.toHaveBeenCalled();
      expect(onSample).not.toHaveBeenCalled();
      expect(readdirSync(out)).toEqual([]);
    },
  );

  it.each([420, 440, 400])(
    "records queue %i normally after the League client recovers",
    async (queue) => {
      const live = scriptedClient([
        payload(1, []),
        payload(2, []),
        payload(3, []),
        payload(4, [{ name: "GameEnd", time: 4 }]),
      ]);
      const getQueue = vi
        .fn<() => Promise<number | null>>()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("League client unavailable"))
        .mockResolvedValue(queue);
      const onStart = vi.fn();
      const session = await recordLiveSession(
        options(recordedQueuesOnly(live, getQueue)),
        { onStart },
      );
      expect(session?.reason).toBe("GAME_END");
      expect(session?.samples.map((sample) => sample.gameTime)).toEqual([3, 4]);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(getQueue).toHaveBeenCalledTimes(3);
      expect(readSamples(session!.dir).samples).toHaveLength(2);
    },
  );

  it("waits through loading, records until GameEnd and calls the hooks", async () => {
    const start = { name: "GameStart", time: 0.1 };
    const client = scriptedClient([
      null, // loading screen
      { errorCode: "RESOURCE_NOT_FOUND" },
      payload(1, [start]),
      payload(2, [start]),
      payload(3, [start, { name: "GameEnd", time: 3 }]),
    ]);
    const started: string[] = [];
    const seen: number[] = [];
    const session = await recordLiveSession(options(client), {
      onStart: (info, first) =>
        started.push(`${info.champion}@${first.gameTime}`),
      onSample: (sample) => seen.push(sample.gameTime),
    });
    expect(session).not.toBeNull();
    expect(session!.reason).toBe("GAME_END");
    expect(session!.champion).toBe("Annie");
    expect(session!.name).toMatch(/-Annie-test$/);
    expect(started).toEqual(["Annie@1"]);
    expect(seen).toEqual([1, 2, 3]);
    // Events are only listed once, in the sample where they appeared.
    expect(session!.samples.map((s) => s.events.map((e) => e.name))).toEqual([
      ["GameStart"],
      [],
      ["GameEnd"],
    ]);
    const meta = JSON.parse(
      readFileSync(join(session!.dir, "meta.json"), "utf8"),
    );
    expect(meta.source).toBe("http://127.0.0.1:2998");
    expect(JSON.stringify(meta)).not.toContain("x".repeat(300)); // tooltips dropped
    const { samples, skipped } = readSamples(session!.dir);
    expect(skipped).toBe(0);
    expect(samples).toEqual(session!.samples);
  });

  it("automatic recording waits for the complete signed-in Riot ID before creating a session", async () => {
    const client = scriptedClient([
      {
        ...payload(1, []),
        activePlayer: { ...payload(1, []).activePlayer, riotId: "Other#MOCK" },
      },
      payload(2, []),
      payload(3, [{ name: "GameEnd", time: 3 }]),
    ]);
    const session = await recordLiveSession({
      ...options(client),
      expectedRiotId: "fictional#mock",
    });
    expect(session?.samples.map((s) => s.gameTime)).toEqual([2, 3]);
  });

  it("ends after endAfter consecutive failures once recording", async () => {
    const client = scriptedClient([payload(60, []), payload(61, []), null]);
    const session = await recordLiveSession(options(client));
    expect(session!.reason).toBe("CONNECTION_LOST");
    expect(session!.samples).toHaveLength(2);
    expect(client.polls).toBe(5); // 2 samples + 3 failures
  });

  it("keeps one session across an API outage longer than the failure count", async () => {
    const client = scriptedClient([
      payload(60, []),
      ...Array(15).fill(null),
      payload(80, []),
      payload(81, [{ name: "GameEnd", time: 81 }]),
    ]);
    let starts = 0;
    const session = await recordLiveSession(
      { ...options(client), disconnectGraceMs: 1000 },
      { onStart: () => starts++ },
    );
    expect(starts).toBe(1);
    expect(session?.reason).toBe("GAME_END");
    expect(session?.samples.map((s) => s.gameTime)).toEqual([60, 80, 81]);
  });

  it("ends an unanswered session after both the grace and failure count", async () => {
    vi.useFakeTimers();
    const client = scriptedClient([payload(60, []), null]);
    const pending = recordLiveSession({
      ...options(client),
      interval: 1000,
      disconnectGraceMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.polls).toBe(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending)?.reason).toBe("CONNECTION_LOST");
    expect(client.polls).toBe(6);
  });

  it("does not append a new game's samples after reconnecting", async () => {
    const client = scriptedClient([payload(600, []), null, payload(1, [])]);
    const session = await recordLiveSession({
      ...options(client),
      disconnectGraceMs: 1000,
    });
    expect(session?.reason).toBe("CONNECTION_LOST");
    expect(session?.samples.map((s) => s.gameTime)).toEqual([600]);
  });

  it("does not start on a game that already ended", async () => {
    const stopper = new Stopper();
    const ended = payload(900, [{ name: "GameEnd", time: 900 }]);
    const client = scriptedClient([ended, ended, ended]);
    const pending = recordLiveSession(options(client, stopper));
    await new Promise((done) => setTimeout(done, 30));
    stopper.stop();
    expect(await pending).toBeNull();
    expect(existsSync(join(out, "meta.json"))).toBe(false);
  });

  it("returns what was recorded when stopped mid-game", async () => {
    const stopper = new Stopper();
    let polls = 0;
    const client: LiveClient = {
      url: new URL("http://127.0.0.1:2998/liveclientdata/allgamedata"),
      getJson: async () => {
        if (++polls === 4) stopper.stop(); // Ctrl+C during the 4th request
        return payload(polls, []);
      },
      close: () => {},
    };
    const session = await recordLiveSession(options(client, stopper));
    expect(session!.reason).toBe("INTERRUPTED");
    expect(session!.samples.map((s) => s.gameTime)).toEqual([1, 2, 3]);
  });
});

describe("live client URL", () => {
  it("allows plain http only on loopback", () => {
    expect(parseLiveUrl("http://127.0.0.1:2998/x").port).toBe("2998");
    expect(parseLiveUrl("https://127.0.0.1:2999/x").protocol).toBe("https:");
    expect(() => parseLiveUrl("http://example.com/x")).toThrow(/loopback|127/);
    expect(() => parseLiveUrl("ftp://127.0.0.1/x")).toThrow(/http/);
  });

  it("wakes a sleeping poller on stop", async () => {
    const stopper = new Stopper();
    const started = Date.now();
    const sleeping = stopper.sleep(10_000);
    stopper.stop();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
    await stopper.sleep(10_000); // already stopped: returns at once
  });
});
