// The lock file of the replay queue (queue-lock.ts): taken when a queue
// starts, renewed while it runs, removed when it leaves. Node only.
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { LOCK_BEAT_MS, lockHolder, lockRefusal } from "./queue-lock";

/**
 * Takes the dataset for this process, or throws when a live queue holds it. A
 * lock left by a queue that was killed stops counting after three minutes.
 * `release` removes the lock if it is still this process's.
 */
export function claimQueueLock(lockFile: string, now = () => Date.now()): { release: () => void } {
  let text: string | null = null,
    age: number | null = null;
  try {
    text = readFileSync(lockFile, "utf8");
    age = now() - statSync(lockFile).mtimeMs;
  } catch {}
  const holder = lockHolder(text, age);
  if (holder) throw new Error(lockRefusal(holder, lockFile));
  const mine = `${JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date(now()).toISOString() })}\n`;
  try {
    // Created, not overwritten, when there is none: of two queues started at
    // the same instant only one gets it.
    writeFileSync(lockFile, mine, text === null ? { flag: "wx" } : undefined);
  } catch {
    throw new Error(lockRefusal(lockHolder(readFileSync(lockFile, "utf8"), 0)!, lockFile));
  }
  const beat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(lockFile, t, t);
    } catch {
      // Deleted by hand while this queue runs: taken again rather than run unseen.
      try {
        writeFileSync(lockFile, mine);
      } catch {}
    }
  }, LOCK_BEAT_MS);
  beat.unref();
  return {
    release() {
      clearInterval(beat);
      try {
        if (readFileSync(lockFile, "utf8") === mine) unlinkSync(lockFile);
      } catch {}
    },
  };
}
