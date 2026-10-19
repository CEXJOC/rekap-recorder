import { describe, expect, it } from "vitest";
import { fitFramesArgs, fitGraph, pngSize, screenFit, sourceBox } from "./screen-fit";

const header = (width: number, height: number) => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  return png;
};

describe("screen fit", () => {
  it("reads a PNG header and refuses anything else", () => {
    expect(pngSize(header(2560, 1440))).toEqual({ width: 2560, height: 1440 });
    expect(pngSize(new Uint8Array(40))).toBeNull();
  });

  it("keeps 1080p, scales 16:9, rebuilds 16:10 to 5:4 and refuses ultrawide or tiny windows", () => {
    expect(screenFit({ width: 1920, height: 1080 })).toEqual({ kind: "keep" });
    for (const [width, height] of [[2560, 1440], [3840, 2160], [1600, 900], [1366, 768], [1280, 720]])
      expect(screenFit({ width, height }).kind, `${width}×${height}`).toBe("scale");
    expect(screenFit({ width: 1920, height: 1200 })).toEqual({ kind: "relayout", scaledWidth: 1728 });
    expect(screenFit({ width: 2560, height: 1600 })).toEqual({ kind: "relayout", scaledWidth: 1728 });
    expect(screenFit({ width: 1680, height: 1050 })).toEqual({ kind: "relayout", scaledWidth: 1728 });
    expect(screenFit({ width: 1440, height: 1080 })).toEqual({ kind: "relayout", scaledWidth: 1440 });
    expect(screenFit({ width: 1280, height: 1024 })).toEqual({ kind: "relayout", scaledWidth: 1350 });
    for (const [width, height] of [[3440, 1440], [2560, 1080], [1024, 576], [1280, 1080]])
      expect(screenFit({ width, height }).kind, `${width}×${height}`).toBe("unsupported");
  });

  it("moves each surface by its anchor", () => {
    const box = { x: 1600, y: 760, width: 320, height: 320 };
    expect(sourceBox({ ...box, anchor: "right" }, 1728)).toEqual({ ...box, x: 1408 });
    expect(sourceBox({ ...box, x: 460, width: 1000, anchor: "center" }, 1728)).toEqual({ ...box, x: 364, width: 1000 });
    expect(sourceBox({ ...box, x: 0, width: 90, anchor: "left" }, 1728)).toEqual({ ...box, x: 0, width: 90 });
  });

  it("builds a black 1920×1080 canvas with only the surfaces for a rebuilt frame", () => {
    const graph = fitGraph({ kind: "relayout", scaledWidth: 1728 }, [{ x: 0, y: 132, width: 90, height: 508, anchor: "left" }, { x: 1830, y: 132, width: 90, height: 508, anchor: "right" }], "rgb24");
    expect(graph).toContain("scale=1728:1080:flags=area,format=rgb24,split=3");
    expect(graph).toContain("pad=1920:1080:0:0,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[b0]");
    expect(graph).toContain("[s1]crop=90:508:1638:132[c1]");
    expect(graph.endsWith("[b1][c1]overlay=1830:132:format=rgb[fit]")).toBe(true);
    expect(fitFramesArgs("a/%06d.png", "b/%06d.png", { kind: "scale" }, []).slice(-5)).toEqual(["-map", "[fit]", "-start_number", "0", "b/%06d.png"]);
  });
});
