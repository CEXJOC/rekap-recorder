import { z } from "zod";

// Live Client Data API (https://127.0.0.1:2999/liveclientdata/allgamedata).
// Parsed leniently: the game client adds and renames fields between patches,
// so a wrong-typed optional field is dropped instead of rejecting the sample.
const num = z.number().optional().catch(undefined);
const str = z.string().optional().catch(undefined);
const bool = z.boolean().optional().catch(undefined);
const lenient = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

export const liveItemSchema = z.object({
  itemID: num,
  price: num,
  count: num,
  slot: num,
});
export const livePlayerSchema = z.object({
  championName: str,
  riotId: str,
  riotIdGameName: str,
  riotIdTagLine: str,
  summonerName: str,
  team: str,
  position: str,
  level: num,
  isDead: bool,
  respawnTimer: num,
  scores: lenient(
    z.object({
      kills: num,
      deaths: num,
      assists: num,
      creepScore: num,
      wardScore: num,
    }),
  ),
  items: lenient(z.array(liveItemSchema.nullable().catch(null))),
});
export const liveEventSchema = z.object({
  EventID: num,
  EventName: z.string(),
  EventTime: num,
  KillerName: str,
  VictimName: str,
  Assisters: lenient(z.array(z.string())),
  Recipient: str,
  DragonType: str,
  Stolen: lenient(z.union([z.string(), z.boolean()])),
  TurretKilled: str,
  InhibKilled: str,
  Result: str,
  Acer: str,
  AcingTeam: str,
  KillStreak: num,
});
export const livePayloadSchema = z.object({
  activePlayer: z
    .object({
      riotId: str,
      riotIdGameName: str,
      summonerName: str,
      level: num,
      currentGold: num,
      championStats: lenient(
        z.object({
          currentHealth: num,
          maxHealth: num,
          resourceValue: num,
          resourceMax: num,
          resourceType: str,
        }),
      ),
    })
    // Spectator mode and the loading screen return an activePlayer without
    // identity (or an error object); those are not recordable samples.
    .refine((p) => Boolean(p.riotId || p.summonerName || p.riotIdGameName)),
  allPlayers: z.array(livePlayerSchema).min(1),
  events: lenient(
    z.object({
      Events: lenient(z.array(liveEventSchema.nullable().catch(null))),
    }),
  ),
  gameData: z.object({ gameTime: z.number(), gameMode: str, mapNumber: num }),
});
export type LivePayload = z.infer<typeof livePayloadSchema>;
export type LivePlayerPayload = z.infer<typeof livePlayerSchema>;

// Compact per-poll sample written to samples.ndjson (one line per poll).
// Player names inside events are resolved to the matching player `id`.
export const liveEventCompactSchema = z.object({
  id: z.number(),
  name: z.string(),
  time: z.number(),
  killer: z.string().optional(),
  victim: z.string().optional(),
  assisters: z.array(z.string()).optional(),
  recipient: z.string().optional(),
  dragonType: z.string().optional(),
  stolen: z.boolean().optional(),
  turret: z.string().optional(),
  inhib: z.string().optional(),
  result: z.string().optional(),
  acer: z.string().optional(),
  acingTeam: z.string().optional(),
  killStreak: z.number().optional(),
});
export const liveSampleSchema = z.object({
  t: z.number(), // wall-clock ms
  gameTime: z.number(), // s
  active: z.object({
    id: z.string(),
    gold: z.number(),
    level: z.number(),
    hp: z.number(),
    maxHp: z.number(),
    resource: z.number(),
    maxResource: z.number(),
    resourceType: z.string(),
  }),
  players: z.array(
    z.object({
      id: z.string(),
      champion: z.string(),
      team: z.string(),
      role: z.string(),
      level: z.number(),
      dead: z.boolean(),
      respawn: z.number(),
      kills: z.number(),
      deaths: z.number(),
      assists: z.number(),
      cs: z.number(),
      wardScore: z.number(),
      itemValue: z.number(), // Σ price × count of current items
      items: z.array(z.number()),
    }),
  ),
  events: z.array(liveEventCompactSchema), // only events new since the previous sample
});
export type LiveEvent = z.infer<typeof liveEventCompactSchema>;
export type LiveSample = z.infer<typeof liveSampleSchema>;
export type LivePlayer = LiveSample["players"][number];
