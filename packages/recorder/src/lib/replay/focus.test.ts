import { describe, expect, it } from "vitest";
import { isFocused, pressFocused } from "./focus";

const presses = (...results: string[]) => {
  const calls: string[] = [];
  const press = async () => {
    calls.push("press");
    return results.shift() ?? "not focused (in front: Visual Studio Code)";
  };
  const retry = (go = true) => async (attempt: number, answer: string) => {
    calls.push(`wait ${attempt}: ${answer}`);
    return go;
  };
  return { calls, press, retry };
};

describe("key presses that need the replay focus", () => {
  it("reads the helper's answers", () => {
    expect(isFocused("focused\n")).toBe(true);
    expect(isFocused("focused after Alt")).toBe(true);
    expect(isFocused("not focused (in front: Slack)")).toBe(false);
    expect(isFocused("")).toBe(false);
  });

  it("presses once when the replay has the focus", async () => {
    const p = presses("focused\n");
    expect(await pressFocused(p.press, p.retry())).toEqual({ ok: true, attempts: 1, answer: "focused" });
    expect(p.calls).toEqual(["press"]);
  });

  it("counts a focus taken after Alt", async () => {
    const p = presses("focused after Alt");
    expect(await pressFocused(p.press, p.retry())).toEqual({ ok: true, attempts: 1, answer: "focused after Alt" });
  });

  it("waits, then presses again after a lost focus, telling which window kept it", async () => {
    const p = presses("not focused (in front: Slack)", "focused");
    expect(await pressFocused(p.press, p.retry())).toEqual({ ok: true, attempts: 2, answer: "focused" });
    expect(p.calls).toEqual(["press", "wait 1: not focused (in front: Slack)", "press"]);
  });

  it("gives up after the bounded attempts", async () => {
    const p = presses();
    const result = await pressFocused(p.press, p.retry(), 3);
    expect(result).toEqual({ ok: false, attempts: 3, answer: "not focused (in front: Visual Studio Code)" });
    expect(p.calls.filter((c) => c === "press")).toHaveLength(3);
  });

  it("stops when the wait is abandoned", async () => {
    const p = presses();
    expect((await pressFocused(p.press, p.retry(false))).attempts).toBe(1);
    expect(p.calls).toEqual(["press", "wait 1: not focused (in front: Visual Studio Code)"]);
  });
});
