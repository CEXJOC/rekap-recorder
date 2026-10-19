import { describe, expect, it } from "vitest";
import { blank, Raster } from "../map/perception/raster";
import { baseLight, fogSide } from "./fog";

const rect = { x: 20, y: 10, size: 100 };

// A uniform minimap at gray 200 on a black screen; `dim` darkens a corner.
function frame(dim: "blue" | "red" | "both" | null): Raster {
  const r = blank(160, 140);
  for (let y = rect.y; y < rect.y + rect.size; y++)
    for (let x = rect.x; x < rect.x + rect.size; x++) {
      const inBlue = x < rect.x + 30 && y >= rect.y + 70;
      const inRed = x >= rect.x + 70 && y < rect.y + 30;
      const dark =
        (inBlue && (dim === "blue" || dim === "both")) ||
        (inRed && (dim === "red" || dim === "both"));
      r.data.fill(dark ? 90 : 200, (y * r.width + x) * 3, (y * r.width + x) * 3 + 3);
    }
  return r;
}

describe("fog side from the minimap base corners", () => {
  const noFog = baseLight(frame(null), rect);

  it("reads the corner light of the minimap, not of the screen", () => {
    expect(noFog.blue).toBeCloseTo(200);
    expect(noFog.red).toBeCloseTo(200);
  });

  it("names the team whose own base stays lit", () => {
    expect(fogSide(baseLight(frame("red"), rect), noFog)).toBe(100);
    expect(fogSide(baseLight(frame("blue"), rect), noFog)).toBe(200);
  });

  it("tells apart no fog and both teams fogged", () => {
    expect(fogSide(baseLight(frame(null), rect), noFog)).toBe("none");
    expect(fogSide(baseLight(frame("both"), rect), noFog)).toBe("both");
  });
});
