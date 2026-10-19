import { describe, expect, it } from "vitest";
import { readDisplay, REPLAY_DISPLAY, sameDisplay, withDisplay } from "./replay-display";

const cfg = "[General]\r\nEnableReplayApi=1\r\nHeight=1440\r\nWidth=2560\r\nWindowMode=2\r\n[HUD]\r\nWidth=7\r\n";

describe("replay display", () => {
  it("reads the window keys of [General] only", () => {
    expect(readDisplay(cfg)).toEqual({ Width: "2560", Height: "1440", WindowMode: "2" });
    expect(readDisplay("[HUD]\nWidth=3\n")).toEqual({ Width: null, Height: null, WindowMode: null });
  });

  it("sets 1920×1080 fullscreen and puts the player's settings back, other lines untouched", () => {
    const forced = withDisplay(cfg, REPLAY_DISPLAY);
    expect(readDisplay(forced)).toEqual(REPLAY_DISPLAY);
    expect(forced).toContain("EnableReplayApi=1\r\n");
    expect(forced).toContain("[HUD]\r\nWidth=7");
    expect(withDisplay(forced, readDisplay(cfg))).toBe(cfg);
  });

  it("adds missing keys, and removes them again when the player had none", () => {
    const bare = "[General]\nEnableReplayApi=1\n[HUD]\n";
    const forced = withDisplay(bare, REPLAY_DISPLAY);
    expect(forced).toBe("[General]\nEnableReplayApi=1\nWidth=1920\nHeight=1080\nWindowMode=0\n[HUD]\n");
    expect(withDisplay(forced, readDisplay(bare))).toBe(bare);
    expect(readDisplay(withDisplay("", REPLAY_DISPLAY))).toEqual(REPLAY_DISPLAY);
    expect(sameDisplay(readDisplay(forced), REPLAY_DISPLAY)).toBe(true);
  });
});
