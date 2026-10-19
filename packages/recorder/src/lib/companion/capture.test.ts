import { describe, expect, it } from "vitest";
import { probeEncoder } from "./capture";
import type { RunResult } from "./process";

const result = (over: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

/** A fake ffmpeg: the encoder list, then one result per encode test. */
function fakeRun(list: RunResult, encodes: Record<string, RunResult>) {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("-encoders")) return list;
    const encoder = args[args.indexOf("-c:v") + 1];
    return encodes[encoder] ?? result({ code: 1, stderr: "no device" });
  };
  return { run, calls };
}

const listing = [
  " V....D libx264              libx264 H.264",
  " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
].join("\n");

describe("probeEncoder", () => {
  it("tests only the listed encoders when the list works", async () => {
    const { run, calls } = fakeRun(result({ stdout: listing }), {
      h264_nvenc: result(),
    });
    const probe = await probeEncoder("ffmpeg", { fps: 30, monitor: 0, run });
    expect(probe.encoder).toBe("h264_nvenc");
    expect(probe.listError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("still tests every encoder when the list times out under load", async () => {
    const { run } = fakeRun(result({ code: null, timedOut: true }), {
      h264_qsv: result(),
    });
    const probe = await probeEncoder("ffmpeg", { fps: 30, monitor: 0, run });
    expect(probe.listError).toMatch(/timed out/);
    expect(probe.attempts.map((a) => a.encoder)).toEqual([
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
    ]);
    expect(probe.encoder).toBe("h264_qsv");
  });

  it("reports an empty list instead of failing silently", async () => {
    const { run } = fakeRun(result({ stdout: "" }), {});
    const probe = await probeEncoder("ffmpeg", { fps: 30, monitor: 0, run });
    expect(probe.encoder).toBeNull();
    expect(probe.listError).toBeDefined();
    expect(probe.attempts.length).toBeGreaterThan(0);
  });
});
