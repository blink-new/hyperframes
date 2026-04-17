import { describe, it, expect } from "vitest";
import { ENCODER_PRESETS, getEncoderPreset, buildEncoderArgs } from "./chunkEncoder.js";

describe("ENCODER_PRESETS", () => {
  it("has draft, standard, and high presets", () => {
    expect(ENCODER_PRESETS).toHaveProperty("draft");
    expect(ENCODER_PRESETS).toHaveProperty("standard");
    expect(ENCODER_PRESETS).toHaveProperty("high");
  });

  it("draft uses ultrafast preset with high CRF", () => {
    expect(ENCODER_PRESETS.draft.preset).toBe("ultrafast");
    expect(ENCODER_PRESETS.draft.quality).toBeGreaterThan(ENCODER_PRESETS.standard.quality);
    expect(ENCODER_PRESETS.draft.codec).toBe("h264");
  });

  it("high uses slow preset with low CRF for better quality", () => {
    expect(ENCODER_PRESETS.high.preset).toBe("slow");
    expect(ENCODER_PRESETS.high.quality).toBeLessThan(ENCODER_PRESETS.standard.quality);
    expect(ENCODER_PRESETS.high.codec).toBe("h264");
  });

  it("standard sits between draft and high in quality", () => {
    expect(ENCODER_PRESETS.standard.quality).toBeGreaterThan(ENCODER_PRESETS.high.quality);
    expect(ENCODER_PRESETS.standard.quality).toBeLessThan(ENCODER_PRESETS.draft.quality);
  });
});

describe("getEncoderPreset", () => {
  it("returns h264 with yuv420p for mp4 format", () => {
    const preset = getEncoderPreset("standard", "mp4");
    expect(preset.codec).toBe("h264");
    expect(preset.pixelFormat).toBe("yuv420p");
  });

  it("returns vp9 with yuva420p for webm format", () => {
    const preset = getEncoderPreset("standard", "webm");
    expect(preset.codec).toBe("vp9");
    expect(preset.pixelFormat).toBe("yuva420p");
  });

  it("maps draft ultrafast to vp9 realtime deadline", () => {
    const preset = getEncoderPreset("draft", "webm");
    expect(preset.preset).toBe("realtime");
    expect(preset.codec).toBe("vp9");
  });

  it("maps standard/high to vp9 good deadline", () => {
    expect(getEncoderPreset("standard", "webm").preset).toBe("good");
    expect(getEncoderPreset("high", "webm").preset).toBe("good");
  });

  it("preserves quality values across formats", () => {
    for (const q of ["draft", "standard", "high"] as const) {
      expect(getEncoderPreset(q, "webm").quality).toBe(ENCODER_PRESETS[q].quality);
    }
  });

  it("returns prores 4444 with yuva444p10le for mov format", () => {
    const preset = getEncoderPreset("standard", "mov");
    expect(preset.codec).toBe("prores");
    expect(preset.preset).toBe("4444");
    expect(preset.pixelFormat).toBe("yuva444p10le");
  });

  it("uses prores 4444 for all mov quality levels", () => {
    for (const q of ["draft", "standard", "high"] as const) {
      const preset = getEncoderPreset(q, "mov");
      expect(preset.codec).toBe("prores");
      expect(preset.preset).toBe("4444");
    }
  });

  it("defaults to mp4 when format is omitted", () => {
    const preset = getEncoderPreset("standard");
    expect(preset.codec).toBe("h264");
    expect(preset.pixelFormat).toBe("yuv420p");
  });
});

describe("buildEncoderArgs anti-banding", () => {
  const baseOptions = { fps: 30, width: 1920, height: 1080 };

  it("adds aq-mode=3 x264-params for h264 CPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23 },
      ["-framerate", "30", "-i", "frames/%04d.png"],
      "out.mp4",
    );
    const paramIdx = args.indexOf("-x264-params");
    expect(paramIdx).toBeGreaterThan(-1);
    expect(args[paramIdx + 1]).toContain("aq-mode=3");
  });

  it("adds aq-mode=3 x265-params for h265 CPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h265", preset: "medium", quality: 23 },
      ["-framerate", "30", "-i", "frames/%04d.png"],
      "out.mp4",
    );
    const paramIdx = args.indexOf("-x265-params");
    expect(paramIdx).toBeGreaterThan(-1);
    expect(args[paramIdx + 1]).toContain("aq-mode=3");
  });

  it("includes deblock for non-ultrafast presets", () => {
    for (const preset of ["medium", "slow"]) {
      const args = buildEncoderArgs(
        { ...baseOptions, codec: "h264", preset, quality: 23 },
        ["-framerate", "30", "-i", "frames/%04d.png"],
        "out.mp4",
      );
      const paramIdx = args.indexOf("-x264-params");
      expect(args[paramIdx + 1]).toContain("deblock=1,1");
    }
  });

  it("omits deblock for ultrafast (draft) preset", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "ultrafast", quality: 28 },
      ["-framerate", "30", "-i", "frames/%04d.png"],
      "out.mp4",
    );
    const paramIdx = args.indexOf("-x264-params");
    expect(paramIdx).toBeGreaterThan(-1);
    expect(args[paramIdx + 1]).toContain("aq-mode=3");
    expect(args[paramIdx + 1]).not.toContain("deblock");
  });

  it("does not add x264-params for GPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23, useGpu: true },
      ["-framerate", "30", "-i", "frames/%04d.png"],
      "out.mp4",
      "nvenc",
    );
    expect(args.indexOf("-x264-params")).toBe(-1);
  });

  it("does not add x264-params for VP9 encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "vp9", preset: "good", quality: 23 },
      ["-framerate", "30", "-i", "frames/%04d.png"],
      "out.webm",
    );
    expect(args.indexOf("-x264-params")).toBe(-1);
    expect(args.indexOf("-x265-params")).toBe(-1);
  });
});

describe("buildEncoderArgs color space", () => {
  const baseOptions = { fps: 30, width: 1920, height: 1080 };
  const inputArgs = ["-framerate", "30", "-i", "frames/%04d.png"];

  it("adds bt709 color space metadata for h264 CPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    // FFmpeg-level metadata tags
    expect(args).toContain("-colorspace:v");
    expect(args[args.indexOf("-colorspace:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_primaries:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_trc:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_range") + 1]).toBe("tv");
    // x264-params VUI embedding
    const paramIdx = args.indexOf("-x264-params");
    expect(args[paramIdx + 1]).toContain("colorprim=bt709");
    expect(args[paramIdx + 1]).toContain("transfer=bt709");
    expect(args[paramIdx + 1]).toContain("colormatrix=bt709");
  });

  it("adds bt709 color space metadata for h265 CPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h265", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    expect(args).toContain("-colorspace:v");
    expect(args[args.indexOf("-colorspace:v") + 1]).toBe("bt709");
    // x265-params VUI embedding
    const paramIdx = args.indexOf("-x265-params");
    expect(args[paramIdx + 1]).toContain("colorprim=bt709");
  });

  it("adds range conversion filter for CPU h264 encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toContain("scale=in_range=pc:out_range=tv");
  });

  it("prepends range conversion to VAAPI filter chain", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23, useGpu: true },
      inputArgs,
      "out.mp4",
      "vaapi",
    );
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe("scale=in_range=pc:out_range=tv,format=nv12,hwupload");
  });

  it("skips range conversion filter for non-VAAPI GPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23, useGpu: true },
      inputArgs,
      "out.mp4",
      "nvenc",
    );
    expect(args.indexOf("-vf")).toBe(-1);
    // but still has color metadata
    expect(args).toContain("-colorspace:v");
  });

  it("does not add color metadata for VP9", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "vp9", preset: "good", quality: 23 },
      inputArgs,
      "out.webm",
    );
    expect(args).not.toContain("-colorspace:v");
  });

  it("adds video_track_timescale for h264", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    expect(args).toContain("-video_track_timescale");
    expect(args[args.indexOf("-video_track_timescale") + 1]).toBe("90000");
  });

  it("does not add timescale for VP9", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "vp9", preset: "good", quality: 23 },
      inputArgs,
      "out.webm",
    );
    expect(args).not.toContain("-video_track_timescale");
  });
});

describe("getEncoderPreset HDR", () => {
  it("returns h265 with 10-bit for HDR HLG", () => {
    const preset = getEncoderPreset("standard", "mp4", { transfer: "hlg" });
    expect(preset.codec).toBe("h265");
    expect(preset.pixelFormat).toBe("yuv420p10le");
    expect(preset.hdr).toEqual({ transfer: "hlg" });
  });

  it("returns h265 with 10-bit for HDR PQ", () => {
    const preset = getEncoderPreset("high", "mp4", { transfer: "pq" });
    expect(preset.codec).toBe("h265");
    expect(preset.pixelFormat).toBe("yuv420p10le");
    expect(preset.hdr).toEqual({ transfer: "pq" });
  });

  it("avoids ultrafast preset for HDR (upgrades to fast)", () => {
    const preset = getEncoderPreset("draft", "mp4", { transfer: "hlg" });
    expect(preset.preset).toBe("fast");
  });

  it("ignores HDR for webm format", () => {
    const preset = getEncoderPreset("standard", "webm", { transfer: "hlg" });
    expect(preset.codec).toBe("vp9");
    expect(preset.hdr).toBeUndefined();
  });

  it("ignores HDR for mov format", () => {
    const preset = getEncoderPreset("standard", "mov", { transfer: "pq" });
    expect(preset.codec).toBe("prores");
    expect(preset.hdr).toBeUndefined();
  });
});

describe("buildEncoderArgs HDR color space", () => {
  const baseOptions = { fps: 30, width: 1920, height: 1080 };
  const inputArgs = ["-framerate", "30", "-i", "frames/%04d.png"];

  it("uses bt709 color tags for HDR output (Chrome captures sRGB)", () => {
    // HDR flag gives H.265 + 10-bit encoding but pixels are still sRGB/bt709.
    // Tagging as bt2020 causes orange shift — so we tag truthfully as bt709.
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h265", preset: "medium", quality: 23, hdr: { transfer: "hlg" } },
      inputArgs,
      "out.mp4",
    );
    expect(args[args.indexOf("-colorspace:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_primaries:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_trc:v") + 1]).toBe("bt709");
    const paramIdx = args.indexOf("-x265-params");
    expect(args[paramIdx + 1]).toContain("colorprim=bt709");
    expect(args[paramIdx + 1]).toContain("transfer=bt709");
  });

  it("uses bt709 when HDR is not set", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h265", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    expect(args[args.indexOf("-colorspace:v") + 1]).toBe("bt709");
    expect(args[args.indexOf("-color_trc:v") + 1]).toBe("bt709");
  });

  it("uses range conversion (not colorspace) for HDR CPU encoding", () => {
    // Chrome screenshots are sRGB — we don't convert primaries (causes color shifts).
    // Just range-convert and let the bt2020 container metadata + 10-bit handle the rest.
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h265", preset: "medium", quality: 23, hdr: { transfer: "hlg" } },
      inputArgs,
      "out.mp4",
    );
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toContain("scale=in_range=pc:out_range=tv");
    expect(args[vfIdx + 1]).not.toContain("colorspace");
  });

  it("uses same range conversion for SDR CPU encoding", () => {
    const args = buildEncoderArgs(
      { ...baseOptions, codec: "h264", preset: "medium", quality: 23 },
      inputArgs,
      "out.mp4",
    );
    const vfIdx = args.indexOf("-vf");
    expect(args[vfIdx + 1]).toContain("scale=in_range=pc:out_range=tv");
  });
});
