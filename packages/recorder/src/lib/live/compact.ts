import {
  LiveEvent,
  LivePayload,
  LivePlayerPayload,
  LiveSample,
  livePayloadSchema,
} from "./types";

export function parsePayload(raw: unknown): LivePayload | null {
  const parsed = livePayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Event fields carry riotIdGameName, summonerName or the full riotId depending
// on the patch, so names are compared case-insensitively with and without tag.
const bare = (name: string) => name.split("#")[0].trim().toLowerCase();
export function sameName(a: string, b: string) {
  const x = a.trim().toLowerCase(),
    y = b.trim().toLowerCase();
  return x === y || (x.length > 0 && bare(x) === bare(y));
}
function identifiers(p: {
  riotId?: string;
  riotIdGameName?: string;
  summonerName?: string;
}) {
  return [p.riotId, p.summonerName, p.riotIdGameName].filter((n): n is string =>
    Boolean(n && n.trim()),
  );
}
const playerId = (p: LivePlayerPayload) =>
  identifiers(p)[0] ?? p.championName ?? "unknown";

const round = (value: number | undefined, digits = 1) =>
  Math.round((value ?? 0) * 10 ** digits) / 10 ** digits;

export function compactSample(
  payload: LivePayload,
  wallClockMs: number,
  lastEventId: number,
): { sample: LiveSample; lastEventId: number } {
  const roster = payload.allPlayers.map((p) => ({
    id: playerId(p),
    names: identifiers(p),
  }));
  // Exact identifiers win over a tag-less match (two players can share a name).
  const exact = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();
  const lookup = (names: string[]) => {
    const by = (eq: (a: string, b: string) => boolean) =>
      roster.find((p) => p.names.some((n) => names.some((m) => eq(n, m))));
    return (by(exact) ?? by(sameName))?.id;
  };
  const resolve = (name?: string) =>
    name ? (lookup([name]) ?? name) : undefined;
  const me = payload.activePlayer;
  const myNames = identifiers(me);
  const myId = lookup(myNames) ?? myNames[0];
  const stats = me.championStats ?? {};
  let nextEventId = lastEventId;
  const events: LiveEvent[] = [];
  (payload.events?.Events ?? []).forEach((e, index) => {
    if (!e) return;
    const id = e.EventID ?? index;
    if (id <= lastEventId) return;
    nextEventId = Math.max(nextEventId, id);
    const stolen =
      typeof e.Stolen === "string"
        ? e.Stolen.toLowerCase() === "true"
        : e.Stolen;
    events.push(
      Object.fromEntries(
        Object.entries({
          id,
          name: e.EventName,
          time: round(e.EventTime, 2),
          killer: resolve(e.KillerName),
          victim: resolve(e.VictimName),
          assisters: e.Assisters?.map((a) => resolve(a) ?? a),
          recipient: resolve(e.Recipient),
          dragonType: e.DragonType,
          stolen,
          turret: e.TurretKilled,
          inhib: e.InhibKilled,
          result: e.Result,
          acer: resolve(e.Acer),
          acingTeam: e.AcingTeam,
          killStreak: e.KillStreak,
        }).filter(([, value]) => value !== undefined),
      ) as LiveEvent,
    );
  });
  return {
    lastEventId: nextEventId,
    sample: {
      t: wallClockMs,
      gameTime: round(payload.gameData.gameTime, 2),
      active: {
        id: myId,
        gold: round(me.currentGold),
        level: me.level ?? 0,
        hp: round(stats.currentHealth),
        maxHp: round(stats.maxHealth),
        resource: round(stats.resourceValue),
        maxResource: round(stats.resourceMax),
        resourceType: stats.resourceType ?? "NONE",
      },
      players: payload.allPlayers.map((p, i) => {
        const items = (p.items ?? []).filter((item) => item !== null);
        return {
          id: roster[i].id,
          champion: p.championName ?? "Unknown",
          team: p.team ?? "",
          role: p.position ?? "",
          level: p.level ?? 0,
          dead: p.isDead ?? false,
          respawn: round(p.respawnTimer),
          kills: p.scores?.kills ?? 0,
          deaths: p.scores?.deaths ?? 0,
          assists: p.scores?.assists ?? 0,
          cs: p.scores?.creepScore ?? 0,
          wardScore: round(p.scores?.wardScore),
          itemValue: items.reduce(
            (sum, item) => sum + (item.price ?? 0) * (item.count ?? 1),
            0,
          ),
          items: [...items]
            .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
            .flatMap((item) =>
              item.itemID === undefined ? [] : [item.itemID],
            ),
        };
      }),
      events,
    },
  };
}

// meta.json keeps the first payload for context, minus tooltip text: ability,
// rune and item descriptions are large and irrelevant to review.
const LONG_TEXT = 200;
export function stripLongText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLongText);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, v]) =>
            !/^raw/i.test(key) &&
            !(typeof v === "string" && v.length > LONG_TEXT),
        )
        .map(([key, v]) => [key, stripLongText(v)]),
    );
  return value;
}

export function sessionDirName(startMs: number, champion: string, label = "") {
  const iso = new Date(startMs).toISOString().replace(/\.\d+Z$/, "Z");
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "");
  return [iso.replace(/:/g, "-"), clean(champion) || "Unknown", clean(label)]
    .filter(Boolean)
    .join("-");
}

// Recorder end detection. A finished game (GameEnd already present on the
// first poll) is not started; once recording, GameEnd or `endAfter`
// consecutive failed polls end the session.
export type RecorderState =
  | { phase: "WAITING" }
  | { phase: "RECORDING"; failures: number }
  | { phase: "ENDED"; reason: "GAME_END" | "CONNECTION_LOST" | "INTERRUPTED" };
export type PollOutcome =
  | { kind: "SAMPLE"; gameEnded: boolean }
  | { kind: "FAILURE" }
  | { kind: "INTERRUPT" };
export function stepRecorder(
  state: RecorderState,
  poll: PollOutcome,
  endAfter: number,
): RecorderState {
  if (state.phase === "ENDED") return state;
  if (poll.kind === "INTERRUPT")
    return { phase: "ENDED", reason: "INTERRUPTED" };
  if (state.phase === "WAITING")
    return poll.kind === "SAMPLE" && !poll.gameEnded
      ? { phase: "RECORDING", failures: 0 }
      : state;
  if (poll.kind === "SAMPLE")
    return poll.gameEnded
      ? { phase: "ENDED", reason: "GAME_END" }
      : { phase: "RECORDING", failures: 0 };
  const failures = state.failures + 1;
  return failures >= endAfter
    ? { phase: "ENDED", reason: "CONNECTION_LOST" }
    : { phase: "RECORDING", failures };
}
