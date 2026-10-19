import { expect, it } from "vitest";
import { parseGameDisplay } from "./game-display";
it("accepts only an unambiguous accessible DXGI output", () => {
  expect(parseGameDisplay('{"monitor":1}')).toBe(1);
  for (const s of [
    '{"monitor":-1}',
    '{"monitor":8}',
    '{"monitor":"0"}',
    "{}",
    "error",
  ])
    expect(parseGameDisplay(s)).toBeNull();
});
