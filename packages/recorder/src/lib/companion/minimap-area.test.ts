import { describe, expect, it } from "vitest";
import { minimapReference } from "../map/perception/locate";
import { blank, resample, toRaster } from "../map/perception/raster";
import { buildFrameGrabArgs, minimapArea } from "./minimap-area";

// A noisy 960×540 "screen" with the minimap terrain pasted at (x, y).
function screen(x: number | null, y: number, size: number) {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const frame = blank(960, 540);
  for (let i = 0; i < frame.data.length; i++) frame.data[i] = 40 + 60 * next();
  if (x === null) return frame;
  const map = toRaster(resample(minimapReference(), size, size));
  for (let row = 0; row < size; row++)
    frame.data.set(
      map.data.subarray(row * size * 3, (row + 1) * size * 3),
      ((y + row) * 960 + x) * 3,
    );
  return frame;
}

describe("minimap area", () => {
  it("finds the minimap in the bottom-right, with an even size", () => {
    const area = minimapArea(screen(797, 377, 141))!;
    expect(Math.abs(area.x - 797)).toBeLessThanOrEqual(2);
    expect(Math.abs(area.y - 377)).toBeLessThanOrEqual(2);
    expect(Math.abs(area.width - 141)).toBeLessThanOrEqual(3);
    expect(area.width % 2).toBe(0);
    expect(area.height).toBe(area.width);
  });

  it("finds a minimap flipped to the bottom-left", () => {
    const area = minimapArea(screen(20, 380, 140))!;
    expect(Math.abs(area.x - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(area.y - 380)).toBeLessThanOrEqual(2);
  });

  it("finds nothing on a screen without the minimap", () => {
    expect(minimapArea(screen(null, 0, 0))).toBeNull();
  });

  it("grabs one RGB frame of the chosen monitor", () => {
    const args = buildFrameGrabArgs(1).join(" ");
    expect(args).toContain("ddagrab=output_idx=1:framerate=1:draw_mouse=0,hwdownload");
    expect(args).toContain("-frames:v 1 -pix_fmt rgb24 -c:v png -f image2pipe -");
  });
});
