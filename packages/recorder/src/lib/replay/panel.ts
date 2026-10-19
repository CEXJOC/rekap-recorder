// The selected champion's panel in the spectator HUD (interfaceTarget): the
// followed player's abilities with their cooldowns, summoner spells, health,
// mana, level, stats and buffs. The queue finds it in each game from two
// frames of the same game moment, without and with the selection: in the fog
// test (patch 16.19) selecting a champion changed nothing else on screen, so
// the panel is where the two frames differ.
import type { Raster } from "../map/perception/raster";
import type { Box } from "./queue";

const luma = (r: Raster, x: number, y: number) => {
  const i = (y * r.width + x) * 3;
  return 0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2];
};

/** `box` cut to the frame. */
const inside = (r: Raster, box: Box): Box => {
  const x = Math.max(0, box.x),
    y = Math.max(0, box.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(r.width, box.x + box.width) - x),
    height: Math.max(0, Math.min(r.height, box.y + box.height) - y),
  };
};

/**
 * Bounding box of the pixels of `area` whose gray level differs by more than
 * `threshold` between two frames of the same size. Rows and columns with
 * fewer than `minCount` such pixels are noise. Null when nothing changed.
 */
export function changedBox(
  a: Raster,
  b: Raster,
  area: Box,
  threshold = 40,
  minCount = 3,
): Box | null {
  const c = inside(a, area);
  const rows = new Array<number>(c.height).fill(0);
  const cols = new Array<number>(c.width).fill(0);
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (
        Math.abs(luma(a, c.x + x, c.y + y) - luma(b, c.x + x, c.y + y)) >
        threshold
      ) {
        rows[y]++;
        cols[x]++;
      }
  const y0 = rows.findIndex((n) => n >= minCount);
  const x0 = cols.findIndex((n) => n >= minCount);
  if (y0 < 0 || x0 < 0) return null;
  return {
    x: c.x + x0,
    y: c.y + y0,
    width: cols.findLastIndex((n) => n >= minCount) - x0 + 1,
    height: rows.findLastIndex((n) => n >= minCount) - y0 + 1,
  };
}

/** Share (0–1) of the pixels of `box` whose gray level differs by more than `threshold`. */
export function changedShare(a: Raster, b: Raster, box: Box, threshold = 40) {
  const c = inside(a, box);
  let n = 0;
  for (let y = c.y; y < c.y + c.height; y++)
    for (let x = c.x; x < c.x + c.width; x++)
      if (Math.abs(luma(a, x, y) - luma(b, x, y)) > threshold) n++;
  return c.width * c.height ? n / (c.width * c.height) : 0;
}

/** Mean absolute gray difference of two frames within `box`. */
export function meanDiff(a: Raster, b: Raster, box: Box) {
  const c = inside(a, box);
  let sum = 0;
  for (let y = c.y; y < c.y + c.height; y++)
    for (let x = c.x; x < c.x + c.width; x++)
      sum += Math.abs(luma(a, x, y) - luma(b, x, y));
  return c.width * c.height ? sum / (c.width * c.height) : 0;
}

/**
 * The panel's crop: the changed area grown by `margin` on each side and by
 * `above` more upwards, where the panel lists the champion's buffs (the check
 * frame shows only those the champion had then). Kept inside `screen`, with
 * even sides for the video encoder.
 */
export function panelBox(
  changed: Box,
  screen: { width: number; height: number },
  margin = 2,
  above = 30,
): Box {
  const x = Math.max(0, changed.x - margin);
  const y = Math.max(0, changed.y - margin - above);
  const even = (n: number, max: number) => Math.min(n + (n % 2), max - (max % 2));
  return {
    x,
    y,
    width: even(Math.min(screen.width, changed.x + changed.width + margin) - x, screen.width - x),
    height: even(Math.min(screen.height, changed.y + changed.height + margin) - y, screen.height - y),
  };
}

/**
 * The stretches of game time without the panel, as [first, last] game seconds
 * of the frames that lack it; frame i shows game second i / fps.
 */
export function panelGaps(present: boolean[], fps: number): [number, number][] {
  const gaps: [number, number][] = [];
  for (let i = 0; i < present.length; i++) {
    if (present[i]) continue;
    const first = i;
    while (i + 1 < present.length && !present[i + 1]) i++;
    gaps.push([first / fps, i / fps]);
  }
  return gaps;
}

/**
 * Whether a frame shows the panel: within the panel's box it is closer to the
 * check frame with the selection than to the one without. The panel is
 * opaque, so its changing numbers weigh less than its presence.
 */
export function showsPanel(
  frame: Raster,
  withPanel: Raster,
  withoutPanel: Raster,
  box: Box,
) {
  const toWith = meanDiff(frame, withPanel, box);
  const toWithout = meanDiff(frame, withoutPanel, box);
  return { present: toWith < toWithout, toWith, toWithout };
}
