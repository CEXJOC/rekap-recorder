import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePng, FloatImage, gray, Raster, resample } from "./raster";

// Minimap location by multi-scale normalized cross-correlation of a terrain
// reference against a temporal median of the bottom-right of the screen.
// The reference (assets/minimap-reference.png, 192 px gray) is Data Dragon's
// Summoner's Rift minimap (cdn/16.18.1/img/map/map11.png, a Riot asset the
// developer policies allow; the Community Dragon texture it replaced on
// 2026-10-13 gave the same square on 58/58 live and replay frames): walls are black and paths light in the texture and on screen,
// whatever the team colours, fog of war or HUD frame. The texture square is
// the whole minimap square, so the match gives the 0..1 coordinate frame.

export type MinimapRect = { x: number; y: number; size: number };
export type LocateResult = MinimapRect & { score: number };

let reference: FloatImage | null = null;
export function minimapReference(): FloatImage {
  if (!reference) {
    const png = decodePng(
      readFileSync(
        fileURLToPath(
          new URL("../assets/minimap-reference.png", import.meta.url),
        ),
      ),
    );
    reference = {
      width: png.width,
      height: png.height,
      channels: 1,
      data: Float32Array.from(
        png.data.filter((_, i) => i % png.channels === 0),
      ),
    };
  }
  return reference;
}

// Summed-area tables for window mean/variance.
function integrals(img: FloatImage) {
  const W = img.width + 1;
  const s = new Float64Array(W * (img.height + 1)),
    q = new Float64Array(W * (img.height + 1));
  for (let y = 0; y < img.height; y++) {
    let a = 0,
      b = 0;
    for (let x = 0; x < img.width; x++) {
      const v = img.data[y * img.width + x];
      a += v;
      b += v * v;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + a;
      q[(y + 1) * W + x + 1] = q[y * W + x + 1] + b;
    }
  }
  const box = (t: Float64Array, x: number, y: number, n: number) =>
    t[(y + n) * W + x + n] -
    t[y * W + x + n] -
    t[(y + n) * W + x] +
    t[y * W + x];
  return {
    sum: (x: number, y: number, n: number) => box(s, x, y, n),
    sq: (x: number, y: number, n: number) => box(q, x, y, n),
  };
}
type Prepared = { size: number; values: Float32Array; norm: number };
function prepare(ref: FloatImage, size: number): Prepared {
  const t = resample(ref, size, size);
  let mean = 0;
  for (const v of t.data) mean += v;
  mean /= t.data.length;
  let norm = 0;
  const values = Float32Array.from(t.data, (v) => v - mean);
  for (const v of values) norm += v * v;
  return { size, values, norm: Math.sqrt(norm) };
}
function scoreAt(
  img: FloatImage,
  ii: ReturnType<typeof integrals>,
  t: Prepared,
  x: number,
  y: number,
) {
  const n = t.size;
  if (x < 0 || y < 0 || x + n > img.width || y + n > img.height) return -1;
  let cross = 0;
  for (let v = 0; v < n; v++) {
    const row = (y + v) * img.width + x,
      trow = v * n;
    for (let u = 0; u < n; u++) cross += img.data[row + u] * t.values[trow + u];
  }
  const s = ii.sum(x, y, n),
    variance = ii.sq(x, y, n) - (s * s) / (n * n);
  return variance > 1e-6 ? cross / (Math.sqrt(variance) * t.norm) : -1;
}

// `image`: static (median) RGB image of the search region; offsets map the
// result back to frame coordinates. Sizes are in image pixels.
export function locateMinimap(
  image: Raster,
  options: {
    minSize: number;
    maxSize: number;
    offsetX?: number;
    offsetY?: number;
  },
  ref: FloatImage = minimapReference(),
): LocateResult {
  const base = gray(image);
  const coarse = 8;
  const levels = [coarse, 4, 2, 1].map((k) =>
    k === 1
      ? base
      : resample(base, Math.floor(base.width / k), Math.floor(base.height / k)),
  );
  const tables = levels.map(integrals);
  // Coarse: every position, sizes in ~3% steps.
  const img = levels[0],
    ii = tables[0];
  let candidates: { x: number; y: number; size: number; score: number }[] = [];
  const maxCoarse = Math.min(
    img.width,
    img.height,
    Math.floor(options.maxSize / coarse),
  );
  for (
    let s = Math.max(8, Math.ceil(options.minSize / coarse));
    s <= maxCoarse;
    s = Math.max(s + 1, Math.round(s * 1.03))
  ) {
    const t = prepare(ref, s);
    for (let y = 0; y + s <= img.height; y++)
      for (let x = 0; x + s <= img.width; x++) {
        const score = scoreAt(img, ii, t, x, y);
        if (score > 0.2) candidates.push({ x, y, size: s, score });
      }
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (
      kept.some(
        (k) =>
          Math.abs(k.x - c.x) < 3 &&
          Math.abs(k.y - c.y) < 3 &&
          Math.abs(k.size - c.size) <= 3,
      )
    )
      continue;
    kept.push(c);
    if (kept.length >= 6) break;
  }
  if (!kept.length) throw new Error("No minimap-like region found.");
  // Refine each candidate down the pyramid (positions ±2, sizes ±3%).
  for (let level = 1; level < levels.length; level++) {
    const k = [coarse, 4, 2, 1][level],
      ratio = [coarse, 4, 2, 1][level - 1] / k;
    const cache = new Map<number, Prepared>();
    const tpl = (s: number) => {
      let t = cache.get(s);
      if (!t) cache.set(s, (t = prepare(ref, s)));
      return t;
    };
    candidates = kept.map((c) => {
      let best = { ...c, score: -2 };
      const cx = c.x * ratio,
        cy = c.y * ratio,
        cs = c.size * ratio;
      const sizes = new Set<number>();
      for (let f = -3; f <= 3; f++)
        sizes.add(Math.round(cs * (1 + f * 0.01 * (level === 1 ? 2 : 1))));
      for (const s of sizes) {
        const t = tpl(s);
        const off = Math.round((cs - s) / 2);
        for (let dy = -2 - level; dy <= 2 + level; dy++)
          for (let dx = -2 - level; dx <= 2 + level; dx++) {
            const x = Math.round(cx) + off + dx,
              y = Math.round(cy) + off + dy;
            const score = scoreAt(levels[level], tables[level], t, x, y);
            if (score > best.score) best = { x, y, size: s, score };
          }
      }
      return best;
    });
    kept.splice(
      0,
      kept.length,
      ...candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, level < 3 ? 3 : 1),
    );
  }
  const best = kept[0];
  return {
    x: best.x + (options.offsetX ?? 0),
    y: best.y + (options.offsetY ?? 0),
    size: best.size,
    score: best.score,
  };
}
