import { describe, expect, it } from "vitest";
import { blank, type Raster } from "../map/perception/raster";
import { findSelectedPanel } from "./selection";

const search = { x: 0, y: 40, width: 150, height: 80 };
const panel = { x: 10, y: 60, width: 80, height: 40 };
const strips = { scoreboard: { x: 150, y: 0, width: 50, height: 30 } };
const minimum = { width: 60, height: 30 };
const without = blank(200, 120, [120, 120, 120]);

function fill(frame: Raster, box: typeof panel, value: number) {
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++)
      frame.data.fill(value, (y * frame.width + x) * 3, (y * frame.width + x) * 3 + 3);
}

function selected() {
  const frame = blank(200, 120, [120, 120, 120]);
  fill(frame, panel, 20);
  return frame;
}

describe("replay selection calibration", () => {
  it("uses a same-time earlier pair when the final frame drops the selection", () => {
    const visible = selected();
    const result = findSelectedPanel([
      { at: 600, without, withPanel: without },
      { at: 599.5, without, withPanel: visible },
      { at: 599, without, withPanel: selected() },
    ], search, strips, minimum, 0.005);
    expect(result).toMatchObject({ at: 599.5, changed: panel, changedInStrips: { scoreboard: 0 } });
    expect(result?.withPanel).toBe(visible);
  });

  it("keeps the final pair when it already passes", () => {
    const result = findSelectedPanel([
      { at: 600, without, withPanel: selected() },
      { at: 599.5, without, withPanel: selected() },
    ], search, strips, minimum, 0.005);
    expect(result?.at).toBe(600);
  });

  it("rejects a panel that changes another retained interface strip", () => {
    const unsafe = selected();
    fill(unsafe, strips.scoreboard, 0);
    expect(findSelectedPanel([{ at: 600, without, withPanel: unsafe }], search, strips, minimum, 0.005)).toBeNull();
  });

  it("does not fabricate a panel from absent, tiny or mismatched frames", () => {
    const tiny = selected();
    fill(tiny, panel, 120);
    fill(tiny, { x: 10, y: 60, width: 10, height: 10 }, 20);
    expect(findSelectedPanel([
      { at: 600, without, withPanel: without },
      { at: 599.5, without, withPanel: tiny },
      { at: 599, without, withPanel: blank(100, 120) },
    ], search, strips, minimum, 0.005)).toBeNull();
  });
});
