import type { Raster } from "../map/perception/raster";
import type { Box } from "./queue";
import { changedBox, changedShare, panelBox } from "./panel";

export type SelectionSample = { at: number; without: Raster; withPanel: Raster };

/** Samples arrive newest first, paired at the same game second. A selection
 * drop in the final frame must not discard a panel visible just before it. */
export function findSelectedPanel(
  samples: Iterable<{ at: number; without: Raster; withPanel: Raster }>,
  searchArea: Box,
  strips: Record<string, Box>,
  minimum: { width: number; height: number },
  maxStripChange: number,
) {
  for (const sample of samples) {
    const { without, withPanel } = sample;
    if (without.width !== withPanel.width || without.height !== withPanel.height) continue;
    const changed = changedBox(without, withPanel, searchArea);
    if (!changed || changed.width < minimum.width || changed.height < minimum.height) continue;
    const changedInStrips = Object.fromEntries(
      Object.entries(strips).map(([name, box]) => [name, Number(changedShare(without, withPanel, box).toFixed(4))]),
    );
    if (Object.values(changedInStrips).some((share) => share > maxStripChange)) continue;
    return { ...sample, changed, changedInStrips, box: panelBox(changed, without) };
  }
  return null;
}
