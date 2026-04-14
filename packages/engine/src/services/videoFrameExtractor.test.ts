import { describe, expect, it } from "vitest";
import { parseVideoElements, isHdrColorSpace } from "./videoFrameExtractor.js";
import type { VideoColorSpace } from "../utils/ffprobe.js";

describe("parseVideoElements", () => {
  it("parses videos without an id or data-start attribute", () => {
    const videos = parseVideoElements('<video src="clip.mp4"></video>');

    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      id: "hf-video-0",
      src: "clip.mp4",
      start: 0,
      end: Infinity,
      mediaStart: 0,
      hasAudio: false,
    });
  });

  it("preserves explicit ids and derives end from data-duration", () => {
    const videos = parseVideoElements(
      '<video id="hero" src="clip.mp4" data-start="2" data-duration="5" data-media-start="1.5" data-has-audio="true"></video>',
    );

    expect(videos).toHaveLength(1);
    expect(videos[0]).toEqual({
      id: "hero",
      src: "clip.mp4",
      start: 2,
      end: 7,
      mediaStart: 1.5,
      hasAudio: true,
    });
  });
});

describe("isHdrColorSpace", () => {
  it("returns false for null color space", () => {
    expect(isHdrColorSpace(null)).toBe(false);
  });

  it("returns false for SDR bt709", () => {
    const sdr: VideoColorSpace = {
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      colorSpace: "bt709",
    };
    expect(isHdrColorSpace(sdr)).toBe(false);
  });

  it("detects HDR via bt2020 primaries", () => {
    const hdr: VideoColorSpace = {
      colorTransfer: "bt709",
      colorPrimaries: "bt2020",
      colorSpace: "bt709",
    };
    expect(isHdrColorSpace(hdr)).toBe(true);
  });

  it("detects HDR via bt2020nc color space", () => {
    const hdr: VideoColorSpace = {
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      colorSpace: "bt2020nc",
    };
    expect(isHdrColorSpace(hdr)).toBe(true);
  });

  it("detects HDR via smpte2084 (PQ) transfer", () => {
    const hdr: VideoColorSpace = {
      colorTransfer: "smpte2084",
      colorPrimaries: "bt2020",
      colorSpace: "bt2020nc",
    };
    expect(isHdrColorSpace(hdr)).toBe(true);
  });

  it("detects HDR via arib-std-b67 (HLG) transfer", () => {
    const hdr: VideoColorSpace = {
      colorTransfer: "arib-std-b67",
      colorPrimaries: "bt2020",
      colorSpace: "bt2020nc",
    };
    expect(isHdrColorSpace(hdr)).toBe(true);
  });
});
