import { describe, expect, it } from "vitest";
import {
  isHdrColorSpace,
  detectTransfer,
  getHdrEncoderColorParams,
  analyzeCompositionHdr,
} from "./hdr.js";
import type { VideoColorSpace } from "./ffprobe.js";

describe("isHdrColorSpace", () => {
  it("returns false for null", () => {
    expect(isHdrColorSpace(null)).toBe(false);
  });

  it("returns false for bt709 SDR", () => {
    expect(
      isHdrColorSpace({ colorTransfer: "bt709", colorPrimaries: "bt709", colorSpace: "bt709" }),
    ).toBe(false);
  });

  it("detects bt2020 primaries", () => {
    expect(
      isHdrColorSpace({ colorTransfer: "bt709", colorPrimaries: "bt2020", colorSpace: "bt709" }),
    ).toBe(true);
  });

  it("detects smpte2084 (PQ)", () => {
    expect(
      isHdrColorSpace({
        colorTransfer: "smpte2084",
        colorPrimaries: "bt2020",
        colorSpace: "bt2020nc",
      }),
    ).toBe(true);
  });

  it("detects arib-std-b67 (HLG)", () => {
    expect(
      isHdrColorSpace({
        colorTransfer: "arib-std-b67",
        colorPrimaries: "bt2020",
        colorSpace: "bt2020nc",
      }),
    ).toBe(true);
  });
});

describe("detectTransfer", () => {
  it("returns hlg for null", () => {
    expect(detectTransfer(null)).toBe("hlg");
  });

  it("returns pq for smpte2084", () => {
    expect(
      detectTransfer({
        colorTransfer: "smpte2084",
        colorPrimaries: "bt2020",
        colorSpace: "bt2020nc",
      }),
    ).toBe("pq");
  });

  it("returns hlg for arib-std-b67", () => {
    expect(
      detectTransfer({
        colorTransfer: "arib-std-b67",
        colorPrimaries: "bt2020",
        colorSpace: "bt2020nc",
      }),
    ).toBe("hlg");
  });

  it("returns hlg for bt709 (fallback)", () => {
    expect(
      detectTransfer({ colorTransfer: "bt709", colorPrimaries: "bt709", colorSpace: "bt709" }),
    ).toBe("hlg");
  });
});

describe("getHdrEncoderColorParams", () => {
  it("returns PQ params", () => {
    const params = getHdrEncoderColorParams("pq");
    expect(params.colorTrc).toBe("smpte2084");
    expect(params.colorPrimaries).toBe("bt2020");
    expect(params.colorspace).toBe("bt2020nc");
    expect(params.pixelFormat).toBe("yuv420p10le");
    expect(params.x265ColorParams).toContain("smpte2084");
  });

  it("returns HLG params", () => {
    const params = getHdrEncoderColorParams("hlg");
    expect(params.colorTrc).toBe("arib-std-b67");
    expect(params.colorPrimaries).toBe("bt2020");
    expect(params.pixelFormat).toBe("yuv420p10le");
    expect(params.x265ColorParams).toContain("arib-std-b67");
  });
});

describe("analyzeCompositionHdr", () => {
  const sdr: VideoColorSpace = {
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
  };
  const hlg: VideoColorSpace = {
    colorTransfer: "arib-std-b67",
    colorPrimaries: "bt2020",
    colorSpace: "bt2020nc",
  };
  const pq: VideoColorSpace = {
    colorTransfer: "smpte2084",
    colorPrimaries: "bt2020",
    colorSpace: "bt2020nc",
  };

  it("returns no HDR for all SDR", () => {
    expect(analyzeCompositionHdr([sdr, sdr, null])).toEqual({
      hasHdr: false,
      dominantTransfer: null,
    });
  });

  it("detects HLG", () => {
    expect(analyzeCompositionHdr([sdr, hlg])).toEqual({
      hasHdr: true,
      dominantTransfer: "hlg",
    });
  });

  it("detects PQ", () => {
    expect(analyzeCompositionHdr([sdr, pq])).toEqual({
      hasHdr: true,
      dominantTransfer: "pq",
    });
  });

  it("PQ takes priority over HLG in mixed HDR", () => {
    expect(analyzeCompositionHdr([hlg, pq])).toEqual({
      hasHdr: true,
      dominantTransfer: "pq",
    });
  });
});
