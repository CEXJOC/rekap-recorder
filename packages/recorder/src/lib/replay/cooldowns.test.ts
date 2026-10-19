import { describe, expect, it } from "vitest";
import { blank, Raster } from "../map/perception/raster";
import {
  cooldownEpisodes,
  createCooldownFrameReader,
  FLASH_READY_CONFIRM_SECONDS,
  cooldownLeft,
  frameStates,
  hexflashSlot,
  ICON,
  PANEL_CHROME,
  PANEL_HEIGHT,
  panelOrigin,
  rowProblem,
  SLOT_ICONS,
  slotFeatures,
  slotState,
} from "./cooldowns";

const origin = { x: 0, y: 32 };
const W = 308,
  H = 192;

function fill(
  r: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: number[],
) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) r.data.set(rgb, (y * r.width + x) * 3);
}

// A panel: dark background, light chrome; each slot drawn in one of three looks.
function panel(
  slots: Partial<Record<string, "ready" | "cooldown" | "grey">>,
  chrome = true,
): Raster {
  const r = blank(W, H, [20, 30, 35]);
  if (chrome)
    for (const a of PANEL_CHROME)
      fill(
        r,
        origin.x + a.x,
        origin.y + a.y,
        a.width,
        a.height,
        [150, 140, 90],
      );
  for (const [slot, look] of Object.entries(slots)) {
    const { x, y } = SLOT_ICONS[slot as keyof typeof SLOT_ICONS];
    const ix = origin.x + x,
      iy = origin.y + y;
    if (look === "ready") fill(r, ix, iy, ICON, ICON, [200, 60, 30]);
    else {
      fill(r, ix, iy, ICON, ICON, [70, 70, 70]);
      // White seconds in the middle band.
      if (look === "cooldown")
        fill(r, ix + 10, iy + 11, 12, 10, [240, 240, 240]);
    }
  }
  return r;
}

describe("cooldown reader", () => {
  const reference = panel({});

  it("withholds short Flash-art charging runs, then confirms a continuous return without future frames", () => {
    const read = createCooldownFrameReader(reference, origin, "D", 2);
    const ready = panel({ D: "ready", F: "ready" });
    for (const s of ["D", "F"] as const)
      fill(
        ready,
        SLOT_ICONS[s].x,
        origin.y + SLOT_ICONS[s].y,
        ICON,
        ICON,
        [138, 135, 63],
      );
    expect(read(panel({ D: "cooldown", F: "ready" }), 0).D).toBe("c");
    for (let i = 1; i <= 5; i++)
      expect(read(ready, i / 2)).toMatchObject({ D: "?", F: "r" });
    expect(read(panel({ D: "cooldown", F: "ready" }), 3).D).toBe("c");
    for (let i = 7; i < 13; i++) expect(read(ready, i / 2).D).toBe("?");
    expect(read(ready, 6.5).D).toBe("r");
    expect(FLASH_READY_CONFIRM_SECONDS).toBe(3);
    expect(() => read(ready, 6.5)).toThrow(/ordered/);
  });
  it("resets Flash confirmation on a missing panel, a time gap or changed state, in either physical slot", () => {
    const ready = panel({ D: "ready", F: "ready" }),
      read = createCooldownFrameReader(reference, origin, "F", 1);
    for (const s of ["D", "F"] as const)
      fill(
        ready,
        SLOT_ICONS[s].x,
        origin.y + SLOT_ICONS[s].y,
        ICON,
        ICON,
        [138, 135, 63],
      );
    expect(read(ready, 0).F).toBe("?");
    expect(read(ready, 1).F).toBe("?");
    expect(read(panel({ F: "ready" }, false), 2).F).toBe("?");
    expect(read(ready, 3).F).toBe("?");
    expect(read(ready, 7).F).toBe("?");
    expect(read(ready, 8).F).toBe("?");
    expect(read(ready, 9).F).toBe("?");
    expect(read(ready, 10)).toMatchObject({ D: "r", F: "r" });
    expect(
      createCooldownFrameReader(reference, origin, null, 2)(ready, 0),
    ).toMatchObject({ D: "r", F: "r" });
    expect(() => createCooldownFrameReader(reference, origin, "D", 0)).toThrow(
      /frame rate/,
    );
  });
  it("does not count partial chrome or a clipped ability as a complete current observation", () => {
    const ready = panel({ F: "ready" });
    expect(
      Object.values(
        frameStates({ ...ready, width: 100 }, reference, origin),
      ).every((s) => s === "?"),
    ).toBe(true);
    expect(
      Object.values(frameStates(ready, reference, { x: -15, y: 32 })).every(
        (s) => s === "?",
      ),
    ).toBe(true);
    const truncated = {
      width: ready.width,
      height: 147,
      data: ready.data.slice(0, ready.width * 147 * 3),
    };
    // Chrome fits the matched geometry, but the rightmost icon does not.
    expect(frameStates(truncated, truncated, origin).F).toBe("?");
  });

  it("tells ready, on cooldown and greyed slots apart", () => {
    const f = panel({
      P: "ready",
      Q: "cooldown",
      W: "grey",
      D: "cooldown",
      F: "ready",
    });
    const at = (s: keyof typeof SLOT_ICONS) => ({
      x: origin.x + SLOT_ICONS[s].x,
      y: origin.y + SLOT_ICONS[s].y,
    });
    expect(slotState(slotFeatures(f, at("P")))).toBe("r");
    expect(slotState(slotFeatures(f, at("Q")))).toBe("c");
    expect(slotState(slotFeatures(f, at("W")))).toBe("-");
    expect(slotFeatures(f, at("Q")).numberPixels).toBeGreaterThan(50);
    expect(frameStates(f, reference, origin)).toMatchObject({
      P: "r",
      Q: "c",
      W: "-",
      D: "c",
      F: "r",
    });
  });

  it("marks every slot unknown when the panel is missing", () => {
    const states = frameStates(panel({ Q: "ready" }, false), reference, origin);
    expect(Object.values(states).every((s) => s === "?")).toBe(true);
  });

  it("turns frame states into cooldowns, across frames without the panel", () => {
    // 2 fps: ready, cast at 1.0 s, a missing frame inside, ready again at 3.5 s.
    const episodes = cooldownEpisodes("rrcc?ccr", 2);
    expect(episodes).toEqual([{ start: 1, castAfter: 0.5, last: 3, end: 3.5 }]);
    expect(cooldownLeft(episodes, 2)).toBe(1.5);
    expect(cooldownLeft(episodes, 0.5)).toBe(null);
  });

  it("keeps the uncertainty when a cooldown starts or ends unseen", () => {
    // Locked from the start of the recording, then cast during missing frames.
    expect(cooldownEpisodes("cc-r??cc", 2)).toEqual([
      { start: 0, castAfter: null, last: 0.5, end: 1 },
      { start: 3, castAfter: 1.5, last: 3.5, end: null },
    ]);
    expect(cooldownLeft(cooldownEpisodes("rcc", 2), 1)).toBe(null);
  });

  it("finds the frame from the bottom of the area that changed, whatever sits above it", () => {
    // Measured on 68 recordings: the area is 133 px high alone, 160 with one
    // row of buffs above, 187 with two; its bottom edge is always at 963.
    const icons = [
      {
        box: { x: 0, y: 798, width: 308, height: 168 },
        changed: { x: 0, y: 830, width: 306, height: 133 },
      },
      {
        box: { x: 0, y: 771, width: 310, height: 194 },
        changed: { x: 0, y: 803, width: 307, height: 160 },
      },
      {
        box: { x: 0, y: 744, width: 308, height: 222 },
        changed: { x: 0, y: 776, width: 306, height: 187 },
      },
    ].map(
      ({ box, changed }) =>
        box.y + panelOrigin(changed, box).y + SLOT_ICONS.R.y,
    );
    expect(icons).toEqual([917, 917, 917]);
    expect(PANEL_HEIGHT - SLOT_ICONS.R.y - ICON).toBe(14); // the row sits 14 px above the bottom edge
  });

  it("tells Hexflash from Flash by colour, in the Flash slot of a player who took the rune", () => {
    // Middle of the icons as measured on recordings: Flash 138, 135, 63; Hexflash 214, 155, 121.
    const draw = (rgb: number[]) => {
      const r = panel({ F: "ready" });
      fill(
        r,
        origin.x + SLOT_ICONS.D.x,
        origin.y + SLOT_ICONS.D.y,
        ICON,
        ICON,
        rgb,
      );
      return r;
    };
    const flash = draw([138, 135, 63]),
      hexflash = draw([214, 155, 121]);
    expect(frameStates(flash, reference, origin, "D").D).toBe("r");
    expect(frameStates(hexflash, reference, origin, "D").D).toBe("h");
    // Without the rune the same colours are a ready spell; another slot is never h.
    expect(frameStates(hexflash, reference, origin).D).toBe("r");
    expect(frameStates(hexflash, reference, origin, "F").D).toBe("r");
    // Greyed, the slot is on cooldown or unavailable as anywhere.
    expect(
      frameStates(panel({ D: "cooldown" }), reference, origin, "D").D,
    ).toBe("c");

    expect(hexflashSlot([8010, 8306], 4, 14)).toBe("D");
    expect(hexflashSlot([8306], 12, 4)).toBe("F");
    expect(hexflashSlot([8010], 4, 14)).toBeNull();
    expect(hexflashSlot([8306], 12, 14)).toBeNull();
  });

  it("counts Hexflash in the Flash slot as Flash on cooldown", () => {
    // 2 fps: Flash cast at 1.0 s, Hexflash up, used once, Flash back at 5.0 s.
    expect(cooldownEpisodes("rrchhhchhhrr", 2)).toEqual([
      { start: 1, castAfter: 0.5, last: 4.5, end: 5 },
    ]);
    expect(rowProblem({ D: "rrchhh", F: "rr" })).toBeNull();
  });

  it("refuses rows where a summoner spell never reads ready", () => {
    expect(rowProblem({ D: "--rrcc", F: "rrrr" })).toBeNull();
    expect(rowProblem({ D: "------", F: "rrcc" })).toMatch(/D never/);
    expect(rowProblem({ D: "cccc", F: "----" })).toMatch(/D and F never/);
  });

  it("ends a cooldown when the slot greys without a number (dead)", () => {
    expect(cooldownEpisodes("rcc--r", 2)).toEqual([
      { start: 0.5, castAfter: 0, last: 1, end: 1.5 },
    ]);
  });
});
