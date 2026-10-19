import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStopRequest, isStaleControl } from "./control";
import {
  CompanionStatus,
  companionStatusSchema,
  initialStatus,
  runningInstance,
  StatusWriter,
  writeJsonAtomic,
} from "./status";

describe("status writer", () => {
  let writes: CompanionStatus[];
  const T0 = Date.parse("2026-10-03T12:00:00.000Z");
  // Fake timers also drive Date.now, the writer's default clock.
  const make = () =>
    new StatusWriter("status.json", initialStatus(4242, T0), {
      write: (_path, value) => writes.push(value),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    writes = [];
  });
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => vi.advanceTimersByTime(ms);

  it("writes at most once per second and never drops the latest change", () => {
    const status = make();
    status.update({ state: "recording", session: "S1", champion: "Annie" });
    expect(writes).toHaveLength(1);
    advance(100);
    status.update({ gameTime: 10 });
    advance(100);
    status.update({ gameTime: 11 });
    expect(writes).toHaveLength(1); // throttled
    advance(800);
    expect(writes).toHaveLength(2); // deferred write with the newest values
    expect(writes[1]).toMatchObject({ state: "recording", gameTime: 11 });
    expect(writes[1].updatedAt).toBe("2026-10-03T12:00:01.000Z");
  });

  it("refreshes updatedAt by heartbeat while nothing changes", () => {
    const status = make();
    status.start();
    advance(5000);
    expect(writes.length).toBeGreaterThanOrEqual(5);
    const ages = writes.map((w) => Date.parse(w.updatedAt) - T0);
    for (let i = 1; i < ages.length; i++)
      expect(ages[i] - ages[i - 1]).toBeLessThanOrEqual(2000);
    expect(writes.every((w) => w.state === "waiting" && w.pid === 4242)).toBe(
      true,
    );
    status.close();
  });

  it("writes the final state immediately on close and stops the heartbeat", () => {
    const status = make();
    status.start();
    advance(200);
    status.close({ state: "stopped" });
    expect(writes.at(-1)!.state).toBe("stopped");
    const count = writes.length;
    advance(5000);
    expect(writes).toHaveLength(count);
  });

  it("keeps running when the file cannot be written", () => {
    const errors: unknown[] = [];
    const status = new StatusWriter("x", initialStatus(1, T0), {
      write: () => {
        throw new Error("EPERM");
      },
      onError: (error) => errors.push(error),
    });
    status.update({ state: "recording" });
    expect(errors).toHaveLength(1);
    expect(status.current.state).toBe("recording");
  });

  it("produces status documents matching the schema", () => {
    const status = make();
    status.update({
      state: "recording",
      session: "2026-10-03T12-00-00Z-Annie",
      champion: "Annie",
      gameTime: 61.5,
      startedAt: "2026-10-03T12:00:00.000Z",
      encoder: "h264_nvenc",
    });
    expect(companionStatusSchema.safeParse(writes[0]).success).toBe(true);
  });
});

describe("atomic status file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rekap-status-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces the file without leaving temp files", () => {
    const path = join(dir, "status.json");
    writeJsonAtomic(path, initialStatus(1));
    writeJsonAtomic(path, { ...initialStatus(1), state: "recording" });
    expect(JSON.parse(readFileSync(path, "utf8")).state).toBe("recording");
    expect(readdirSync(dir)).toEqual(["status.json"]);
  });
});

describe("single instance", () => {
  const now = Date.parse("2026-10-03T12:00:10.000Z");
  const status = (patch: Partial<CompanionStatus>) => ({
    ...initialStatus(100),
    updatedAt: "2026-10-03T12:00:08.000Z",
    ...patch,
  });
  const check = (raw: unknown, alive = true) =>
    runningInstance(raw, { now, selfPid: 200, isAlive: () => alive });

  it("refuses to start next to a live, fresh companion", () => {
    expect(check(status({ state: "recording" }))?.pid).toBe(100);
    expect(check(status({ state: "waiting" }))?.pid).toBe(100);
  });

  it("starts when the previous one stopped, died or went stale", () => {
    expect(check(status({ state: "stopped" }))).toBeNull();
    expect(check(status({}), false)).toBeNull(); // pid gone
    expect(
      check(status({ updatedAt: "2026-10-03T11:59:59.000Z" })), // 11 s old
    ).toBeNull();
    expect(check(status({ pid: 200 }))).toBeNull(); // our own pid
    expect(check(undefined)).toBeNull(); // no file
    expect(check({ state: "recording" })).toBeNull(); // unreadable
  });
});

describe("control file", () => {
  const start = Date.parse("2026-10-03T12:00:00.000Z");

  it("accepts a stop requested after start", () => {
    expect(
      parseStopRequest(
        { command: "stop", requestedAt: "2026-10-03T12:05:00.000Z" },
        start,
      ),
    ).toEqual({ analyze: false, requestedAtMs: start + 300_000 });
    expect(
      parseStopRequest(
        {
          command: "stop",
          requestedAt: "2026-10-03T12:05:00.000Z",
          analyze: true,
        },
        start,
      )?.analyze,
    ).toBe(true);
  });

  it("ignores stale, malformed or unknown requests", () => {
    const stale = {
      command: "stop",
      requestedAt: "2026-10-03T11:59:00.000Z",
    };
    expect(parseStopRequest(stale, start)).toBeNull();
    expect(isStaleControl(stale, start)).toBe(true);
    expect(
      parseStopRequest({ command: "stop", requestedAt: "soon" }, start),
    ).toBeNull();
    expect(
      parseStopRequest(
        { command: "pause", requestedAt: "2026-10-03T12:05:00.000Z" },
        start,
      ),
    ).toBeNull();
    expect(parseStopRequest(undefined, start)).toBeNull();
    expect(isStaleControl(undefined, start)).toBe(false);
  });
});
