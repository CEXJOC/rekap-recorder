import { describe, expect, it } from "vitest";
import { NEVER_UPLOADED, SOURCES, UPLOAD_MANIFEST, checkUpload, cleanReplayCapture, manifestEntrySchema } from "./manifest";

describe("upload manifest", () => {
  it("has valid, unique entries for each source", () => {
    for (const source of SOURCES) {
      for (const entry of UPLOAD_MANIFEST[source]) manifestEntrySchema.parse(entry);
      const paths = UPLOAD_MANIFEST[source].map((entry) => entry.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it("never lists a file that must stay on the PC", () => {
    for (const source of SOURCES)
      for (const entry of UPLOAD_MANIFEST[source]) expect(NEVER_UPLOADED).not.toHaveProperty(entry.path);
    for (const local of ["screen.mp4", "meta.json", "source.json", "report.json"]) expect(NEVER_UPLOADED).toHaveProperty(local);
  });

  it("refuses the full-screen video and other sources' files, and reports missing required files", () => {
    const live = checkUpload("live", ["masked.mp4", "screen.mp4", "game.json", "frames.mp4"]);
    expect(live.allowed).toEqual(["masked.mp4", "game.json"]);
    expect(live.refused.map((r) => r.path)).toEqual(["screen.mp4", "frames.mp4"]);
    expect(live.refused[1].reason).toBe("Not in the upload manifest for this source.");
    expect(live.missing).toEqual(["samples.ndjson", "clock.json"]);
    const replay = checkUpload("replay", ["capture.json", "minimap.mp4", "frames.mp4", "source.json", "screen.mp4"]);
    expect(replay.allowed).toEqual(["capture.json", "minimap.mp4", "frames.mp4"]);
    expect(replay.missing).toEqual([]);
  });

  it("removes the followed player's Riot ID from a replay capture and keeps the rest", () => {
    const capture = {
      matchId: "EUW1_1",
      selectedPlayer: { participantId: 9, championName: "Ezreal", riotIdGameName: "Someone" },
      selectionCheck: { ok: true, selection: "Someone" },
    };
    const clean = cleanReplayCapture(capture);
    expect(JSON.stringify(clean)).not.toContain("Someone");
    expect(clean).toMatchObject({ matchId: "EUW1_1", selectedPlayer: { participantId: 9, championName: "Ezreal" }, selectionCheck: { ok: true } });
    expect(capture.selectedPlayer.riotIdGameName).toBe("Someone");
  });
});
