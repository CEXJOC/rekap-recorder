import { describe, expect, it } from "vitest";
import { blank, Raster } from "../map/perception/raster";
import { changedBox, changedShare, panelBox, panelGaps, showsPanel } from "./panel";

const screen = { width: 200, height: 120 };
const panel = { x: 10, y: 60, width: 80, height: 40 };

function fill(r: Raster, box: typeof panel, value: number) {
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++)
      r.data.fill(value, (y * r.width + x) * 3, (y * r.width + x) * 3 + 3);
}

// A gray background; with a panel, a dark rectangle with a lighter digit in it.
function frame(background: number, digit: number | null): Raster {
  const r = blank(screen.width, screen.height, [background, background, background]);
  if (digit !== null) {
    fill(r, panel, 20);
    fill(r, { x: 20 + digit, y: 70, width: 6, height: 10 }, 230);
  }
  return r;
}

describe("the followed player's panel", () => {
  const without = frame(120, null);
  const withPanel = frame(120, 0);
  const area = { x: 0, y: 40, width: 150, height: 80 };

  it("is where the frames without and with the selection differ", () => {
    expect(changedBox(without, withPanel, area)).toEqual(panel);
    expect(changedBox(without, without, area)).toBe(null);
  });

  it("ignores a change of a pixel or two, and changes outside the area", () => {
    const noisy = frame(120, null);
    noisy.data.fill(255, (50 * screen.width + 120) * 3, (50 * screen.width + 120) * 3 + 6);
    fill(noisy, { x: 160, y: 0, width: 30, height: 30 }, 0);
    expect(changedBox(without, noisy, area)).toBe(null);
  });

  it("measures how much of a recorded strip the selection changed", () => {
    expect(changedShare(without, withPanel, panel)).toBe(1);
    expect(changedShare(without, withPanel, { x: 100, y: 0, width: 100, height: 120 })).toBe(0);
  });

  it("grows the crop above the panel for buffs, inside the screen, with even sides", () => {
    expect(panelBox({ x: 1, y: 803, width: 306, height: 159 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 771,
      width: 310,
      height: 194,
    });
    const edge = panelBox({ x: 0, y: 1000, width: 301, height: 79 }, { width: 1920, height: 1080 });
    expect(edge.y + edge.height).toBeLessThanOrEqual(1080);
    expect(edge.width % 2).toBe(0);
    expect(edge.height % 2).toBe(0);
  });

  it("tells a frame with the panel from one without, whatever the numbers and the fog", () => {
    expect(showsPanel(frame(100, 30), withPanel, without, panel).present).toBe(true);
    expect(showsPanel(frame(140, 50), withPanel, without, panel).present).toBe(true);
    expect(showsPanel(frame(100, null), withPanel, without, panel).present).toBe(false);
    expect(showsPanel(frame(140, null), withPanel, without, panel).present).toBe(false);
  });

  it("lists the stretches of game time without the panel", () => {
    const present = [false, true, true, false, false, false, true, false];
    expect(panelGaps(present, 2)).toEqual([
      [0, 0],
      [1.5, 2.5],
      [3.5, 3.5],
    ]);
    expect(panelGaps([true, true], 2)).toEqual([]);
  });
});
