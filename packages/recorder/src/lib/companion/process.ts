// Child-process helpers: below-normal priority (the game keeps the CPU) and
// whole-tree termination on Windows.
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { constants, setPriority } from "node:os";

export function lowerPriority(pid?: number, background = false) {
  try {
    setPriority(
      pid ?? 0,
      background
        ? constants.priority.PRIORITY_LOW
        : constants.priority.PRIORITY_BELOW_NORMAL,
    );
    return true;
  } catch {
    return false;
  }
}

/** Kills a child and its descendants (tsx runs scripts in a grandchild). */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    if (result.status === 0) return;
  }
  child.kill("SIGKILL");
}

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      done(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once("exit", onExit);
  });
}

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Runs a short-lived command at below-normal priority and collects output. */
export function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxOutput?: number } = {},
): Promise<RunResult> {
  const { timeoutMs = 120_000, maxOutput = 256 * 1024 } = options;
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lowerPriority(child.pid);
    const keep = (buffer: string, chunk: Buffer) =>
      (buffer + chunk.toString("utf8")).slice(-maxOutput);
    child.stdout?.on("data", (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = keep(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });
}
