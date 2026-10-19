// Where the minimap is on the player's screen, so that the recorder can grab
// only that square (--minimap-only). One full frame is grabbed with the same
// Desktop Duplication source as the recording and searched with the map
// module's terrain locator, the way the replay queue finds it in a replay.
import { spawn } from "node:child_process";
import { locateMinimap } from "../map/perception/locate";
import { crop, decodePng, Raster } from "../map/perception/raster";
import type { CaptureArea } from "./encoder";

/** Below this the best match is not the minimap (as in the replay queue). */
export const MIN_MINIMAP_SCORE = 0.4;

export type MinimapArea = CaptureArea & { score: number };

/** One full frame of a monitor as an RGB PNG on stdout. */
export function buildFrameGrabArgs(monitor: number) {
  return [
    ...["-hide_banner", "-nostats", "-loglevel", "error"],
    ...["-f", "lavfi", "-i"],
    `ddagrab=output_idx=${monitor}:framerate=1:draw_mouse=0,hwdownload,format=bgra`,
    ...["-frames:v", "1", "-pix_fmt", "rgb24", "-c:v", "png"],
    ...["-f", "image2pipe", "-"],
  ];
}

export function grabFrame(ffmpeg: string, monitor: number): Promise<Raster> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, buildFrameGrabArgs(monitor), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !out.length)
        return reject(new Error(`Frame grab failed (${code}): ${error.trim()}`));
      try {
        const png = decodePng(Buffer.concat(out));
        if (png.channels !== 3) throw new Error(`Expected RGB, got ${png.channels} channels.`);
        resolve({ width: png.width, height: png.height, data: png.data });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * The minimap square in screen pixels: searched in the bottom-right of the
 * screen, then in the bottom-left (a minimap flipped to the left in the
 * game's settings). Null when neither match reaches MIN_MINIMAP_SCORE, for
 * example on the loading screen. The size is rounded down to even pixels.
 */
export function minimapArea(frame: Raster): MinimapArea | null {
  const sizes = { minSize: frame.height * 0.12, maxSize: frame.height * 0.6 };
  const top = Math.round(frame.height * 0.35);
  const right = Math.round(frame.width * 0.55);
  const left = Math.round(frame.width * 0.45);
  const searches = [
    { x: right, width: frame.width - right },
    { x: 0, width: left },
  ];
  for (const s of searches) {
    const found = locateMinimap(crop(frame, s.x, top, s.width, frame.height - top), {
      ...sizes,
      offsetX: s.x,
      offsetY: top,
    });
    if (found.score < MIN_MINIMAP_SCORE) continue;
    const size = Math.floor(found.size / 2) * 2;
    return { x: found.x, y: found.y, width: size, height: size, score: found.score };
  }
  return null;
}
