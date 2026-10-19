// Which team's fog of war a replay frame shows, read from its minimap.
// Under one team's fog, the corner of the other team's base is darkened (the
// team has no vision there before the late game) while its own base stays lit
// by its structures. Each corner is compared with the same corner in a view
// without fog, so terrain and icons cancel out.
import type { MinimapRect } from "../map/perception/locate";
import { gray, Raster } from "../map/perception/raster";

/** Mean gray level (0–255) of the two base corners of the minimap. */
export type BaseLight = { blue: number; red: number };

/** `share`: side of each corner square as a fraction of the minimap side. */
export function baseLight(
  frame: Raster,
  rect: MinimapRect,
  share = 0.2,
): BaseLight {
  const g = gray(frame);
  const side = Math.max(1, Math.round(rect.size * share));
  const mean = (x0: number, y0: number) => {
    let sum = 0,
      n = 0;
    for (let y = Math.max(0, y0); y < Math.min(g.height, y0 + side); y++)
      for (let x = Math.max(0, x0); x < Math.min(g.width, x0 + side); x++) {
        sum += g.data[y * g.width + x];
        n++;
      }
    return n ? sum / n : NaN;
  };
  // Blue base is the bottom-left corner of the minimap, red base the top right.
  return {
    blue: mean(rect.x, rect.y + rect.size - side),
    red: mean(rect.x + rect.size - side, rect.y),
  };
}

/** 100: blue team's vision, 200: red team's vision. */
export type FogSide = 100 | 200 | "none" | "both";

/** A corner is fogged when it keeps less than `dark` of its light without fog. */
export function fogSide(
  withFog: BaseLight,
  noFog: BaseLight,
  dark = 0.8,
): FogSide {
  const blueDark = withFog.blue < noFog.blue * dark;
  const redDark = withFog.red < noFog.red * dark;
  if (blueDark && redDark) return "both";
  if (redDark) return 100;
  if (blueDark) return 200;
  return "none";
}
