// The game window a replay import records in. Every reader is measured at
// 1920×1080: the import opens the replay in 1920×1080 fullscreen whatever the
// player's own settings, so its frames need no scaling or rebuilding and every
// screen shape (ultrawide included) gets the measured geometry, then puts the
// player's settings back. A screen that cannot show 1920×1080 falls back to
// its own mode, which screen-fit.ts scales (16:9) or rebuilds (16:10 to 5:4).

/** The [General] keys of game.cfg that set the game window. */
export const DISPLAY_KEYS = ["Width", "Height", "WindowMode"] as const;
export type DisplayKey = (typeof DISPLAY_KEYS)[number];
/** Values to set, or null for a key the file did not have. */
export type Display = Record<DisplayKey, string | null>;

/** 1920×1080, fullscreen (WindowMode 0: borderless would take the desktop's size). */
export const REPLAY_DISPLAY: Display = { Width: "1920", Height: "1080", WindowMode: "0" };

function general(lines: string[]) {
  const start = lines.findIndex((l) => l.trim() === "[General]");
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return { start, end };
}

/** The window keys as the file sets them under [General]. */
export function readDisplay(cfg: string): Display {
  const lines = cfg.split(/\r?\n/);
  const section = general(lines);
  const out: Display = { Width: null, Height: null, WindowMode: null };
  if (!section) return out;
  for (const line of lines.slice(section.start + 1, section.end)) {
    const m = /^\s*(Width|Height|WindowMode)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1] as DisplayKey] = m[2];
  }
  return out;
}

/** game.cfg with these window keys under [General] (null removes one); other lines untouched. */
export function withDisplay(cfg: string, display: Display): string {
  const eol = cfg.includes("\r\n") ? "\r\n" : "\n";
  const lines = cfg.split(/\r?\n/);
  let section = general(lines);
  if (!section) {
    const end = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(end, 0, "[General]");
    section = { start: end, end: end + 1 };
  }
  for (const key of DISPLAY_KEYS) {
    const at = lines.findIndex((l, i) => i > section!.start && i < section!.end && new RegExp(`^\s*${key}\s*=`).test(l));
    const value = display[key];
    if (value === null) {
      if (at >= 0) {
        lines.splice(at, 1);
        section.end--;
      }
    } else if (at >= 0) lines[at] = `${key}=${value}`;
    else {
      lines.splice(section.end, 0, `${key}=${value}`);
      section.end++;
    }
  }
  return lines.join(eol);
}

export const sameDisplay = (a: Display, b: Display) => DISPLAY_KEYS.every((k) => a[k] === b[k]);
