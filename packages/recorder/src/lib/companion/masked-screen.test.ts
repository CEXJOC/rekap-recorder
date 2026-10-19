import { describe, expect, it } from "vitest";
import { blackBoxes, keptRegions, maskArgs } from "./masked-screen";

const minimap = { x: 1602, y: 759, width: 304, height: 304 };

describe("masked screen", () => {
  it("keeps the counters, ally portraits, minimap and HUD of a 1920×1080 screen", () => {
    const regions = keptRegions({ width: 1920, height: 1080 }, minimap)!;
    expect(regions.map((r) => r.name)).toEqual(["top", "allies", "minimap", "recall", "hud"]);
    expect(regions.find((r) => r.name === "allies")).toEqual({ name: "allies", x: 1586, y: 613, width: 334, height: 130 });
    // The minimap keeps a margin for analysis to locate it again, inside the screen.
    expect(regions.find((r) => r.name === "minimap")).toEqual({ name: "minimap", x: 1586, y: 743, width: 334, height: 336 });
    for (const r of regions) {
      expect(r.x + r.width).toBeLessThanOrEqual(1920);
      expect(r.y + r.height).toBeLessThanOrEqual(1080);
    }
    // Most of the screen, where the game world is, stays black.
    const kept = regions.reduce((sum, r) => sum + r.width * r.height, 0);
    expect(kept / (1920 * 1080)).toBeLessThan(0.2);
  });

  it("refuses screen sizes it was not measured on", () => {
    expect(keptRegions({ width: 2560, height: 1440 }, minimap)).toBeNull();
    expect(keptRegions({ width: 1920, height: 1200 }, minimap)).toBeNull();
  });

  it("covers exactly what is not kept with black boxes", () => {
    const size = { width: 1920, height: 1080 };
    const regions = keptRegions(size, minimap)!;
    const boxes = blackBoxes(size, regions);
    const inside = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }) =>
      p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
    // Every pixel is either kept or blacked, never both (sampled every 7 px).
    for (let y = 0; y < size.height; y += 7)
      for (let x = 0; x < size.width; x += 7) {
        const kept = regions.some((r) => inside({ x, y }, r));
        const black = boxes.filter((b) => inside({ x, y }, b)).length;
        expect(kept ? black : black - 1, `${x},${y}`).toBe(0);
      }
  });

  it("keeps the frames the analysis reads, one a second, and blacks out the rest, no sound", () => {
    const args = maskArgs("in.mp4", "out.mp4", { width: 1920, height: 1080 }, keptRegions({ width: 1920, height: 1080 }, minimap)!);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph.startsWith("[0:v]fps=1,format=yuv444p[fit];[fit]drawbox=")).toBe(true);
    expect(args[args.indexOf("-map") + 1]).toBe("[out]");
    expect(args[args.indexOf("-r") + 1]).toBe("1");
    expect(args).toContain("-an");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("scales a 16:9 screen of any size to 1920×1080 before masking, like the analysis", () => {
    const regions = keptRegions({ width: 1920, height: 1080 }, minimap)!;
    for (const [width, height] of [[2560, 1440], [3840, 2160], [1600, 900], [1366, 768]]) {
      const args = maskArgs("in.mp4", "out.mp4", { width, height }, regions);
      const graph = args[args.indexOf("-filter_complex") + 1];
      expect(graph.startsWith("[0:v]fps=1,scale=1920:1080:flags=area,format=yuv444p[fit];[fit]drawbox=")).toBe(true);
    }
  });

  it("rebuilds a 16:10 screen surface by surface: right-pinned ones move by the missing width, centred ones by half", () => {
    const regions = keptRegions({ width: 1920, height: 1080 }, minimap)!;
    const args = maskArgs("in.mp4", "out.mp4", { width: 2560, height: 1600 }, regions);
    const graph = args[args.indexOf("-filter_complex") + 1];
    // 2560×1600 at 1080 px high is 1728 px wide: 192 px narrower than 1920.
    expect(graph).toContain("scale=1728:1080:flags=area");
    const hud = regions.find((r) => r.name === "hud")!;
    const top = regions.find((r) => r.name === "top")!;
    expect(graph).toContain(`crop=${hud.width}:${hud.height}:${hud.x - 96}:${hud.y}`);
    expect(graph).toContain(`overlay=${hud.x}:${hud.y}`);
    expect(graph).toContain(`crop=${top.width}:${top.height}:${top.x - 192}:${top.y}`);
  });
});
