import { describe, expect, it } from "vitest";
import { UNKNOWN, pseudonymizeSample, slotsFor } from "./pseudonymize";

const roster = [
  { riotId: "Faker#KR1", riotIdGameName: "Faker", riotIdTagLine: "KR1" },
  { summonerName: "Twin", riotId: "Twin#EUW" },
  { riotId: "Twin#NA1" },
];

describe("slots", () => {
  const slots = slotsFor(roster);
  it("maps every name form of a player to the same slot", () => {
    expect(slots.slotOf("Faker#KR1")).toBe("P1");
    expect(slots.slotOf("faker")).toBe("P1");
    expect(slots.slotOf(" FAKER#kr1 ")).toBe("P1");
  });
  it("uses the tag when two players share a game name", () => {
    expect(slots.slotOf("Twin#EUW")).toBe("P2");
    expect(slots.slotOf("Twin#NA1")).toBe("P3");
  });
  it("keeps game objects and hides anything else", () => {
    expect(slots.slotOf("Turret_T2_L_03_A")).toBe("Turret_T2_L_03_A");
    expect(slots.slotOf("SRU_Baron17.1.1")).toBe("SRU_Baron17.1.1");
    expect(slots.slotOf("Someone#Else")).toBe(UNKNOWN);
    expect(slots.slotOf(undefined)).toBeUndefined();
  });
});

describe("samples", () => {
  it("leaves no player name in a sample", () => {
    const sample = {
      t: 1,
      gameTime: 600,
      active: { id: "Faker#KR1", gold: 1200 },
      players: [{ id: "Faker#KR1", champion: "Ahri" }, { id: "Twin#EUW", champion: "Faker" }, { id: "Twin#NA1", champion: "Zed" }],
      events: [
        { id: 7, name: "ChampionKill", killer: "Twin#EUW", victim: "Faker", assisters: ["Twin#NA1", "Stranger"] },
        { id: 8, name: "TurretKilled", killer: "Minion_T100L0S01N0042", turret: "Turret_T2_L_03_A" },
      ],
    };
    const out = pseudonymizeSample(sample, slotsFor(roster));
    expect(out.active.id).toBe("P1");
    expect(out.players.map((p) => p.id)).toEqual(["P1", "P2", "P3"]);
    expect(out.players[1].champion).toBe("Faker");
    expect(out.events[0]).toMatchObject({ killer: "P2", victim: "P1", assisters: ["P3", UNKNOWN] });
    expect(out.events[1]).toMatchObject({ killer: "Minion_T100L0S01N0042", turret: "Turret_T2_L_03_A" });
    const text = JSON.stringify(out);
    for (const name of ["Faker#", "Twin", "Stranger"]) expect(text).not.toContain(name);
  });
});
