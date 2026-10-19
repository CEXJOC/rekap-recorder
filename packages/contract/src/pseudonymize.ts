/**
 * Replaces player names with slots (P1-P10) before anything leaves the PC.
 * The Live Client API names players by Riot ID, by game name without tag, or
 * by summoner name depending on the patch, so every form maps to one slot.
 * The server links the upload to the player's account through sign-in, not
 * through a name in the files.
 */

export type RosterPlayer = {
  riotId?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
};

/** Game objects that kill or get killed in events; never player names. */
const GAME_OBJECT = /^(Turret|Minion|SRU|Barracks|Obelisk|HA_|Inhibitor|Nexus)/i;
export const UNKNOWN = "unknown";

const key = (name: string) => name.trim().toLowerCase();
const bare = (name: string) => key(name.split("#")[0]);

export type Slots = { slotOf(name: string | undefined): string | undefined };

/** Slots follow the Live Client roster order: P1 is allPlayers[0]. */
export function slotsFor(roster: readonly RosterPlayer[]): Slots {
  const exact = new Map<string, string>();
  const tagless = new Map<string, string | null>();
  roster.forEach((player, index) => {
    const slot = `P${index + 1}`;
    const names = [
      player.riotId,
      player.summonerName,
      player.riotIdGameName,
      player.riotIdGameName && player.riotIdTagLine ? `${player.riotIdGameName}#${player.riotIdTagLine}` : undefined,
    ].filter((name): name is string => Boolean(name && name.trim()));
    for (const name of names) {
      exact.set(key(name), slot);
      const b = bare(name);
      // Two players sharing a game name cannot be told apart without the tag.
      tagless.set(b, tagless.has(b) && tagless.get(b) !== slot ? null : slot);
    }
  });
  return {
    slotOf(name) {
      if (name === undefined) return undefined;
      if (!name.trim()) return name;
      const found = exact.get(key(name)) ?? tagless.get(bare(name));
      if (found) return found;
      return GAME_OBJECT.test(name.trim()) ? name : UNKNOWN;
    },
  };
}

const EVENT_NAME_FIELDS = ["killer", "victim", "recipient", "acer"] as const;

type SampleLike = {
  active?: { id?: string } & Record<string, unknown>;
  players?: ({ id?: string } & Record<string, unknown>)[];
  events?: ({ assisters?: string[] } & Record<string, unknown>)[];
} & Record<string, unknown>;

/** One samples.ndjson line with every player name replaced by its slot. */
export function pseudonymizeSample<T extends SampleLike>(sample: T, slots: Slots): T {
  return {
    ...sample,
    ...(sample.active && { active: { ...sample.active, id: slots.slotOf(sample.active.id) } }),
    ...(sample.players && { players: sample.players.map((player) => ({ ...player, id: slots.slotOf(player.id) })) }),
    ...(sample.events && {
      events: sample.events.map((event) => {
        const out: Record<string, unknown> = { ...event };
        for (const field of EVENT_NAME_FIELDS)
          if (typeof out[field] === "string") out[field] = slots.slotOf(out[field] as string);
        if (event.assisters) out.assisters = event.assisters.map((name) => slots.slotOf(name));
        return out;
      }),
    }),
  };
}
