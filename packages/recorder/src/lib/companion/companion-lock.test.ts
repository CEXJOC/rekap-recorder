import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimCompanionLock } from "./companion-lock";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const lockIn = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rekap-lock-"));
  dirs.push(dir);
  return path.join(dir, "companion.lock");
};
const ageMs = (file: string) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

it("lets only one of two companions started together run", () => {
  const file = lockIn();
  const first = claimCompanionLock(file, { pid: 101, isAlive: () => true, ageMs });
  const second = claimCompanionLock(file, { pid: 202, isAlive: () => true, ageMs });
  expect("release" in first).toBe(true);
  expect(second).toEqual({ holder: expect.objectContaining({ pid: 101 }) });
  if ("release" in first) first.release();
  expect(existsSync(file)).toBe(false);
  expect("release" in claimCompanionLock(file, { pid: 202, isAlive: () => true, ageMs })).toBe(true);
});

it("takes over at once from a companion that is gone", () => {
  const file = lockIn();
  writeFileSync(file, JSON.stringify({ pid: 999, startedAt: "yesterday" }));
  const claim = claimCompanionLock(file, { pid: 303, isAlive: (pid) => pid !== 999, ageMs });
  expect("release" in claim).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(303);
});

it("takes over a lock not renewed lately, and never removes another's lock", () => {
  const file = lockIn();
  writeFileSync(file, JSON.stringify({ pid: 404, startedAt: "earlier" }));
  const stale = claimCompanionLock(file, { pid: 505, isAlive: () => true, ageMs: () => 10 * 60_000 });
  expect("release" in stale).toBe(true);
  writeFileSync(file, JSON.stringify({ pid: 606, startedAt: "now" }));
  if ("release" in stale) stale.release();
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(606);
});
