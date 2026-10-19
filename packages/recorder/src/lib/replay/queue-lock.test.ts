import { describe, expect, it } from "vitest";
import { LOCK_BEAT_MS, LOCK_FRESH_MS, lockHolder, lockRefusal } from "./queue-lock";

const lock = JSON.stringify({ pid: 72004, host: "PC-1", startedAt: "2026-10-08T10:07:48.000Z" });

describe("one replay queue per dataset", () => {
  it("finds a running queue by a lock renewed lately", () => {
    expect(lockHolder(lock, 5_000)).toEqual({ pid: 72004, host: "PC-1", startedAt: "2026-10-08T10:07:48.000Z" });
    expect(lockHolder(lock, LOCK_FRESH_MS)).not.toBeNull();
    // Several beats may be missed (a busy disk) before the queue counts as gone.
    expect(LOCK_FRESH_MS).toBeGreaterThanOrEqual(4 * LOCK_BEAT_MS);
  });

  it("lets a new queue start when there is no lock or its queue is gone", () => {
    expect(lockHolder(null, null)).toBeNull();
    expect(lockHolder(lock, LOCK_FRESH_MS + 1)).toBeNull();
    expect(lockHolder(lock, 3_600_000)).toBeNull();
  });

  it("still sees a queue behind a fresh lock that cannot be read", () => {
    // Half-written, or from a later version: starting a second queue is the worse mistake.
    expect(lockHolder("{", 1_000)).toMatchObject({ pid: 0 });
    expect(lockHolder('{"pid":"x"}', 1_000)).toMatchObject({ host: "unknown" });
  });

  it("says which queue holds the dataset and how to free it", () => {
    const text = lockRefusal(lockHolder(lock, 0)!, "D:/data/replay-queue.lock");
    expect(text).toMatch(/process 72004 on PC-1/);
    expect(text).toMatch(/delete D:\/data\/replay-queue\.lock/);
  });
});
