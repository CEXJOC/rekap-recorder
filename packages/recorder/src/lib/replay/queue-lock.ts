// One replay queue per dataset folder. Two of them take the same League
// client and delete each other's frames (a team PC, 2026-10-08: a catch-up
// run from a sandboxed session could not list the PC's processes and started
// a second one). A queue writes DATASET_ROOT/replay-queue.lock when it starts
// and renews it while it runs: whoever can read the folder can tell that a
// queue is alive, without listing processes. Pure: the file is read and
// written in scripts/replay/replay-queue.ts.

/** A running queue renews its lock this often. */
export const LOCK_BEAT_MS = 30_000;
/** A lock not renewed for this long was left by a queue that is gone. */
export const LOCK_FRESH_MS = 180_000;

export type QueueLock = { pid: number; host: string; startedAt: string };

/**
 * The queue that holds the lock, or null when none is alive: no file, or a
 * file that was last renewed `ageMs` ago, too long for a running queue. A
 * fresh file that cannot be read still stands for a queue (it is being
 * written).
 */
export function lockHolder(text: string | null, ageMs: number | null): QueueLock | null {
  if (text === null || ageMs === null || ageMs > LOCK_FRESH_MS) return null;
  const unknown = { pid: 0, host: "unknown", startedAt: "unknown" };
  try {
    const lock = JSON.parse(text) as Partial<QueueLock>;
    return typeof lock.pid === "number" && typeof lock.host === "string" && typeof lock.startedAt === "string"
      ? { pid: lock.pid, host: lock.host, startedAt: lock.startedAt }
      : unknown;
  } catch {
    return unknown;
  }
}

/** What a queue that finds a live one says before it leaves. */
export const lockRefusal = (holder: QueueLock, file: string) =>
  `Another replay queue is running on this dataset (process ${holder.pid} on ${holder.host}, started ${holder.startedAt}). Stop it first, or delete ${file} if it is gone.`;
