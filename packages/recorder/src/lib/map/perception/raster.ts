import { deflateSync, inflateSync } from "node:zlib";

// Interleaved 8-bit RGB pixels, the same layout as src/lib/reviews/hud.ts.
export type Raster = { width: number; height: number; data: Uint8Array };
// Interleaved float channels (1 = gray, 3 = RGB, 4 = RGBA).
export type FloatImage = {
  width: number;
  height: number;
  channels: number;
  data: Float32Array;
};

export function blank(width: number, height: number, rgb = [0, 0, 0]): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) data.set(rgb, p * 3);
  return { width, height, data };
}

export function crop(
  r: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
): Raster {
  const out = blank(width, height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= r.height) continue;
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= r.width) continue;
      const s = (sy * r.width + sx) * 3,
        d = (row * width + col) * 3;
      out.data[d] = r.data[s];
      out.data[d + 1] = r.data[s + 1];
      out.data[d + 2] = r.data[s + 2];
    }
  }
  return out;
}

export function toFloat(r: Raster): FloatImage {
  return {
    width: r.width,
    height: r.height,
    channels: 3,
    data: Float32Array.from(r.data),
  };
}
export function toRaster(img: FloatImage): Raster {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let p = 0; p < img.width * img.height; p++)
    for (let c = 0; c < 3; c++) {
      const v = img.data[p * img.channels + Math.min(c, img.channels - 1)];
      out[p * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  return { width: img.width, height: img.height, data: out };
}
export function gray(r: Raster | FloatImage): FloatImage {
  const channels = "channels" in r ? r.channels : 3;
  const n = r.width * r.height;
  const data = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * channels;
    data[p] =
      channels >= 3
        ? 0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2]
        : r.data[i];
  }
  return { width: r.width, height: r.height, channels: 1, data };
}

// Area (box) resampling with fractional pixel coverage, separable.
export function resample(
  img: FloatImage,
  width: number,
  height: number,
): FloatImage {
  const { channels: ch } = img;
  const horizontal = boxWeights(img.width, width);
  const vertical = boxWeights(img.height, height);
  const tmp = new Float32Array(width * img.height * ch);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < width; x++) {
      const { start, weights } = horizontal[x];
      for (let c = 0; c < ch; c++) {
        let total = 0;
        for (let k = 0; k < weights.length; k++)
          total += img.data[(y * img.width + start + k) * ch + c] * weights[k];
        tmp[(y * width + x) * ch + c] = total;
      }
    }
  const out = new Float32Array(width * height * ch);
  for (let y = 0; y < height; y++) {
    const { start, weights } = vertical[y];
    for (let x = 0; x < width; x++)
      for (let c = 0; c < ch; c++) {
        let total = 0;
        for (let k = 0; k < weights.length; k++)
          total += tmp[((start + k) * width + x) * ch + c] * weights[k];
        out[(y * width + x) * ch + c] = total;
      }
  }
  return { width, height, channels: ch, data: out };
}
function boxWeights(from: number, to: number) {
  const scale = from / to;
  return Array.from({ length: to }, (_, i) => {
    let a = i * scale,
      b = (i + 1) * scale;
    if (scale < 1) {
      // Upsampling: linear interpolation between the two nearest pixels.
      const centre = Math.min(from - 1, Math.max(0, (i + 0.5) * scale - 0.5));
      const start = Math.min(from - 2, Math.floor(centre));
      if (start < 0) return { start: 0, weights: [1] };
      const f = centre - start;
      return { start, weights: [1 - f, f] };
    }
    a = Math.max(0, a);
    b = Math.min(from, b);
    const start = Math.floor(a);
    const weights: number[] = [];
    for (let p = start; p < b; p++)
      weights.push((Math.min(p + 1, b) - Math.max(p, a)) / (b - a));
    return { start, weights };
  });
}

// Per-pixel median over frames of identical size (moving icons disappear).
export function medianImage(frames: Raster[]): Raster {
  const { width, height } = frames[0];
  const n = width * height * 3;
  const out = new Uint8Array(n);
  const values = new Uint8Array(frames.length);
  const half = frames.length >> 1;
  if (frames.length > 40) {
    const counts = new Uint16Array(256);
    for (let i = 0; i < n; i++) {
      counts.fill(0);
      for (let f = 0; f < frames.length; f++) counts[frames[f].data[i]]++;
      let seen = 0,
        v = 0;
      for (; v < 255; v++) {
        seen += counts[v];
        if (seen > half) break;
      }
      out[i] = v;
    }
    return { width, height, data: out };
  }
  for (let i = 0; i < n; i++) {
    // Insertion sort for small frame counts.
    for (let f = 0; f < frames.length; f++) {
      const v = frames[f].data[i];
      let j = f;
      while (j > 0 && values[j - 1] > v) {
        values[j] = values[j - 1];
        j--;
      }
      values[j] = v;
    }
    out[i] = values[half];
  }
  return { width, height, data: out };
}

export function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h = 0;
  if (d > 0) {
    h =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}
export function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Minimal PNG codec (8-bit gray/RGB/RGBA, non-interlaced) so assets and
// overlays need no image dependency.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
export function encodePng(
  width: number,
  height: number,
  data: Uint8Array,
  channels: 1 | 3 | 4 = 3,
): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter 1 (Sub) compresses smooth images better than no filter.
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i];
      const left = i >= channels ? data[y * stride + i - channels] : 0;
      raw[row + 1 + i] = (v - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}
export const rasterPng = (r: Raster) => encodePng(r.width, r.height, r.data);

export function decodePng(buffer: Uint8Array): {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
} {
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.length);
  if (view.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG file.");
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0;
  const idat: Buffer[] = [];
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("ascii", offset + 4, offset + 8);
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (depth !== 8 || !channels || interlace)
        throw new Error("Only 8-bit non-interlaced PNGs are supported.");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? data[y * stride + i - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + i] : 0;
      const c =
        y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

// Debug drawing helpers for overlays.
export function drawCircle(
  img: Raster,
  cx: number,
  cy: number,
  r: number,
  rgb: [number, number, number],
  dashed = false,
) {
  const steps = Math.max(24, Math.round(2 * Math.PI * r * 1.5));
  for (let i = 0; i < steps; i++) {
    if (dashed && i % 6 >= 3) continue;
    const a = (2 * Math.PI * i) / steps;
    const x = Math.round(cx + r * Math.cos(a)),
      y = Math.round(cy + r * Math.sin(a));
    if (x >= 0 && y >= 0 && x < img.width && y < img.height)
      img.data.set(rgb, (y * img.width + x) * 3);
  }
}
export function drawLine(
  img: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps),
      y = Math.round(y0 + ((y1 - y0) * i) / steps);
    if (x >= 0 && y >= 0 && x < img.width && y < img.height)
      img.data.set(rgb, (y * img.width + x) * 3);
  }
}
export function upscale(img: Raster, factor: number): Raster {
  const out = blank(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s =
        (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 3;
      out.data.set(img.data.subarray(s, s + 3), (y * out.width + x) * 3);
    }
  return out;
}
