// Every surface Rekap reads (minimap, HUD, counters, portraits, spectator
// frames, scoreboard, panel) is measured on a 1920×1080 game. Other window
// sizes are brought to that geometry before anything reads them:
//
// - 16:9 at any size (1280×720 to 3840×2160, 1366×768 within 1%): scaled to
//   1920×1080, as the analysis already scales screen recordings (video.ts).
// - Narrower shapes, 5:4 to 16:9 (16:10 such as 1920×1200 or 2560×1600, 4:3):
//   the frame is scaled to 1080 px high, then each surface is cut out and put
//   back at its 1920×1080 place, moved by its anchor: surfaces on the left
//   edge keep their x, centred ones move by half the missing width, those on
//   the right edge by all of it. Everything else stays black.
// - Wider shapes (ultrawide 21:9) and windows under 720 px high: refused.
//
// Both assume the game sizes its interface with the window's height and pins
// each surface to an edge or the centre. Measured only for 1920×1080 so far
// (2026-10-13); every other size is checked on a real game before it is claimed.

export const REFERENCE = { width: 1920, height: 1080 } as const;
export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Anchor = "left" | "center" | "right";
export type AnchoredBox = Box & { anchor: Anchor };

export type Fit =
  | { kind: "keep" }
  | { kind: "scale" }
  | { kind: "relayout"; scaledWidth: number }
  | { kind: "unsupported"; reason: string };

const WIDE = 16 / 9;
const NARROWEST = 5 / 4;
const MIN_HEIGHT = 720;
/** 1366×768 is 0.05% wider than 16:9: such screens are scaled as 16:9. */
const RATIO_TOLERANCE = 0.01;

export function screenFit(size: Size): Fit {
  const { width, height } = size;
  if (width === REFERENCE.width && height === REFERENCE.height) return { kind: "keep" };
  const ratio = width / height;
  if (height < MIN_HEIGHT || ratio > WIDE * (1 + RATIO_TOLERANCE) || ratio < NARROWEST * (1 - RATIO_TOLERANCE))
    return {
      kind: "unsupported",
      reason: `La fenêtre du jeu est en ${width}×${height} : Rekap lit les formats de 5:4 à 16:9 (1920×1080, 2560×1440, 1920×1200, 2560×1600…), au moins 720 px de haut. Les écrans ultra-larges ne sont pas encore pris en charge.`,
    };
  if (Math.abs(ratio / WIDE - 1) <= RATIO_TOLERANCE) return { kind: "scale" };
  // Even width, as yuv420p encoders require.
  return { kind: "relayout", scaledWidth: Math.round((width * REFERENCE.height) / height / 2) * 2 };
}

/** Where a 1920×1080 surface sits in the frame scaled to 1080 px high and `scaledWidth` wide. */
export function sourceBox(box: AnchoredBox, scaledWidth: number): Box {
  const missing = REFERENCE.width - scaledWidth;
  const shift = box.anchor === "left" ? 0 : box.anchor === "right" ? missing : Math.round(missing / 2);
  const x = Math.max(0, box.x - shift);
  return { x, y: box.y, width: Math.min(box.width, scaledWidth - x), height: box.height };
}

/**
 * ffmpeg filter graph from `[0:v]` to `[fit]`: `pre` (such as fps=1) first,
 * then the frame brought to 1920×1080 in `format`. With "relayout", only
 * `surfaces` are kept, at their 1920×1080 places.
 */
export function fitGraph(fit: Fit, surfaces: readonly AnchoredBox[], format: "rgb24" | "yuv444p", pre: string[] = []) {
  const head = ["[0:v]" + [...pre, ...(fit.kind === "scale" ? [`scale=${REFERENCE.width}:${REFERENCE.height}:flags=area`] : []), ...(fit.kind === "relayout" ? [`scale=${fit.scaledWidth}:${REFERENCE.height}:flags=area`] : []), `format=${format}`].join(",")];
  if (fit.kind !== "relayout") return `${head[0]}[fit]`;
  const n = surfaces.length;
  const parts = [`${head[0]},split=${n + 1}[base0]${surfaces.map((_, i) => `[s${i}]`).join("")}`];
  // A black 1920×1080 canvas with the frame's own timing.
  parts.push(`[base0]pad=${REFERENCE.width}:${REFERENCE.height}:0:0,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[b0]`);
  surfaces.forEach((box, i) => {
    const src = sourceBox(box, fit.scaledWidth);
    parts.push(`[s${i}]crop=${src.width}:${src.height}:${src.x}:${src.y}[c${i}]`);
    parts.push(`[b${i}][c${i}]overlay=${box.x}:${box.y}:format=${format === "rgb24" ? "rgb" : "yuv444"}${i === n - 1 ? "[fit]" : `[b${i + 1}]`}`);
  });
  return parts.join(";");
}

/** Width and height from a PNG's header (IHDR), or null for something else. */
export function pngSize(png: Uint8Array): Size | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** ffmpeg arguments bringing a numbered PNG sequence to 1920×1080 into `to`, same numbering. */
export function fitFramesArgs(from: string, to: string, fit: Fit, surfaces: readonly AnchoredBox[]) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", from, "-filter_complex", fitGraph(fit, surfaces, "rgb24"), "-map", "[fit]", "-start_number", "0", to];
}
