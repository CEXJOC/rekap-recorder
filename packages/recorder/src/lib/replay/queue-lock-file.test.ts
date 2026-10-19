import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCK_FRESH_MS } from "./queue-lock";
import { claimQueueLock } from "./queue-lock-file";

const dirs: string[] = [];
const lockIn = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riftrecall-queue-lock-"));
  dirs.push(dir);
  return path.join(dir, "replay-queue.lock");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the replay queue's lock file", () => {
  it("lets one queue in and keeps a second one out", () => {
    const file = lockIn();
    const first = claimQueueLock(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, host: os.hostname() });
    expect(() => claimQueueLock(file)).toThrow(/Another replay queue is running/);
    // The second one changed nothing.
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    first.release();
    expect(existsSync(file)).toBe(false);
    claimQueueLock(file).release();
  });

  it("takes over a lock that a killed queue left behind", () => {
    const file = lockIn();
    writeFileSync(file, `${JSON.stringify({ pid: 1, host: "gone", startedAt: "2026-10-08T10:07:48.000Z" })}\n`);
    const old = new Date(Date.now() - LOCK_FRESH_MS - 60_000);
    utimesSync(file, old, old);
    const lock = claimQueueLock(file);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("does not remove a lock that is no longer its own", () => {
    const file = lockIn();
    const lock = claimQueueLock(file);
    writeFileSync(file, "another queue's\n");
    lock.release();
    expect(readFileSync(file, "utf8")).toBe("another queue's\n");
  });
});
