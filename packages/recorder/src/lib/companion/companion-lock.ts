// One companion per PC. The app's automation asks for one every 2 s, and a
// companion takes a few seconds to load before it writes status.json: on
// 2026-10-11 two ran at once, each with its own analysis. The status check
// alone could not stop that, so a companion first creates this lock file,
// exclusively; of two started at the same instant only one gets it.
import { readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";

/** A running companion renews its lock this often. */
export const COMPANION_LOCK_BEAT_MS = 15_000;
/** A lock not renewed for this long was left by a companion that is gone. */
export const COMPANION_LOCK_FRESH_MS = 90_000;

type Holder = { pid: number; startedAt: string };

/**
 * Takes the lock, or returns the companion that holds it. A lock whose
 * process is dead, or that was not renewed lately, is taken over at once.
 */
export function claimCompanionLock(
  file: string,
  options: {
    pid?: number;
    now?: () => number;
    isAlive: (pid: number) => boolean;
    ageMs: (file: string) => number | null;
  },
): { holder: Holder } | { release: () => void } {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const mine = `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      const beat = setInterval(() => {
        try {
          const t = new Date(now());
          utimesSync(file, t, t);
        } catch {}
      }, COMPANION_LOCK_BEAT_MS);
      beat.unref?.();
      return {
        release() {
          clearInterval(beat);
          try {
            if (readFileSync(file, "utf8") === mine) unlinkSync(file);
          } catch {}
        },
      };
    } catch {
      // Held: by a live companion, or left behind.
    }
    let holder: Holder | null = null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Holder>;
      if (typeof parsed.pid === "number") holder = { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "unknown") };
    } catch {}
    const age = options.ageMs(file);
    const live = holder !== null && holder.pid !== pid && options.isAlive(holder.pid) && age !== null && age <= COMPANION_LOCK_FRESH_MS;
    if (live) return { holder: holder! };
    // Gone: removed, then created again exclusively, so of two companions
    // taking over the same stale lock only one gets it.
    try {
      unlinkSync(file);
    } catch {}
  }
  return { holder: { pid: 0, startedAt: "unknown" } };
}
