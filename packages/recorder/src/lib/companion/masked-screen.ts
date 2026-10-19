// The screen recording with everything blacked out except the fixed interface
// surfaces Rekap reads (product rule 4): top counters, ally portraits,
// minimap and the player's own HUD. The 3D world, chat, kill feed, target
// panel, other windows and notifications disappear; the geometry stays the
// full screen's, so screen-mode analysis reads it unchanged. This is the
// track meant to leave the PC under the data contract (doc/tasks/open-recorder.md).
//
// Rectangles are measured on native 1920×1080 with the default HUD scale
// (2026-10-12, own recordings). Other screens are brought to that geometry
// first (screen-fit.ts): 16:9 scaled, 16:10 to 5:4 rebuilt surface by surface;
// ultrawide screens get no masked track.
// The minimap is located on the recording itself, since its size is a setting.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { CaptureArea } from "./encoder";
import { minimapArea } from "./minimap-area";
import { decodePng, Raster } from "../map/perception/raster";
import { REFERENCE, fitGraph, screenFit, type Anchor, type Fit } from "./screen-fit";

/** Written next to screen.mp4 when the companion runs with --masked. */
export const MASKED_FILE = "masked.mp4";
/** Screen-mode analysis reads one frame a second (sampleEvery 1). */
export const MASKED_FPS = 1;

export type Region = CaptureArea & { name: "top" | "allies" | "minimap" | "recall" | "hud" };

/**
 * Pixels kept around the located minimap. Analysis locates the minimap on the
 * recording again, frame and border included: cut flush, the black edge moved
 * its square to 307 px instead of 304 and shifted positions on 11% of the
 * sightings (Syndra, 2026-10-12).
 */
export const MINIMAP_MARGIN = 16;

/** The masked track's size: the measured screen. */
export const MASKED_SIZE = REFERENCE;

/** The edge or centre each kept surface is pinned to (screen-fit.ts). */
export const REGION_ANCHORS: Record<Region["name"], Anchor> = { top: "right", allies: "right", minimap: "right", recall: "center", hud: "center" };

/** Kept surfaces of a 1920×1080 screen, or null for an unmeasured size. */
export function keptRegions(screen: { width: number; height: number }, minimap: CaptureArea): Region[] | null {
  if (screen.width !== 1920 || screen.height !== 1080) return null;
  const right = screen.width;
  const m = MINIMAP_MARGIN;
  const left = Math.max(0, minimap.x - m);
  const top = Math.max(0, minimap.y - m);
  return [
    // Score, K/D/A, CS and clock; the FPS and ping line below is left out.
    { name: "top", x: 1540, y: 0, width: right - 1540, height: 30 },
    // Ally portraits with level, health and ultimate, just above the minimap.
    { name: "allies", x: left, y: Math.max(0, top - 130), width: right - left, height: Math.min(130, top) },
    {
      name: "minimap",
      x: left,
      y: top,
      width: Math.min(right, minimap.x + minimap.width + m) - left,
      height: Math.min(screen.height, minimap.y + minimap.height + m) - top,
    },
    // The recall title and channel bar above the HUD (own-recall-hud.ts reads
    // them at 925,780 and 758,795 in screen pixels); the world around stays black.
    { name: "recall", x: 460, y: 780, width: 1000, height: 30 },
    // The HUD itself: portrait, abilities, items, health and resource bars.
    { name: "hud", x: 460, y: 955, width: 1000, height: 125 },
  ];
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * The rectangles that cover everything outside `kept`: the screen is cut into
 * horizontal bands at every region edge, and each band's uncovered spans
 * become one box.
 */
export function blackBoxes(size: { width: number; height: number }, kept: readonly Box[]): Box[] {
  const ys = [...new Set([0, size.height, ...kept.flatMap((r) => [r.y, r.y + r.height])])]
    .filter((y) => y >= 0 && y <= size.height)
    .sort((a, b) => a - b);
  const boxes: Box[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const [top, bottom] = [ys[i], ys[i + 1]];
    const covered = kept
      .filter((r) => r.y < bottom && r.y + r.height > top)
      .map((r) => [Math.max(0, r.x), Math.min(size.width, r.x + r.width)] as const)
      .sort((a, b) => a[0] - b[0]);
    let x = 0;
    for (const [from, to] of covered) {
      if (from > x) boxes.push({ x, y: top, width: from - x, height: bottom - top });
      x = Math.max(x, to);
    }
    if (x < size.width) boxes.push({ x, y: top, width: size.width - x, height: bottom - top });
  }
  return boxes;
}

/**
 * ffmpeg arguments: one frame a second, taken by the same fps filter the
 * analysis reads with (video.ts, fps=1/every), so both keep the very same
 * frames; black boxes over everything else, in 4:4:4 so odd edges stay exact.
 * Measured on a 60 s clip read like the analysis (2026-10-12): mean minimap
 * difference 1.99 against 4.68 for a 2 fps grid, 5.89 for frames kept at
 * their own times and 3.40 for the full 30 fps; 5.2 s of encoding.
 */
export function maskArgs(input: string, output: string, screen: { width: number; height: number }, regions: readonly Region[]) {
  const boxes = blackBoxes(MASKED_SIZE, regions).map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=black:t=fill`);
  const surfaces = regions.map((r) => ({ ...r, anchor: REGION_ANCHORS[r.name] }));
  const graph = `${fitGraph(screenFit(screen), surfaces, "yuv444p", [`fps=${MASKED_FPS}`])};[fit]${boxes.length ? boxes.join(",") : "null"}[out]`;
  return [
    "-v", "error", "-y", "-i", input,
    "-filter_complex", graph, "-map", "[out]",
    "-an", "-r", String(MASKED_FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ];
}

function run(ffmpeg: string, args: string[], stdout = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const out: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => stdout && out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${error.trim().slice(-300)}`))));
  });
}

const frameAt = async (ffmpeg: string, video: string, seconds: number, scale: string | null): Promise<Raster> =>
  decodePng(await run(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", video, ...(scale ? ["-vf", scale] : []), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], true));

/** The scale under which the minimap is located: 1080 px high, its 1920×1080 size for 16:9. */
function locateScale(fit: Fit) {
  if (fit.kind === "scale") return `scale=${REFERENCE.width}:${REFERENCE.height}:flags=area`;
  if (fit.kind === "relayout") return `scale=${fit.scaledWidth}:${REFERENCE.height}:flags=area`;
  return null;
}

/**
 * The minimap square of a recording, found on three frames (30, 50, 80 % in).
 * The locator can differ by a pixel between frames: the most frequent square
 * wins, and a move of more than 2 px means no answer. With `scale` (an ffmpeg
 * filter), frames are scaled first and the square is in the scaled pixels.
 */
export async function recordedMinimap(ffmpeg: string, video: string, durationSeconds: number, scale: string | null = null): Promise<CaptureArea | null> {
  const found = await Promise.all([0.3, 0.5, 0.8].map(async (f) => minimapArea(await frameAt(ffmpeg, video, Math.round(durationSeconds * f), scale))));
  if (found.some((a) => !a)) return null;
  const areas = found as NonNullable<(typeof found)[number]>[];
  const key = (a: CaptureArea) => `${a.x},${a.y},${a.width}`;
  const count = (a: CaptureArea) => areas.filter((b) => key(b) === key(a)).length;
  const best = areas.reduce((a, b) => (count(b) > count(a) ? b : a));
  if (!areas.every((a) => Math.abs(a.x - best.x) <= 2 && Math.abs(a.y - best.y) <= 2 && Math.abs(a.width - best.width) <= 2)) return null;
  return { x: best.x, y: best.y, width: best.width, height: best.height };
}

/** Writes `output` from a full-screen recording, or returns why it cannot. */
export async function writeMaskedScreen(options: {
  ffmpeg: string;
  input: string;
  output: string;
  screen: { width: number; height: number; durationSeconds: number };
}): Promise<{ regions: Region[] } | { skipped: string }> {
  const { ffmpeg, input, output, screen } = options;
  const fit = screenFit(screen);
  if (fit.kind === "unsupported") return { skipped: fit.reason };
  const found = await recordedMinimap(ffmpeg, input, screen.durationSeconds, locateScale(fit));
  if (!found) return { skipped: "The minimap was not found at the same place on three frames." };
  // Found 1080 px high; on a narrower screen it moves right with its edge.
  const minimap = fit.kind === "relayout" ? { ...found, x: found.x + REFERENCE.width - fit.scaledWidth } : found;
  const regions = keptRegions(MASKED_SIZE, minimap)!;
  await run(ffmpeg, maskArgs(input, output, screen, regions));
  // What the track holds, for whoever reads it without the recording.
  writeFileSync(
    output.replace(/\.mp4$/, ".json"),
    `${JSON.stringify({ version: "masked-0.1", fps: MASKED_FPS, ...MASKED_SIZE, source: { width: screen.width, height: screen.height }, minimap, regions }, null, 2)}\n`,
  );
  return { regions };
}
