// Cooldown reader for the selected player's panel (player.mp4, written by the
// replay queue). For each frame and each slot of the ability row (passive, Q,
// W, E, R, and the summoner spells on D and F) it tells whether the slot is
// ready, on cooldown or unavailable, and from those frames each cooldown:
// when it started (the cast) and when it ended. Measured on EUW1_8004857210
// (Aatrox, 1,923 frames, 2026-10-05); doc/REPLAY.md, "Per game".
import type { Raster } from "../map/perception/raster";
import type { Box } from "./queue";

// 0.2 (2026-10-08): the row is found from the panel's bottom edge
// (panelOrigin); 0.1 files read it 27 px off on some recordings.
// 0.3 (2026-10-08): h in the Flash slot of a player who took Hextech
// Flashtraption (HEXFLASH_RUNE): 0.2 read Hexflash ready as Flash ready.
// 0.4: withhold unconfirmed Flash art during Hexflash charging/return;
// reject incomplete panel geometry instead of reading partial icons.
export const COOLDOWNS_VERSION = "cooldowns-0.4" as const;
export const SLOTS = ["P", "Q", "W", "E", "R", "D", "F"] as const;
export type Slot = (typeof SLOTS)[number];

/** Side of an ability icon at 1920×1080 with the interface scale at 1. */
export const ICON = 32;
/**
 * Height of the panel's frame at 1920×1080. The area the queue finds changing
 * with the selection is taller when buff icons sit above the frame (133 to
 * 187 px on 68 recordings, 2026-10-08), and its bottom edge never moves: the
 * frame is its bottom 133 px.
 */
export const PANEL_HEIGHT = 133;
/**
 * The frame's top-left corner inside the recorded crop `box`, from the area
 * that changed with the selection. Until 2026-10-08 the top of that area was
 * taken: right with one row of buffs above the frame only, and every slot was
 * read 27 px off on the 12 of 68 recordings with none or two.
 */
export function panelOrigin(changed: Box, box: Box) {
  return {
    x: changed.x - box.x,
    y: changed.y + changed.height - PANEL_HEIGHT - box.y,
  };
}
/** Top-left corners of the icons, relative to the frame's top-left corner (panelOrigin). */
export const SLOT_ICONS: Record<Slot, { x: number; y: number }> = {
  P: { x: 16, y: 87 },
  Q: { x: 54, y: 87 },
  W: { x: 93, y: 87 },
  E: { x: 131, y: 87 },
  R: { x: 170, y: 87 },
  D: { x: 220, y: 87 },
  F: { x: 257, y: 87 },
};
/**
 * Parts of the frame that never change (the stat icons, the top border),
 * relative to its top-left corner: a frame without the panel differs there.
 */
export const PANEL_CHROME: Box[] = [
  { x: 178, y: 13, width: 22, height: 60 },
  { x: 10, y: 1, width: 280, height: 5 },
];

/**
 * A slot is ready when its icon is in colour: ready icons measured 71 to 130
 * (mean max − min channel), every greyed icon 0 to 1.
 */
export const READY_COLOUR = 25;
/**
 * A greyed icon is on cooldown when it shows the seconds left in white: 19 to
 * 84 such pixels in the icon's middle band, against 0 without a number (not
 * learned yet, dead, or the first seconds of the game).
 */
export const NUMBER_PIXELS = 10;
/** Mean gray difference to the panel's own chrome: 4.3 with the panel, 18.7 without. */
export const MISSING_PANEL = 14;

/**
 * r: ready, c: on cooldown, -: unavailable (greyed, no number), ?: no panel,
 * h: the Flash slot shows Hexflash, ready: Flash itself is on cooldown.
 */
export type SlotState = "r" | "c" | "-" | "?" | "h";
/** Riot's rune ID of Hextech Flashtraption: while Flash is on cooldown its slot holds Hexflash. */
export const HEXFLASH_RUNE = 8306;
/**
 * The two icons by the hue of their middle when ready (degrees): Flash 55 to
 * 60 on 2,065 frames of two players, Hexflash 20 to 25 on 615 frames of one,
 * nothing between (2026-10-08).
 */
export const HEXFLASH_HUE_BELOW = 40;
/** Charging can display Flash art for two seconds in the native development
 * packet. Require a longer uninterrupted current-art run; gaps reset it. */
export const FLASH_READY_CONFIRM_SECONDS = 3;
/** The slot that holds Flash for a player who took the rune, or null. */
export function hexflashSlot(
  runes: number[],
  spellD?: number | null,
  spellF?: number | null,
): "D" | "F" | null {
  if (!runes.includes(HEXFLASH_RUNE)) return null;
  return spellD === 4 ? "D" : spellF === 4 ? "F" : null;
}

const luma = (r: Raster, i: number) =>
  0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2];

export type SlotFeatures = {
  colour: number;
  numberPixels: number;
  hue: number;
};

/**
 * Colour strength and hue (degrees, -1 without colour) of the icon's middle
 * 20×20 px, and the white, colourless pixels of its middle band, where the
 * seconds left are written.
 */
export function slotFeatures(
  frame: Raster,
  icon: { x: number; y: number },
): SlotFeatures {
  let colour = 0,
    n = 0,
    numberPixels = 0;
  const sum = [0, 0, 0];
  for (let y = icon.y + 2; y < icon.y + ICON - 2; y++)
    for (let x = icon.x + 2; x < icon.x + ICON - 2; x++) {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const i = (y * frame.width + x) * 3;
      const max = Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
      const min = Math.min(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
      if (
        y >= icon.y + 6 &&
        y < icon.y + ICON - 6 &&
        x >= icon.x + 6 &&
        x < icon.x + ICON - 6
      ) {
        colour += max - min;
        n++;
        for (let c = 0; c < 3; c++) sum[c] += frame.data[i + c];
      }
      const bright =
        (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3 > 190;
      if (bright && max - min < 45 && y >= icon.y + 9 && y < icon.y + 23)
        numberPixels++;
    }
  return {
    colour: n ? colour / n : 0,
    numberPixels,
    hue: n ? hueOf(sum[0] / n, sum[1] / n, sum[2] / n) : -1,
  };
}

function hueOf(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max - min < 1) return -1;
  const h =
    max === r
      ? ((g - b) / (max - min)) % 6
      : max === g
        ? (b - r) / (max - min) + 2
        : (r - g) / (max - min) + 4;
  return (h * 60 + 360) % 360;
}

export function slotState(f: SlotFeatures): Exclude<SlotState, "?"> {
  if (f.colour >= READY_COLOUR) return "r";
  return f.numberPixels >= NUMBER_PIXELS ? "c" : "-";
}

/** Whether a frame shows the panel: its chrome matches the reference frame's. */
export function showsPanelChrome(
  frame: Raster,
  reference: Raster,
  origin: { x: number; y: number },
) {
  if (
    frame.width !== reference.width ||
    frame.height !== reference.height ||
    !Number.isInteger(origin.x) ||
    !Number.isInteger(origin.y) ||
    PANEL_CHROME.some(
      (a) =>
        origin.x + a.x < 0 ||
        origin.y + a.y < 0 ||
        origin.x + a.x + a.width > frame.width ||
        origin.y + a.y + a.height > frame.height,
    )
  )
    return false;
  let sum = 0,
    n = 0;
  for (const a of PANEL_CHROME)
    for (let y = origin.y + a.y; y < origin.y + a.y + a.height; y++)
      for (let x = origin.x + a.x; x < origin.x + a.x + a.width; x++) {
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
        const i = (y * frame.width + x) * 3;
        sum += Math.abs(luma(frame, i) - luma(reference, i));
        n++;
      }
  return n > 0 && sum / n < MISSING_PANEL;
}

/**
 * The state of every slot in one frame of player.mp4. `hexflash` is the slot
 * that holds Flash when the player took Hextech Flashtraption (hexflashSlot):
 * ready in Hexflash's colours, it reads h.
 */
export function frameStates(
  frame: Raster,
  reference: Raster,
  origin: { x: number; y: number },
  hexflash: Slot | null = null,
): Record<Slot, SlotState> {
  const shown = showsPanelChrome(frame, reference, origin);
  const read = (s: Slot): SlotState => {
    const icon = {
      x: origin.x + SLOT_ICONS[s].x,
      y: origin.y + SLOT_ICONS[s].y,
    };
    if (
      icon.x < 0 ||
      icon.y < 0 ||
      icon.x + ICON > frame.width ||
      icon.y + ICON > frame.height
    )
      return "?";
    const f = slotFeatures(frame, icon);
    const state = slotState(f);
    return s === hexflash &&
      state === "r" &&
      f.hue >= 0 &&
      f.hue < HEXFLASH_HUE_BELOW
      ? "h"
      : state;
  };
  return Object.fromEntries(
    SLOTS.map((s) => [s, shown ? read(s) : "?"]),
  ) as Record<Slot, SlotState>;
}

/** Current native states with conservative Flash return confirmation for the
 * known Hexflash slot. This never holds readiness across a missing panel, uses
 * a later frame or fills a missing frame. Unconfirmed art is unknown. */
export function createCooldownFrameReader(
  reference: Raster,
  origin: { x: number; y: number },
  hexflash: "D" | "F" | null,
  fps: number,
) {
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error("Invalid cooldown frame rate.");
  let previous = -Infinity,
    readySince: number | null = null;
  return (frame: Raster, videoTime: number): Record<Slot, SlotState> => {
    if (!Number.isFinite(videoTime) || videoTime < 0 || videoTime <= previous)
      throw new Error("Cooldown frames must be ordered.");
    const contiguous = Math.abs(videoTime - previous - 1 / fps) < 0.001;
    previous = videoTime;
    const states = frameStates(frame, reference, origin, hexflash);
    if (hexflash) {
      if (states[hexflash] !== "r") readySince = null;
      else {
        if (!contiguous || readySince === null) readySince = videoTime;
        if (videoTime - readySince < FLASH_READY_CONFIRM_SECONDS)
          states[hexflash] = "?";
      }
    }
    return states;
  };
}

export type CooldownEpisode = {
  /** Game second of the first frame on cooldown. */
  start: number;
  /**
   * Game second of the last frame seen off cooldown before it: the cast lies
   * in (castAfter, start]. Null when the cooldown runs from the start of the
   * recording (the summoner spells are locked for the first seconds).
   */
  castAfter: number | null;
  /** Game second of the last frame on cooldown. */
  last: number;
  /**
   * Game second of the first frame seen off cooldown after it: the cooldown
   * ended in (last, end]. Null when the recording ends first.
   */
  end: number | null;
};

/**
 * Cooldowns of one slot from its states (one character per frame, frame i at
 * game second i / fps). Frames without the panel inside a cooldown belong to
 * it; they never start or end one. Hexflash in the Flash slot (h) is Flash on
 * cooldown: the episode runs until Flash readiness is confirmed. That end
 * includes the confirmation delay and any panel gap; it is an upper bound,
 * not an exact return time.
 */
export function cooldownEpisodes(
  states: string,
  fps: number,
): CooldownEpisode[] {
  const episodes: CooldownEpisode[] = [];
  let open: CooldownEpisode | null = null;
  let lastOff: number | null = null;
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s === "?") continue;
    if (s === "c" || s === "h") {
      if (open) open.last = i / fps;
      else
        open = {
          start: i / fps,
          castAfter: lastOff === null ? null : lastOff / fps,
          last: i / fps,
          end: null,
        };
      continue;
    }
    if (open) {
      open.end = i / fps;
      episodes.push(open);
      open = null;
    }
    lastOff = i;
  }
  if (open) episodes.push(open);
  return episodes;
}

/**
 * Seconds of cooldown left at game second t, from the episode it falls in, or
 * null when the slot is not on cooldown then (or the end is not recorded).
 */
export function cooldownLeft(
  episodes: CooldownEpisode[],
  t: number,
): number | null {
  const e = episodes.find((e) => e.start <= t && t <= e.last);
  return e && e.end !== null ? e.end - t : null;
}

/**
 * Why a recording's rows cannot be right, or null. A summoner spell is ready
 * at some point of every game; a slot that never is was read in the wrong
 * place (all 12 recordings read 27 px off before 2026-10-08 fail this, and
 * none of the 68 does since). It is no proof that the rest is right.
 */
export function rowProblem(
  states: Pick<Record<Slot, string>, "D" | "F">,
): string | null {
  const never = (["D", "F"] as const).filter((s) => !states[s].includes("r"));
  return never.length
    ? `summoner spell ${never.join(" and ")} never reads ready`
    : null;
}

/** Riot's summoner spell IDs (match-v5 summoner1Id on D, summoner2Id on F). */
export const SUMMONER_SPELLS: Record<number, string> = {
  1: "Cleanse",
  3: "Exhaust",
  4: "Flash",
  6: "Ghost",
  7: "Heal",
  11: "Smite",
  12: "Teleport",
  13: "Clarity",
  14: "Ignite",
  21: "Barrier",
  32: "Mark",
};
