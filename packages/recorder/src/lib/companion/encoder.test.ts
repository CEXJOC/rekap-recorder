import { describe, expect, it } from "vitest";
import {
  buildCaptureArgs,
  buildCopyProbeArgs,
  buildDecodeCheckArgs,
  buildProbeArgs,
  buildRemuxArgs,
  captureFilter,
  effectiveFps,
  encoderArgs,
  encoderCandidates,
  ENCODER_ORDER,
  parseEncoderList,
} from "./encoder";

// Trimmed `ffmpeg -hide_banner -encoders` output (gyan.dev 6.1.1 essentials).
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_mf              H264 via MediaFoundation (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

describe("encoder fallback", () => {
  it("parses video encoders from ffmpeg -encoders", () => {
    const names = parseEncoderList(ENCODERS);
    for (const name of ENCODER_ORDER) expect(names.has(name)).toBe(true);
    expect(names.has("aac")).toBe(false); // audio
    expect(names.has("=")).toBe(false); // legend line
  });

  it("tries hardware encoders first, then Media Foundation, then libx264", () => {
    expect(encoderCandidates(parseEncoderList(ENCODERS))).toEqual([
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_mf",
      "libx264",
    ]);
  });

  it("skips encoders this ffmpeg build lacks", () => {
    expect(encoderCandidates(new Set(["libx264", "h264_mf"]))).toEqual([
      "h264_mf",
      "libx264",
    ]);
    expect(encoderCandidates(new Set())).toEqual([]);
  });

  it("puts a preferred encoder first and keeps the rest as fallback", () => {
    expect(encoderCandidates(parseEncoderList(ENCODERS), "libx264")).toEqual([
      "libx264",
      "h264_nvenc",
      "h264_amf",
      "h264_qsv",
      "h264_mf",
    ]);
    // A preferred encoder missing from the build is not invented.
    expect(encoderCandidates(new Set(["libx264"]), "h264_nvenc")).toEqual([
      "libx264",
    ]);
  });

  it("caps the CPU encoder at 15 fps", () => {
    expect(effectiveFps("libx264", 30)).toBe(15);
    expect(effectiveFps("libx264", 10)).toBe(10);
    expect(effectiveFps("h264_nvenc", 60)).toBe(60);
  });
});

describe("ffmpeg arguments", () => {
  it("captures with ddagrab and keeps D3D11 frames on the GPU for NVENC", () => {
    const args = buildCaptureArgs(
      { encoder: "h264_nvenc", fps: 30, monitor: 0 },
      "C:\\Rift Recall\\screen.mkv",
    );
    const input = args[args.indexOf("-i") + 1];
    expect(input).toBe("ddagrab=output_idx=0:framerate=30:draw_mouse=0");
    expect(args.slice(args.indexOf("-c:v")).join(" ")).toBe(
      "-c:v h264_nvenc -preset p4 -rc vbr -cq 30 -b:v 0 -g 60 -bf 0 -f matroska -cluster_time_limit 1000 -flush_packets 1 -y C:\\Rift Recall\\screen.mkv",
    );
    // The output path stays one argument even with a space in it.
    expect(args.at(-1)).toBe("C:\\Rift Recall\\screen.mkv");
    expect(args).toContain("-an");
    expect(args[args.indexOf("-progress") + 1]).toBe("pipe:1");
    expect(args.join(" ")).not.toMatch(/hwdownload|-nostdin/); // q via stdin
  });

  it("downloads frames to system memory only for encoders that need it", () => {
    const filter = (encoder: Parameters<typeof captureFilter>[0]["encoder"]) =>
      captureFilter({ encoder, fps: 30, monitor: 1 });
    expect(filter("h264_amf")).toBe(
      "ddagrab=output_idx=1:framerate=30:draw_mouse=0",
    );
    const download = ",hwdownload,format=bgra,scale=flags=fast_bilinear";
    expect(filter("h264_qsv")).toMatch(new RegExp(`${download},format=nv12$`));
    expect(filter("h264_mf")).toMatch(new RegExp(`${download},format=nv12$`));
    expect(filter("libx264")).toBe(
      `ddagrab=output_idx=1:framerate=15:draw_mouse=0${download},format=yuv420p`,
    );
  });

  it("grabs only the given area of the screen", () => {
    const area = { x: 1602, y: 778, width: 288, height: 288 };
    const grab = "ddagrab=output_idx=0:framerate=2:draw_mouse=0";
    const region = ":video_size=288x288:offset_x=1602:offset_y=778";
    expect(captureFilter({ encoder: "h264_nvenc", fps: 2, monitor: 0, area })).toBe(
      `${grab}${region}`,
    );
    expect(captureFilter({ encoder: "libx264", fps: 2, monitor: 0, area })).toMatch(
      new RegExp(`^${grab}${region},hwdownload`),
    );
    const args = buildCaptureArgs(
      { encoder: "h264_nvenc", fps: 2, monitor: 0, area },
      "screen.mkv",
    );
    expect(args[args.indexOf("-g") + 1]).toBe("4");
  });

  it("uses a 2-second GOP at the effective frame rate", () => {
    const gop = (args: string[]) => args[args.indexOf("-g") + 1];
    const nvenc = encoderArgs({ encoder: "h264_nvenc", fps: 60, monitor: 0 });
    const x264 = encoderArgs({ encoder: "libx264", fps: 30, monitor: 0 });
    expect(gop(nvenc)).toBe("120");
    expect(gop(x264)).toBe("30");
    expect(encoderArgs({ encoder: "libx264", fps: 30, monitor: 0 })).toEqual(
      expect.arrayContaining(["-preset", "ultrafast"]),
    );
  });

  it("never uses B-frames, so frames are stored in display order", () => {
    for (const encoder of ENCODER_ORDER) {
      const args = encoderArgs({ encoder, fps: 30, monitor: 0 });
      expect(args[args.indexOf("-bf") + 1]).toBe("0");
      expect(args[args.indexOf("-c:v") + 1]).toBe(encoder);
    }
  });

  it("remuxes by stream copy with the index at the front of the MP4", () => {
    const single = buildRemuxArgs(["-i", "a b\\screen.mkv"], "a b\\screen.mp4");
    expect(single.slice(single.indexOf("-i")).join("|")).toBe(
      "-i|a b\\screen.mkv|-map|0:v:0|-c|copy|-movflags|+faststart|-f|mp4|a b\\screen.mp4",
    );
    const joined = buildRemuxArgs(
      ["-f", "concat", "-safe", "0", "-i", "list.txt"],
      "screen.mp4.part",
    );
    expect(joined.join(" ")).toContain("-f concat -safe 0 -i list.txt -map");
    expect(joined.at(-1)).toBe("screen.mp4.part");
  });

  it("checks a video by decoding it on the GPU, or on the CPU as fallback", () => {
    const gpu = buildDecodeCheckArgs("screen.mp4", true).join(" ");
    expect(gpu).toContain(
      "-hwaccel d3d11va -hwaccel_output_format d3d11 -i screen.mp4",
    );
    expect(gpu).toMatch(/-progress pipe:1 .* -map 0:v:0 -f null -$/);
    const cpu = buildDecodeCheckArgs("screen.mp4", false).join(" ");
    expect(cpu).not.toContain("hwaccel");
    expect(cpu).not.toContain("-c copy"); // really decodes
    expect(buildCopyProbeArgs("screen.mkv").join(" ")).toMatch(
      /-i screen\.mkv -map 0:v:0 -c copy -f null -$/,
    );
  });

  it("probes with a discarded one-second encode of the same graph", () => {
    const args = buildProbeArgs({ encoder: "h264_mf", fps: 30, monitor: 0 });
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(args[args.indexOf("-t") + 1]).toBe("1");
    expect(args[args.indexOf("-c:v") + 1]).toBe("h264_mf");
    expect(args[args.indexOf("-i") + 1]).toContain("hwdownload");
  });
});
