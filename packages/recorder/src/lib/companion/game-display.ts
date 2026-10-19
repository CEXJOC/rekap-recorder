import path from "node:path";
import { run } from "./process";
export function parseGameDisplay(value: string): number | null {
  try {
    const monitor = JSON.parse(value).monitor;
    return Number.isInteger(monitor) && monitor >= 0 && monitor < 8
      ? monitor
      : null;
  } catch {
    return null;
  }
}
export async function gameDisplay(root: string): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts/companion/game-display.ps1"),
    ],
    { timeoutMs: 10000 },
  );
  return result.code === 0 ? parseGameDisplay(result.stdout) : null;
}
